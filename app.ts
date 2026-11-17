// app.ts: the forge's HTTP surface. One process serves git smart HTTP, REST v3, GraphQL v4 and
// MCP from its own store; no UI, no outside service, no git binary.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Forge, type Repo } from './store.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { authorized, readRaw, respond } from './http.ts';
import {
  advertiseRefs,
  infoRefs,
  parseSmartPath,
  resultHeaders,
  servicePost,
  writeSmart,
  type SmartTarget,
} from './git/http.ts';
import { ZERO_OID } from './git/objects.ts';

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
  return `http://${req.headers.host ?? 'localhost'}`;
}

/** Answer one JSON 405 with an Allow header, for a path served by another method only. */
function methodNotAllowed(res: ServerResponse, allow: string): void {
  respond(res, 405, { message: 'Method Not Allowed' }, { allow });
}

/** Per-bucket request timings, so a slow surface is measured instead of guessed. */
const timings = new Map<string, number[]>();

/** The bucket one request belongs to: the surface, not the path. */
function bucketOf(path: string, method: string): string {
  if (path.includes('.git/git-receive-pack')) return 'git-receive-pack';
  if (path.includes('.git/git-upload-pack')) return 'git-upload-pack';
  if (path.includes('.git/info/refs')) return 'git-info-refs';
  if (path === '/mcp') return 'mcp';
  if (path.startsWith('/api/graphql') || path === '/graphql') return 'graphql';
  if (path.startsWith('/api/v3')) return `rest-${method.toLowerCase()}`;
  return 'other';
}

/** Write the timing summary beside the process, once, as it exits. */
function writeTimings(): void {
  const out: Record<string, unknown> = {};
  for (const [key, values] of timings) {
    if (values.length === 0) continue;
    const sorted = [...values].sort((a, b) => a - b);
    const total = sorted.reduce((a, b) => a + b, 0);
    out[key] = {
      requests: sorted.length,
      total_ms: Math.round(total),
      mean_ms: Number((total / sorted.length).toFixed(1)),
      p50_ms: sorted[Math.floor(sorted.length / 2)],
      max_ms: sorted[sorted.length - 1],
    };
  }
  try {
    writeFileSync(`${process.env.TMPDIR ?? '/tmp'}/forge-timing.json`, JSON.stringify(out));
  } catch {
    // profiling must never break a trial
  }
}

process.on('exit', writeTimings);

/** Build the server. It binds nothing until main.ts listens on its ephemeral port. */
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const startedAt = Date.now();
    res.once('finish', () => {
      const key = bucketOf((req.url ?? '/').split('?')[0]!, req.method ?? 'GET');
      const list = timings.get(key);
      const elapsed = Date.now() - startedAt;
      if (list === undefined) timings.set(key, [elapsed]);
      else list.push(elapsed);
    });
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

  // GraphQL v4: the token is required, and a query without one is 401
  if (path === '/api/graphql' || path === '/graphql') {
    if (method === 'POST') {
      if (!authorized(req, f.token)) {
        respond(res, 401, { message: 'Requires authentication' });
        return;
      }
      await handleGraphQL(f, req, res);
      return;
    }
    methodNotAllowed(res, 'POST');
    return;
  }

  // MCP over Streamable HTTP
  if (path === '/mcp' || path === '/mcp/') {
    if (method === 'POST') {
      await handleMcp(f, req, res);
      return;
    }
    // this server sends nothing unprompted, so a GET stream is not offered
    methodNotAllowed(res, 'POST');
    return;
  }

  // REST v3, and everything else under /api/v3
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
  target: SmartTarget,
): Promise<void> {
  const repo = f.get(target.owner, target.repo);
  if (!repo) {
    // a missing repository is 404 on both services, and the server stays up
    writeSmart(res, 404, Buffer.from(`${JSON.stringify({ message: 'Not Found' })}\n`), {
      'content-type': 'application/json',
    });
    return;
  }

  // git speaks with the same token the suite presents, as Basic or a bearer
  if (!authorized(req, f.token)) {
    res.writeHead(401, { 'content-type': 'text/plain', 'www-authenticate': 'Basic realm="GitHub"' });
    res.end('Unauthorized');
    return;
  }

  const refs = advertiseRefs(
    repo.store,
    new Map(Object.entries(repo.meta.branches)),
    new Map(Object.entries(repo.meta.tags ?? {})),
  );
  const head = `refs/heads/${repo.meta.default_branch}`;
  const wantsV2 = (req.headers['git-protocol'] ?? '')
    .toString()
    .split(':')
    .some((part) => part.trim() === 'version=2');

  if (target.kind === 'info-refs') {
    const service = url.searchParams.get('service');
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('Dumb HTTP protocol is not supported\n');
      return;
    }
    const answer = infoRefs(repo.store, refs, service, wantsV2);
    writeSmart(res, 200, answer.body, answer.headers);
    return;
  }

  const body = await readRaw(req);
  const answer = servicePost(repo.store, refs, head, target.service, body, wantsV2);

  // a push moves the repository's branches, but only the refs the protocol reported ok
  if (target.service === 'git-receive-pack' && answer.applied) {
    applyPush(repo, answer.applied);
  }
  void resultHeaders;
  writeSmart(res, 200, answer.body, answer.headers);
}

/** Move the repository's branch and tag maps to what a push's report said it accepted. */
function applyPush(repo: Repo, applied: ReadonlyArray<{ ref: string; newOid: string }>): void {
  let moved = false;
  for (const update of applied) {
    const tag = /^refs\/tags\/(.+)$/.exec(update.ref);
    if (tag) {
      const name = tag[1]!;
      const tags = (repo.meta.tags ??= {});
      if (update.newOid === ZERO_OID) {
        delete tags[name];
        moved = true;
        continue;
      }
      if (!repo.store.has(update.newOid)) continue;
      tags[name] = update.newOid;
      moved = true;
      continue;
    }
    const m = /^refs\/heads\/(.+)$/.exec(update.ref);
    if (!m) continue;
    const branch = m[1]!;
    if (update.newOid === ZERO_OID) {
      delete repo.meta.branches[branch];
      moved = true;
      continue;
    }
    if (!repo.store.has(update.newOid)) continue;
    repo.meta.branches[branch] = update.newOid;
    moved = true;
  }
  if (!moved) return;
  repo.meta.updated_at = new Date().toISOString();
  repo.save();
}

/** Hand the tests a forge bound to a store in a directory they name. */
export function freshForge(root: string, token: string, login: string): Forge {
  const f = new Forge(root, token, login);
  f.load();
  return f;
}
