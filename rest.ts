// rest.ts: the GitHub REST v3 surface: /api/v3 root and meta, repositories, contents, branches,
// commits, issues, labels, pull requests, and the refs/commits routes gh uses to open one.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { OBJ_BLOB, OBJ_TREE } from './git/objects.ts';
import {
  buildTree,
  createCommit,
  diffTrees,
  fileAtCommit,
  flattenTree,
  readCommit,
  readTree,
  treeAtPath,
  walkHistory,
} from './git/model.ts';
import type { Forge, Issue, Pull, Repo } from './store.ts';
import { readBody, respond, respondText } from './http.ts';

/**
 * Serialized single-issue bodies, keyed by the repository revision and the issue number. A read loop
 * over one issue then pays JSON.stringify once; any save bumps `rev` and the old entries go stale.
 */
const issueBodyCache = new Map<string, string>();
const ISSUE_BODY_CACHE_MAX = 512;

/** The JSON text of one issue, newline-terminated as respond() writes it. */
function issueBody(repo: Repo, issue: Issue, base: string): string {
  const key = `${repo.meta.owner}/${repo.meta.name}#${repo.rev}#${issue.number}`;
  const hit = issueBodyCache.get(key);
  if (hit !== undefined) return hit;
  const text = `${JSON.stringify(issueJson(repo, issue, base))}\n`;
  issueBodyCache.set(key, text);
  if (issueBodyCache.size > ISSUE_BODY_CACHE_MAX) {
    const oldest = issueBodyCache.keys().next();
    if (oldest.done !== true) issueBodyCache.delete(oldest.value);
  }
  return text;
}
import { mergeViaMcp, MergeConflictError } from './merge.ts';

/** One route's answer: `handled` once this module wrote one, `unmatched` when the path is not ours. */
export type RestOutcome = 'handled' | 'unmatched';

/** The all-zero id, as a git ref names an absent object. */
const ZERO = '0'.repeat(40);

/** A stable small integer for an id string (GitHub ids are integers). */
export function hashId(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h) || 1;
}

/** The base64 form GitHub wraps: 60 characters a line. */
function b64Wrapped(data: Buffer): string {
  const raw = data.toString('base64');
  const out: string[] = [];
  for (let i = 0; i < raw.length; i += 60) out.push(raw.slice(i, i + 60));
  return out.join('\n');
}

/** The node_id GitHub reports: a base64 of "<type>:<id>". */
function nodeId(kind: string, id: string): string {
  return Buffer.from(`${kind}:${id}`).toString('base64');
}

