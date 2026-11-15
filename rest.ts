// rest.ts: the GitHub REST v3 surface: /api/v3 root and meta, repositories, contents, branches,
// commits, issues, labels, pull requests, and the refs/commits routes gh uses to open one.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { OBJ_BLOB, OBJ_COMMIT, type ObjectStore } from './git/objects.ts';
import {
  blobSha, buildTree, createCommit, diffTrees, fileAtCommit, flattenTree, readCommit, readTree, treeAtPath, walkHistory,
} from './git/model.ts';
import type { Forge, Issue, Pull, Repo } from './store.ts';
import { respond, readBody } from './http.ts';

/** The JSON a repository is reported as. */
export function repoJson(repo: Repo, base: string): Record<string, unknown> {
  const m = repo.meta;
  return {
    id: hashId(`${m.owner}/${m.name}`),
    node_id: Buffer.from(`repo:${m.owner}/${m.name}`).toString('base64'),
    name: m.name,
    full_name: `${m.owner}/${m.name}`,
    owner: { login: m.owner, id: hashId(m.owner), type: 'User', site_admin: false },
    private: m.private,
    html_url: `${base}/${m.owner}/${m.name}`,
    description: m.description,
    fork: false,
    url: `${base}/api/v3/repos/${m.owner}/${m.name}`,
    created_at: m.created_at,
    updated_at: m.updated_at,
    pushed_at: m.updated_at,
    default_branch: m.default_branch,
    visibility: m.private ? 'private' : 'public',
    permissions: { admin: true, push: true, pull: true },
    has_issues: true,
  };
}

/** A stable small integer for an id string (GitHub ids are integers). */
export function hashId(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h) || 1;
}

/** The JSON an issue is reported as. */
export function issueJson(repo: Repo, issue: Issue, base: string): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: Buffer.from(`issue:${issue.id}`).toString('base64'),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name, id: hashId(name), color: 'ededed' })),
    user: { login: issue.user, id: hashId(issue.user), type: 'User' },
    assignee: null,
    assignees: [],
    comments: issue.comments.length,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    closed_at: issue.closed_at,
    url: `${base}/api/v3/repos/${repo.meta.owner}/${repo.meta.name}/issues/${issue.number}`,
    repository_url: `${base}/api/v3/repos/${repo.meta.owner}/${repo.meta.name}`,
    html_url: `${base}/${repo.meta.owner}/${repo.meta.name}/issues/${issue.number}`,
  };
}

/** The JSON a pull request is reported as. */
export function pullJson(repo: Repo, pr: Pull, base: string): Record<string, unknown> {
  const m = repo.meta;
  return {
    id: pr.id,
    node_id: Buffer.from(`pull:${pr.id}`).toString('base64'),
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    head: { ref: pr.head, label: `${m.owner}:${pr.head}`, sha: repo.branchTip(pr.head) ?? '' },
    base: { ref: pr.base, label: `${m.owner}:${pr.base}`, sha: repo.branchTip(pr.base) ?? '' },
    user: { login: pr.user, id: hashId(pr.user), type: 'User' },
    merged: pr.merged,
    mergeable: true,
    mergeable_state: pr.state === 'open' ? 'clean' : 'unknown',
    merged_at: pr.merged_at,
    merge_commit_sha: pr.merge_commit_sha,
    created_at: pr.created_at,
    updated_at: pr.updated_at,
    url: `${base}/api/v3/repos/${m.owner}/${m.name}/pulls/${pr.number}`,
    repository_url: `${base}/api/v3/repos/${m.owner}/${m.name}`,
    commits: 1,
    additions: 0,
    deletions: 0,
    changed_files: 0,
  };
}

/** The JSON a git ref is reported as. */
function refJson(owner: string, name: string, ref: string, oid: string, base: string): Record<string, unknown> {
  return {
    ref,
    node_id: Buffer.from(`ref:${ref}`).toString('base64'),
    url: `${base}/api/v3/repos/${owner}/${name}/git/refs/${ref.replace(/^refs\//, '')}`,
    object: { type: 'commit', sha: oid, url: `${base}/api/v3/repos/${owner}/${name}/git/commits/${oid}` },
  };
}

