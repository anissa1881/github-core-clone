// git/model.ts: reading and writing the two objects a forge must understand, commits and trees,
// walking history, building trees from a file map, and diffing two trees for a pull request.

import { createHash } from 'node:crypto';
import { OBJ_BLOB, OBJ_COMMIT, OBJ_TREE, type ObjectStore } from './objects.ts';

/** The identity a commit records: who, when, and in which zone. */
export interface Who {
  name: string;
  email: string;
  date: number;
  tz: string;
}

/** One parsed commit. */
export interface Commit {
  oid: string;
  tree: string;
  parents: string[];
  author: Who;
  committer: Who;
  message: string;
}

/** One tree entry. */
export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
  type: number;
}

/** A file map: repository path to its blob id and mode. */
export type FileMap = Map<string, { oid: string; mode: string }>;

const ZERO = '0'.repeat(40);

/** Parse "Name <email> 1234567890 +0000". */
function parseWho(s: string): Who {
  const lt = s.indexOf('<');
  const gt = lt >= 0 ? s.indexOf('>', lt) : -1;
  const name = lt > 0 ? s.slice(0, lt).trim() : '';
  const email = gt > lt ? s.slice(lt + 1, gt) : '';
  const rest = gt >= 0 ? s.slice(gt + 1).trim().split(/\s+/).filter((p) => p !== '') : [];
  return { name, email, date: Number(rest[0] ?? 0) || 0, tz: rest[1] ?? '+0000' };
}

/** Write a Who back out as the commit header line's value. */
function whoOf(w: Who): string {
  return `${w.name} <${w.email}> ${w.date} ${w.tz}`;
}

/** Parse a commit object's bytes. */
export function parseCommit(oid: string, data: Buffer): Commit {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author: Who = { name: '', email: '', date: 0, tz: '+0000' };
  let committer: Who = author;
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = parseWho(line.slice(7));
    else if (line.startsWith('committer ')) committer = parseWho(line.slice(10));
  }
  return { oid, tree, parents, author, committer, message };
}

/** Parse a tree object's bytes into its entries. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const space = data.indexOf(0x20, off);
    if (space < 0) break;
    const mode = data.subarray(off, space).toString('ascii');
    const nul = data.indexOf(0, space);
    if (nul < 0) break;
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    off = nul + 21;
    entries.push({ mode, name, oid, type: mode === '40000' || mode === '040000' ? OBJ_TREE : OBJ_BLOB });
  }
  return entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** git sorts tree entries bytewise, treating a directory as if its name ended with '/'. */
function treeSortCompare(a: string, b: string): number {
  const aa = a.endsWith('/') ? a : `${a}/`;
  const bb = b.endsWith('/') ? b : `${b}/`;
  return aa < bb ? -1 : aa > bb ? 1 : 0;
}

