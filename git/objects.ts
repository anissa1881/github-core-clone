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

/** The all-zero object id: an unborn branch's old and new value. */
export const ZERO_OID = '0'.repeat(40);

/** One stored object: its type number and its content bytes. */
export interface GitObject {
  type: number;
  data: Buffer;
}

/** A type number's name, as "<type> <size>\0" writes it. */
export function typeName(type: number): string {
  switch (type) {
    case OBJ_COMMIT:
      return 'commit';
    case OBJ_TREE:
      return 'tree';
    case OBJ_BLOB:
      return 'blob';
    case OBJ_TAG:
      return 'tag';
    default:
      throw new Error(`unknown object type ${type}`);
  }
}

/** The type number a name means; throws on anything else. */
export function typeNumber(name: string): number {
  switch (name) {
    case 'commit':
      return OBJ_COMMIT;
    case 'tree':
      return OBJ_TREE;
    case 'blob':
      return OBJ_BLOB;
    case 'tag':
      return OBJ_TAG;
    default:
      throw new Error(`unknown object type ${JSON.stringify(name)}`);
  }
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
  if (space < 0) throw new Error('object header has no space');
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
  const baseSize = readVarint(delta, 0);
  if (baseSize.value !== base.length) {
    throw new Error(`delta base size ${baseSize.value} is not the base's ${base.length}`);
  }
  const resultSize = readVarint(delta, baseSize.next);
  let off = resultSize.next;
  const out = Buffer.allocUnsafe(resultSize.value);
  let written = 0;

  while (off < delta.length) {
    const op = delta[off];
    off += 1;
    if (op & 0x80) {
      // copy from the base: the low bits name which offset and size bytes follow
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
      // insert this many literal bytes taken from the delta itself
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

/** One object as a packfile entry, before its delta is resolved. */
interface PackEntry {
  type: number;
  data: Buffer;
  /** For an OFS_DELTA: where its base starts in this pack. */
  baseOffset?: number;
  /** For a REF_DELTA: the base's id (a thin pack's may lie outside this pack). */
  baseOid?: string;
  /** Where this entry starts in the pack. */
  offset: number;
}

/** Inflate the one zlib stream starting at `start`, answering its bytes and where it ended. */
export function inflateOne(buf: Buffer, start: number): { data: Buffer; next: number } {
  // A zlib stream has no length prefix, so grow the slice until inflate succeeds, then bisect on
  // the first prefix that yields a complete stream to learn exactly how many bytes it occupied.
  let end = Math.min(buf.length, start + 512);
  for (;;) {
    try {
      const data = inflateSync(buf.subarray(start, end));
      return { data, next: start + zlibConsumed(buf, start, end) };
    } catch (err) {
      const message = err instanceof Error ? err.message : '';
      const code = (err as NodeJS.ErrnoException).code;
      const short = code === 'Z_BUF_ERROR' || message.includes('unexpected end') || message.includes('buffer');
      if (!short) throw err;
      if (end >= buf.length) throw new Error('truncated zlib stream in pack');
      end = Math.min(buf.length, end * 2);
    }
  }
}

/** How many bytes of `buf` from `start` one zlib stream occupies (the first prefix that inflates). */
function zlibConsumed(buf: Buffer, start: number, end: number): number {
  let lo = 2;
  let hi = end - start;
  const complete = (n: number): boolean => {
    try {
      inflateSync(buf.subarray(start, start + n));
      return true;
    } catch {
      return false;
    }
  };
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (complete(mid)) hi = mid;
    else lo = mid + 1;
  }
  return lo;
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

  const out = new Map<string, GitObject>();
  const resolvedAt = new Map<number, GitObject>();
  let off = 12;

  for (let i = 0; i < count; i += 1) {
    const start = off;
    if (off >= pack.length) throw new Error(`pack ends before object ${i}`);

    let byte = pack[off]!;
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

    let baseOffset: number | undefined;
    let baseOid: string | undefined;
    if (type === OBJ_OFS_DELTA) {
      // a negative distance to the base, in git's own variable-length encoding
      let next = pack[off];
      if (next === undefined) throw new Error('truncated ofs-delta offset');
      off += 1;
      let distance = next & 0x7f;
      while (next & 0x80) {
        next = pack[off];
        if (next === undefined) throw new Error('truncated ofs-delta offset');
        off += 1;
        distance = (distance + 1) * 128 + (next & 0x7f);
      }
      baseOffset = start - distance;
      if (!resolvedAt.has(baseOffset) && baseOffset < 0) throw new Error('ofs-delta base before the pack');
    } else if (type === OBJ_REF_DELTA) {
      baseOid = pack.subarray(off, off + 20).toString('hex');
      off += 20;
    } else if (type !== OBJ_COMMIT && type !== OBJ_TREE && type !== OBJ_BLOB && type !== OBJ_TAG) {
      throw new Error(`unknown pack object type ${type}`);
    }

    const inflated = inflateOne(pack, off);
    off = inflated.next;
    if (inflated.data.length !== size) {
      throw new Error(`object ${i} inflated to ${inflated.data.length}, the header said ${size}`);
    }

    let resolved: GitObject;
    if (type === OBJ_OFS_DELTA) {
      const base = resolvedAt.get(baseOffset!);
      if (!base) throw new Error(`ofs-delta base at ${baseOffset} not resolved earlier in the pack`);
      resolved = { type: base.type, data: applyDelta(base.data, inflated.data) };
    } else if (type === OBJ_REF_DELTA) {
      const base = out.get(baseOid!) ?? external?.get(baseOid!);
      if (!base) throw new Error(`ref-delta base ${baseOid} is not in the pack`);
      resolved = { type: base.type, data: applyDelta(base.data, inflated.data) };
    } else {
      resolved = { type, data: inflated.data };
    }

    resolvedAt.set(start, resolved);
    out.set(hashObject(resolved.type, resolved.data), resolved);
  }

  return out;
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

  /** Whether the store holds this object. */
  has(oid: string): boolean {
    return existsSync(this.loosePath(oid));
  }

  /** Read one object, or null when it is absent. */
  read(oid: string): GitObject | null {
    const path = this.loosePath(oid);
    if (!existsSync(path)) return null;
    return parseRaw(inflateSync(readFileSync(path)));
  }

  /** Write one object, answering its id; writing the same object twice is harmless. */
  write(type: number, data: Buffer): string {
    const oid = hashObject(type, data);
    this.store(oid, { type, data });
    return oid;
  }

  /** Write one already-hashed object unless it is on disk. */
  private store(oid: string, o: GitObject): void {
    const path = this.loosePath(oid);
    if (existsSync(path)) return;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, deflateSync(rawObject(o), { level: 1 }));
  }

  /** Write every object of a parsed pack, answering their ids. */
  ingest(pack: Buffer): string[] {
    const objects = readPack(pack, this.allLoose());
    const ids: string[] = [];
    for (const [oid, o] of objects) {
      this.store(oid, o);
      ids.push(oid);
    }
    return ids;
  }

  /** Every loose object, for a thin pack's external delta bases. */
  allObjects(): Map<string, GitObject> {
    return this.allLoose();
  }

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

/** Build a packfile from objects already in the store (no deltas), with its trailer. */
export function writePack(oids: ReadonlyArray<string>, store: ObjectStore): Buffer {
  const parts: Buffer[] = [Buffer.from('PACK'), Buffer.alloc(4), Buffer.alloc(4)];
  parts[1]!.writeUInt32BE(2);
  parts[2]!.writeUInt32BE(oids.length);
  for (const oid of oids) {
    const o = store.read(oid);
    if (!o) throw new Error(`pack wants object ${oid}, which the store does not hold`);
    parts.push(packEntry(o.type, o.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}
