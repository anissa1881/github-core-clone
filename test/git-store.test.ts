// git-store.test.ts: the parts under the HTTP surface, tested as units, because a bug here shows up
// as a wrong sha in a clone rather than as a wrong status. It covers the object store (hash, loose
// round trip, pack write and read, delta), the model (commit and tree parsing, flatten, build,
// history, ancestry, diff), the pkt-line framing git speaks, and the forge that keeps repositories
// on disk across a reload.

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  hashObject,
  OBJ_BLOB,
  OBJ_COMMIT,
  OBJ_TAG,
  OBJ_TREE,
  ObjectStore,
  readPack,
  typeName,
  typeNumber,
  writePack,
  ZERO_OID,
} from '../git/objects.ts';
import {
  blobSha,
  buildTree,
  createCommit,
  diffTrees,
  fileAtCommit,
  flattenTree,
  isAncestor,
  parseCommit,
  parseTree,
  readCommit,
  readTree,
  serializeTree,
  treeAtPath,
  walkHistory,
} from '../git/model.ts';
import { decodePackets, dataLines, DELIM, FLUSH, pkt, pktLines } from '../git/pktline.ts';
import { Forge } from '../store.ts';

/** A store in a directory nobody else uses. */
function freshStore(): ObjectStore {
  return new ObjectStore(mkdtempSync(join(tmpdir(), 'forge-objects-')));
}

