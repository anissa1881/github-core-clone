// git/objects.ts: the object store. Git's four object types in their zlib form, object ids as
// sha1 over "<type> <size>\0<content>", loose objects on disk, and packfiles both ways: read a
// pushed pack (zlib inflation, OFS_DELTA and REF_DELTA resolution) and write one for a clone.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';

/** Git's object types, by the number a packfile gives them. */
export const OBJ_COMMIT = 1;
export const OBJ_TREE = 2;
export const OBJ_BLOB = 3;
export const OBJ_TAG = 4;
export const OBJ_OFS_DELTA = 6;
export const OBJ_REF_DELTA = 7;

/** A type number's name, as "<type> <size>\0" writes it. */
export function typeName(type: number): string {
  switch (type) {
    case OBJ_COMMIT: return 'commit';
    case OBJ_TREE: return 'tree';
    case OBJ_BLOB: return 'blob';
    case OBJ_TAG: return 'tag';
    default: throw new Error(`unknown object type ${type}`);
  }
}

/** The type number a name means; throws on anything else. */
export function typeNumber(name: string): number {
  switch (name) {
    case 'commit': return OBJ_COMMIT;
    case 'tree': return OBJ_TREE;
    case 'blob': return OBJ_BLOB;
    case 'tag': return OBJ_TAG;
    default: throw new Error(`unknown object type ${JSON.stringify(name)}`);
  }
}

/** The all-zero object id: an unborn branch's old and new value. */
export const ZERO_OID = '0'.repeat(40);

/** One stored object: its type number and its content bytes. */
export interface GitObject {
  type: number;
  data: Buffer;
}