/** Serialise tree entries, git's wire form: "<mode> <name>\0<20-byte oid>". */
export function serializeTree(entries: ReadonlyArray<TreeEntry>): Buffer {
  const sorted = [...entries].sort((a, b) => treeSortCompare(a.name, b.name));
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Serialise a commit object's bytes. */
export function serializeCommit(c: {
  tree: string;
  parents: ReadonlyArray<string>;
  author: Who;
  committer: Who;
  message: string;
}): Buffer {
  const lines: string[] = [`tree ${c.tree}`];
  for (const p of c.parents) lines.push(`parent ${p}`);
  lines.push(`author ${whoOf(c.author)}`);
  lines.push(`committer ${whoOf(c.committer)}`);
  const message = c.message.endsWith('\n') ? c.message : `${c.message}\n`;
  return Buffer.from(`${lines.join('\n')}\n\n${message}`, 'utf8');
}

/** Read a commit, or null when the object is missing or is not a commit. */
export function readCommit(store: ObjectStore, oid: string): Commit | null {
  const o = store.read(oid);
  if (!o || o.type !== OBJ_COMMIT) return null;
  return parseCommit(oid, o.data);
}

/** Read a tree's entries, or [] when it is missing or is not a tree. */
export function readTree(store: ObjectStore, oid: string): TreeEntry[] {
  const o = store.read(oid);
  if (!o || o.type !== OBJ_TREE) return [];
  return parseTree(o.data);
}

/** Flatten a tree into path -> blob, recursively. */
export function flattenTree(store: ObjectStore, treeOid: string, prefix = '', out: FileMap = new Map()): FileMap {
  for (const e of readTree(store, treeOid)) {
    const path = prefix === '' ? e.name : `${prefix}/${e.name}`;
    if (e.type === OBJ_TREE) flattenTree(store, e.oid, path, out);
    else out.set(path, { oid: e.oid, mode: e.mode });
  }
  return out;
}

/** One directory while a tree is being built. */
interface Dir {
  files: Map<string, { oid: string; mode: string }>;
  dirs: Map<string, Dir>;
}

/**
 * Build the tree chain for a file map, answering the root tree's id. Content that did not change
 * hashes to the same subtree id, so an unchanged directory costs nothing to rebuild.
 */
export function buildTree(store: ObjectStore, files: FileMap): string {
  const root: Dir = { files: new Map(), dirs: new Map() };
  for (const [path, v] of files) {
    const segs = path.split('/').filter((s) => s !== '');
    if (segs.length === 0) continue;
    let cur = root;
    for (let i = 0; i < segs.length - 1; i += 1) {
      const seg = segs[i]!;
      let next = cur.dirs.get(seg);
      if (!next) {
        next = { files: new Map(), dirs: new Map() };
        cur.dirs.set(seg, next);
      }
      cur = next;
    }
    cur.files.set(segs[segs.length - 1]!, v);
  }

  const write = (dir: Dir): string => {
    const entries: TreeEntry[] = [];
    for (const [name, v] of dir.files) {
      entries.push({ mode: v.mode === '100755' ? '100755' : '100644', name, oid: v.oid, type: OBJ_BLOB });
    }
    for (const [name, sub] of dir.dirs) {
      entries.push({ mode: '40000', name, oid: write(sub), type: OBJ_TREE });
    }
    if (entries.length === 0) return store.write(OBJ_TREE, Buffer.alloc(0));
    return store.write(OBJ_TREE, serializeTree(entries));
  };

  return write(root);
}

/** Create a commit object, answering its id. */
export function createCommit(
  store: ObjectStore,
  args: { tree: string; parents: ReadonlyArray<string>; message: string; name: string; email: string; date?: number },
): string {
  const date = args.date ?? Math.floor(Date.now() / 1000);
  const w: Who = { name: args.name, email: args.email, date, tz: '+0000' };
  const parents = args.parents.filter((p) => p && p !== ZERO);
  return store.write(
    OBJ_COMMIT,
    serializeCommit({ tree: args.tree, parents, author: w, committer: w, message: args.message }),
  );
}

/** Every commit reachable from `tips`, newest first, without revisiting one. */
export function walkHistory(store: ObjectStore, tips: ReadonlyArray<string>, limit = 10_000): Commit[] {
  const seen = new Set<string>();
  const out: Commit[] = [];
  const queue = tips.filter((t) => t && t !== ZERO);
  while (queue.length > 0 && out.length < limit) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const c = readCommit(store, oid);
    if (!c) continue;
    out.push(c);
    for (const p of c.parents) if (!seen.has(p)) queue.push(p);
  }
  out.sort((a, b) => b.committer.date - a.committer.date);
  return out;
}

/** True when `ancestor` is reachable from `descendant` (the fast-forward test). */
export function isAncestor(store: ObjectStore, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant || ancestor === ZERO) return true;
  const seen = new Set<string>();
  const queue = [descendant];
  while (queue.length > 0) {
    const oid = queue.shift()!;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const c = readCommit(store, oid);
    if (!c) continue;
    for (const p of c.parents) queue.push(p);
  }
  return false;
}

/** One changed file between two trees, as a pull request's files list reports it. */
export interface FileDiff {
  filename: string;
  status: 'added' | 'modified' | 'removed' | 'renamed';
  additions: number;
  deletions: number;
  changes: number;
  patch: string;
  sha: string;
}

/** More than this many line pairs is diffed without the table, so a huge file cannot stall a request. */
const LCS_CELL_LIMIT = 4_000_000;

