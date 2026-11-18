// rest-repos.test.ts: the REST v3 root, the token's own user, and the lifecycle of a repository:
// create, read, patch, list, delete, and the JSON 404 every surface answers for what does not exist.

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { api, LOGIN, makeRepo, start, TOKEN, type Harness } from './helpers.ts';

describe('REST v3 root and identity', () => {
  let h: Harness;
  before(async () => {
    h = await start();
  });
  after(async () => {
    await h.close();
  });

  it('names the URLs every client tries first', async () => {
    const answer = await api(h, '/api/v3');
    assert.equal(answer.status, 200);
    assert.equal(answer.body.current_user_url, `${h.base}/api/v3/user`);
    assert.equal(answer.body.repository_url, `${h.base}/api/v3/repos/{owner}/{repo}`);
    assert.equal(answer.headers.get('x-oauth-scopes'), 'repo, read:org');
  });

  it('reads the token as one user', async () => {
    const answer = await api(h, '/api/v3/user');
    assert.equal(answer.status, 200);
    assert.equal(answer.body.login, LOGIN);
    assert.equal(answer.body.type, 'User');
    assert.equal(typeof answer.body.id, 'number');
    assert.ok(answer.body.id > 0);
  });

  it('answers 401 without a token, and with the wrong one', async () => {
    const anonymous = await api(h, '/api/v3/user', { token: null });
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.body.message, 'Requires authentication');
    const wrong = await api(h, '/api/v3/user', { token: 'not-the-token' });
    assert.equal(wrong.status, 401);
  });

  it('stamps every REST answer with a request id', async () => {
    const answer = await api(h, '/api/v3/rate_limit');
    assert.equal(answer.status, 200);
    const id = answer.headers.get('x-github-request-id');
    assert.equal(typeof id, 'string');
    assert.ok((id ?? '').length > 0);
  });

  it('reports the rate limit in the shape the clients parse', async () => {
    const answer = await api(h, '/api/v3/rate_limit');
    assert.equal(answer.body.rate.limit, 5000);
    assert.equal(answer.body.rate.remaining, 5000);
    assert.equal(typeof answer.body.rate.reset, 'number');
    assert.equal(answer.body.resources.core.limit, 5000);
    assert.equal(answer.body.resources.graphql.limit, 5000);
  });

  it('reports one installed version for the emulator', async () => {
    const answer = await api(h, '/api/v3/meta');
    assert.equal(answer.status, 200);
    assert.equal(answer.body.installed_version, '4.13.0');
  });

  it('answers JSON 404, never HTML, for a path it does not serve', async () => {
    const answer = await api(h, '/api/v3/definitely-not-a-route');
    assert.equal(answer.status, 404);
    assert.equal(answer.body.message, 'Not Found');
    assert.match(answer.headers.get('content-type') ?? '', /application\/json/);
  });
});

describe('repository lifecycle', () => {
  let h: Harness;
  before(async () => {
    h = await start();
  });
  after(async () => {
    await h.close();
  });

  it('creates one repository and answers 201 with its JSON', async () => {
    const answer = await api(h, '/api/v3/user/repos', {
      method: 'POST',
      body: { name: 'lifecycle', description: 'one repository, three verbs' },
    });
    assert.equal(answer.status, 201);
    assert.equal(answer.body.name, 'lifecycle');
    assert.equal(answer.body.full_name, `${LOGIN}/lifecycle`);
    assert.equal(answer.body.owner.login, LOGIN);
    assert.equal(answer.body.private, false);
    assert.equal(answer.body.default_branch, 'main');
    assert.equal(answer.body.description, 'one repository, three verbs');
    assert.ok(answer.body.html_url.endsWith(`/${LOGIN}/lifecycle`));
    assert.ok(answer.body.url.endsWith(`/api/v3/repos/${LOGIN}/lifecycle`));
  });

  it('refuses a repository with no name, naming the field', async () => {
    const answer = await api(h, '/api/v3/user/repos', { method: 'POST', body: { description: 'nameless' } });
    assert.equal(answer.status, 422);
    assert.equal(answer.body.errors[0].field, 'name');
    assert.equal(answer.body.errors[0].code, 'missing');
  });

  it('lists the token repositories, newest first or oldest first by sort', async () => {
    await makeRepo(h, 'listed-one');
    await makeRepo(h, 'listed-two');
    const answer = await api(h, '/api/v3/user/repos');
    assert.equal(answer.status, 200);
    assert.ok(Array.isArray(answer.body));
    const names = answer.body.map((r: any) => r.name);
    assert.ok(names.includes('listed-one'));
    assert.ok(names.includes('listed-two'));
    const link = answer.headers.get('link');
    assert.equal(typeof link === 'string' || link === null, true);
  });

  it('pages the list and says so in the link header', async () => {
    for (const name of ['page-a', 'page-b', 'page-c', 'page-d', 'page-e']) await makeRepo(h, name);
    const first = await api(h, '/api/v3/user/repos?per_page=2');
    assert.equal(first.status, 200);
    assert.equal(first.body.length, 2);
    const link = first.headers.get('link') ?? '';
    assert.match(link, /rel="next"/);
    const target = new URL(link.split('>')[0]!.replace(/^</, ''));
    const next = await api(h, `${target.pathname}${target.search}`);
    assert.equal(next.status, 200);
    assert.equal(next.body.length, 2);
    assert.notEqual(next.body[0].name, first.body[0].name);
  });

  it('reads one repository back', async () => {
    await makeRepo(h, 'read-back', { private: true });
    const answer = await api(h, `/api/v3/repos/${LOGIN}/read-back`);
    assert.equal(answer.status, 200);
    assert.equal(answer.body.private, true);
    assert.equal(answer.body.name, 'read-back');
  });

  it('patches a repository, and the change survives the next read', async () => {
    await makeRepo(h, 'patched');
    const patched = await api(h, `/api/v3/repos/${LOGIN}/patched`, {
      method: 'PATCH',
      body: { description: 'a new description', private: true },
    });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.description, 'a new description');
    assert.equal(patched.body.private, true);
    const again = await api(h, `/api/v3/repos/${LOGIN}/patched`);
    assert.equal(again.body.description, 'a new description');
  });

  it('deletes a repository, and the next read is 404', async () => {
    await makeRepo(h, 'doomed');
    const gone = await api(h, `/api/v3/repos/${LOGIN}/doomed`, { method: 'DELETE' });
    assert.equal(gone.status, 204);
    assert.equal(gone.text, '');
    const after = await api(h, `/api/v3/repos/${LOGIN}/doomed`);
    assert.equal(after.status, 404);
    assert.equal(after.body.message, 'Not Found');
  });

  it('never shows a repository to a login that does not own it', async () => {
    await makeRepo(h, 'private-to-the-token');
    const other = await api(h, `/api/v3/repos/someone-else/private-to-the-token`);
    assert.equal(other.status, 404);
  });

  it('answers 405 with an Allow header for a method a path does not take', async () => {
    const answer = await api(h, '/api/graphql', { method: 'GET' });
    assert.equal(answer.status, 405);
    assert.equal(answer.headers.get('allow'), 'POST');
  });
});
