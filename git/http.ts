// git/http.ts: git's smart HTTP protocol. upload-pack speaks v2 (ls-refs, fetch) and falls back
// to v0 for a client that does not ask for v2; receive-pack is v0 with report-status and
// side-band-64k. Everything is served from the ObjectStore: no git binary is involved.

import type { ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { DELIM, FLUSH, decodeAll, pkt, pktLines } from './pktline.ts';
import { OBJ_COMMIT, type GitObject, type ObjectStore, hashObject, readPack, writePack } from './objects.ts';
import { flattenTree, isAncestor, readCommit, readTree } from './model.ts';

/** One reference as the advertisement and ls-refs report it. */
export interface Ref {
  name: string;
  oid: string;
  peeled?: string;
}

/** The object ids reachable from `tips`, parents first, so a pack's deltas can point back. */
export function reachableObjects(store: ObjectStore, tips: ReadonlyArray<string>, exclude: ReadonlySet<string> = new Set()): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const queue: string[] = [...tips];
  const addTree = (treeOid: string): void => {
    const walk = (t: string): void => {
      if (seen.has(t)) return;
      seen.add(t);
      out.push(t);
      for (const e of readTree(store, t)) {
        if (e.type === 2) walk(e.oid);
        else if (!seen.has(e.oid)) { seen.add(e.oid); out.push(e.oid); }
      }
    };
    walk(treeOid);
  };
  while (queue.length > 0) {
    const oid = queue.shift()!;
    if (!oid || seen.has(oid) || exclude.has(oid)) continue;
    const o = store.read(oid);
    if (!o) continue;
    seen.add(oid);
    out.push(oid);
    if (o.type === OBJ_COMMIT) {
      const c = readCommit(store, oid);
      if (!c) continue;
      addTree(c.tree);
      for (const p of c.parents) queue.push(p);
    }
  }
  return out;
}

/** Count the objects reachable from `tips`, stopping the walk at `exclude` (the depth-1 case). */
export function countReachable(store: ObjectStore, tips: ReadonlyArray<string>, exclude: ReadonlySet<string>): number {
  let n = 0;
  const seen = new Set<string>();
  const queue = [...tips];
  while (queue.length > 0) {
    const oid = queue.shift()!;
    if (seen.has(oid) || exclude.has(oid)) continue;
    seen.add(oid);
    const o = store.read(oid);
    if (!o) continue;
    n += 1;
    if (o.type === OBJ_COMMIT) {
      const c = readCommit(store, oid);
      if (!c) continue;
      const walk = (t: string): void => {
        if (seen.has(t)) return;
        seen.add(t);
        n += 1;
        for (const e of readTree(store, t)) if (e.type === 2) walk(e.oid); else if (!seen.has(e.oid)) { seen.add(e.oid); n += 1; }
      };
      walk(c.tree);
      for (const p of c.parents) queue.push(p);
    }
  }
  return n;
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

/**
 * send_receive's first line: "<oid> <name>\0<caps>\n" on the first ref only, and each ref after
 * it as "<oid> <name>\n". When a repository has no refs, git advertises a capabilities^{} line
 * naming the zero id so the client still reads the capabilities.
 */
function refAdvertisement(refs: ReadonlyArray<Ref>, caps: string, includePeeled: boolean): Buffer {
  const lines: Array<string | Buffer> = [];
  if (refs.length === 0) {
    lines.push(pkt(`0000000000000000000000000000000000000000 capabilities^{}\0${caps}\n`));
  } else {
    refs.forEach((ref, i) => {
      const suffix = i === 0 ? `\0${caps}` : '';
      lines.push(pkt(`${ref.oid} ${ref.name}${suffix}\n`));
      if (includePeeled && ref.peeled) lines.push(pkt(`${ref.peeled} ${ref.name}^{}\n`));
    });
  }
  lines.push(FLUSH);
  return Buffer.concat(lines.map((l) => (Buffer.isBuffer(l) ? l : l)));
}

/** The v2 capability advertisement: "version 2" then one capability per line, then a flush. */
function v2Advertisement(refs: ReadonlyArray<Ref>): Buffer {
  const lines = [
    'version 2\n',
    'agent=git/2.43.0\n',
    'ls-refs=unborn\n',
    'fetch=shallow wait-for-done\n',
    'server-option\n',
    'object-format=sha1\n',
  ];
  const parts: Array<string | Buffer> = lines.map((l) => pkt(l));
  if (refs.length === 0) parts.push(pkt('0000000000000000000000000000000000000000 capabilities^{}\n'));
  parts.push(FLUSH);
  return Buffer.concat(parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p))));
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
    return { body: Buffer.concat([preamble, FLUSH, v2Advertisement(refs)]), headers: advertHeaders(service) };
  }
  if (service === 'git-receive-pack') {
    const caps = 'report-status report-status-v2 delete-refs side-band-64k ofs-delta atomic quiet agent=git/2.43.0 object-format=sha1';
    return { body: Buffer.concat([preamble, FLUSH, refAdvertisement(refs, caps, false)]), headers: advertHeaders(service) };
  }
  const caps = 'multi_ack multi_ack_detailed side-band side-band-64k ofs-delta shallow deepen-since deepen-not deepen-relative no-progress include-tag thin-pack agent=git/2.43.0 symref=HEAD:refs/heads/main object-format=sha1 allow-tip-sha1-in-want allow-reachable-sha1-in-want';
  return { body: Buffer.concat([preamble, FLUSH, refAdvertisement(refs, caps, true)]), headers: advertHeaders(service) };
}