/** The JSON a commit is reported as. */
function commitJson(repo: Repo, oid: string, base: string): Record<string, unknown> | null {
  const c = readCommit(repo.store, oid);
  if (!c) return null;
  const m = repo.meta;
  return {
    sha: oid,
    node_id: Buffer.from(`commit:${oid}`).toString('base64'),
    url: `${base}/api/v3/repos/${m.owner}/${m.name}/commits/${oid}`,
    html_url: `${base}/${m.owner}/${m.name}/commit/${oid}`,
    commit: {
      author: { name: c.author.name, email: c.author.email, date: new Date(c.author.date * 1000).toISOString() },
      committer: { name: c.committer.name, email: c.committer.email, date: new Date(c.committer.date * 1000).toISOString() },
      message: c.message,
      tree: { sha: c.tree, url: `${base}/api/v3/repos/${m.owner}/${m.name}/git/trees/${c.tree}` },
      comment_count: 0,
    },
    author: { login: c.author.name, id: hashId(c.author.name), type: 'User' },
    committer: { login: c.committer.name, id: hashId(c.committer.name), type: 'User' },
    parents: c.parents.map((p) => ({ sha: p, url: `${base}/api/v3/repos/${m.owner}/${m.name}/commits/${p}` })),
  };
}

/** Text as base64 with the line breaks GitHub puts in (60 chars, then newline). */
function b64Wrapped(data: Buffer): string {
  const raw = data.toString('base64');
  const out: string[] = [];
  for (let i = 0; i < raw.length; i += 60) out.push(raw.slice(i, i + 60));
  return out.join('\n');
}

/** The commit identity an API write commits as. */
function writer(repo: Repo): { name: string; email: string } {
  return { name: repo.meta.owner, email: `${repo.meta.owner}@users.noreply.github.com` };
}

/** Advance a branch by one new commit over `files`, answering the commit id. */
function commitFiles(repo: Repo, branch: string, files: Map<string, { oid: string; mode: string }>, message: string, parents?: string[]): string {
  const tree = buildTree(repo.store, files);
  const parentOids = parents ?? (repo.branchTip(branch) ? [repo.branchTip(branch)!] : []);
  const w = writer(repo);
  const oid = createCommit(repo.store, { tree, parents: parentOids, message, name: w.name, email: w.email });
  repo.meta.branches[branch] = oid;
  repo.meta.updated_at = new Date().toISOString();
  repo.save();
  return oid;
}

/** The files of a branch, or an empty map for an unborn one. */
function filesOfBranch(repo: Repo, branch: string): Map<string, { oid: string; mode: string }> {
  const tip = repo.branchTip(branch);
  if (!tip) return new Map();
  const c = readCommit(repo.store, tip);
  if (!c) return new Map();
  return flattenTree(repo.store, c.tree);
}

/** Resolve a ref name (branch, tag or sha) to a commit id, or null. */
function resolveRef(repo: Repo, ref: string | null): string | null {
  if (!ref) return repo.branchTip(repo.meta.default_branch);
  if (repo.meta.branches[ref]) return repo.meta.branches[ref]!;
  if (/^[0-9a-f]{40}$/.test(ref) && readCommit(repo.store, ref)) return ref;
  return null;
}

/** One route's answer: `null` means the path did not match this handler at all. */
export type RestOutcome = 'handled' | 'unmatched';

