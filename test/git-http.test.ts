// git-http.test.ts: the smart-HTTP surface as a git client meets it. The ref advertisement is read
// as pkt-lines, so these tests decode what the server sent and check the first ref names the branch,
// the capabilities are there and, on protocol v2, the advertisement lists ls-refs and fetch. The
// refusals matter as much: a missing repository is 404 on both services, and the dumb protocol is
// 400 rather than a hang.

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { api, LOGIN, makeRepo, putFile, start, type Harness } from './helpers.ts';

/** The pkt-line payloads of a body, decoded without the four-byte headers. */
function payloads(body: Buffer): string[] {
  const out: string[] = [];
  let off = 0;
  while (off + 4 <= body.length) {
    const header = body.subarray(off, off + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) break;
    const len = parseInt(header, 16);
    if (len < 4) {
      off += 4;
      continue;
    }
    out.push(body.subarray(off + 4, off + len - 1).toString('utf8'));
    off += len;
  }
  return out;
}

describe('git smart http: refs and refusals', () => {
  let h: Harness;
  before(async () => {
    h = await start();
    await makeRepo(h, 'smart');
    await putFile(h, 'smart', 'file.txt', 'the first line\n', 'the first commit');
  });
  after(async () => {
    await h.close();
  });

  it('advertises the default branch as the first ref of upload-pack', async () => {
    const response = await fetch(`${h.base}/${LOGIN}/smart.git/info/refs?service=git-upload-pack`, {
      headers: { authorization: 'Bearer makefun-trial-token' },
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /application\/x-git-upload-pack-advertisement/);
    const body = Buffer.from(await response.arrayBuffer());
    const lines = payloads(body);
    assert.equal(lines[0], '# service=git-upload-pack');
    // the first ref carries the capability list after a NUL, as git's v0 advertisement does
    assert.match(lines[1] ?? '', /^[0-9a-f]{40} refs\/heads\/main\0/);
    const caps = (lines[1] ?? '').split('\0')[1] ?? '';
    assert.ok(caps.includes('symref=HEAD:refs/heads/main'), 'the advertisement says which ref HEAD follows');
    assert.ok(caps.includes('side-band-64k'));
    assert.ok(caps.includes('object-format=sha1'));
  });

  it('advertises the capabilities a push needs on receive-pack', async () => {
    const response = await fetch(`${h.base}/${LOGIN}/smart.git/info/refs?service=git-receive-pack`, {
      headers: { authorization: 'Bearer makefun-trial-token' },
    });
    assert.equal(response.status, 200);
    const text = response.headers.get('content-type') ?? '';
    assert.match(text, /application\/x-git-receive-pack-advertisement/);
    const lines = payloads(Buffer.from(await response.arrayBuffer()));
    const caps = lines[1] ?? '';
    for (const name of ['report-status', 'delete-refs', 'ofs-delta']) {
      assert.ok(caps.includes(name), `the advertisement names ${name}`);
    }
  });

  it('answers the v2 advertisement with a version line and its commands', async () => {
    const response = await fetch(`${h.base}/${LOGIN}/smart.git/info/refs?service=git-upload-pack`, {
      headers: { authorization: 'Bearer makefun-trial-token', 'git-protocol': 'version=2' },
    });
    assert.equal(response.status, 200);
    const lines = payloads(Buffer.from(await response.arrayBuffer()));
    assert.ok(lines.includes('version 2'), 'protocol v2 answers its own version line');
    assert.ok(lines.some((l) => l.startsWith('ls-refs')), 'v2 lists the ls-refs command');
    assert.ok(lines.some((l) => l.startsWith('fetch')), 'v2 lists the fetch command');
  });

  it('answers 400 for the dumb protocol a git client may still try', async () => {
    const response = await fetch(`${h.base}/${LOGIN}/smart.git/info/refs`, {
      headers: { authorization: 'Bearer makefun-trial-token' },
    });
    assert.equal(response.status, 400);
    assert.match(await response.text(), /Dumb HTTP protocol is not supported/);
  });

  it('answers 401 without the token, on both services', async () => {
    for (const service of ['git-upload-pack', 'git-receive-pack']) {
      const response = await fetch(`${h.base}/${LOGIN}/smart.git/info/refs?service=${service}`);
      assert.equal(response.status, 401, `${service} asked anonymously`);
      assert.match(response.headers.get('www-authenticate') ?? '', /Basic realm="GitHub"/);
    }
  });

  it('answers 404 for a repository that does not exist, and stays up', async () => {
    const response = await fetch(`${h.base}/${LOGIN}/nothing.git/info/refs?service=git-upload-pack`, {
      headers: { authorization: 'Bearer makefun-trial-token' },
    });
    assert.equal(response.status, 404);
    const body = await response.json();
    assert.equal(body.message, 'Not Found');
    const health = await fetch(`${h.base}/healthz`);
    assert.equal(health.status, 200);
  });

  it('accepts the token as git sends it, in Basic credentials', async () => {
    const basic = Buffer.from(`x-access-token:makefun-trial-token`).toString('base64');
    const response = await fetch(`${h.base}/${LOGIN}/smart.git/info/refs?service=git-upload-pack`, {
      headers: { authorization: `Basic ${basic}` },
    });
    assert.equal(response.status, 200);
  });

  it('lists the branch through the REST branches route as well', async () => {
    const listed = await api(h, `/api/v3/repos/${LOGIN}/smart/branches`);
    assert.equal(listed.status, 200);
    assert.equal(listed.body.length, 1);
    assert.equal(listed.body[0].name, 'main');
    assert.match(listed.body[0].commit.sha, /^[0-9a-f]{40}$/);
    const one = await api(h, `/api/v3/repos/${LOGIN}/smart/branches/main`);
    assert.equal(one.status, 200);
    assert.equal(one.body.commit.sha, listed.body[0].commit.sha);
    const missing = await api(h, `/api/v3/repos/${LOGIN}/smart/branches/nope`);
    assert.equal(missing.status, 404);
    assert.equal(missing.body.message, 'Branch not found');
  });

  it('walks the commit history of the branch and reads one commit', async () => {
    await putFile(h, 'smart', 'second.txt', 'the second line\n', 'the second commit');
    const log = await api(h, `/api/v3/repos/${LOGIN}/smart/commits?per_page=5`);
    assert.equal(log.status, 200);
    assert.ok(log.body.length >= 2);
    const newest = log.body[0];
    assert.equal(newest.commit.message, 'the second commit');
    assert.equal(newest.parents.length, 1);
    const one = await api(h, `/api/v3/repos/${LOGIN}/smart/commits/${newest.sha}`);
    assert.equal(one.status, 200);
    assert.equal(one.body.sha, newest.sha);
    const missing = await api(h, `/api/v3/repos/${LOGIN}/smart/commits/${'0'.repeat(40)}`);
    assert.equal(missing.status, 404);
    const status = await api(h, `/api/v3/repos/${LOGIN}/smart/commits/${newest.sha}/status`);
    assert.equal(status.body.state, 'success');
    assert.deepEqual(status.body.statuses, []);
  });

  it('answers an unborn branch with an empty history list', async () => {
    await makeRepo(h, 'empty');
    const log = await api(h, `/api/v3/repos/${LOGIN}/empty/commits`);
    assert.equal(log.status, 200);
    assert.deepEqual(log.body, []);
    const refs = await fetch(`${h.base}/${LOGIN}/empty.git/info/refs?service=git-upload-pack`, {
      headers: { authorization: 'Bearer makefun-trial-token' },
    });
    assert.equal(refs.status, 200);
    const lines = payloads(Buffer.from(await refs.arrayBuffer()));
    assert.equal(lines[0], '# service=git-upload-pack');
    const refLines = lines.filter((l) => /^[0-9a-f]{40} /.test(l));
    assert.equal(refLines.length, 1, 'an unborn repository advertises one line, and it is not a branch');
    assert.match(refLines[0] ?? '', /^0{40} capabilities\^\{\}/);
  });
});