/** The parsed command block of a v2 upload-pack POST: the command and its arguments. */
interface V2Request {
  command: string;
  args: string[];
}

/** Split a v2 request body into its command and argument lines. */
function parseV2(body: Buffer): V2Request {
  const packets = decodeAll(body);
  const lines = packets.filter((p) => p.packet.kind === 'data').map((p) => p.text);
  let command = '';
  const args: string[] = [];
  for (const line of lines) {
    const trimmed = line.replace(/\n$/, '');
    if (command === '' && trimmed.startsWith('command=')) { command = trimmed.slice('command='.length); continue; }
    if (trimmed !== '') args.push(trimmed);
  }
  return { command, args };
}

/** The v2 ls-refs answer: "<oid> <name>\n" for each matching ref, a symref and peel as asked. */
function lsRefs(store: ObjectStore, refs: ReadonlyArray<Ref>, head: string | null, args: ReadonlyArray<string>): Buffer {
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
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const out: Array<string | Buffer> = [];
  const headOid = head ? refs.find((r) => r.name === head)?.oid : undefined;
  // HEAD comes first as "<oid> HEAD", with its symref target as an attribute when asked for
  if (head && matches('HEAD')) {
    if (headOid) {
      const attr = symrefs ? ` symref-target:${head}` : '';
      out.push(pkt(`${headOid} HEAD${attr}\n`));
    } else if (unborn) {
      const attr = symrefs ? ` symref-target:${head}` : '';
      out.push(pkt(`unborn HEAD${attr}\n`));
    }
  }
  for (const r of refs) {
    if (!matches(r.name)) continue;
    out.push(pkt(`${r.oid} ${r.name}\n`));
    if (peel && r.peeled) out.push(pkt(`${r.peeled} ${r.name}^{}\n`));
  }
  out.push(FLUSH);
  return Buffer.concat(out.map((o) => (Buffer.isBuffer(o) ? o : Buffer.from(o))));
}

/** The objects a v2 fetch asked for, read from its want/have/deepen/shallow lines. */
interface FetchWants {
  wants: string[];
  haves: string[];
  deepen: number | null;
  done: boolean;
}

/** Parse a v2 fetch argument list. */
function parseFetchArgs(args: ReadonlyArray<string>): FetchWants {
  const wants: string[] = [];
  const haves: string[] = [];
  let deepen: number | null = null;
  let done = false;
  for (const a of args) {
    if (a.startsWith('want ')) wants.push(a.slice(5).trim());
    else if (a.startsWith('have ')) haves.push(a.slice(5).trim());
    else if (a.startsWith('deepen ')) deepen = Number(a.slice(7).trim());
    else if (a === 'done') done = true;
  }
  return { wants, haves, deepen, done };
}

/**
 * Build the pack a fetch answers with, honouring `deepen` (a shallow clone limits how many
 * commits deep the walk goes, and the resulting shallow boundary is reported separately).
 */
function buildFetchPack(store: ObjectStore, f: FetchWants): { pack: Buffer; shallow: string[] } {
  const exclude = new Set<string>(f.haves);
  let tips = f.wants.slice();
  const shallow: string[] = [];
  if (f.deepen !== null && f.deepen > 0) {
    // keep only the first `deepen` generations of commits; the oldest kept commits' parents are
    // the shallow boundary
    const depth = new Map<string, number>();
    const queue: Array<{ oid: string; d: number }> = tips.map((w) => ({ oid: w, d: 1 }));
    const kept = new Set<string>();
    while (queue.length > 0) {
      const { oid, d } = queue.shift()!;
      if (kept.has(oid)) continue;
      kept.add(oid);
      depth.set(oid, d);
      const c = readCommit(store, oid);
      if (!c) continue;
      if (d >= f.deepen) {
        for (const p of c.parents) if (p) shallow.push(p);
        continue;
      }
      for (const p of c.parents) queue.push({ oid: p, d: d + 1 });
    }
    for (const s of shallow) exclude.add(s);
    tips = tips.filter((t) => kept.has(t));
  }
  const oids = reachableObjects(store, tips, exclude);
  return { pack: writePack(oids, store), shallow: [...new Set(shallow)] };
}