/** A line diff: the common ends trimmed, then an LCS over the middle, as unified-diff lines. */
function lineDiff(a: string[], b: string[]): { added: number; removed: number; lines: string[] } {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }

  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const lines: string[] = a.slice(0, start).map((l) => ` ${l}`);
  let added = 0;
  let removed = 0;

  if (midA.length * midB.length > LCS_CELL_LIMIT) {
    // too big for the table: report the middle as removed, then added
    for (const l of midA) { lines.push(`-${l}`); removed += 1; }
    for (const l of midB) { lines.push(`+${l}`); added += 1; }
  } else {
    const n = midA.length;
    const m = midB.length;
    const w = m + 1;
    const table = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i -= 1) {
      for (let j = m - 1; j >= 0; j -= 1) {
        table[i * w + j] = midA[i] === midB[j]
          ? table[(i + 1) * w + j + 1]! + 1
          : Math.max(table[(i + 1) * w + j]!, table[i * w + j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (midA[i] === midB[j]) {
        lines.push(` ${midA[i]}`);
        i += 1;
        j += 1;
      } else if (table[(i + 1) * w + j]! >= table[i * w + j + 1]!) {
        lines.push(`-${midA[i]}`);
        removed += 1;
        i += 1;
      } else {
        lines.push(`+${midB[j]}`);
        added += 1;
        j += 1;
      }
    }
    while (i < n) { lines.push(`-${midA[i]}`); removed += 1; i += 1; }
    while (j < m) { lines.push(`+${midB[j]}`); added += 1; j += 1; }
  }

  for (const l of a.slice(endA)) lines.push(` ${l}`);
  return { added, removed, lines };
}

/** The unified patch body for one file's diff. */
function makePatch(filename: string, a: string[], b: string[], lines: string[]): string {
  return [
    `diff --git a/${filename} b/${filename}`,
    `--- a/${filename}`,
    `+++ b/${filename}`,
    `@@ -1,${a.length} +1,${b.length} @@`,
    ...lines,
    '',
  ].join('\n');
}

/** The text lines of a file, without its final newline making an empty trailing line. */
function linesOf(text: string): string[] {
  return text === '' ? [] : text.replace(/\n$/, '').split('\n');
}

/** Diff two trees into the pull request files list. */
export function diffTrees(store: ObjectStore, baseTree: string, headTree: string): FileDiff[] {
  const before = baseTree ? flattenTree(store, baseTree) : new Map<string, { oid: string; mode: string }>();
  const after = headTree ? flattenTree(store, headTree) : new Map<string, { oid: string; mode: string }>();
  const names = new Set<string>([...before.keys(), ...after.keys()]);
  const out: FileDiff[] = [];

  for (const name of [...names].sort()) {
    const b = before.get(name);
    const a = after.get(name);
    if (b && a && b.oid === a.oid) continue;
    const status: FileDiff['status'] = !b ? 'added' : !a ? 'removed' : 'modified';
    const textA = b ? (store.read(b.oid)?.data.toString('utf8') ?? '') : '';
    const textB = a ? (store.read(a.oid)?.data.toString('utf8') ?? '') : '';
    const linesA = linesOf(textA);
    const linesB = linesOf(textB);
    const d = lineDiff(linesA, linesB);
    out.push({
      filename: name,
      status,
      additions: d.added,
      deletions: d.removed,
      changes: d.added + d.removed,
      patch: makePatch(name, linesA, linesB, d.lines),
      sha: a?.oid ?? b?.oid ?? '',
    });
  }
  return out;
}

/** The blob id of a file at a commit's tree, or null. */
export function fileAtCommit(store: ObjectStore, commitOid: string, path: string): string | null {
  const c = readCommit(store, commitOid);
  if (!c) return null;
  const segs = path.split('/').filter((s) => s !== '');
  if (segs.length === 0) return null;
  let treeOid = c.tree;
  for (let i = 0; i < segs.length; i += 1) {
    const entry = readTree(store, treeOid).find((e) => e.name === segs[i]);
    if (!entry) return null;
    if (i === segs.length - 1) return entry.type === OBJ_BLOB ? entry.oid : null;
    if (entry.type !== OBJ_TREE) return null;
    treeOid = entry.oid;
  }
  return null;
}

/** The tree id at a path inside a tree (for a directory listing), or null. */
export function treeAtPath(store: ObjectStore, rootTree: string, path: string): string | null {
  let cur = rootTree;
  for (const seg of path.split('/').filter((s) => s !== '')) {
    const entry = readTree(store, cur).find((e) => e.name === seg);
    if (!entry || entry.type !== OBJ_TREE) return null;
    cur = entry.oid;
  }
  return cur;
}

/** The sha1 of a git blob, as the contents API reports it. */
export function blobSha(data: Buffer): string {
  return createHash('sha1').update(Buffer.from(`blob ${data.length}\0`, 'utf8')).update(data).digest('hex');
}
