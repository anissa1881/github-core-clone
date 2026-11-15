// app.ts: the forge's HTTP surface. One process serves git smart HTTP, REST v3, GraphQL v4 and
// MCP from its own store; no UI, no outside service, no git binary.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Forge } from './store.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { authorized, readRaw, respond } from './http.ts';
import { advertiseRefs, infoRefs, parseSmartPath, servicePost, writeSmart, resultHeaders } from './git/http.ts';

/** The forge every request reads: created once per process. */
let forge: Forge | null = null;

/** The token the suite presents, from MAKEFUN_SHOP_TOKEN. */
function shopToken(): string {
  return process.env.MAKEFUN_SHOP_TOKEN ?? 'makefun-trial-token';
}

/** The login the token names: the owner every repository belongs to. */
function tokenLogin(): string {
  const fromEnv = process.env.MAKEFUN_SHOP_LOGIN;
  if (fromEnv && fromEnv.trim() !== '') return fromEnv.trim();
  return 'makefun';
}

/** Build (or reuse) the forge. */
function forgeOf(): Forge {
  if (forge) return forge;
  const root = process.env.MAKEFUN_STORE_DIR ?? mkdtempSync(join(tmpdir(), 'forge-'));
  const f = new Forge(root, shopToken(), tokenLogin());
  f.load();
  forge = f;
  return f;
}

/** The base URL the suite uses, for the absolute links the API reports. */
function baseOf(req: IncomingMessage): string {
  const host = req.headers.host ?? 'localhost';
  return `http://${host}`;
}

/** Build the server. It binds nothing until main.ts listens on its ephemeral port. */
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void route(req, res).catch((err: unknown) => {
      // never leave a request unanswered, and never answer HTML
      if (res.headersSent) {
        res.end();
        return;
      }
      const message = err instanceof Error ? err.message : 'Internal Server Error';
      respond(res, 500, { message });
    });
  });
}

/** Dispatch one request across the four surfaces. */
async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://entry');
  } catch {
    respond(res, 400, { message: 'Bad Request' });
    return;
  }
  const path = url.pathname;
  const method = req.method ?? 'GET';

  // the env's own boot probe
  if (path === '/healthz') {
    respond(res, 200, { ok: true });
    return;
  }

  const f = forgeOf();

  // git smart HTTP: /{owner}/{repo}.git/...
  const smart = parseSmartPath(path);
  if (smart) {
    await handleSmart(f, req, res, url, smart);
    return;
  }

  // GraphQL
  if (path === '/api/graphql' || path === '/graphql') {
    if (method === 'POST') { await handleGraphQL(f, req, res); return; }
    res.writeHead(405, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message: 'Method Not Allowed' }));
    return;
  }

  // MCP
  if (path === '/mcp' || path === '/mcp/') {
    if (method === 'POST') { await handleMcp(f, req, res); return; }
    if (method === 'GET') {
      // the Streamable HTTP transport allows a GET for a server-initiated stream; this server
      // sends nothing unprompted, so it answers an empty event stream and closes
      res.writeHead(405, { 'content-type': 'application/json', allow: 'POST' });
      res.end(JSON.stringify({ message: 'Method Not Allowed' }));
      return;
    }
    res.writeHead(405, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message: 'Method Not Allowed' }));
    return;
  }

  // REST v3 (and everything else under /api/v3)
  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    if (!authorized(req, f.token)) {
      respond(res, 401, { message: 'Requires authentication' });
      return;
    }
    const outcome = await handleRest(f, req, res, url, baseOf(req));
    if (outcome === 'handled') return;
    respond(res, 404, { message: 'Not Found' });
    return;
  }

  // any other path: GitHub's JSON 404, never HTML
  if (method !== 'GET' && method !== 'HEAD') await readRaw(req);
  respond(res, 404, { message: 'Not Found' });
}

