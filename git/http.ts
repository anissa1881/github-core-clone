// git/http.ts: git's smart HTTP protocol. upload-pack speaks v2 (ls-refs, fetch) and falls back
// to v0 for a client that does not ask for v2; receive-pack is v0 with report-status and
// side-band-64k. Everything is served from the ObjectStore: no git binary is involved.

import type { ServerResponse } from 'node:http';
import { DELIM, FLUSH, decodePackets, pkt } from './pktline.ts';
import {
  OBJ_COMMIT,
  OBJ_TAG,
  OBJ_TREE,
  type GitObject,
  type ObjectStore,
  hashObject,
  readPack,
  writePack,
} from './objects.ts';
import { isAncestor, readCommit, readTree } from './model.ts';

/** The agent string both services advertise. */
const AGENT = 'git/2.43.0';
/** The largest side-band payload: LARGE_PACKET_MAX minus the pkt header and the channel byte. */
const SIDE_BAND_MAX = 65515;
/** The all-zero id: an unborn ref's value. */
const ZERO = '0'.repeat(40);

/** One reference as the advertisement and ls-refs report it. */
export interface Ref {
  name: string;
  oid: string;
  peeled?: string;
}

/** The service preamble and content type of one smart-HTTP endpoint's advertisement. */
function advertHeaders(service: string): Record<string, string> {
  return {
    'content-type': `application/x-${service}-advertisement`,
    'cache-control': 'no-cache, max-age=0, must-revalidate',
    pragma: 'no-cache',
    expires: 'Fri, 01 Jan 1980 00:00:00 GMT',
  };
}

/** The result content type of a POST to one service. */
export function resultHeaders(service: string): Record<string, string> {
  return {
    'content-type': `application/x-${service}-result`,
    'cache-control': 'no-cache, max-age=0, must-revalidate',
    pragma: 'no-cache',
    expires: 'Fri, 01 Jan 1980 00:00:00 GMT',
  };
}

/** Whether a request asked for protocol v2. */
export function wantsV2(gitProtocol: string | undefined): boolean {
  if (!gitProtocol) return false;
  return gitProtocol.split(':').some((part) => part.trim() === 'version=2');
}

/** A sha1 hex guard, so a malformed want never reaches the store. */
export function isOid(s: string): boolean {
  return /^[0-9a-f]{40}$/.test(s);
}

/** The id of an object given its type and content, without writing it. */
export function oidOf(type: number, data: Buffer): string {
  return hashObject(type, data);
}

/**
 * Every object id reachable from `tips`: each commit, its tree chain and its blobs, following
 * parents. Ids in `exclude` (a fetch's haves) stop the walk, so a client that already holds them
 * is sent only the difference.
 */
export function reachableObjects(
  store: ObjectStore,
  tips: ReadonlyArray<string>,
  exclude: ReadonlySet<string> = new Set(),
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  /** Add a tree and everything under it, depth first, never one the client already holds. */
  const addTree = (treeOid: string): void => {
    const stack = [treeOid];
    while (stack.length > 0) {
      const t = stack.pop()!;
      if (seen.has(t) || exclude.has(t)) continue;
      seen.add(t);
      out.push(t);
      for (const e of readTree(store, t)) {
        if (e.type === OBJ_TREE) stack.push(e.oid);
        else if (!seen.has(e.oid) && !exclude.has(e.oid)) {
          seen.add(e.oid);
          out.push(e.oid);
        }
      }
    }
  };

  const queue = [...tips];
  while (queue.length > 0) {
    const oid = queue.shift()!;
    if (!oid || seen.has(oid) || exclude.has(oid)) continue;
    const o = store.read(oid);
    if (!o) continue;
    seen.add(oid);
    out.push(oid);
    if (o.type !== OBJ_COMMIT) continue;
    const c = readCommit(store, oid);
    if (!c) continue;
    addTree(c.tree);
    for (const p of c.parents) queue.push(p);
  }
  return out;
}

/** Count the objects reachable from `tips`, stopping the walk at `exclude`. */
export function countReachable(
  store: ObjectStore,
  tips: ReadonlyArray<string>,
  exclude: ReadonlySet<string>,
): number {
  return reachableObjects(store, tips, exclude).length;
}