/** Answer one POST /{owner}/{repo}.git/{service} request. */
export function servicePost(
  store: ObjectStore,
  refs: ReadonlyArray<Ref>,
  head: string | null,
  service: 'git-upload-pack' | 'git-receive-pack',
  body: Buffer,
  protocolV2: boolean,
): { body: Buffer; headers: Record<string, string> } {
  if (service === 'git-receive-pack') return receivePack(store, refs, body);
  if (protocolV2) {
    const req = parseV2(body);
    if (req.command === 'ls-refs') return { body: lsRefs(store, refs, head, req.args), headers: { 'content-type': 'application/x-git-upload-pack-result' } };
    if (req.command === 'fetch') {
      const f = parseFetchArgs(req.args);
      const { pack, shallow } = buildFetchPack(store, f);
      const parts: Buffer[] = [];
      for (const s of shallow) parts.push(pkt(`shallow ${s}\n`));
      if (shallow.length > 0) parts.push(FLUSH);
      // the section header, then the pack on side-band channel 1, then a flush
      parts.push(pkt('packfile\n'));
      for (let p = 0; p < pack.length; p += 65515) {
        const chunk = pack.subarray(p, p + 65515);
        parts.push(pkt(Buffer.concat([Buffer.from([1]), chunk])));
      }
      parts.push(FLUSH);
      return { body: Buffer.concat(parts), headers: { 'content-type': 'application/x-git-upload-pack-result' } };
    }
    // an unknown command answers with an error line, never a crash
    return {
      body: pktLines([pkt(`ERR unknown command ${JSON.stringify(req.command)}\n`), FLUSH]),
      headers: { 'content-type': 'application/x-git-upload-pack-result' },
    };
  }
  return uploadPackV0(store, body);
}

/** The v0 upload-pack: want/have negotiation answered with a side-band-64k framed pack. */
function uploadPackV0(store: ObjectStore, body: Buffer): { body: Buffer; headers: Record<string, string> } {
  const packets = decodeAll(body).filter((p) => p.packet.kind === 'data').map((p) => p.text);
  const wants: string[] = [];
  const haves: string[] = [];
  for (let line of packets) {
    const nul = line.indexOf('\0');
    if (nul >= 0) line = line.slice(0, nul);
    line = line.replace(/\n$/, '');
    if (line.startsWith('want ')) wants.push(line.slice(5, 45));
    else if (line.startsWith('have ')) haves.push(line.slice(5, 45));
  }
  if (wants.length === 0) {
    return { body: FLUSH, headers: { 'content-type': 'application/x-git-upload-pack-result' } };
  }
  const pack = writePack(reachableObjects(store, wants, new Set(haves)), store);
  // NAK on its own packet, then the pack in side-band channel 1, then a flush
  const parts: Buffer[] = [pkt('NAK\n')];
  const max = 65515;
  for (let off = 0; off < pack.length; off += max) {
    const chunk = pack.subarray(off, off + max);
    const framed = Buffer.concat([Buffer.from([1]), chunk]);
    parts.push(pkt(framed));
  }
  parts.push(FLUSH);
  return { body: Buffer.concat(parts), headers: { 'content-type': 'application/x-git-upload-pack-result' } };
}