/** The JSON a repository is reported as. */
export function repoJson(repo: Repo, base: string): Record<string, unknown> {
  const m = repo.meta;
  return {
    id: hashId(`${m.owner}/${m.name}`),
    node_id: nodeId('repo', `${m.owner}/${m.name}`),
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

/** The JSON an issue is reported as. */
export function issueJson(repo: Repo, issue: Issue, base: string): Record<string, unknown> {
  const m = repo.meta;
  return {
    id: issue.id,
    node_id: nodeId('issue', String(issue.id)),
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
    url: `${base}/api/v3/repos/${m.owner}/${m.name}/issues/${issue.number}`,
    repository_url: `${base}/api/v3/repos/${m.owner}/${m.name}`,
    html_url: `${base}/${m.owner}/${m.name}/issues/${issue.number}`,
  };
}

/** The JSON a pull request is reported as. */
export function pullJson(repo: Repo, pr: Pull, base: string): Record<string, unknown> {
  const m = repo.meta;
  return {
    id: pr.id,
    node_id: nodeId('pull', String(pr.id)),
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
    node_id: nodeId('ref', ref),
    url: `${base}/api/v3/repos/${owner}/${name}/git/refs/${ref.replace(/^refs\//, '')}`,
    object: {
      type: 'commit',
      sha: oid,
      url: `${base}/api/v3/repos/${owner}/${name}/git/commits/${oid}`,
    },
  };
}

/** The JSON a commit is reported as. */
function commitJson(repo: Repo, oid: string, base: string): Record<string, unknown> | null {
  const c = readCommit(repo.store, oid);
  if (!c) return null;
  const m = repo.meta;
  const repoUrl = `${base}/api/v3/repos/${m.owner}/${m.name}`;
  return {
    sha: oid,
    node_id: nodeId('commit', oid),
    url: `${repoUrl}/commits/${oid}`,
    html_url: `${base}/${m.owner}/${m.name}/commit/${oid}`,
    commit: {
      author: {
        name: c.author.name,
        email: c.author.email,
        date: new Date(c.author.date * 1000).toISOString(),
      },
      committer: {
        name: c.committer.name,
        email: c.committer.email,
        date: new Date(c.committer.date * 1000).toISOString(),
      },
      message: c.message.replace(/\n$/, ''),
      tree: { sha: c.tree, url: `${repoUrl}/git/trees/${c.tree}` },
      comment_count: 0,
    },
    author: { login: c.author.name, id: hashId(c.author.name), type: 'User' },
    committer: { login: c.committer.name, id: hashId(c.committer.name), type: 'User' },
    parents: c.parents.map((p) => ({ sha: p, url: `${repoUrl}/commits/${p}` })),
  };
}

/** The commit identity an API write commits as: the repository's owner. */
function writer(repo: Repo): { name: string; email: string } {
  return { name: repo.meta.owner, email: `${repo.meta.owner}@users.noreply.github.com` };
}

/** The files of a branch, or an empty map for an unborn one. */
function filesOfBranch(repo: Repo, branch: string): Map<string, { oid: string; mode: string }> {
  const tip = repo.branchTip(branch);
  if (!tip) return new Map();
  const c = readCommit(repo.store, tip);
  if (!c) return new Map();
  return flattenTree(repo.store, c.tree);
}

/** The tree id of a branch's tip, or '' for an unborn one. */
function treeOfBranch(repo: Repo, branch: string): string {
  const tip = repo.branchTip(branch);
  if (!tip) return '';
  return readCommit(repo.store, tip)?.tree ?? '';
}

/** Advance a branch by one new commit over `files`, answering the commit id. */
function commitFiles(
  repo: Repo,
  branch: string,
  files: Map<string, { oid: string; mode: string }>,
  message: string,
  parents?: string[],
): string {
  const tree = buildTree(repo.store, files);
  const tip = repo.branchTip(branch);
  const parentOids = parents ?? (tip ? [tip] : []);
  const w = writer(repo);
  const oid = createCommit(repo.store, { tree, parents: parentOids, message, name: w.name, email: w.email });
  repo.meta.branches[branch] = oid;
  repo.meta.updated_at = new Date().toISOString();
  repo.save();
  return oid;
}

/** Resolve a ref name (branch, or a full sha) to a commit id, or null. */
function resolveRef(repo: Repo, ref: string | null): string | null {
  if (!ref) return repo.branchTip(repo.meta.default_branch);
  const byName = repo.meta.branches[ref];
  if (byName) return byName;
  if (/^[0-9a-f]{40}$/.test(ref) && readCommit(repo.store, ref)) return ref;
  return null;
}

/** The paging slice a list route answers, and the Link header that follows it. */
function paginate<T>(items: T[], url: URL, base: string): { slice: T[]; headers: Record<string, string> } {
  const perPage = Math.max(1, Math.min(100, Number(url.searchParams.get('per_page') ?? 30) || 30));
  const page = Math.max(1, Number(url.searchParams.get('page') ?? 1) || 1);
  const slice = items.slice((page - 1) * perPage, page * perPage);
  const links: string[] = [];

  const link = (target: number, rel: string): void => {
    const next = new URL(url.pathname, base);
    next.searchParams.set('per_page', String(perPage));
    next.searchParams.set('page', String(target));
    for (const [k, v] of url.searchParams) if (k !== 'per_page' && k !== 'page') next.searchParams.set(k, v);
    links.push(`<${next.toString()}>; rel="${rel}"`);
  };

  if (page * perPage < items.length) link(page + 1, 'next');
  if (page > 1) link(page - 1, 'prev');

  return { slice, headers: links.length > 0 ? { link: links.join(', ') } : {} };
}

/** Answer 204 with the request-id header and no body. */
function noContent(res: ServerResponse): void {
  res.writeHead(204, requestHeaders());
  res.end();
}

/** The headers every REST answer carries beyond its body. */
export function requestHeaders(): Record<string, string> {
  const seq = Math.floor(Math.random() * 1e6).toString(36).toUpperCase();
  return { 'x-github-request-id': `${Date.now().toString(36).toUpperCase()}:${seq}` };
}

/** Handle every /api/v3 route. */
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

  // the API root, naming the URLs every client tries first
  if (rest === '/' && method === 'GET') {
    respond(
      res,
      200,
      {
        current_user_url: `${base}/api/v3/user`,
        current_user_repositories_url: `${base}/api/v3/user/repos`,
        rate_limit_url: `${base}/api/v3/rate_limit`,
        repository_url: `${base}/api/v3/repos/{owner}/{repo}`,
        user_url: `${base}/api/v3/users/{user}`,
      },
      { 'x-oauth-scopes': 'repo, read:org' },
    );
    return 'handled';
  }

  if (seg[0] === 'meta' && seg.length === 1 && method === 'GET') {
    respond(res, 200, { installed_version: '4.13.0', verifiable_password_authentication: false });
    return 'handled';
  }

  if (seg[0] === 'rate_limit' && method === 'GET') {
    const row = { limit: 5000, remaining: 5000, reset: Math.floor(Date.now() / 1000) + 3600, used: 0 };
    respond(res, 200, { resources: { core: row, search: row, graphql: row }, rate: row });
    return 'handled';
  }

  if (seg[0] === 'user' && seg.length === 1 && method === 'GET') {
    respond(res, 200, {
      login: forge.login,
      id: hashId(forge.login),
      type: 'User',
      site_admin: false,
      name: forge.login,
    });
    return 'handled';
  }

  // the token's own repositories
  if (seg[0] === 'user' && seg[1] === 'repos' && seg.length === 2) {
    if (method === 'GET') {
      const { slice, headers } = paginate(forge.list(forge.login), url, base);
      respond(res, 200, slice.map((r) => repoJson(r, base)), headers);
      return 'handled';
    }
    if (method === 'POST') {
      const body = await readBody(req, res);
      if (body === null) return 'handled';
      const name = String(body.name ?? '').trim();
      if (name === '') {
        respond(res, 422, {
          message: 'Repository name is required',
          errors: [{ resource: 'Repository', field: 'name', code: 'missing' }],
        });
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

  // everything below names one repository
  if (seg[0] === 'repos' && seg.length >= 3) {
    const owner = decodeURIComponent(seg[1]!);
    const name = decodeURIComponent(seg[2]!);
    const repo = forge.get(owner, name);
    // a repository belongs to the login the token names, and anything else is simply not found
    if (!repo || repo.meta.owner.toLowerCase() !== forge.login.toLowerCase()) {
      respond(res, 404, { message: 'Not Found' });
      return 'handled';
    }
    await repoRoutes(forge, repo, req, res, url, base, method, seg.slice(3));
    return 'handled';
  }

  respond(res, 404, { message: 'Not Found' });
  return 'handled';
}

/** The routes under one repository. */
async function repoRoutes(
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

  // the repository itself
  if (tail.length === 0) {
    if (method === 'GET') {
      respond(res, 200, repoJson(repo, base));
      return;
    }
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
      forge.remove(m.owner, m.name);
      noContent(res);
      return;
    }
  }

  if (tail[0] === 'branches') {
    await branchesRoute(repo, res, base, method, tail);
    return;
  }

  if (tail[0] === 'commits') {
    await commitsRoute(repo, res, url, base, method, tail);
    return;
  }

  if (tail[0] === 'git') {
    await gitRoutes(repo, req, res, base, method, tail);
    return;
  }

  if (tail[0] === 'contents') {
    const path = tail.slice(1).map((s) => decodeURIComponent(s)).join('/');
    await contentsRoute(repo, req, res, url, base, method, path);
    return;
  }

  if (tail[0] === 'labels') {
    await labelsRoute(repo, req, res, base, method, tail);
    return;
  }

  if (tail[0] === 'issues') {
    await issuesRoute(repo, req, res, url, base, method, tail);
    return;
  }

  if (tail[0] === 'pulls') {
    await pullsRoute(repo, req, res, url, base, method, tail);
    return;
  }

  respond(res, 404, { message: 'Not Found' });
}

/** The branches routes: list and read one. */
async function branchesRoute(repo: Repo, res: ServerResponse, base: string, method: string, tail: string[]): Promise<void> {
  const m = repo.meta;
  if (method === 'GET' && tail.length === 1) {
    respond(
      res,
      200,
      Object.entries(m.branches).map(([name, sha]) => ({
        name,
        commit: { sha, url: `${base}/api/v3/repos/${m.owner}/${m.name}/commits/${sha}` },
        protected: false,
      })),
    );
    return;
  }
  if (method === 'GET' && tail.length === 2) {
    const branchName = decodeURIComponent(tail[1]!);
    const sha = m.branches[branchName];
    if (!sha) {
      respond(res, 404, { message: 'Branch not found' });
      return;
    }
    respond(res, 200, { name: branchName, commit: { sha }, protected: false });
    return;
  }
  respond(res, 404, { message: 'Not Found' });
}

/** The commits routes: history, one commit, its comments and status. */
async function commitsRoute(repo: Repo, res: ServerResponse, url: URL, base: string, method: string, tail: string[]): Promise<void> {
  if (method !== 'GET') {
    respond(res, 404, { message: 'Not Found' });
    return;
  }

  if (tail.length === 1) {
    const ref = resolveRef(repo, url.searchParams.get('sha'));
    if (!ref) {
      respond(res, 200, []);
      return;
    }
    const perPage = Math.max(1, Math.min(100, Number(url.searchParams.get('per_page') ?? 30) || 30));
    const history = walkHistory(repo.store, [ref], perPage);
    respond(res, 200, history.map((c) => commitJson(repo, c.oid, base)).filter((x) => x !== null));
    return;
  }

  const sha = tail[1]!;
  if (!readCommit(repo.store, sha)) {
    respond(res, 404, { message: 'Not Found' });
    return;
  }
  if (tail.length === 2) {
    respond(res, 200, commitJson(repo, sha, base));
    return;
  }
  if (tail[2] === 'comments') {
    respond(res, 200, []);
    return;
  }
  if (tail[2] === 'status') {
    respond(res, 200, { state: 'success', statuses: [], sha, total_count: 0 });
    return;
  }
  respond(res, 404, { message: 'Not Found' });
}

/** The git object routes gh uses to create a branch, a commit or read a blob. */
async function gitRoutes(repo: Repo, req: IncomingMessage, res: ServerResponse, base: string, method: string, tail: string[]): Promise<void> {
  const m = repo.meta;

  if (tail[1] === 'refs') {
    if (method === 'POST' && tail.length === 2) {
      const body = await readBody(req, res);
      if (body === null) return;
      const ref = String(body.ref ?? '');
      const object = body.object as { sha?: string } | undefined;
      const sha = String(body.sha ?? object?.sha ?? '');
      const branch = ref.replace(/^refs\/heads\//, '');
      if (!/^[0-9a-f]{40}$/.test(sha) || !readCommit(repo.store, sha)) {
        respond(res, 422, {
          message: 'Object does not exist',
          errors: [{ resource: 'GitRef', field: 'sha', code: 'invalid' }],
        });
        return;
      }
      if (m.branches[branch]) {
        respond(res, 422, { message: 'Reference already exists' });
        return;
      }
      m.branches[branch] = sha;
      m.updated_at = new Date().toISOString();
      repo.save();
      respond(res, 201, refJson(m.owner, m.name, `refs/heads/${branch}`, sha, base));
      return;
    }
    if (method === 'GET') {
      const all = Object.entries(m.branches).map(([n, sha]) => refJson(m.owner, m.name, `refs/heads/${n}`, sha, base));
      if (tail.length > 2) {
        const want = `refs/${tail.slice(2).join('/')}`;
        const found = all.find((r) => r.ref === want);
        if (!found) {
          respond(res, 404, { message: 'Not Found' });
          return;
        }
        respond(res, 200, found);
        return;
      }
      respond(res, 200, all);
      return;
    }
  }

  if (tail[1] === 'commits' && method === 'POST') {
    const body = await readBody(req, res);
    if (body === null) return;
    const tip = repo.branchTip(m.default_branch);
    const tree = body.tree ? String(body.tree) : (tip ? (readCommit(repo.store, tip)?.tree ?? '') : '');
    const parents = Array.isArray(body.parents) ? body.parents.map(String) : [];
    if (!tree || !repo.store.has(tree)) {
      respond(res, 422, { message: 'Tree not found' });
      return;
    }
    const w = writer(repo);
    const oid = createCommit(repo.store, { tree, parents, message: String(body.message ?? ''), name: w.name, email: w.email });
    respond(res, 201, commitJson(repo, oid, base));
    return;
  }

  if (tail[1] === 'trees' && method === 'GET' && tail[2]) {
    const treeOid = tail[2];
    if (!repo.store.read(treeOid)) {
      respond(res, 404, { message: 'Not Found' });
      return;
    }
    respond(res, 200, {
      sha: treeOid,
      url: `${base}/api/v3/repos/${m.owner}/${m.name}/git/trees/${treeOid}`,
      truncated: false,
      tree: readTree(repo.store, treeOid).map((e) => ({
        path: e.name,
        mode: e.mode,
        type: e.type === OBJ_TREE ? 'tree' : 'blob',
        sha: e.oid,
      })),
    });
    return;
  }

  if (tail[1] === 'blobs' && method === 'GET' && tail[2]) {
    const o = repo.store.read(tail[2]);
    if (!o) {
      respond(res, 404, { message: 'Not Found' });
      return;
    }
    respond(res, 200, { sha: tail[2], size: o.data.length, encoding: 'base64', content: b64Wrapped(o.data) });
    return;
  }

  respond(res, 404, { message: 'Not Found' });
}

/** One file's JSON at one path. */
function fileJson(repo: Repo, base: string, path: string, oid: string): Record<string, unknown> {
  const m = repo.meta;
  const data = repo.store.read(oid)?.data ?? Buffer.alloc(0);
  return {
    name: path.split('/').pop() ?? path,
    path,
    sha: oid,
    size: data.length,
    type: 'file',
    encoding: 'base64',
    content: b64Wrapped(data),
    url: `${base}/api/v3/repos/${m.owner}/${m.name}/contents/${path}`,
    git_url: `${base}/api/v3/repos/${m.owner}/${m.name}/git/blobs/${oid}`,
    download_url: null,
  };
}

/** The contents API: create, update, read and delete one file at one path. */
async function contentsRoute(
  repo: Repo,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  base: string,
  method: string,
  path: string,
): Promise<void> {
  const m = repo.meta;
  const branch = url.searchParams.get('ref') ?? m.default_branch;
  const files = filesOfBranch(repo, branch);

  if (method === 'GET') {
    if (path === '') {
      respond(
        res,
        200,
        [...files.entries()].map(([name, v]) => fileJson(repo, base, name, v.oid)),
      );
      return;
    }

    const tip = repo.branchTip(branch);
    const blob = tip ? fileAtCommit(repo.store, tip, path) : null;
    if (!blob) {
      // a directory answers a listing of its entries instead
      const dirTree = tip ? treeAtPath(repo.store, treeOfBranch(repo, branch), path) : null;
      if (!dirTree) {
        respond(res, 404, { message: 'Not Found' });
        return;
      }
      respond(
        res,
        200,
        readTree(repo.store, dirTree).map((e) => ({
          name: e.name,
          path: `${path}/${e.name}`,
          sha: e.oid,
          size: e.type === OBJ_TREE ? 0 : (repo.store.read(e.oid)?.data.length ?? 0),
          type: e.type === OBJ_TREE ? 'dir' : 'file',
          url: `${base}/api/v3/repos/${m.owner}/${m.name}/contents/${path}/${e.name}`,
        })),
      );
      return;
    }
    respond(res, 200, fileJson(repo, base, path, blob));
    return;
  }

  // a write names its branch in the body (`branch`), which wins over the ref query; GET uses the query
  const targetOf = (body: Record<string, unknown>): string | null => {
    const asked = typeof body.branch === 'string' && body.branch !== '' ? body.branch : branch;
    return asked === m.default_branch || repo.branchTip(asked) ? asked : null;
  };

  if (method === 'PUT' || method === 'POST') {
    const body = await readBody(req, res);
    if (body === null) return;
    const target = targetOf(body);
    if (target === null) {
      respond(res, 404, { message: `Branch ${String(body.branch)} not found` });
      return;
    }
    const targetFiles = target === branch ? files : filesOfBranch(repo, target);

    const decoded = Buffer.from(String(body.content ?? '').replace(/\n/g, ''), 'base64');
    const givenSha = typeof body.sha === 'string' && body.sha !== '' ? body.sha : null;
    const existing = targetFiles.get(path);

    // an update must name the sha it replaces, and a create must not name one
    if (existing) {
      if (givenSha !== existing.oid) {
        respond(res, 409, {
          message: `${path} does not match ${existing.oid}`,
          documentation_url: 'https://docs.github.com/rest/repos/contents',
        });
        return;
      }
    } else if (givenSha) {
      respond(res, 422, { message: 'sha does not match any file' });
      return;
    }

    const blob = repo.store.write(OBJ_BLOB, decoded);
    const next = new Map(targetFiles);
    next.set(path, { oid: blob, mode: '100644' });
    const message = typeof body.message === 'string' && body.message !== '' ? body.message : `Update ${path}`;
    const commit = commitFiles(repo, target, next, message);
    respond(res, existing ? 200 : 201, {
      content: fileJson(repo, base, path, blob),
      commit: {
        sha: commit,
        message,
        url: `${base}/api/v3/repos/${m.owner}/${m.name}/commits/${commit}`,
      },
    });
    return;
  }

  if (method === 'DELETE') {
    const body = await readBody(req, res);
    if (body === null) return;
    const target = targetOf(body);
    if (target === null) {
      respond(res, 404, { message: `Branch ${String(body.branch)} not found` });
      return;
    }
    const targetFiles = target === branch ? files : filesOfBranch(repo, target);
    if (!targetFiles.has(path)) {
      respond(res, 404, { message: 'Not Found' });
      return;
    }
    const next = new Map(targetFiles);
    next.delete(path);
    const message = typeof body.message === 'string' && body.message !== '' ? body.message : `Delete ${path}`;
    const commit = commitFiles(repo, target, next, message);
    respond(res, 200, { commit: { sha: commit, message }, content: null });
    return;
  }

  respond(res, 404, { message: 'Not Found' });
}

/** One label's JSON. */
function labelJson(repo: Repo, base: string, id: number, name: string, color: string, description: string): Record<string, unknown> {
  const m = repo.meta;
  return { id, name, color, description, url: `${base}/api/v3/repos/${m.owner}/${m.name}/labels/${name}` };
}

/** The labels routes. */
async function labelsRoute(repo: Repo, req: IncomingMessage, res: ServerResponse, base: string, method: string, tail: string[]): Promise<void> {
  const m = repo.meta;

  if (method === 'GET' && tail.length === 1) {
    respond(res, 200, m.labels.map((l) => labelJson(repo, base, l.id, l.name, l.color, l.description)));
    return;
  }

  if (method === 'POST' && tail.length === 1) {
    const body = await readBody(req, res);
    if (body === null) return;
    const name = String(body.name ?? '').trim();
    if (name === '') {
      respond(res, 422, { message: 'name is required' });
      return;
    }
    if (m.labels.some((l) => l.name === name)) {
      respond(res, 422, {
        message: 'Validation Failed',
        errors: [{ resource: 'Label', code: 'already_exists', field: 'name' }],
      });
      return;
    }
    const color = String(body.color ?? 'ededed').replace(/^#/, '');
    const label = { id: m.next_label_id++, name, color, description: String(body.description ?? '') };
    m.labels.push(label);
    repo.save();
    respond(res, 201, labelJson(repo, base, label.id, label.name, label.color, label.description));
    return;
  }

  respond(res, 404, { message: 'Not Found' });
}

/** The issues routes: create, list, read, patch, comments. */
async function issuesRoute(
  repo: Repo,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  base: string,
  method: string,
  tail: string[],
): Promise<void> {
  const m = repo.meta;

  if (tail.length === 1) {
    if (method === 'POST') {
      const body = await readBody(req, res);
      if (body === null) return;
      const title = String(body.title ?? '').trim();
      if (title === '') {
        respond(res, 422, { message: 'title is required' });
        return;
      }
      const wanted = Array.isArray(body.labels) ? body.labels.map(String) : [];
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
        id: hashId(`issue:${m.owner}/${m.name}:${m.next_issue_id}`),
        number: m.next_issue_id++,
        title,
        body: typeof body.body === 'string' ? body.body : '',
        state: 'open',
        labels: wanted,
        user: typeof body.user === 'string' ? body.user : m.owner,
        created_at: now,
        updated_at: now,
        closed_at: null,
        comments: [],
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

      let list = m.issues.filter((i) => {
        if (state === 'all') return true;
        return i.state === state;
      });
      if (labels) {
        const want = labels.split(',').map((s) => s.trim()).filter(Boolean);
        list = list.filter((i) => want.every((w) => i.labels.includes(w)));
      }
      const key = sort === 'updated' ? 'updated_at' : 'created_at';
      list = [...list].sort((a, b) => {
        const av = a[key];
        const bv = b[key];
        // Two writes can land in the same second, and their timestamps then compare equal: the issue
        // opened later carries the higher number, so the number breaks the tie the way GitHub does.
        if (av === bv) return direction === 'asc' ? a.number - b.number : b.number - a.number;
        const before = av < bv ? -1 : 1;
        return direction === 'asc' ? before : -before;
      });
      respond(res, 200, list.map((i) => issueJson(repo, i, base)));
      return;
    }
  }

  if (tail.length >= 2) {
    const number = Number(tail[1]);
    const issue = m.issues.find((i) => i.number === number);
    if (!issue) {
      respond(res, 404, { message: 'Not Found' });
      return;
    }

    if (tail.length === 2) {
      if (method === 'GET') {
        respondText(res, 200, issueBody(repo, issue, base));
        return;
      }
      if (method === 'PATCH' || method === 'POST') {
        const body = await readBody(req, res);
        if (body === null) return;
        if (typeof body.title === 'string') issue.title = body.title;
        if (typeof body.body === 'string') issue.body = body.body;
        if (body.state === 'open' || body.state === 'closed') {
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
        respond(
          res,
          200,
          issue.comments.map((c) => ({
            id: c.id,
            body: c.body,
            user: { login: c.user, type: 'User' },
            created_at: c.created_at,
            url: `${base}/api/v3/repos/${m.owner}/${m.name}/issues/${issue.number}/comments/${c.id}`,
          })),
        );
        return;
      }
      if (method === 'POST') {
        const body = await readBody(req, res);
        if (body === null) return;
        const now = new Date().toISOString();
        const comment = { id: m.next_comment_id++, body: String(body.body ?? ''), user: m.owner, created_at: now };
        issue.comments.push(comment);
        issue.updated_at = now;
        repo.save();
        respond(res, 201, {
          id: comment.id,
          body: comment.body,
          user: { login: comment.user, type: 'User' },
          created_at: comment.created_at,
          url: `${base}/api/v3/repos/${m.owner}/${m.name}/issues/${issue.number}/comments/${comment.id}`,
        });
        return;
      }
    }
  }

  respond(res, 404, { message: 'Not Found' });
}

/** The pulls routes: create, list, read, files, merge. */
async function pullsRoute(
  repo: Repo,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  base: string,
  method: string,
  tail: string[],
): Promise<void> {
  const m = repo.meta;

  if (tail.length === 1) {
    if (method === 'POST') {
      const body = await readBody(req, res);
      if (body === null) return;
      const head = String(body.head ?? '').replace(/^[^:]+:/, '');
      const baseBranch = String(body.base ?? m.default_branch);
      if (head === '' || baseBranch === '') {
        respond(res, 422, { message: 'head and base are required' });
        return;
      }
      const now = new Date().toISOString();
      const pr: Pull = {
        id: hashId(`pull:${m.owner}/${m.name}:${m.next_pull_id}`),
        number: m.next_pull_id++,
        title: String(body.title ?? head),
        body: typeof body.body === 'string' ? body.body : '',
        state: 'open',
        head,
        base: baseBranch,
        base_sha: repo.branchTip(baseBranch) ?? undefined,
        user: m.owner,
        created_at: now,
        updated_at: now,
        merged: false,
        merged_at: null,
        merge_commit_sha: null,
      };
      m.pulls.push(pr);
      repo.save();
      respond(res, 201, pullJson(repo, pr, base));
      return;
    }
    if (method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      const list = m.pulls.filter((p) => (state === 'all' ? true : p.state === state));
      respond(res, 200, list.map((p) => pullJson(repo, p, base)));
      return;
    }
  }

  if (tail.length >= 2) {
    const number = Number(tail[1]);
    const pr = m.pulls.find((p) => p.number === number);
    if (!pr) {
      respond(res, 404, { message: 'Not Found' });
      return;
    }

    if (tail.length === 2 && method === 'GET') {
      respond(res, 200, pullJson(repo, pr, base));
      return;
    }

    if (tail[2] === 'files' && method === 'GET') {
      respond(res, 200, pullFiles(repo, pr));
      return;
    }

    if (tail[2] === 'merge') {
      if (method === 'GET') {
        respond(res, 200, { merged: pr.merged, mergeable: true, sha: pr.merge_commit_sha });
        return;
      }
      if (method === 'PUT' || method === 'POST') {
        if (!repo.branchTip(pr.head)) {
          respond(res, 404, { message: 'Head branch not found' });
          return;
        }
        // the merge runs through the one path MCP shares, so both surfaces answer the same sha;
        // a head and a base that both moved over the same file is a conflict, answered 405
        let sha: string;
        try {
          sha = mergeViaMcp(repo, pr);
        } catch (err) {
          if (err instanceof MergeConflictError) {
            respond(res, 405, { message: err.message, documentation_url: 'https://docs.github.com/rest/pulls/pulls#merge-a-pull-request' });
            return;
          }
          throw err;
        }
        respond(res, 200, { sha, merged: true, message: 'Pull Request successfully merged' });
        return;
      }
    }
  }

  respond(res, 404, { message: 'Not Found' });
}

/** A pull's changed files, diffed between its base and head tips. */
function pullFiles(repo: Repo, pr: Pull): Array<Record<string, unknown>> {
  const baseTree = treeOfBranch(repo, pr.base);
  const headTree = treeOfBranch(repo, pr.head);
  return diffTrees(repo.store, baseTree, headTree).map((d) => ({
    sha: d.sha,
    filename: d.filename,
    status: d.status,
    additions: d.additions,
    deletions: d.deletions,
    changes: d.changes,
    blob_url: '',
    raw_url: '',
    contents_url: '',
    patch: d.patch,
  }));
}

/** A guard so the zero id stays referenced by the ref routes above. */
export const _zero = ZERO;