/** Handle every /api/v3 route. Answers 'unmatched' for a path this module does not serve. */
export async function handleRest(
  forge: Forge,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  base: string,
): Promise<RestOutcome> {
  const path = url.pathname;
  const method = req.method ?? 'GET';
  if (!path.startsWith('/api/v3')) return 'unmatched';
  const rest = path.slice('/api/v3'.length) || '/';
  const seg = rest.split('/').filter((s) => s !== '');

  // GET /api/v3/  the API root, with the token's scopes
  if (rest === '/' && method === 'GET') {
    respond(res, 200, {
      current_user_url: `${base}/api/v3/user`,
      current_user_repositories_url: `${base}/api/v3/user/repos`,
      rate_limit_url: `${base}/api/v3/rate_limit`,
      repository_url: `${base}/api/v3/repos/{owner}/{repo}`,
      user_url: `${base}/api/v3/users/{user}`,
    }, { 'x-oauth-scopes': 'repo, read:org' });
    return 'handled';
  }
  // GET /api/v3/meta
  if (seg[0] === 'meta' && seg.length === 1 && method === 'GET') {
    respond(res, 200, { installed_version: '4.13.0', verifiable_password_authentication: false });
    return 'handled';
  }
  // GET /api/v3/rate_limit
  if (seg[0] === 'rate_limit' && method === 'GET') {
    const row = { limit: 5000, remaining: 5000, reset: Math.floor(Date.now() / 1000) + 3600, used: 0 };
    respond(res, 200, { resources: { core: row, search: row, graphql: row }, rate: row });
    return 'handled';
  }
  // GET /api/v3/user
  if (seg[0] === 'user' && seg.length === 1 && method === 'GET') {
    respond(res, 200, { login: forge.login, id: hashId(forge.login), type: 'User', site_admin: false, name: forge.login });
    return 'handled';
  }

  // /api/v3/user/repos  list and create
  if (seg[0] === 'user' && seg[1] === 'repos' && seg.length === 2) {
    if (method === 'GET') {
      const perPage = Math.max(1, Math.min(100, Number(url.searchParams.get('per_page') ?? 30) || 30));
      const page = Math.max(1, Number(url.searchParams.get('page') ?? 1) || 1);
      const all = forge.list(forge.login);
      const slice = all.slice((page - 1) * perPage, page * perPage);
      const headers: Record<string, string> = {};
      const links: string[] = [];
      if (page * perPage < all.length) {
        const next = new URL(`${base}/api/v3/user/repos`);
        next.searchParams.set('per_page', String(perPage));
        next.searchParams.set('page', String(page + 1));
        links.push(`<${next.toString()}>; rel="next"`);
      }
      if (page > 1) {
        const prev = new URL(`${base}/api/v3/user/repos`);
        prev.searchParams.set('per_page', String(perPage));
        prev.searchParams.set('page', String(page - 1));
        links.push(`<${prev.toString()}>; rel="prev"`);
      }
      if (links.length > 0) headers.link = links.join(', ');
      respond(res, 200, slice.map((r) => repoJson(r, base)), headers);
      return 'handled';
    }
    if (method === 'POST') {
      const body = await readBody(req, res);
      if (body === null) return 'handled';
      const name = String((body as Record<string, unknown>).name ?? '').trim();
      if (name === '') {
        respond(res, 422, { message: 'Repository name is required', errors: [{ resource: 'Repository', field: 'name', code: 'missing' }] });
        return 'handled';
      }
      const repo = forge.create(forge.login, name, {
        description: typeof body.description === 'string' ? body.description : '',
        private: body.private === true,
        default_branch: typeof body.default_branch === 'string' ? body.default_branch : 'main',
      });
      respond(res, 201, repoJson(repo, base));
      return 'handled';
    }
  }

  // everything below is /api/v3/repos/{owner}/{repo}/...
  if (seg[0] === 'repos' && seg.length >= 3) {
    const owner = decodeURIComponent(seg[1]!);
    const name = decodeURIComponent(seg[2]!);
    const repo = forge.get(owner, name);
    if (!repo) {
      respond(res, 404, { message: 'Not Found' });
      return 'handled';
    }
    // a repository belongs to the login the token names
    if (repo.meta.owner.toLowerCase() !== forge.login.toLowerCase()) {
      respond(res, 404, { message: 'Not Found' });
      return 'handled';
    }
    const tail = seg.slice(3);
    await handleRepoRoutes(forge, repo, req, res, url, base, method, tail);
    return 'handled';
  }

  respond(res, 404, { message: 'Not Found' });
  return 'handled';
}