/** One receive-pack command: update or delete one ref. */
interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** Apply a push: every update must fast-forward, and each ref answers one report line. */
function receivePack(
  store: ObjectStore,
  refs: ReadonlyArray<Ref>,
  body: Buffer,
): { body: Buffer; headers: Record<string, string>; applied: Array<{ ref: string; newOid: string }>; created: string[] } {
  // the command block is pkt-line framed and ends at the first flush; the pack follows raw
  const commands: PushCommand[] = [];
  let off = 0;
  while (off + 4 <= body.length) {
    const header = body.subarray(off, off + 4).toString('ascii');
    if (!/^[0-9a-f]{4}$/.test(header)) break;
    const len = parseInt(header, 16);
    if (len === 0) { off += 4; break; }
    if (len === 1 || len === 2) { off += 4; continue; }
    const payload = body.subarray(off + 4, off + len);
    off += len;
    const nul = payload.indexOf(0);
    const line = (nul >= 0 ? payload.subarray(0, nul) : payload).toString('utf8').replace(/\n$/, '');
    const parts = line.split(' ');
    if (parts.length === 3 && /^[0-9a-f]{40}$/.test(parts[0]!) && /^[0-9a-f]{40}$/.test(parts[1]!) && parts[2]!.startsWith('refs/')) {
      commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts[2]! });
    }
  }
  const byOid = new Map(refs.map((r) => [r.name, r.oid]));
  const packBytes = body.subarray(off);
  const ingest = new Map<string, GitObject>();
  if (packBytes.length >= 12 && packBytes.subarray(0, 4).toString('ascii') === 'PACK') {
    for (const [oid, o] of readPack(packBytes, store.allObjects())) {
      ingest.set(oid, o);
      if (!store.read(oid)) store.write(o.type, o.data);
    }
  }

  const applied: Array<{ ref: string; newOid: string }> = [];
  const status: string[] = [];
  for (const c of commands) {
    const current = byOid.get(c.ref) ?? '0'.repeat(40);
    if (c.newOid === '0'.repeat(40)) {
      status.push(`ok ${c.ref}`);
      applied.push({ ref: c.ref, newOid: c.newOid });
      continue;
    }
    if (!store.has(c.newOid) && !ingest.has(c.newOid)) {
      status.push(`ng ${c.ref} missing object`);
      continue;
    }
    if (current !== '0'.repeat(40) && !isAncestor(store, current, c.newOid)) {
      status.push(`ng ${c.ref} non-fast-forward`);
      continue;
    }
    status.push(`ok ${c.ref}`);
    applied.push({ ref: c.ref, newOid: c.newOid });
  }

  const report: Array<string | Buffer> = [pkt('unpack ok\n')];
  for (const s of status) report.push(pkt(`${s}\n`));
  report.push(FLUSH);
  const reportBytes = Buffer.concat(report.map((r) => (Buffer.isBuffer(r) ? r : Buffer.from(r))));
  // frame the report on side-band channel 1, as a client that advertised side-band-64k expects
  const parts: Buffer[] = [];
  for (let p = 0; p < reportBytes.length; p += 65515) {
    const chunk = reportBytes.subarray(p, p + 65515);
    parts.push(pkt(Buffer.concat([Buffer.from([1]), chunk])));
  }
  parts.push(FLUSH);
  return {
    body: Buffer.concat(parts),
    headers: { 'content-type': 'application/x-git-receive-pack-result' },
    applied,
    created: [...ingest.keys()],
  };
}

/** Every byte of a receive-pack body after the command block's flush packet. */
function packAfterCommands(body: Buffer): Buffer | null {
  let off = 0;
  while (off + 4 <= body.length) {
    const header = body.subarray(off, off + 4).toString('ascii');
    if (!/^[0-9a-f]{4}$/.test(header)) return body.subarray(off);
    const len = parseInt(header, 16);
    if (len === 0) return body.subarray(off + 4);
    if (len === 1 || len === 2) { off += 4; continue; }
    off += len;
  }
  return null;
}

/** The store's objects as a map, for a thin pack's external delta bases. */
function looseMap(store: ObjectStore): Map<string, GitObject> {
  const m = new Map<string, GitObject>();
  for (const oid of reachableObjects(store, [], new Set())) {
    const o = store.read(oid);
    if (o) m.set(oid, o);
  }
  return m;
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
  const service = m[3] === 'info/refs' ? 'git-upload-pack' : (m[3] as 'git-upload-pack' | 'git-receive-pack');
  return { owner: decodeURIComponent(m[1]!), repo: decodeURIComponent(m[2]!), service, kind: m[3] === 'info/refs' ? 'info-refs' : 'post' };
}

/** Build the ref list a repository advertises: its branches, newest tip first is irrelevant. */
export function advertiseRefs(store: ObjectStore, branches: ReadonlyMap<string, string>, tags: ReadonlyMap<string, string> = new Map()): Ref[] {
  const refs: Ref[] = [];
  for (const [name, oid] of branches) if (oid && oid !== '0'.repeat(40)) refs.push({ name: `refs/heads/${name}`, oid });
  for (const [name, oid] of tags) if (oid && oid !== '0'.repeat(40)) refs.push({ name: `refs/tags/${name}`, oid });
  return refs;
}

/** Write a smart-HTTP answer, ending the response. */
export function writeSmart(res: ServerResponse, status: number, body: Buffer, headers: Readonly<Record<string, string>>): void {
  res.writeHead(status, { ...headers, 'content-length': body.length });
  res.end(body);
}

/** A sha1 hex guard, so a malformed want never reaches the store. */
export function isOid(s: string): boolean {
  return /^[0-9a-f]{40}$/.test(s);
}

/** The id of an object given its type and content, without writing it. */
export function oidOf(type: number, data: Buffer): string {
  return hashObject(type, data);
}

/** A guard so an unused import of createHash never breaks the build. */
export const _hash = createHash;