/** The sha1 git gives an object: sha1("<type> <size>\0" + content). */
export function hashObject(type: number, data: Buffer): string {
  const header = Buffer.from(`${typeName(type)} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

/** An object's content bytes as git writes them on disk, header included, before zlib. */
function rawObject(o: GitObject): Buffer {
  return Buffer.concat([Buffer.from(`${typeName(o.type)} ${o.data.length}\0`, 'utf8'), o.data]);
}

/** Parse "<type> <size>\0<content>". */
function parseRaw(raw: Buffer): GitObject {
  const nul = raw.indexOf(0);
  if (nul < 0) throw new Error('object header has no NUL');
  const header = raw.subarray(0, nul).toString('utf8');
  const space = header.indexOf(' ');
  const type = typeNumber(header.slice(0, space));
  const size = Number(header.slice(space + 1));
  const data = raw.subarray(nul + 1);
  if (data.length !== size) throw new Error(`object size ${data.length} is not the header's ${size}`);
  return { type, data };
}

/** Read a variable-length little-endian size, as a delta header writes it. */
function readVarint(buf: Buffer, start: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let off = start;
  for (;;) {
    const byte = buf[off];
    if (byte === undefined) throw new Error('truncated varint');
    off += 1;
    value += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if ((byte & 0x80) === 0) break;
  }
  return { value, next: off };
}

/** Apply a git delta to its base, returning the result. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const baseSize = readVarint(delta, off);
  if (baseSize.value !== base.length) throw new Error(`delta base size ${baseSize.value} is not the base's ${base.length}`);
  off = baseSize.next;
  const resultSize = readVarint(delta, off);
  off = resultSize.next;
  const out = Buffer.allocUnsafe(resultSize.value);
  let written = 0;
  while (off < delta.length) {
    const op = delta[off];
    off += 1;
    if (op & 0x80) {
      // copy from base: the low bits name which offset and size bytes follow
      let cpOff = 0;
      let cpSize = 0;
      if (op & 0x01) { cpOff |= delta[off]; off += 1; }
      if (op & 0x02) { cpOff |= delta[off] << 8; off += 1; }
      if (op & 0x04) { cpOff |= delta[off] << 16; off += 1; }
      if (op & 0x08) { cpOff |= delta[off] << 24; off += 1; }
      if (op & 0x10) { cpSize |= delta[off]; off += 1; }
      if (op & 0x20) { cpSize |= delta[off] << 8; off += 1; }
      if (op & 0x40) { cpSize |= delta[off] << 16; off += 1; }
      if (cpSize === 0) cpSize = 0x10000;
      if (cpOff + cpSize > base.length) throw new Error('delta copy past the base');
      base.copy(out, written, cpOff, cpOff + cpSize);
      written += cpSize;
    } else if (op > 0) {
      // insert op literal bytes from the delta
      if (off + op > delta.length) throw new Error('delta insert past its end');
      delta.copy(out, written, off, off + op);
      off += op;
      written += op;
    } else {
      throw new Error('delta reserved opcode 0');
    }
  }
  if (written !== resultSize.value) throw new Error(`delta wrote ${written} of ${resultSize.value} bytes`);
  return out;
}

/** One object as a packfile entry: its type, its inflated content, and its delta base link. */
interface PackEntry {
  type: number;
  data: Buffer;
  /** For a delta entry: the base this entry was packed against. */
  baseOffset?: number;
  baseOid?: string;
  /** Where this entry starts in the pack. */
  offset: number;
}

/**
 * Read every object in a packfile, resolving OFS_DELTA and REF_DELTA against objects already
 * decoded in this pack and, for a thin pack's REF_DELTA, against `external`.
 */
export function readPack(pack: Buffer, external?: ReadonlyMap<string, GitObject>): Map<string, GitObject> {
  if (pack.length < 12) throw new Error('pack is shorter than its header');
  const sig = pack.subarray(0, 4).toString('ascii');
  if (sig !== 'PACK') throw new Error(`bad pack signature ${JSON.stringify(sig)}`);
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  if (count > 2_000_000) throw new Error(`pack claims ${count} objects`);

  const entries: PackEntry[] = [];
  const byOffset = new Map<number, PackEntry>();
  const out = new Map<string, GitObject>();
  const oidOf = new Map<PackEntry, string>();
  let off = 12;

  for (let i = 0; i < count; i += 1) {
    const start = off;
    if (off >= pack.length) throw new Error(`pack ends before object ${i}`);
    let byte = pack[off];
    off += 1;
    const type = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[off];
      if (byte === undefined) throw new Error('truncated object size');
      off += 1;
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    const entry: PackEntry = { type, data: Buffer.alloc(0), offset: start };
    if (type === OBJ_OFS_DELTA) {
      // negative offset to the base, in git's variable-length encoding
      let byte2 = pack[off];
      off += 1;
      let rel = byte2 & 0x7f;
      while (byte2 & 0x80) {
        byte2 = pack[off];
        if (byte2 === undefined) throw new Error('truncated ofs-delta offset');
        off += 1;
        rel = ((rel + 1) * 128) + (byte2 & 0x7f);
      }
      entry.baseOffset = start - rel;
      if (!byOffset.has(entry.baseOffset)) throw new Error(`ofs-delta base at ${entry.baseOffset} not in pack`);
    } else if (type === OBJ_REF_DELTA) {
      entry.baseOid = pack.subarray(off, off + 20).toString('hex');
      off += 20;
    } else if (type !== OBJ_COMMIT && type !== OBJ_TREE && type !== OBJ_BLOB && type !== OBJ_TAG) {
      throw new Error(`unknown pack object type ${type}`);
    }

    // the payload is one zlib stream; inflate it without consuming the next entry's bytes
    const inflated = inflateOne(pack, off);
    off = inflated.next;
    if (inflated.data.length !== size) throw new Error(`object ${i} inflated to ${inflated.data.length}, the header said ${size}`);
    entry.data = inflated.data;
    entries.push(entry);
    byOffset.set(start, entry);

    // resolve now: a delta needs its base, which is always earlier or already seen
    let resolved: GitObject;
    if (type === OBJ_OFS_DELTA) {
      const base = resolveEntry(entry.baseOffset!);
      resolved = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else if (type === OBJ_REF_DELTA) {
      const base = resolveOid(entry.baseOid!);
      resolved = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else {
      resolved = { type, data: entry.data };
    }
    entry.data = resolved.data;
    entry.type = resolved.type;
    const oid = hashObject(resolved.type, resolved.data);
    oidOf.set(entry, oid);
    out.set(oid, resolved);
  }

  return out;

  function resolveEntry(offset: number): GitObject {
    const e = byOffset.get(offset);
    if (!e) throw new Error(`delta base at offset ${offset} not found`);
    // an entry's data is its resolved content once it has been processed
    const oid = oidOf.get(e);
    if (oid) {
      const found = out.get(oid);
      if (found) return found;
    }
    if (e.type === OBJ_OFS_DELTA || e.type === OBJ_REF_DELTA) throw new Error('delta base is itself unresolved');
    return { type: e.type, data: e.data };
  }

  function resolveOid(oid: string): GitObject {
    const found = out.get(oid) ?? external?.get(oid);
    if (!found) throw new Error(`ref-delta base ${oid} is not in the pack`);
    return found;
  }
}

/** Inflate the one zlib stream starting at `start`, answering its bytes and where it ended. */
export function inflateOne(buf: Buffer, start: number): { data: Buffer; next: number } {
  // zlib streams end at a 4-byte adler32; inflate with a growing tail so an entry's compressed
  // bytes can be located exactly. Sync inflation reports how much it consumed.
  const chunkEnd = Math.min(buf.length, start + 512);
  let end = chunkEnd;
  for (;;) {
    try {
      const data = inflateSync(buf.subarray(start, end), { finishFlush: 2 });
      // find the true consumed length by re-inflating with the zlib header accounting
      const consumed = zlibConsumed(buf, start, end);
      return { data, next: start + consumed };
    } catch (err) {
      const e = err as NodeJS.ErrnoException & { code?: string };
      if (e.code === 'Z_BUF_ERROR' || (e as { errno?: number }).errno === -5 || e.message.includes('unexpected end')) {
        if (end >= buf.length) throw new Error('truncated zlib stream in pack');
        end = Math.min(buf.length, end * 2);
        continue;
      }
      throw err;
    }
  }
}

/**
 * How many bytes of `buf` from `start` one zlib stream occupies: inflate progressively and bisect
 * on the first prefix that yields a complete stream.
 */
function zlibConsumed(buf: Buffer, start: number, end: number): number {
  let lo = 2;
  let hi = end - start;
  const fits = (n: number): boolean => {
    try {
      inflateSync(buf.subarray(start, start + n));
      return true;
    } catch {
      return false;
    }
  };
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (fits(mid)) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** The on-disk store for one repository: loose objects and refs under its directory. */
export class ObjectStore {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(join(dir, 'objects'), { recursive: true });
    mkdirSync(join(dir, 'refs', 'heads'), { recursive: true });
  }

  /** Where a loose object lives: objects/<2>/<38>. */
  private loosePath(oid: string): string {
    return join(this.dir, 'objects', oid.slice(0, 2), oid.slice(2));
  }

  has(oid: string): boolean {
    return existsSync(this.loosePath(oid));
  }

  read(oid: string): GitObject | null {
    const path = this.loosePath(oid);
    if (!existsSync(path)) return null;
    return parseRaw(inflateSync(readFileSync(path)));
  }

  /** Write one object, answering its id; writing an object twice is harmless. */
  write(type: number, data: Buffer): string {
    const oid = hashObject(type, data);
    const path = this.loosePath(oid);
    if (!existsSync(path)) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, deflateSync(rawObject({ type, data }), { level: 1 }));
    }
    return oid;
  }

  /** Write every object of a parsed pack, answering their ids. */
  ingest(pack: Buffer): string[] {
    const objects = readPack(pack, this.allLoose());
    const ids: string[] = [];
    for (const [oid, o] of objects) {
      const path = this.loosePath(oid);
      if (!existsSync(path)) {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, deflateSync(rawObject(o), { level: 1 }));
      }
      ids.push(oid);
    }
    return ids;
  }

  /** Every loose object, for a thin pack's external delta bases. */
  allObjects(): Map<string, GitObject> { return this.allLoose(); }

  /** Every loose object, for a thin pack's external delta bases. */
  private allLoose(): Map<string, GitObject> {
    const all = new Map<string, GitObject>();
    const root = join(this.dir, 'objects');
    let dirs: string[] = [];
    try {
      dirs = readdirSync(root).filter((d) => /^[0-9a-f]{2}$/.test(d));
    } catch {
      return all;
    }
    for (const d of dirs) {
      for (const f of readdirSync(join(root, d))) {
        const oid = d + f;
        const o = this.read(oid);
        if (o) all.set(oid, o);
      }
    }
    return all;
  }

  /** Delete the whole store (a repository delete). */
  destroy(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }
}

/** Write one entry into a packfile: a type header, its size varint, then the zlib stream. */
function packEntry(type: number, data: Buffer): Buffer {
  const head: number[] = [];
  let size = data.length;
  let first = (type << 4) | (size & 0x0f);
  size >>>= 4;
  while (size > 0) {
    head.push(first | 0x80);
    first = size & 0x7f;
    size >>>= 7;
  }
  head.push(first);
  return Buffer.concat([Buffer.from(head), deflateSync(data, { level: 1 })]);
}

/** Build a packfile from objects already in `objects` order (no deltas), with its trailer. */
export function writePack(oids: ReadonlyArray<string>, store: ObjectStore): Buffer {
  const parts: Buffer[] = [Buffer.from('PACK'), Buffer.alloc(4), Buffer.alloc(4)];
  parts[1].writeUInt32BE(2);
  parts[2].writeUInt32BE(oids.length);
  for (const oid of oids) {
    const o = store.read(oid);
    if (!o) throw new Error(`pack wants object ${oid}, which the store does not hold`);
    parts.push(packEntry(o.type, o.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}