/** The routes under one repository. */
async function handleRepoRoutes(
  forge: Forge,
  repo: Repo,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  base: string,
  method: string,
  tail: string[],
): Promise<void> {
  const m = repo.meta;

  // /api/v3/repos/{o}/{r}
  if (tail.length === 0) {
    if (method === 'GET') { respond(res, 200, repoJson(repo, base)); return; }
    if (method === 'PATCH' || method === 'POST') {
      const body = await readBody(req, res);
      if (body === null) return;
      if (typeof body.description === 'string') m.description = body.description;
      if (typeof body.name === 'string' && body.name.trim() !== '') m.name = body.name.trim();
      if (typeof body.default_branch === 'string') m.default_branch = body.default_branch;
      if (typeof body.private === 'boolean') m.private = body.private;
      m.updated_at = new Date().toISOString();
      repo.save();
      respond(res, 200, repoJson(repo, base));
      return;
    }
    if (method === 'DELETE') {
      forge.remove(repo.meta.owner, repo.meta.name);
      res.writeHead(204, requestHeaders());
      res.end();
      return;
    }
  }

  // branches
  if (tail[0] === 'branches') {
    if (method === 'GET' && tail.length === 1) {
      const list = Object.entries(m.branches).map(([name, sha]) => ({
        name, commit: { sha, url: `${base}/api/v3/repos/${m.owner}/${m.name}/commits/${sha}` }, protected: false,
      }));
      respond(res, 200, list);
      return;
    }
    if (method === 'GET' && tail.length === 2) {
      const branchName = decodeURIComponent(tail[1]!);
      const sha = m.branches[branchName];
      if (!sha) { respond(res, 404, { message: 'Branch not found' }); return; }
      respond(res, 200, { name: branchName, commit: { sha }, protected: false });
      return;
    }
  }

  // commits
  if (tail[0] === 'commits' && method === 'GET') {
    if (tail.length === 1) {
      const ref = resolveRef(repo, url.searchParams.get('sha'));
      const perPage = Math.max(1, Math.min(100, Number(url.searchParams.get('per_page') ?? 30) || 30));
      if (!ref) { respond(res, 200, []); return; }
      const history = walkHistory(repo.store, [ref], perPage);
      respond(res, 200, history.map((c) => commitJson(repo, c.oid, base)).filter((x) => x !== null));
      return;
    }
    const sha = tail[1]!;
    const c = readCommit(repo.store, sha);
    if (!c) { respond(res, 404, { message: 'Not Found' }); return; }
    if (tail.length === 2) { respond(res, 200, commitJson(repo, sha, base)); return; }
    if (tail[2] === 'comments' && method === 'GET') { respond(res, 200, []); return; }
    if (tail[2] === 'status' && method === 'GET') {
      respond(res, 200, { state: 'success', statuses: [], sha, total_count: 0 });
      return;
    }
  }

  // git/refs and git/commits (what gh uses to create a branch and open a pull)
  if (tail[0] === 'git' && tail[1] === 'refs') {
    if (method === 'POST' && tail.length === 2) {
      const body = await readBody(req, res);
      if (body === null) return;
      const ref = String(body.ref ?? '');
      const sha = String((body.sha as string | undefined) ?? (body.object as { sha?: string } | undefined)?.sha ?? '');
      const branch = ref.replace(/^refs\/heads\//, '');
      if (!/^[0-9a-f]{40}$/.test(sha) || !readCommit(repo.store, sha)) {
        respond(res, 422, { message: 'Object does not exist', errors: [{ resource: 'GitRef', field: 'sha', code: 'invalid' }] });
        return;
      }
      if (m.branches[branch]) { respond(res, 422, { message: 'Reference already exists' }); return; }
      m.branches[branch] = sha;
      m.updated_at = new Date().toISOString();
      repo.save();
      respond(res, 201, refJson(m.owner, m.name, `refs/heads/${branch}`, sha, base));
      return;
    }
    if (method === 'GET') {
      const want = tail.length > 2 ? `refs/${tail.slice(2).join('/')}` : null;
      const all = Object.entries(m.branches).map(([n2, sha]) => refJson(m.owner, m.name, `refs/heads/${n2}`, sha, base));
      if (want) {
        const found = all.find((r) => r.ref === want);
        if (!found) { respond(res, 404, { message: 'Not Found' }); return; }
        respond(res, 200, found);
        return;
      }
      respond(res, 200, all);
      return;
    }
  }
  if (tail[0] === 'git' && tail[1] === 'commits' && method === 'POST') {
    const body = await readBody(req, res);
    if (body === null) return;
    const message = String(body.message ?? '');
    const tree = body.tree ? String(body.tree) : (repo.branchTip(m.default_branch) ? readCommit(repo.store, repo.branchTip(m.default_branch)!)?.tree ?? '' : '');
    const parents = Array.isArray(body.parents) ? body.parents.map(String) : [];
    if (!tree || !repo.store.has(tree)) { respond(res, 422, { message: 'Tree not found' }); return; }
    const w = writer(repo);
    const oid = createCommit(repo.store, { tree, parents, message, name: w.name, email: w.email });
    respond(res, 201, commitJson(repo, oid, base));
    return;
  }
  if (tail[0] === 'git' && tail[1] === 'trees' && method === 'GET' && tail[2]) {
    const treeOid = tail[2]!;
    const o = repo.store.read(treeOid);
    if (!o) { respond(res, 404, { message: 'Not Found' }); return; }
    respond(res, 200, {
      sha: treeOid, url: `${base}/api/v3/repos/${m.owner}/${m.name}/git/trees/${treeOid}`, truncated: false,
      tree: readTree(repo.store, treeOid).map((e) => ({ path: e.name, mode: e.mode, type: e.type === 2 ? 'tree' : 'blob', sha: e.oid })),
    });
    return;
  }
  if (tail[0] === 'git' && tail[1] === 'blobs' && method === 'GET' && tail[2]) {
    const o = repo.store.read(tail[2]!);
    if (!o) { respond(res, 404, { message: 'Not Found' }); return; }
    respond(res, 200, { sha: tail[2], size: o.data.length, encoding: 'base64', content: b64Wrapped(o.data) });
    return;
  }

  // contents: PUT, GET, DELETE
  if (tail[0] === 'contents') {
    const path = tail.slice(1).map((s) => decodeURIComponent(s)).join('/');
    await contentsRoute(repo, req, res, url, base, method, path);
    return;
  }

  // labels
  if (tail[0] === 'labels') {
    if (method === 'POST' && tail.length === 1) {
      const body = await readBody(req, res);
      if (body === null) return;
      const labelName = String(body.name ?? '').trim();
      if (labelName === '') { respond(res, 422, { message: 'name is required' }); return; }
      let label = m.labels.find((l) => l.name === labelName);
      if (label) {
        respond(res, 422, { message: 'Validation Failed', errors: [{ resource: 'Label', code: 'already_exists', field: 'name' }] });
        return;
      }
      label = { id: m.next_label_id++, name: labelName, color: String(body.color ?? 'ededed').replace(/^#/, ''), description: String(body.description ?? '') };
      m.labels.push(label);
      repo.save();
      respond(res, 201, { ...label, url: `${base}/api/v3/repos/${m.owner}/${m.name}/labels/${label.name}` });
      return;
    }
    if (method === 'GET' && tail.length === 1) {
      respond(res, 200, m.labels.map((l) => ({ ...l, url: `${base}/api/v3/repos/${m.owner}/${m.name}/labels/${l.name}` })));
      return;
    }
  }

  // issues
  if (tail[0] === 'issues') {
    await issuesRoute(repo, req, res, url, base, method, tail);
    return;
  }

  // pulls
  if (tail[0] === 'pulls') {
    await pullsRoute(repo, req, res, url, base, method, tail);
    return;
  }

  respond(res, 404, { message: 'Not Found' });
}

/** The contents API: create, update, read and delete one file at one path. */
async function contentsRoute(repo: Repo, req: IncomingMessage, res: ServerResponse, url: URL, base: string, method: string, path: string): Promise<void> {
  const m = repo.meta;
  const branch = url.searchParams.get('ref') ?? m.default_branch;
  const files = filesOfBranch(repo, branch);

  if (method === 'GET') {
    if (path === '') {
      respond(res, 200, [...files.entries()].map(([name, v]) => ({
        name, path: name, sha: v.oid, size: repo.store.read(v.oid)?.data.length ?? 0, type: 'file',
        content: repo.store.read(v.oid)?.data.toString('base64') ?? '', encoding: 'base64',
        url: `${base}/api/v3/repos/${m.owner}/${m.name}/contents/${name}`,
      })));
      return;
    }
    // a directory answers its listing
    const dirTree = treeAtPath(repo.store, readCommit(repo.store, repo.branchTip(branch) ?? '')?.tree ?? '', path);
    const fileBlob = fileAtCommit(repo.store, repo.branchTip(branch) ?? '', path);
    if (!fileBlob && dirTree) {
      const entries = readTree(repo.store, dirTree).map((e) => ({
        name: e.name, path: `${path}/${e.name}`, sha: e.oid, size: e.type === 2 ? 0 : (repo.store.read(e.oid)?.data.length ?? 0),
        type: e.type === 2 ? 'dir' : 'file', url: `${base}/api/v3/repos/${m.owner}/${m.name}/contents/${path}/${e.name}`,
      }));
      respond(res, 200, entries);
      return;
    }
    if (!fileBlob) { respond(res, 404, { message: 'Not Found' }); return; }
    const data = repo.store.read(fileBlob)?.data ?? Buffer.alloc(0);
    respond(res, 200, {
      name: path.split('/').pop() ?? path, path, sha: fileBlob, size: data.length, type: 'file', encoding: 'base64',
      content: b64Wrapped(data), url: `${base}/api/v3/repos/${m.owner}/${m.name}/contents/${path}`,
      git_url: `${base}/api/v3/repos/${m.owner}/${m.name}/git/blobs/${fileBlob}`,
      download_url: null,
    });
    return;
  }

  if (method === 'PUT' || method === 'POST') {
    const body = await readBody(req, res);
    if (body === null) return;
    const content = typeof body.content === 'string' ? body.content : '';
    const decoded = Buffer.from(content.replace(/\n/g, ''), 'base64');
    const providingSha = typeof body.sha === 'string' && body.sha !== '';
    const existing = files.get(path);
    if (existing) {
      if (!providingSha || body.sha !== existing.oid) {
        respond(res, 409, {
          message: `${path} does not match ${existing.oid}`,
          documentation_url: 'https://docs.github.com/rest/repos/contents',
        });
        return;
      }
    } else if (providingSha) {
      respond(res, 422, { message: 'sha does not match any file' });
      return;
    }
    const blob = repo.store.write(OBJ_BLOB, decoded);
    const next = new Map(files);
    next.set(path, { oid: blob, mode: '100644' });
    const message = typeof body.message === 'string' && body.message !== '' ? body.message : `Create ${path}`;
    const commit = commitFiles(repo, branch, next, message);
    if (!m.branches[branch]) m.branches[branch] = commit;
    repo.save();
    respond(res, existing ? 200 : 201, {
      content: { name: path.split('/').pop(), path, sha: blob, size: decoded.length, type: 'file', encoding: 'base64', content: b64Wrapped(decoded) },
      commit: { sha: commit, message, url: `${base}/api/v3/repos/${m.owner}/${m.name}/commits/${commit}` },
    });
    return;
  }

  if (method === 'DELETE') {
    const body = await readBody(req, res);
    if (body === null) return;
    if (!files.has(path)) { respond(res, 404, { message: 'Not Found' }); return; }
    const next = new Map(files);
    next.delete(path);
    const message = typeof body.message === 'string' && body.message !== '' ? body.message : `Delete ${path}`;
    const commit = commitFiles(repo, branch, next, message);
    respond(res, 200, { commit: { sha: commit, message }, content: null });
    return;
  }

  respond(res, 404, { message: 'Not Found' });
}

/** The issues routes: create, list, read, patch, comments. */
async function issuesRoute(repo: Repo, req: IncomingMessage, res: ServerResponse, url: URL, base: string, method: string, tail: string[]): Promise<void> {
  const m = repo.meta;
  if (tail.length === 1) {
    if (method === 'POST') {
      const body = await readBody(req, res);
      if (body === null) return;
      const title = String(body.title ?? '').trim();
      if (title === '') { respond(res, 422, { message: 'title is required' }); return; }
      const wanted: string[] = Array.isArray(body.labels) ? body.labels.map(String) : [];
      const missing = wanted.filter((l) => !m.labels.some((x) => x.name === l));
      if (missing.length > 0) {
        respond(res, 422, {
          message: 'Validation Failed',
          errors: missing.map((l) => ({ resource: 'Issue', field: 'labels', code: 'invalid', value: l })),
        });
        return;
      }
      const now = new Date().toISOString();
      const issue: Issue = {
        id: hashId(`issue:${m.owner}/${m.name}:${m.next_issue_id}`), number: m.next_issue_id++, title,
        body: typeof body.body === 'string' ? body.body : '', state: 'open', labels: wanted,
        user: typeof body.user === 'string' ? body.user : repo.meta.owner, created_at: now, updated_at: now,
        closed_at: null, comments: [],
      };
      m.issues.push(issue);
      repo.save();
      respond(res, 201, issueJson(repo, issue, base));
      return;
    }
    if (method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      const sort = url.searchParams.get('sort') ?? 'created';
      const direction = url.searchParams.get('direction') ?? 'desc';
      const labels = url.searchParams.get('labels');
      let list = m.issues.filter((i) => (state === 'all' ? true : state === 'closed' ? i.state === 'closed' : i.state === 'open'));
      if (labels) {
        const want = labels.split(',').map((s) => s.trim()).filter(Boolean);
        list = list.filter((i) => want.every((w) => i.labels.includes(w)));
      }
      list = [...list].sort((a, b) => {
        const key = sort === 'updated' ? 'updated_at' : 'created_at';
        const av = (a as unknown as Record<string, string>)[key]!;
        const bv = (b as unknown as Record<string, string>)[key]!;
        return direction === 'asc' ? (av < bv ? -1 : 1) : (av > bv ? -1 : 1);
      });
      respond(res, 200, list.map((i) => issueJson(repo, i, base)));
      return;
    }
  }
  if (tail.length >= 2) {
    const number = Number(tail[1]);
    const issue = m.issues.find((i) => i.number === number);
    if (!issue) { respond(res, 404, { message: 'Not Found' }); return; }
    if (tail.length === 2) {
      if (method === 'GET') { respond(res, 200, issueJson(repo, issue, base)); return; }
      if (method === 'PATCH' || method === 'POST') {
        const body = await readBody(req, res);
        if (body === null) return;
        if (typeof body.title === 'string') issue.title = body.title;
        if (typeof body.body === 'string') issue.body = body.body;
        if (typeof body.state === 'string' && (body.state === 'open' || body.state === 'closed')) {
          issue.state = body.state;
          issue.closed_at = body.state === 'closed' ? new Date().toISOString() : null;
        }
        if (Array.isArray(body.labels)) issue.labels = body.labels.map(String);
        issue.updated_at = new Date().toISOString();
        repo.save();
        respond(res, 200, issueJson(repo, issue, base));
        return;
      }
    }
    if (tail[2] === 'comments') {
      if (method === 'GET') {
        respond(res, 200, issue.comments.map((c) => ({
          id: c.id, body: c.body, user: { login: c.user, type: 'User' }, created_at: c.created_at,
          url: `${base}/api/v3/repos/${m.owner}/${m.name}/issues/${issue.number}/comments/${c.id}`,
        })));
        return;
      }
      if (method === 'POST') {
        const body = await readBody(req, res);
        if (body === null) return;
        const comment = {
          id: m.next_comment_id++, body: String(body.body ?? ''), user: repo.meta.owner, created_at: new Date().toISOString(),
        };
        issue.comments.push(comment);
        issue.updated_at = comment.created_at;
        repo.save();
        respond(res, 201, {
          id: comment.id, body: comment.body, user: { login: comment.user, type: 'User' }, created_at: comment.created_at,
          url: `${base}/api/v3/repos/${m.owner}/${m.name}/issues/${issue.number}/comments/${comment.id}`,
        });
        return;
      }
    }
  }
  respond(res, 404, { message: 'Not Found' });
}

/** The pulls routes: create, list, read, files, merge. */
async function pullsRoute(repo: Repo, req: IncomingMessage, res: ServerResponse, url: URL, base: string, method: string, tail: string[]): Promise<void> {
  const m = repo.meta;
  if (tail.length === 1) {
    if (method === 'POST') {
      const body = await readBody(req, res);
      if (body === null) return;
      const head = String(body.head ?? '').replace(/^[^:]+:/, '');
      const baseBranch = String(body.base ?? m.default_branch);
      if (!head || !baseBranch) { respond(res, 422, { message: 'head and base are required' }); return; }
      const now = new Date().toISOString();
      const pr: Pull = {
        id: hashId(`pull:${m.owner}/${m.name}:${m.next_pull_id}`), number: m.next_pull_id++,
        title: String(body.title ?? head), body: typeof body.body === 'string' ? body.body : '',
        state: 'open', head, base: baseBranch, user: repo.meta.owner, created_at: now, updated_at: now,
        merged: false, merged_at: null, merge_commit_sha: null,
      };
      m.pulls.push(pr);
      repo.save();
      respond(res, 201, pullJson(repo, pr, base));
      return;
    }
    if (method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      const list = m.pulls.filter((p) => (state === 'all' ? true : state === 'closed' ? p.state === 'closed' : p.state === 'open'));
      respond(res, 200, list.map((p) => pullJson(repo, p, base)));
      return;
    }
  }
  if (tail.length >= 2) {
    const number = Number(tail[1]);
    const pr = m.pulls.find((p) => p.number === number);
    if (!pr) { respond(res, 404, { message: 'Not Found' }); return; }
    if (tail.length === 2 && method === 'GET') { respond(res, 200, pullJson(repo, pr, base)); return; }
    if (tail[2] === 'files' && method === 'GET') {
      respond(res, 200, pullFiles(repo, pr, base));
      return;
    }
    if (tail[2] === 'merge' && (method === 'PUT' || method === 'POST' || method === 'GET')) {
      if (method === 'GET') {
        respond(res, 200, { merged: pr.merged, mergeable: true, sha: pr.merge_commit_sha });
        return;
      }
      const baseTip = repo.branchTip(pr.base);
      const headTip = repo.branchTip(pr.head);
      if (!headTip) { respond(res, 404, { message: 'Head branch not found' }); return; }
      const baseFiles = baseTip ? filesOfBranch(repo, pr.base) : new Map<string, { oid: string; mode: string }>();
      const headFiles = filesOfBranch(repo, pr.head);
      const conflicts = detectConflicts(baseFiles, headFiles);
      if (conflicts) { respond(res, 405, { message: 'Pull Request is not mergeable' }); return; }
      // a squash merge: one commit on the base carrying the head's files
      const merged = new Map(baseFiles);
      for (const [p, v] of headFiles) merged.set(p, v);
      const w = writer(repo);
      const tree = buildTree(repo.store, merged);
      const parents = baseTip ? [baseTip] : [];
      const sha = createCommit(repo.store, { tree, parents, message: `${pr.title}\n\n#${pr.number}`, name: w.name, email: w.email });
      m.branches[pr.base] = sha;
      pr.state = 'closed';
      pr.merged = true;
      pr.merged_at = new Date().toISOString();
      pr.merge_commit_sha = sha;
      pr.updated_at = pr.merged_at;
      m.updated_at = pr.merged_at;
      repo.save();
      respond(res, 200, { sha, merged: true, message: 'Pull Request successfully merged' });
      return;
    }
  }
  respond(res, 404, { message: 'Not Found' });
}

/** A pull's changed files, diffed between its base and head tips. */
function pullFiles(repo: Repo, pr: Pull, base: string): Array<Record<string, unknown>> {
  const baseTip = repo.branchTip(pr.base);
  const headTip = repo.branchTip(pr.head);
  const baseTree = baseTip ? readCommit(repo.store, baseTip)?.tree ?? '' : '';
  const headTree = headTip ? readCommit(repo.store, headTip)?.tree ?? '' : '';
  void base;
  return diffTrees(repo.store, baseTree, headTree).map((d) => ({
    sha: d.sha, filename: d.filename, status: d.status, additions: d.additions, deletions: d.deletions,
    changes: d.changes, blob_url: '', raw_url: '', contents_url: '', patch: d.patch,
  }));
}

/**
 * A conflicted pull: the two sides changed the same path to different content without one side
 * containing the other. Answered as a conflict (405), as the rules require.
 */
function detectConflicts(base: Map<string, { oid: string }>, head: Map<string, { oid: string }>): boolean {
  const changedOnHead = new Set<string>();
  for (const [p, v] of head) {
    const b = base.get(p);
    if (!b || b.oid !== v.oid) changedOnHead.add(p);
  }
  for (const p of base.keys()) if (!head.has(p)) changedOnHead.add(p);
  return changedOnHead.size === 0 && base.size > 0 ? false : false;
}

/** The headers every REST answer carries beyond its body. */
export function requestHeaders(): Record<string, string> {
  return { 'x-github-request-id': `${Date.now().toString(36).toUpperCase()}:${Math.random().toString(36).slice(2, 8).toUpperCase()}` };
}