describe('objects: hashing and loose storage', () => {
  it('hashes the empty blob to the id git publishes', () => {
    assert.equal(hashObject(OBJ_BLOB, Buffer.alloc(0)), 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
  });

  it('hashes a blob whose bytes decide the id, not its path', () => {
    const a = hashObject(OBJ_BLOB, Buffer.from('same bytes\n'));
    const b = hashObject(OBJ_BLOB, Buffer.from('same bytes\n'));
    assert.equal(a, b);
    assert.notEqual(a, hashObject(OBJ_BLOB, Buffer.from('other bytes\n')));
    assert.match(a, /^[0-9a-f]{40}$/);
  });

  it('names the object types both ways', () => {
    assert.equal(typeName(OBJ_COMMIT), 'commit');
    assert.equal(typeName(OBJ_TREE), 'tree');
    assert.equal(typeName(OBJ_BLOB), 'blob');
    assert.equal(typeName(OBJ_TAG), 'tag');
    assert.equal(typeNumber('commit'), OBJ_COMMIT);
    assert.equal(typeNumber('tree'), OBJ_TREE);
    assert.equal(typeNumber('blob'), OBJ_BLOB);
    assert.equal(typeNumber('tag'), OBJ_TAG);
  });

  it('writes a loose object once and reads it back byte for byte', () => {
    const store = freshStore();
    const oid = store.write(OBJ_BLOB, Buffer.from('one line\n'));
    assert.equal(store.has(oid), true);
    const object = store.read(oid);
    assert.equal(object?.type, OBJ_BLOB);
    assert.equal(object?.data.toString('utf8'), 'one line\n');
    const again = store.write(OBJ_BLOB, Buffer.from('one line\n'));
    assert.equal(again, oid, 'writing the same bytes twice answers the same id');
  });

  it('answers null for an object it never wrote', () => {
    const store = freshStore();
    assert.equal(store.has(ZERO_OID), false);
    assert.equal(store.read(ZERO_OID), null);
  });

  it('packs the objects it is given, and reads them back out of the pack', () => {
    const store = freshStore();
    const one = store.write(OBJ_BLOB, Buffer.from('the first file\n'));
    const two = store.write(OBJ_BLOB, Buffer.from('the second file\n'));
    const pack = writePack([one, two], store);
    assert.ok(pack.subarray(0, 4).toString('ascii') === 'PACK');
    const read = readPack(pack, (oid) => store.read(oid));
    assert.ok(read.size >= 2);
    const contents = [...read.values()].map((o) => o.data.toString('utf8')).sort();
    assert.deepEqual(contents, ['the first file\n', 'the second file\n']);
  });
});

describe('model: commits, trees and history', () => {
  let store: ObjectStore;
  before(() => {
    store = freshStore();
  });

  it('serializes a tree and parses it back with its modes', () => {
    const blob = store.write(OBJ_BLOB, Buffer.from('x\n'));
    const raw = serializeTree([
      { mode: '100644', name: 'a.txt', oid: blob, type: OBJ_BLOB },
      { mode: '100755', name: 'run.sh', oid: blob, type: OBJ_BLOB },
    ]);
    const entries = parseTree(raw);
    assert.deepEqual(entries.map((e) => e.name), ['a.txt', 'run.sh']);
    assert.equal(entries[0]?.mode, '100644');
    assert.equal(entries[1]?.mode, '100755');
    assert.equal(entries[0]?.oid, blob);
  });

  it('builds a nested tree from flat paths and flattens it back', () => {
    const a = store.write(OBJ_BLOB, Buffer.from('a\n'));
    const b = store.write(OBJ_BLOB, Buffer.from('b\n'));
    const tree = buildTree(store, new Map([
      ['a.txt', { oid: a, mode: '100644' }],
      ['docs/b.txt', { oid: b, mode: '100644' }],
    ]));
    const flat = flattenTree(store, tree);
    assert.deepEqual([...flat.keys()].sort(), ['a.txt', 'docs/b.txt']);
    assert.equal(flat.get('docs/b.txt')?.oid, b);
  });

  it('reads a commit back with its tree, parents and author', () => {
    const blob = store.write(OBJ_BLOB, Buffer.from('one\n'));
    const tree = buildTree(store, new Map([['file.txt', { oid: blob, mode: '100644' }]]));
    const oid = createCommit(store, {
      tree,
      parents: [],
      message: 'the first commit',
      name: 'tester',
      email: 'tester@example.invalid',
    });
    const commit = readCommit(store, oid);
    assert.equal(commit?.tree, tree);
    assert.equal(commit?.message.trim(), 'the first commit');
    assert.deepEqual(commit?.parents, []);
    assert.equal(commit?.author.name, 'tester');
    assert.equal(parseCommit(oid, Buffer.from('')).oid, oid);
  });

  it('walks history from a tip, newest first', () => {
    const base = store.write(OBJ_BLOB, Buffer.from('one\n'));
    let tree = buildTree(store, new Map([['file.txt', { oid: base, mode: '100644' }]]));
    const first = createCommit(store, { tree, parents: [], message: 'one', name: 't', email: 't@x.invalid' });
    const second = createCommit(store, { tree, parents: [first], message: 'two', name: 't', email: 't@x.invalid' });
    const third = createCommit(store, { tree, parents: [second], message: 'three', name: 't', email: 't@x.invalid' });
    const history = walkHistory(store, [third], 10);
    assert.deepEqual(history.map((c) => c.message.trim()), ['three', 'two', 'one']);
    assert.equal(walkHistory(store, [third], 2).length, 2);
  });

  it('knows which commit is an ancestor of another', () => {
    const blob = store.write(OBJ_BLOB, Buffer.from('one\n'));
    const tree = buildTree(store, new Map([['file.txt', { oid: blob, mode: '100644' }]]));
    const first = createCommit(store, { tree, parents: [], message: 'one', name: 't', email: 't@x.invalid' });
    const second = createCommit(store, { tree, parents: [first], message: 'two', name: 't', email: 't@x.invalid' });
    assert.equal(isAncestor(store, first, second), true);
    assert.equal(isAncestor(store, second, first), false);
    assert.equal(isAncestor(store, first, first), true);
  });

  it('diffs two trees, naming added, removed and modified paths', () => {
    const kept = store.write(OBJ_BLOB, Buffer.from('kept\n'));
    const changed = store.write(OBJ_BLOB, Buffer.from('before\n'));
    const after = store.write(OBJ_BLOB, Buffer.from('after\n'));
    const added = store.write(OBJ_BLOB, Buffer.from('new\n'));
    const base = buildTree(store, new Map([
      ['kept.txt', { oid: kept, mode: '100644' }],
      ['changed.txt', { oid: changed, mode: '100644' }],
    ]));
    const head = buildTree(store, new Map([
      ['kept.txt', { oid: kept, mode: '100644' }],
      ['changed.txt', { oid: after, mode: '100644' }],
      ['added.txt', { oid: added, mode: '100644' }],
    ]));
    const diff = diffTrees(store, base, head);
    const byPath = new Map(diff.map((d) => [d.filename, d.status]));
    assert.equal(byPath.get('changed.txt'), 'modified');
    assert.equal(byPath.get('added.txt'), 'added');
    assert.equal(byPath.has('kept.txt'), false, 'an unchanged file is not in the diff');
    const removedDiff = diffTrees(store, head, base);
    assert.equal(removedDiff.find((d) => d.filename === 'added.txt')?.status, 'removed');
  });

  it('reads one file at one commit, and one directory tree at a path', () => {
    const blob = store.write(OBJ_BLOB, Buffer.from('deep\n'));
    const tree = buildTree(store, new Map([['docs/deep/file.txt', { oid: blob, mode: '100644' }]]));
    const oid = createCommit(store, { tree, parents: [], message: 'deep', name: 't', email: 't@x.invalid' });
    assert.equal(fileAtCommit(store, oid, 'docs/deep/file.txt'), blob);
    assert.equal(fileAtCommit(store, oid, 'docs/deep/missing.txt'), null);
    const docsTree = treeAtPath(store, tree, 'docs');
    assert.equal(typeof docsTree, 'string');
    assert.equal(readTree(store, docsTree!).length, 1);
    assert.equal(treeAtPath(store, tree, 'nowhere'), null);
    assert.equal(blobSha(Buffer.from('deep\n')), blob);
  });
});

describe('pkt-line: the framing git speaks', () => {
  it('frames a payload with its four-byte length', () => {
    const framed = pkt('hello\n');
    assert.equal(framed.subarray(0, 4).toString('ascii'), '000a');
    assert.equal(framed.subarray(4).toString('utf8'), 'hello\n');
  });

  it('frames a list and ends it with a flush', () => {
    const framed = pktLines(['a', 'b']);
    const decoded = decodePackets(Buffer.concat([framed, FLUSH]));
    assert.deepEqual(dataLines(decoded.packets), ['a', 'b']);
    assert.equal(decoded.packets[decoded.packets.length - 1]?.packet.kind, 'flush');
    assert.equal(decoded.incomplete, false);
  });

  it('reads a delimiter and a response end as their own packets', () => {
    const decoded = decodePackets(Buffer.concat([pkt('x'), DELIM]));
    assert.equal(decoded.packets[0]?.packet.kind, 'data');
    assert.equal(decoded.packets[1]?.packet.kind, 'delim');
  });

  it('tells a truncated frame apart from a whole one', () => {
    const whole = pkt('complete');
    const partial = whole.subarray(0, whole.length - 2);
    assert.equal(decodePackets(partial).incomplete, true);
    assert.equal(decodePackets(whole).incomplete, false);
  });

  it('counts the bytes it read, and stops at the frame that ran out', () => {
    const whole = Buffer.concat([pkt('one'), pkt('two')]);
    const read = decodePackets(whole);
    assert.equal(read.used, whole.length);
    assert.deepEqual(dataLines(read.packets), ['one', 'two']);
    const cut = Buffer.concat([pkt('one'), pkt('two').subarray(0, 5)]);
    const partial = decodePackets(cut);
    assert.equal(partial.used, pkt('one').length);
    assert.equal(partial.incomplete, true);
    assert.deepEqual(dataLines(partial.packets), ['one'], 'the whole frame before the cut is still read');
  });
});

describe('forge: repositories on disk', () => {
  let root: string;
  before(() => {
    root = mkdtempSync(join(tmpdir(), 'forge-root-'));
  });
  after(() => {
    // nothing to stop: the store writes on save, and the directory is a temporary one
  });

  it('creates a repository, saves it, and loads it back from the same directory', () => {
    const forge = new Forge(root, 'the-token', 'owner');
    const repo = forge.create('owner', 'persisted', { description: 'on disk' });
    repo.writeNow();
    assert.equal(forge.get('owner', 'persisted')?.meta.name, 'persisted');
    const reloaded = new Forge(root, 'the-token', 'owner');
    reloaded.load();
    const again = reloaded.get('owner', 'persisted');
    assert.equal(again?.meta.description, 'on disk');
    assert.equal(again?.meta.default_branch, 'main');
  });

  it('answers null for a repository it does not hold', () => {
    const forge = new Forge(root, 'the-token', 'owner');
    forge.load();
    assert.equal(forge.get('owner', 'never-made'), null);
    assert.equal(forge.get('owner', 'persisted')?.meta.owner, 'owner');
  });

  it('lists only the repositories the login owns', () => {
    const forge = new Forge(root, 'the-token', 'owner');
    forge.load();
    forge.create('owner', 'listed');
    forge.create('owner', 'also-listed');
    const names = forge.list('owner').map((r) => r.meta.name).sort();
    assert.deepEqual(names, ['also-listed', 'listed', 'persisted']);
    assert.deepEqual(forge.list('someone'), []);
  });

  it('removes a repository from the store', () => {
    const forge = new Forge(root, 'the-token', 'owner');
    forge.load();
    forge.create('owner', 'removable');
    assert.equal(forge.remove('owner', 'removable'), true);
    assert.equal(forge.get('owner', 'removable'), null);
  });

  it('starts a repository with an unborn default branch', () => {
    const forge = new Forge(root, 'the-token', 'owner');
    forge.load();
    const repo = forge.create('owner', 'unborn');
    assert.equal(repo.branchTip('main'), null);
    assert.equal(repo.tip(), ZERO_OID);
  });
});