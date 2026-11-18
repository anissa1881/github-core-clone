// rest-git-objects.test.ts: the routes gh uses when it builds a commit itself rather than asking the
// contents API to do it: create a ref, read the refs back, create a commit over a tree, and read a
// tree or a blob by sha. These routes decide what a branch points at, so the refusals matter: a sha
// that names nothing must not become a branch.

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { api, LOGIN, makeRepo, putFile, start, type Harness } from './helpers.ts';

/** The raw bytes a wrapped base64 blob decodes to. */
function decodeBlob(wrapped: string): string {
  assert.ok(wrapped.length <= 60 || wrapped.includes('\n'), 'the content is wrapped at sixty characters');
  return Buffer.from(wrapped.split('\n').join(''), 'base64').toString('utf8');
}

describe('rest: refs, commits, trees and blobs', () => {
  let h: Harness;
  let seed: string;
  before(async () => {
    h = await start();
    await makeRepo(h, 'objects');
    seed = await putFile(h, 'objects', 'a.txt', 'the first file\n', 'the first commit');
  });
  after(async () => {
    await h.close();
  });

  it('creates a branch by pointing a ref at a commit', async () => {
    const answer = await api(h, `/api/v3/repos/${LOGIN}/objects/git/refs`, {
      method: 'POST',
      body: { ref: 'refs/heads/made-by-ref', sha: seed },
    });
    assert.equal(answer.status, 201);
    assert.equal(answer.body.ref, 'refs/heads/made-by-ref');
    assert.equal(answer.body.object.sha, seed);
    assert.equal(answer.body.object.type, 'commit');
    const branches = await api(h, `/api/v3/repos/${LOGIN}/objects/branches`);
    assert.ok(branches.body.some((b: any) => b.name === 'made-by-ref'));
  });

  it('accepts the sha inside an object, as gh sends it', async () => {
    const answer = await api(h, `/api/v3/repos/${LOGIN}/objects/git/refs`, {
      method: 'POST',
      body: { ref: 'refs/heads/object-form', object: { sha: seed } },
    });
    assert.equal(answer.status, 201);
    assert.equal(answer.body.ref, 'refs/heads/object-form');
  });

  it('refuses a ref that already exists', async () => {
    const answer = await api(h, `/api/v3/repos/${LOGIN}/objects/git/refs`, {
      method: 'POST',
      body: { ref: 'refs/heads/object-form', sha: seed },
    });
    assert.equal(answer.status, 422);
    assert.match(answer.body.message, /already exists/);
  });

  it('refuses a sha that names no commit', async () => {
    const answer = await api(h, `/api/v3/repos/${LOGIN}/objects/git/refs`, {
      method: 'POST',
      body: { ref: 'refs/heads/nowhere', sha: '0'.repeat(40) },
    });
    assert.equal(answer.status, 422);
    assert.equal(answer.body.message, 'Object does not exist');
    assert.equal(answer.body.errors[0].field, 'sha');
    const branches = await api(h, `/api/v3/repos/${LOGIN}/objects/branches`);
    assert.equal(branches.body.some((b: any) => b.name === 'nowhere'), false, 'a refused ref is not created');
  });

  it('refuses a sha that is not forty hex characters', async () => {
    const answer = await api(h, `/api/v3/repos/${LOGIN}/objects/git/refs`, {
      method: 'POST',
      body: { ref: 'refs/heads/short', sha: 'abc123' },
    });
    assert.equal(answer.status, 422);
  });

  it('lists every ref, and reads one by its path', async () => {
    const listed = await api(h, `/api/v3/repos/${LOGIN}/objects/git/refs`);
    assert.equal(listed.status, 200);
    const refs = listed.body.map((r: any) => r.ref);
    assert.ok(refs.includes('refs/heads/main'));
    assert.ok(refs.includes('refs/heads/made-by-ref'));
    const one = await api(h, `/api/v3/repos/${LOGIN}/objects/git/refs/heads/made-by-ref`);
    assert.equal(one.status, 200);
    assert.equal(one.body.object.sha, seed);
    const missing = await api(h, `/api/v3/repos/${LOGIN}/objects/git/refs/heads/nothing`);
    assert.equal(missing.status, 404);
  });

  it('creates a commit over the tip tree, and the branch stays where it was', async () => {
    const before = await api(h, `/api/v3/repos/${LOGIN}/objects/commits/${seed}`);
    const answer = await api(h, `/api/v3/repos/${LOGIN}/objects/git/commits`, {
      method: 'POST',
      body: { message: 'a commit with no branch', parents: [seed] },
    });
    assert.equal(answer.status, 201);
    assert.match(answer.body.sha, /^[0-9a-f]{40}$/);
    assert.equal(answer.body.commit.tree.sha, before.body.commit.tree.sha, 'a commit with no tree reuses the tip tree');
    assert.deepEqual(answer.body.parents.map((p: any) => p.sha), [seed]);
    const main = await api(h, `/api/v3/repos/${LOGIN}/objects/branches/main`);
    assert.equal(main.body.commit.sha, seed, 'creating a commit moves no ref');
  });

  it('creates a commit over a tree the caller names', async () => {
    const commit = await api(h, `/api/v3/repos/${LOGIN}/objects/commits/${seed}`);
    const treeSha = commit.body.commit.tree.sha;
    const answer = await api(h, `/api/v3/repos/${LOGIN}/objects/git/commits`, {
      method: 'POST',
      body: { message: 'over a named tree', tree: treeSha, parents: [] },
    });
    assert.equal(answer.status, 201);
    assert.equal(answer.body.commit.tree.sha, treeSha);
    assert.deepEqual(answer.body.parents, []);
  });

  it('refuses a commit over a tree that is not there', async () => {
    const answer = await api(h, `/api/v3/repos/${LOGIN}/objects/git/commits`, {
      method: 'POST',
      body: { message: 'nothing to point at', tree: '1'.repeat(40) },
    });
    assert.equal(answer.status, 422);
    assert.match(answer.body.message, /Tree not found/);
  });

  it('reads a tree by sha, naming each entry with its mode and type', async () => {
    const commit = await api(h, `/api/v3/repos/${LOGIN}/objects/commits/${seed}`);
    const tree = await api(h, `/api/v3/repos/${LOGIN}/objects/git/trees/${commit.body.commit.tree.sha}`);
    assert.equal(tree.status, 200);
    assert.equal(tree.body.sha, commit.body.commit.tree.sha);
    assert.equal(tree.body.truncated, false);
    const entry = tree.body.tree.find((e: any) => e.path === 'a.txt');
    assert.equal(entry.mode, '100644');
    assert.equal(entry.type, 'blob');
    assert.match(entry.sha, /^[0-9a-f]{40}$/);
    const missing = await api(h, `/api/v3/repos/${LOGIN}/objects/git/trees/${'2'.repeat(40)}`);
    assert.equal(missing.status, 404);
  });

  it('reads a blob as wrapped base64, and the bytes are the file', async () => {
    const commit = await api(h, `/api/v3/repos/${LOGIN}/objects/commits/${seed}`);
    const tree = await api(h, `/api/v3/repos/${LOGIN}/objects/git/trees/${commit.body.commit.tree.sha}`);
    const entry = tree.body.tree.find((e: any) => e.path === 'a.txt');
    const blob = await api(h, `/api/v3/repos/${LOGIN}/objects/git/blobs/${entry.sha}`);
    assert.equal(blob.status, 200);
    assert.equal(blob.body.encoding, 'base64');
    assert.equal(blob.body.sha, entry.sha);
    assert.equal(blob.body.size, Buffer.byteLength('the first file\n'));
    assert.equal(decodeBlob(blob.body.content), 'the first file\n');
    const missing = await api(h, `/api/v3/repos/${LOGIN}/objects/git/blobs/${'3'.repeat(40)}`);
    assert.equal(missing.status, 404);
  });

  it('builds a nested tree the way a client that creates directories expects', async () => {
    await putFile(h, 'objects', 'docs/nested/readme.md', 'nested\n', 'add a nested file');
    const main = await api(h, `/api/v3/repos/${LOGIN}/objects/branches/main`);
    const tip = await api(h, `/api/v3/repos/${LOGIN}/objects/commits/${main.body.commit.sha}`);
    const root = tip.body.commit.tree.sha;
    const top = await api(h, `/api/v3/repos/${LOGIN}/objects/git/trees/${root}`);
    const docs = top.body.tree.find((e: any) => e.path === 'docs');
    assert.equal(docs.type, 'tree');
    const inner = await api(h, `/api/v3/repos/${LOGIN}/objects/git/trees/${docs.sha}`);
    assert.equal(inner.body.tree[0].path, 'nested');
    assert.equal(inner.body.tree[0].type, 'tree');
  });

  it('answers 404 to a git object route under a repository it does not hold', async () => {
    const answer = await api(h, `/api/v3/repos/${LOGIN}/nothing-here/git/refs`);
    assert.equal(answer.status, 404);
    assert.equal(answer.body.message, 'Not Found');
  });
});