/** Serve one git smart-HTTP request for one repository. */
async function handleSmart(
  f: Forge,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  target: NonNullable<ReturnType<typeof parseSmartPath>>,
): Promise<void> {
  const repo = f.get(target.owner, target.repo);
  if (!repo) {
    // a missing repository is 404 on both services' info/refs, and the server stays up
    writeSmart(res, 404, Buffer.from(JSON.stringify({ message: 'Not Found' })), { 'content-type': 'application/json' });
    return;
  }
  // git speaks with the same bearer token the suite presents
  if (!authorized(req, f.token)) {
    res.writeHead(401, { 'content-type': 'text/plain', 'www-authenticate': 'Basic realm="GitHub"' });
    res.end('Unauthorized');
    return;
  }
  const refs = advertiseRefs(repo.store, new Map(Object.entries(repo.meta.branches)));
  const head = `refs/heads/${repo.meta.default_branch}`;

  if (target.kind === 'info-refs') {
    const service = url.searchParams.get('service');
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('Dumb HTTP protocol is not supported\n');
      return;
    }
    const v2 = (req.headers['git-protocol'] ?? '').toString().split(':').some((p) => p.trim() === 'version=2');
    const answer = infoRefs(repo.store, refs, service, v2);
    writeSmart(res, 200, answer.body, answer.headers);
    return;
  }

  const body = await readRaw(req);
  const v2 = (req.headers['git-protocol'] ?? '').toString().split(':').some((p) => p.trim() === 'version=2');
  const answer = servicePost(repo.store, refs, head, target.service, body, v2);

  // a push moves the repository's branches
  if (target.service === 'git-receive-pack') {
    applyPush(repo, body);
  }
  void resultHeaders;
  writeSmart(res, 200, answer.body, answer.headers);
}

/**
 * Apply a push's ref updates to the repository's branch map. The protocol answer already refused
 * a non-fast-forward; only the refs it reported `ok` move.
 */
function applyPush(repo: import('./store.ts').Repo, body: Buffer): void {
  const updates = readPushCommands(body);
  for (const u of updates) {
    const m = /^refs\/heads\/(.+)$/.exec(u.ref);
    if (!m) continue;
    const branch = m[1]!;
    if (u.newOid === '0'.repeat(40)) {
      delete repo.meta.branches[branch];
      continue;
    }
    if (!repo.store.has(u.newOid)) continue;
    const current = repo.meta.branches[branch];
    if (current && current !== u.newOid && !isFastForward(repo, current, u.newOid)) continue;
    repo.meta.branches[branch] = u.newOid;
    repo.meta.updated_at = new Date().toISOString();
  }
  repo.save();
}

/** Read the command block of a receive-pack body: "<old> <new> <ref>". */
function readPushCommands(body: Buffer): Array<{ oldOid: string; newOid: string; ref: string }> {
  const out: Array<{ oldOid: string; newOid: string; ref: string }> = [];
  let off = 0;
  while (off + 4 <= body.length) {
    const header = body.subarray(off, off + 4).toString('ascii');
    if (!/^[0-9a-f]{4}$/.test(header)) break;
    const len = parseInt(header, 16);
    if (len === 0) break;
    if (len === 1 || len === 2) { off += 4; continue; }
    const payload = body.subarray(off + 4, off + len);
    const nul = payload.indexOf(0);
    const line = (nul >= 0 ? payload.subarray(0, nul) : payload).toString('utf8').replace(/\n$/, '');
    const parts = line.split(' ');
    if (parts.length === 3 && /^[0-9a-f]{40}$/.test(parts[0]!) && /^[0-9a-f]{40}$/.test(parts[1]!) && parts[2]!.startsWith('refs/')) {
      out.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts[2]! });
    }
    off += len;
  }
  return out;
}

/** Whether `next` descends from `current` (the fast-forward test a push must pass). */
function isFastForward(repo: import('./store.ts').Repo, current: string, next: string): boolean {
  const seen = new Set<string>();
  const queue = [next];
  while (queue.length > 0) {
    const oid = queue.shift()!;
    if (oid === current) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const o = repo.store.read(oid);
    if (!o || o.type !== 1) continue;
    const text = o.data.toString('utf8');
    for (const line of text.split('\n')) {
      if (line.startsWith('parent ')) queue.push(line.slice(7).trim());
      if (line === '') break;
    }
  }
  return false;
}

/** Hand the tests a forge bound to a fresh store in a directory they name. */
export function freshForge(root: string, token: string, login: string): Forge {
  const f = new Forge(root, token, login);
  f.load();
  return f;
}
