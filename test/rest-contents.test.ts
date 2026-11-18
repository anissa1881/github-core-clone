// rest-contents.test.ts: the contents API over one repository's history — reading a file, listing a
// directory, creating, updating and deleting one, the shas an update must match, and the branch a
// write lands on. The branch a write names in its body wins over the query, which is the one rule a
// client leans on when it commits to a branch other than the default.

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { api, LOGIN, makeRepo, putFile, start, wrap64, type Harness } from './helpers.ts';

describe('contents: read and write one file', () => {
  let h: Harness;
  before(async () => {
    h = await start();
    await makeRepo(h, 'files');
  });
  after(async () => {
    await h.close();
  });

  it('creates a file and answers the content and the commit', async () => {
    const answer = await api(h, `/api/v3/repos/${LOGIN}/files/contents/readme.md`, {
      method: 'PUT',
      body: { message: 'add the readme', content: Buffer.from('# hello\n').toString('base64') },
    });
    assert.equal(answer.status, 201);
    assert.equal(answer.body.content.path, 'readme.md');
    assert.equal(answer.body.content.name, 'readme.md');
    assert.equal(answer.body.content.type, 'file');
    assert.equal(answer.body.content.encoding, 'base64');
    assert.equal(answer.body.content.content, wrap64('# hello\n'));
    assert.equal(answer.body.commit.message, 'add the readme');
    assert.match(answer.body.commit.sha, /^[0-9a-f]{40}$/);
    assert.equal(answer.body.commit.url, `${h.base}/api/v3/repos/${LOGIN}/files/commits/${answer.body.commit.sha}`);
  });

  it('reads the file back, wrapped at sixty characters', async () => {
    const answer = await api(h, `/api/v3/repos/${LOGIN}/files/contents/readme.md`);
    assert.equal(answer.status, 200);
    assert.equal(answer.body.content, wrap64('# hello\n'));
    assert.equal(answer.body.size, Buffer.byteLength('# hello\n'));
    assert.ok(answer.body.git_url.endsWith(`/git/blobs/${answer.body.sha}`));
  });

  it('answers 404 for a path the branch does not hold', async () => {
    const answer = await api(h, `/api/v3/repos/${LOGIN}/files/contents/nope.txt`);
    assert.equal(answer.status, 404);
    assert.equal(answer.body.message, 'Not Found');
  });

  it('updates a file, and refuses an update that names the wrong sha', async () => {
    const first = await api(h, `/api/v3/repos/${LOGIN}/files/contents/note.txt`, {
      method: 'PUT',
      body: { message: 'create', content: Buffer.from('one\n').toString('base64') },
    });
    assert.equal(first.status, 201);
    const sha = first.body.content.sha;
    const stale = await api(h, `/api/v3/repos/${LOGIN}/files/contents/note.txt`, {
      method: 'PUT',
      body: { message: 'update', content: Buffer.from('two\n').toString('base64'), sha: '0'.repeat(40) },
    });
    assert.equal(stale.status, 409);
    assert.match(stale.body.message, /does not match/);
    const updated = await api(h, `/api/v3/repos/${LOGIN}/files/contents/note.txt`, {
      method: 'PUT',
      body: { message: 'update', content: Buffer.from('two\n').toString('base64'), sha },
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.content.content, wrap64('two\n'));
    assert.equal(updated.body.commit.message, 'update');
  });

  it('refuses a create that names a sha for a path it does not hold', async () => {
    const answer = await api(h, `/api/v3/repos/${LOGIN}/files/contents/fresh.txt`, {
      method: 'PUT',
      body: { message: 'create', content: Buffer.from('x\n').toString('base64'), sha: '1'.repeat(40) },
    });
    assert.equal(answer.status, 422);
    assert.equal(answer.body.message, 'sha does not match any file');
  });

  it('lists a directory, naming each entry and its type', async () => {
    await putFile(h, 'files', 'docs/a.md', 'a\n', 'add a');
    await putFile(h, 'files', 'docs/b.md', 'b\n', 'add b');
    const answer = await api(h, `/api/v3/repos/${LOGIN}/files/contents/docs`);
    assert.equal(answer.status, 200);
    assert.ok(Array.isArray(answer.body));
    const names = answer.body.map((e: any) => e.name).sort();
    assert.deepEqual(names, ['a.md', 'b.md']);
    assert.equal(answer.body[0].type, 'file');
    assert.match(answer.body[0].path, /^docs\//);
  });

  it('wraps the base64 of a long file at sixty characters a line', async () => {
    const long = 'abcdefghij'.repeat(20);
    const written = await api(h, `/api/v3/repos/${LOGIN}/files/contents/long.txt`, {
      method: 'PUT',
      body: { message: 'add long', content: Buffer.from(long).toString('base64') },
    });
    assert.equal(written.status, 201);
    const read = await api(h, `/api/v3/repos/${LOGIN}/files/contents/long.txt`);
    const lines = String(read.body.content).split('\n');
    assert.ok(lines.length > 1);
    for (const line of lines) assert.ok(line.length <= 60, 'no line of the wrapped body exceeds sixty');
    assert.equal(lines.join(''), Buffer.from(long).toString('base64'));
  });

  it('lists the root when no path is named', async () => {
    const answer = await api(h, `/api/v3/repos/${LOGIN}/files/contents`);
    assert.equal(answer.status, 200);
    const paths = (answer.body as any[]).map((e) => e.path);
    assert.ok(paths.includes('readme.md'));
    // the listing walks the tree, so a nested file carries its full path
    assert.ok(paths.includes('docs/a.md'));
  });

  it('deletes a file and records the delete as a commit', async () => {
    await putFile(h, 'files', 'gone.txt', 'bye\n', 'add');
    const answer = await api(h, `/api/v3/repos/${LOGIN}/files/contents/gone.txt`, {
      method: 'DELETE',
      body: { message: 'remove it' },
    });
    assert.equal(answer.status, 200);
    assert.equal(answer.body.content, null);
    assert.equal(answer.body.commit.message, 'remove it');
    const read = await api(h, `/api/v3/repos/${LOGIN}/files/contents/gone.txt`);
    assert.equal(read.status, 404);
  });

  it('answers 400, not a crash, for a body that is not JSON', async () => {
    const response = await fetch(`${h.base}/api/v3/repos/${LOGIN}/files/contents/bad.txt`, {
      method: 'PUT',
      headers: {
        authorization: 'Bearer makefun-trial-token',
        'content-type': 'application/json',
      },
      body: 'this is not JSON',
    });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.message, 'Problems parsing JSON');
  });
});

describe('contents: the branch a write names', () => {
  let h: Harness;
  let baseSha: string;
  before(async () => {
    h = await start();
    await makeRepo(h, 'branchy');
    baseSha = await putFile(h, 'branchy', 'seed.txt', 'seed\n', 'the seed commit');
    const branch = await api(h, `/api/v3/repos/${LOGIN}/branchy`);
    assert.equal(branch.status, 200);
  });
  after(async () => {
    await h.close();
  });

  it('creates a branch by pointing a ref at the seed commit', async () => {
    const answer = await api(h, `/api/v3/repos/${LOGIN}/branchy/git/refs`, {
      method: 'POST',
      body: { ref: 'refs/heads/topic', sha: baseSha },
    });
    assert.equal(answer.status, 201);
    assert.equal(answer.body.ref, 'refs/heads/topic');
    assert.equal(answer.body.object.sha, baseSha);
  });

  it('refuses a ref that already exists', async () => {
    const answer = await api(h, `/api/v3/repos/${LOGIN}/branchy/git/refs`, {
      method: 'POST',
      body: { ref: 'refs/heads/topic', sha: baseSha },
    });
    assert.equal(answer.status, 422);
    assert.equal(answer.body.message, 'Reference already exists');
  });

  it('refuses a ref pointing at an object the store does not hold', async () => {
    const answer = await api(h, `/api/v3/repos/${LOGIN}/branchy/git/refs`, {
      method: 'POST',
      body: { ref: 'refs/heads/ghost', sha: '2'.repeat(40) },
    });
    assert.equal(answer.status, 422);
    assert.equal(answer.body.errors[0].field, 'sha');
  });

  it('commits to the branch named in the body, leaving the default branch alone', async () => {
    const written = await api(h, `/api/v3/repos/${LOGIN}/branchy/contents/on-topic.txt`, {
      method: 'PUT',
      body: { message: 'only on topic', content: Buffer.from('topic\n').toString('base64'), branch: 'topic' },
    });
    assert.equal(written.status, 201);
    const onTopic = await api(h, `/api/v3/repos/${LOGIN}/branchy/contents/on-topic.txt?ref=topic`);
    assert.equal(onTopic.status, 200);
    const onMain = await api(h, `/api/v3/repos/${LOGIN}/branchy/contents/on-topic.txt`);
    assert.equal(onMain.status, 404);
  });

  it('answers 404 when the body names a branch that does not exist', async () => {
    const answer = await api(h, `/api/v3/repos/${LOGIN}/branchy/contents/x.txt`, {
      method: 'PUT',
      body: { message: 'nowhere', content: Buffer.from('x\n').toString('base64'), branch: 'missing' },
    });
    assert.equal(answer.status, 404);
    assert.match(answer.body.message, /missing/);
  });

  it('reads the git blob and tree the contents routes point at', async () => {
    const file = await api(h, `/api/v3/repos/${LOGIN}/files/contents/readme.md`);
    if (file.status === 200) {
      const blob = await api(h, `/api/v3/repos/${LOGIN}/files/git/blobs/${file.body.sha}`);
      assert.equal(blob.status, 200);
      assert.equal(blob.body.sha, file.body.sha);
      assert.equal(blob.body.encoding, 'base64');
      assert.ok(blob.body.size > 0);
    }
    const commit = await api(h, `/api/v3/repos/${LOGIN}/branchy/commits/${baseSha}`);
    assert.equal(commit.status, 200);
    const tree = await api(h, `/api/v3/repos/${LOGIN}/branchy/git/trees/${commit.body.commit.tree.sha}`);
    assert.equal(tree.status, 200);
    assert.equal(tree.body.truncated, false);
    const entry = (tree.body.tree as any[]).find((e) => e.path === 'seed.txt');
    assert.ok(entry);
    assert.equal(entry.type, 'blob');
  });
});
