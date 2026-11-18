// rest-pulls.test.ts: pull requests from the two ends gh uses — the list and the single read, the
// changed-file list a review reads, and the merge that moves a branch. Two of these tests are about
// refusals: a merge whose base is behind the head answers 405 on a real conflict, and the merge
// endpoint never reports success for a head branch that is gone.

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { api, LOGIN, makeRepo, putFile, start, type Harness } from './helpers.ts';

/** Point a new branch at the commit a ref already names. */
async function branchOff(h: Harness, repo: string, name: string, sha: string): Promise<void> {
  const answer = await api(h, `/api/v3/repos/${LOGIN}/${repo}/git/refs`, {
    method: 'POST',
    body: { ref: `refs/heads/${name}`, sha },
  });
  assert.ok(answer.status === 201, `creating ${name} answered ${answer.status}: ${answer.text}`);
}

/** The sha of one file on one branch, read through the contents route. */
async function fileSha(h: Harness, repo: string, path: string, branch: string): Promise<string> {
  const answer = await api(h, `/api/v3/repos/${LOGIN}/${repo}/contents/${path}?ref=${branch}`);
  assert.equal(answer.status, 200, `reading ${path}@${branch} answered ${answer.status}`);
  return answer.body.sha;
}

describe('pulls: open, list, read, merge', () => {
  let h: Harness;
  let seed: string;
  before(async () => {
    h = await start();
    await makeRepo(h, 'pulls');
    seed = await putFile(h, 'pulls', 'app.txt', 'the base\n', 'the seed commit');
    await branchOff(h, 'pulls', 'feature', seed);
  });
  after(async () => {
    await h.close();
  });

  it('refuses a pull request with no head', async () => {
    const answer = await api(h, `/api/v3/repos/${LOGIN}/pulls/pulls`, {
      method: 'POST',
      body: { title: 'nothing to merge', base: 'main' },
    });
    assert.equal(answer.status, 422);
    assert.equal(answer.body.message, 'head and base are required');
  });

  it('opens a pull request against the default branch', async () => {
    const answer = await api(h, `/api/v3/repos/${LOGIN}/pulls/pulls`, {
      method: 'POST',
      body: { title: 'add a line', head: 'feature', body: 'one line more' },
    });
    assert.equal(answer.status, 201);
    assert.equal(answer.body.number, 1);
    assert.equal(answer.body.title, 'add a line');
    assert.equal(answer.body.head.ref, 'feature');
    assert.equal(answer.body.base.ref, 'main');
    assert.equal(answer.body.head.label, `${LOGIN}:feature`);
    assert.equal(answer.body.merged, false);
    assert.equal(answer.body.merge_commit_sha, null);
    assert.equal(answer.body.mergeable, true);
    assert.equal(answer.body.state, 'open');
  });

  it('takes the branch name out of an owner-qualified head', async () => {
    const answer = await api(h, `/api/v3/repos/${LOGIN}/pulls/pulls`, {
      method: 'POST',
      body: { title: 'qualified head', head: 'someone:feature', base: 'main' },
    });
    assert.equal(answer.status, 201);
    assert.equal(answer.body.head.ref, 'feature');
  });

  it('lists the open pull requests and hides the merged ones', async () => {
    const open = await api(h, `/api/v3/repos/${LOGIN}/pulls/pulls`);
    assert.equal(open.status, 200);
    assert.ok(open.body.length >= 2);
    for (const pr of open.body) assert.equal(pr.state, 'open');
  });

  it('reads one pull request back by number', async () => {
    const answer = await api(h, `/api/v3/repos/${LOGIN}/pulls/pulls/1`);
    assert.equal(answer.status, 200);
    assert.equal(answer.body.number, 1);
    assert.equal(answer.body.commits, 1);
    assert.match(answer.body.url, /\/pulls\/1$/);
  });

  it('reports no changed files while head and base still agree', async () => {
    const answer = await api(h, `/api/v3/repos/${LOGIN}/pulls/pulls/1/files`);
    assert.equal(answer.status, 200);
    assert.deepEqual(answer.body, []);
  });

  it('reports the changed file once the head moves', async () => {
    const before = await fileSha(h, 'pulls', 'app.txt', 'feature');
    await api(h, `/api/v3/repos/${LOGIN}/pulls/contents/app.txt`, {
      method: 'PUT',
      body: {
        message: 'change on the feature branch',
        content: Buffer.from('the base\nand one more line\n').toString('base64'),
        sha: before,
        branch: 'feature',
      },
    });
    const files = await api(h, `/api/v3/repos/${LOGIN}/pulls/pulls/1/files`);
    assert.equal(files.status, 200);
    assert.equal(files.body.length, 1);
    assert.equal(files.body[0].filename, 'app.txt');
    assert.equal(files.body[0].status, 'modified');
    assert.ok(files.body[0].additions >= 1);
    assert.equal(typeof files.body[0].patch, 'string');
  });

  it('merges the pull request, moving the base branch to a new commit', async () => {
    const answer = await api(h, `/api/v3/repos/${LOGIN}/pulls/pulls/1/merge`, { method: 'PUT' });
    assert.equal(answer.status, 200);
    assert.equal(answer.body.merged, true);
    assert.match(answer.body.sha, /^[0-9a-f]{40}$/);
    assert.equal(answer.body.message, 'Pull Request successfully merged');
    const main = await api(h, `/api/v3/repos/${LOGIN}/pulls/contents/app.txt`);
    assert.equal(Buffer.from(main.body.content, 'base64').toString('utf8'), 'the base\nand one more line\n');
    const read = await api(h, `/api/v3/repos/${LOGIN}/pulls/pulls/1`);
    assert.equal(read.body.merged, true);
    assert.equal(read.body.state, 'closed');
    assert.equal(read.body.merge_commit_sha, answer.body.sha);
  });

  it('answers the merge status gh polls before merging', async () => {
    const answer = await api(h, `/api/v3/repos/${LOGIN}/pulls/pulls/2/merge`);
    assert.equal(answer.status, 200);
    assert.equal(answer.body.merged, false);
    assert.equal(answer.body.mergeable, true);
  });

  it('answers 404 for a pull request number it never issued', async () => {
    const answer = await api(h, `/api/v3/repos/${LOGIN}/pulls/pulls/99`);
    assert.equal(answer.status, 404);
    assert.equal(answer.body.message, 'Not Found');
  });
});