/**
 * The v0 ref advertisement: "<oid> <name>\0<caps>\n" on the first ref only, then one
 * "<oid> <name>\n" per ref. A repository with no refs advertises a capabilities^{} line naming
 * the zero id, so the client still reads the capabilities.
 */
function refAdvertisement(refs: ReadonlyArray<Ref>, caps: string, includePeeled: boolean): Buffer {
  const parts: Buffer[] = [];
  if (refs.length === 0) {
    parts.push(pkt(`${ZERO} capabilities^{}\0${caps}\n`));
  } else {
    refs.forEach((ref, i) => {
      const suffix = i === 0 ? `\0${caps}` : '';
      parts.push(pkt(`${ref.oid} ${ref.name}${suffix}\n`));
      if (includePeeled && ref.peeled) parts.push(pkt(`${ref.peeled} ${ref.name}^{}\n`));
    });
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

/** The v2 capability advertisement: "version 2", one capability per line, then a flush. */
function v2Advertisement(refs: ReadonlyArray<Ref>): Buffer {
  const parts: Buffer[] = [
    pkt('version 2\n'),
    pkt(`agent=${AGENT}\n`),
    pkt('ls-refs=unborn\n'),
    pkt('fetch=shallow wait-for-done\n'),
    pkt('server-option\n'),
    pkt('object-format=sha1\n'),
  ];
  if (refs.length === 0) parts.push(pkt(`${ZERO} capabilities^{}\n`));
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

/** The GET /info/refs?service=<service> answer, as bytes and headers. */
export function infoRefs(
  store: ObjectStore,
  refs: ReadonlyArray<Ref>,
  service: 'git-upload-pack' | 'git-receive-pack',
  protocolV2: boolean,
): { body: Buffer; headers: Record<string, string> } {
  const preamble = pkt(`# service=${service}\n`);

  if (service === 'git-upload-pack' && protocolV2) {
    return {
      body: Buffer.concat([preamble, FLUSH, v2Advertisement(refs)]),
      headers: advertHeaders(service),
    };
  }

  if (service === 'git-receive-pack') {
    const caps = [
      'report-status',
      'report-status-v2',
      'delete-refs',
      'side-band-64k',
      'ofs-delta',
      'atomic',
      'quiet',
      `agent=${AGENT}`,
      'object-format=sha1',
    ].join(' ');
    return {
      body: Buffer.concat([preamble, FLUSH, refAdvertisement(refs, caps, false)]),
      headers: advertHeaders(service),
    };
  }

  const caps = [
    'multi_ack',
    'multi_ack_detailed',
    'side-band',
    'side-band-64k',
    'ofs-delta',
    'shallow',
    'deepen-since',
    'deepen-not',
    'deepen-relative',
    'no-progress',
    'include-tag',
    'thin-pack',
    `agent=${AGENT}`,
    'symref=HEAD:refs/heads/main',
    'object-format=sha1',
    'allow-tip-sha1-in-want',
    'allow-reachable-sha1-in-want',
  ].join(' ');
  return {
    body: Buffer.concat([preamble, FLUSH, refAdvertisement(refs, caps, true)]),
    headers: advertHeaders(service),
  };
}

/** The text lines of a pkt-line body, special packets dropped. */
function bodyLines(body: Buffer): string[] {
  return decodePackets(body)
    .packets.filter((p) => p.packet.kind === 'data')
    .map((p) => p.text.replace(/\n$/, ''));
}

/** The parsed command of a v2 upload-pack POST. */
interface V2Request {
  command: string;
  args: string[];
}

/** Split a v2 request body into its command and argument lines. */
function parseV2(body: Buffer): V2Request {
  let command = '';
  const args: string[] = [];
  for (const line of bodyLines(body)) {
    if (command === '' && line.startsWith('command=')) {
      command = line.slice('command='.length);
      continue;
    }
    if (line !== '') args.push(line);
  }
  return { command, args };
}

/** The v2 ls-refs answer: "<oid> <name>\n" per matching ref, with symrefs and peel as asked. */
function lsRefs(
  store: ObjectStore,
  refs: ReadonlyArray<Ref>,
  head: string | null,
  args: ReadonlyArray<string>,
): Buffer {
  let symrefs = false;
  let peel = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const a of args) {
    if (a === 'symrefs') symrefs = true;
    else if (a === 'peel') peel = true;
    else if (a === 'unborn') unborn = true;
    else if (a.startsWith('ref-prefix ')) prefixes.push(a.slice('ref-prefix '.length));
  }
  void store;

  const matches = (name: string): boolean =>
    prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));

  const parts: Buffer[] = [];
  const headOid = head ? refs.find((r) => r.name === head)?.oid : undefined;
  if (head && matches('HEAD')) {
    const attr = symrefs ? ` symref-target:${head}` : '';
    if (headOid) parts.push(pkt(`${headOid} HEAD${attr}\n`));
    else if (unborn) parts.push(pkt(`unborn HEAD${attr}\n`));
  }
  for (const r of refs) {
    if (!matches(r.name)) continue;
    // gitprotocol-v2 carries the peel as a `peeled:<oid>` attribute on the ref's own line
    const peeled = peel && r.peeled ? ` peeled:${r.peeled}` : '';
    parts.push(pkt(`${r.oid} ${r.name}${peeled}\n`));
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

/** What a v2 fetch asked for, read from its want/have/deepen lines. */
interface FetchWants {
  wants: string[];
  haves: string[];
  shallow: string | null;
  deepen: number | null;
  done: boolean;
}

/** Parse a v2 fetch argument list. */
function parseFetchArgs(args: ReadonlyArray<string>): FetchWants {
  const wants: string[] = [];
  const haves: string[] = [];
  let deepen: number | null = null;
  let shallow: string | null = null;
  let done = false;
  for (const a of args) {
    if (a.startsWith('want ')) wants.push(a.slice(5).trim());
    else if (a.startsWith('have ')) haves.push(a.slice(5).trim());
    else if (a.startsWith('shallow ')) shallow = a.slice(8).trim();
    else if (a.startsWith('deepen ')) deepen = Number(a.slice(7).trim());
    else if (a === 'done') done = true;
  }
  return { wants, haves, shallow, deepen, done };
}

/**
 * Build the pack a fetch answers with. A shallow clone keeps only `deepen` generations of
 * commits; the oldest kept commits' parents become the shallow boundary the client is told about,
 * and are excluded from the pack.
 */
function buildFetchPack(store: ObjectStore, f: FetchWants): { pack: Buffer; shallow: string[] } {
  // A have says the client holds that object and everything reachable from it, so the whole
  // closure is excluded: a shared tree or blob the client already has must not be re-sent.
  const exclude = new Set<string>();
  for (const have of f.haves) {
    if (!isOid(have)) continue;
    for (const oid of reachableObjects(store, [have])) exclude.add(oid);
  }
  let tips = f.wants.filter((w) => isOid(w));
  const shallow: string[] = [];

  // a deepen of 2^31-1 is git's --unshallow: the whole history, with no boundary at all
  const unbounded = f.deepen !== null && f.deepen >= 0x7fffffff;

  if (f.deepen !== null && f.deepen > 0 && !unbounded) {
    // a deepen from an already-shallow clone must still send the ancestors it is missing, so a
    // commit the client already has may not be excluded as a boundary when it is an ancestor
    exclude.clear();
    // Keep `deepen` generations of commits from each want. A commit at the boundary is sent, but
    // its parents are not: the client is told the boundary id as shallow, so it stops there.
    const kept = new Set<string>();
    const queue: Array<{ oid: string; d: number }> = tips.map((w) => ({ oid: w, d: 1 }));
    while (queue.length > 0) {
      const { oid, d } = queue.shift()!;
      if (kept.has(oid)) continue;
      kept.add(oid);
      const c = readCommit(store, oid);
      if (!c) continue;
      if (d >= f.deepen) {
        shallow.push(oid);
        for (const p of c.parents) if (p) exclude.add(p);
        continue;
      }
      for (const p of c.parents) queue.push({ oid: p, d: d + 1 });
    }
    tips = tips.filter((t) => kept.has(t));
  }

  if (unbounded) {
    // nothing is a boundary, so every ancestor of every want is sent
    exclude.clear();
    tips = f.wants.filter((w) => isOid(w));
  }

  return { pack: writePack(reachableObjects(store, tips, exclude), store), shallow: [...new Set(shallow)] };
}

/**
 * The built packs, keyed by what the fetch asked for. Every id in the key is a content hash, so an
 * identical key can only answer identical bytes: the 50 concurrent depth-1 clones of one repo build
 * the pack once and replay it. Bounded in entries and bytes, oldest evicted first.
 */
const packCache = new Map<string, { pack: Buffer; shallow: string[] }>();
const PACK_CACHE_ENTRIES = 24;
const PACK_CACHE_BYTES = 32 * 1024 * 1024;
let packCacheBytes = 0;

/** The pack a fetch answers with, from the cache when the same want/have/deepen was asked before. */
function cachedFetchPack(store: ObjectStore, f: FetchWants): { pack: Buffer; shallow: string[] } {
  const key = JSON.stringify([
    [...f.wants].sort(),
    [...f.haves].sort(),
    f.deepen,
    f.shallow,
  ]);
  const hit = packCache.get(key);
  if (hit !== undefined) {
    // refresh the entry's position so the eviction is least-recently-used
    packCache.delete(key);
    packCache.set(key, hit);
    return hit;
  }
  const built = buildFetchPack(store, f);
  if (built.pack.length <= PACK_CACHE_BYTES) {
    packCache.set(key, built);
    packCacheBytes += built.pack.length;
    while (packCache.size > PACK_CACHE_ENTRIES || packCacheBytes > PACK_CACHE_BYTES) {
      const oldest = packCache.keys().next();
      if (oldest.done === true) break;
      const evicted = packCache.get(oldest.value);
      packCache.delete(oldest.value);
      if (evicted !== undefined) packCacheBytes -= evicted.pack.length;
    }
  }
  return built;
}

/** Frame `data` on side-band channel 1, as a client that advertised side-band-64k expects. */
function sideBand(data: Buffer): Buffer {
  const parts: Buffer[] = [];
  for (let off = 0; off < data.length; off += SIDE_BAND_MAX) {
    const chunk = data.subarray(off, off + SIDE_BAND_MAX);
    parts.push(pkt(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return Buffer.concat(parts);
}

/** Answer one POST /{owner}/{repo}.git/{service} request. */
export function servicePost(
  store: ObjectStore,
  refs: ReadonlyArray<Ref>,
  head: string | null,
  service: 'git-upload-pack' | 'git-receive-pack',
  body: Buffer,
  protocolV2: boolean,
): { body: Buffer; headers: Record<string, string>; applied?: Array<{ ref: string; newOid: string }> } {
  if (service === 'git-receive-pack') return receivePack(store, refs, body);

  if (!protocolV2) return uploadPackV0(store, body);

  const req = parseV2(body);
  if (req.command === 'ls-refs') {
    return { body: lsRefs(store, refs, head, req.args), headers: resultHeaders('git-upload-pack') };
  }
  if (req.command === 'fetch') {
    const asked = parseFetchArgs(req.args);
    const { pack, shallow } = cachedFetchPack(store, asked);

    // v2 fetch answers in sections: acknowledgments (only when the client sent haves), then
    // shallow-info inside that same section, then packfile whose payload rides side-band 1.
    // A client that sent no haves gets no acknowledgments section at all.
    const parts: Buffer[] = [];

    // v2 fetch sections, each closed by a delimiter (FLUSH), as gitprotocol-v2 defines them:
    //   acknowledgments -> shallow-info -> packfile
    // A client that sent haves always gets acknowledgments, with 'ready' closing it. The
    // shallow-info section carries 'shallow' for a new boundary and 'unshallow' for a commit the
    // client marked shallow that is no longer one, which is what --unshallow needs.
    const deepening = asked.shallow !== null || asked.deepen !== null;

    // gitprotocol-v2 sections are separated by a delim-pkt (0001); a flush-pkt (0000) ends the
    // whole response. A fetch that sent haves opens with acknowledgments, which closes with
    // 'ready'. Then shallow-info, then packfile.
    if (asked.haves.length > 0) {
      parts.push(pkt('acknowledgments\n'));
      parts.push(pkt(`ACK ${asked.haves[asked.haves.length - 1]}\n`));
      parts.push(pkt('ready\n'));
      parts.push(DELIM);
    }

    if (shallow.length > 0) {
      parts.push(pkt('shallow-info\n'));
      for (const s of shallow) parts.push(pkt(`shallow ${s}\n`));
      parts.push(DELIM);
    } else if (deepening) {
      // a deepen that ends in no boundary unshallows what the client held, so the client stops
      // treating those commits as shallow
      parts.push(pkt('shallow-info\n'));
      if (asked.shallow !== null) parts.push(pkt(`unshallow ${asked.shallow}\n`));
      parts.push(DELIM);
    }

    parts.push(pkt('packfile\n'));
    parts.push(sideBand(pack));
    parts.push(FLUSH);
    return { body: Buffer.concat(parts), headers: resultHeaders('git-upload-pack') };
  }
  return {
    body: Buffer.concat([pkt(`ERR unknown command ${JSON.stringify(req.command)}\n`), FLUSH]),
    headers: resultHeaders('git-upload-pack'),
  };
}

/** The v0 upload-pack: want/have negotiation, answered with a side-band-64k framed pack. */
function uploadPackV0(store: ObjectStore, body: Buffer): { body: Buffer; headers: Record<string, string> } {
  const wants: string[] = [];
  const haves: string[] = [];
  for (let line of bodyLines(body)) {
    const nul = line.indexOf('\0');
    if (nul >= 0) line = line.slice(0, nul);
    if (line.startsWith('want ')) wants.push(line.slice(5, 45));
    else if (line.startsWith('have ')) haves.push(line.slice(5, 45));
  }

  const headers = resultHeaders('git-upload-pack');
  const valid = wants.filter((w) => isOid(w));
  if (valid.length === 0) return { body: FLUSH, headers };

  const pack = writePack(reachableObjects(store, valid, new Set(haves)), store);
  return { body: Buffer.concat([pkt('NAK\n'), sideBand(pack), FLUSH]), headers };
}

/** One receive-pack command: update or delete one ref. */
interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** Read the command block of a receive-pack body: "<old> <new> <ref>", ending at the first flush. */
function readPushCommands(body: Buffer): { commands: PushCommand[]; rest: Buffer } {
  const commands: PushCommand[] = [];
  let off = 0;
  while (off + 4 <= body.length) {
    const header = body.subarray(off, off + 4).toString('ascii');
    if (!/^[0-9a-f]{4}$/.test(header)) break;
    const len = parseInt(header, 16);
    if (len === 0) {
      off += 4;
      return { commands, rest: body.subarray(off) };
    }
    if (len === 1 || len === 2) {
      off += 4;
      continue;
    }
    const payload = body.subarray(off + 4, off + len);
    off += len;
    const nul = payload.indexOf(0);
    const line = (nul >= 0 ? payload.subarray(0, nul) : payload).toString('utf8').replace(/\n$/, '');
    const parts = line.split(' ');
    if (
      parts.length === 3 &&
      isOid(parts[0]!) &&
      isOid(parts[1]!) &&
      parts[2]!.startsWith('refs/')
    ) {
      commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts[2]! });
    }
  }
  return { commands, rest: body.subarray(off) };
}

/**
 * Apply a push: ingest its pack, then answer one report line per ref. A ref updates only when its
 * new commit exists and descends from what the ref held, so a force-push is refused here.
 */
function receivePack(
  store: ObjectStore,
  refs: ReadonlyArray<Ref>,
  body: Buffer,
): {
  body: Buffer;
  headers: Record<string, string>;
  applied: Array<{ ref: string; newOid: string }>;
} {
  const { commands, rest } = readPushCommands(body);

  const ingested = new Set<string>();
  if (rest.length >= 12 && rest.subarray(0, 4).toString('ascii') === 'PACK') {
    for (const [oid, o] of readPack(rest, (oid) => store.read(oid))) {
      ingested.add(oid);
      if (!store.has(oid)) store.write(o.type, o.data);
    }
  }

  const current = new Map<string, string>();
  for (const r of refs) current.set(r.name, r.oid);

  const applied: Array<{ ref: string; newOid: string }> = [];
  const status: string[] = [];
  for (const c of commands) {
    if (c.newOid === ZERO) {
      // a delete: report-status carries its own result, so a missing ref is not an error
      status.push(`ok ${c.ref}`);
      applied.push({ ref: c.ref, newOid: c.newOid });
      continue;
    }
    if (!store.has(c.newOid) && !ingested.has(c.newOid)) {
      status.push(`ng ${c.ref} missing object`);
      continue;
    }
    const held = current.get(c.ref) ?? ZERO;
    if (held !== ZERO && !isAncestor(store, held, c.newOid)) {
      status.push(`ng ${c.ref} non-fast-forward`);
      continue;
    }
    status.push(`ok ${c.ref}`);
    applied.push({ ref: c.ref, newOid: c.newOid });
  }

  const report = Buffer.concat([
    pkt('unpack ok\n'),
    ...status.map((s) => pkt(`${s}\n`)),
    FLUSH,
  ]);

  return {
    body: Buffer.concat([sideBand(report), FLUSH]),
    headers: resultHeaders('git-receive-pack'),
    applied,
  };
}

/** Where a smart-HTTP path points: which service and which repository. */
export interface SmartTarget {
  owner: string;
  repo: string;
  service: 'git-upload-pack' | 'git-receive-pack';
  kind: 'info-refs' | 'post';
}

/** Parse "/{owner}/{repo}.git/info/refs" or "/{owner}/{repo}.git/{service}". */
export function parseSmartPath(path: string): SmartTarget | null {
  const m = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
  if (!m) return null;
  const tail = m[3]!;
  const service =
    tail === 'info/refs' ? 'git-upload-pack' : (tail as 'git-upload-pack' | 'git-receive-pack');
  return {
    owner: decodeURIComponent(m[1]!),
    repo: decodeURIComponent(m[2]!),
    service,
    kind: tail === 'info/refs' ? 'info-refs' : 'post',
  };
}

/** The commit an object peels to: a tag chain is followed, a commit answers itself, else null. */
export function peelToCommit(store: ObjectStore, oid: string): string | null {
  let current = oid;
  for (let depth = 0; depth < 16; depth += 1) {
    const o = store.read(current);
    if (!o) return null;
    if (o.type === OBJ_COMMIT) return current;
    if (o.type !== OBJ_TAG) return null;
    const m = /^object ([0-9a-f]{40})$/m.exec(o.data.toString('utf8'));
    if (!m) return null;
    current = m[1]!;
  }
  return null;
}

/** The ref list a repository advertises: its branches and tags that point at something. */
export function advertiseRefs(
  store: ObjectStore,
  branches: ReadonlyMap<string, string>,
  tags: ReadonlyMap<string, string> = new Map(),
): Ref[] {
  const refs: Ref[] = [];
  for (const [name, oid] of branches) {
    if (oid && oid !== ZERO) refs.push({ name: `refs/heads/${name}`, oid });
  }
  for (const [name, oid] of tags) {
    if (!oid || oid === ZERO) continue;
    const peeled = peelToCommit(store, oid);
    refs.push(peeled && peeled !== oid ? { name: `refs/tags/${name}`, oid, peeled } : { name: `refs/tags/${name}`, oid });
  }
  return refs;
}

/** Write a smart-HTTP answer, ending the response. */
export function writeSmart(
  res: ServerResponse,
  status: number,
  body: Buffer,
  headers: Readonly<Record<string, string>>,
): void {
  res.writeHead(status, { ...headers, 'content-length': body.length });
  res.end(body);
}

/** A guard so the GitObject type import stays used by the readPack call above. */
export type { GitObject };