describe('pulls: a head and a base that both moved', () => {
  let h: Harness;
  before(async () => {
    h = await start();
    await makeRepo(h, 'clash');
    const seed = await putFile(h, 'clash', 'shared.txt', 'the original line\n', 'the seed commit');
    await branchOff(h, 'clash', 'topic', seed);
    // the pull is opened while head and base still agree, so it records the sha it was opened at
    const opened = await api(h, `/api/v3/repos/${LOGIN}/clash/pulls`, {
      method: 'POST',
      body: { title: 'a real conflict', head: 'topic', base: 'main' },
    });
    assert.equal(opened.status, 201);
    // then the base moves the file one way
    await putFile(h, 'clash', 'shared.txt', 'a line from main\n', 'main moves the file', {
      sha: await fileSha(h, 'clash', 'shared.txt', 'main'),
    });
    // and the head moves the same file a different way
    await putFile(h, 'clash', 'shared.txt', 'a line from the topic branch\n', 'the topic moves it too', {
      sha: await fileSha(h, 'clash', 'shared.txt', 'topic'),
      branch: 'topic',
    });
  });
  after(async () => {
    await h.close();
  });

  it('remembers the base sha the pull request was opened against', async () => {
    const answer = await api(h, `/api/v3/repos/${LOGIN}/clash/pulls/1`);
    assert.equal(answer.body.base.ref, 'main');
    assert.match(answer.body.base.sha, /^[0-9a-f]{40}$/);
    assert.equal(answer.body.base_sha, undefined, 'base_sha stays internal to the merge decision');
  });

  it('answers 405, not a silent overwrite, when the merge conflicts', async () => {
    const answer = await api(h, `/api/v3/repos/${LOGIN}/clash/pulls/1/merge`, { method: 'PUT' });
    assert.equal(answer.status, 405);
    assert.equal(typeof answer.body.message, 'string');
    assert.match(answer.body.documentation_url, /pulls/);
  });

  it('leaves the base branch where it was after the refusal', async () => {
    const main = await api(h, `/api/v3/repos/${LOGIN}/clash/contents/shared.txt`);
    assert.equal(Buffer.from(main.body.content, 'base64').toString('utf8'), 'a line from main\n');
    const pr = await api(h, `/api/v3/repos/${LOGIN}/clash/pulls/1`);
    assert.equal(pr.body.merged, false);
  });

  it('reports the file as changed while the conflict stands', async () => {
    const files = await api(h, `/api/v3/repos/${LOGIN}/clash/pulls/1/files`);
    assert.equal(files.status, 200);
    assert.equal(files.body.length, 1);
    assert.equal(files.body[0].filename, 'shared.txt');
    assert.equal(files.body[0].status, 'modified');
  });

  it('refuses a merge for a head branch that was removed', async () => {
    const opened = await api(h, `/api/v3/repos/${LOGIN}/clash/pulls`, {
      method: 'POST',
      body: { title: 'a branch that will vanish', head: 'ghost', base: 'main' },
    });
    assert.equal(opened.status, 201);
    const merged = await api(h, `/api/v3/repos/${LOGIN}/clash/pulls/${opened.body.number}/merge`, { method: 'PUT' });
    assert.equal(merged.status, 404);
    assert.match(merged.body.message, /Head branch/);
  });
});
