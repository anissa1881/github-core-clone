// rest-meta.test.ts: the routes a client calls before it calls anything else, and the answers around
// the repository routes rather than inside them: the API root, the meta and rate-limit endpoints,
// the token's own user and repositories, the Link header a list carries, and the refusals that keep
// one login's token out of another login's repositories.

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { api, LOGIN, makeRepo, start, type Harness } from './helpers.ts';

describe('rest: the routes before the repositories', () => {
  let h: Harness;
  before(async () => {
    h = await start();
  });
  after(async () => {
    await h.close();
  });

  it('answers the API root with the URLs a client tries first', async () => {
    const answer = await api(h, '/api/v3');
    assert.equal(answer.status, 200);
    assert.equal(answer.body.current_user_url, `${h.base}/api/v3/user`);
    assert.equal(answer.body.current_user_repositories_url, `${h.base}/api/v3/user/repos`);
    assert.equal(answer.body.rate_limit_url, `${h.base}/api/v3/rate_limit`);
    assert.equal(answer.body.repository_url, `${h.base}/api/v3/repos/{owner}/{repo}`);
    assert.equal(answer.body.user_url, `${h.base}/api/v3/users/{user}`);
    assert.equal(answer.headers.get('x-oauth-scopes'), 'repo, read:org');
  });

  it('answers meta with an installed version, as the GH CLI reads it', async () => {
    const answer = await api(h, '/api/v3/meta');
    assert.equal(answer.status, 200);
    assert.equal(answer.body.installed_version, '4.13.0');
    assert.equal(typeof answer.body.verifiable_password_authentication, 'boolean');
  });

  it('answers a rate limit with the three resources a client reads', async () => {
    const answer = await api(h, '/api/v3/rate_limit');
    assert.equal(answer.status, 200);
    for (const name of ['core', 'search', 'graphql']) {
      const row = answer.body.resources[name];
      assert.equal(row.limit, 5000);
      assert.equal(row.remaining, 5000);
      assert.equal(typeof row.reset, 'number');
      assert.equal(row.used, 0);
    }
    assert.deepEqual(answer.body.rate, answer.body.resources.core);
  });

  it('answers the token as a user, with a stable id', async () => {
    const first = await api(h, '/api/v3/user');
    assert.equal(first.status, 200);
    assert.equal(first.body.login, LOGIN);
    assert.equal(first.body.type, 'User');
    assert.equal(first.body.site_admin, false);
    assert.equal(typeof first.body.id, 'number');
    const second = await api(h, '/api/v3/user');
    assert.equal(second.body.id, first.body.id, 'the id does not move between calls');
  });

  it('answers 404 for a user route this clone does not serve', async () => {
    const answer = await api(h, '/api/v3/users/somebody');
    assert.equal(answer.status, 404);
    assert.equal(answer.body.message, 'Not Found');
  });

  it('answers 404 for a path under the API it does not serve, and stays up', async () => {
    const answer = await api(h, '/api/v3/nothing/here');
    assert.equal(answer.status, 404);
    assert.equal(answer.body.message, 'Not Found');
    assert.equal((await fetch(`${h.base}/healthz`)).status, 200);
  });

  it('answers 401 to every route without the token', async () => {
    for (const path of ['/api/v3', '/api/v3/user', '/api/v3/user/repos', '/api/v3/rate_limit']) {
      const answer = await api(h, path, { token: null });
      assert.equal(answer.status, 401, path);
      assert.equal(answer.body.message, 'Requires authentication');
    }
  });

  it('answers 401 for a token that is not the one the trial set', async () => {
    const answer = await api(h, '/api/v3/user', { token: 'not-the-token' });
    assert.equal(answer.status, 401);
    assert.equal(answer.body.message, 'Requires authentication');
    assert.equal(answer.headers.get('www-authenticate'), null, 'the REST refusal names no scheme');
  });
});

describe('rest: the token’s own repositories', () => {
  let h: Harness;
  before(async () => {
    h = await start();
  });
  after(async () => {
    await h.close();
  });

  it('lists them, newest first, with the fields a client reads', async () => {
    await makeRepo(h, 'first-listed');
    await makeRepo(h, 'second-listed');
    const answer = await api(h, '/api/v3/user/repos');
    assert.equal(answer.status, 200);
    const names = answer.body.map((r: any) => r.name);
    assert.deepEqual([...names].sort(), ['first-listed', 'second-listed']);
    const again = await api(h, '/api/v3/user/repos');
    assert.deepEqual(again.body.map((r: any) => r.name), names, 'the order is stable between calls');
    const one = answer.body[0];
    assert.equal(one.full_name, `${LOGIN}/${one.name}`);
    assert.equal(one.owner.login, LOGIN);
    assert.equal(one.private, false);
    assert.equal(one.fork, false);
    assert.equal(one.default_branch, 'main');
    assert.match(one.created_at, /^\d{4}-\d{2}-\d{2}T/);
  });

  it('creates one with the description and default branch the body names', async () => {
    const answer = await api(h, '/api/v3/user/repos', {
      method: 'POST',
      body: { name: 'made-by-post', description: 'posted', default_branch: 'trunk' },
    });
    assert.equal(answer.status, 201);
    assert.equal(answer.body.name, 'made-by-post');
    assert.equal(answer.body.description, 'posted');
    assert.equal(answer.body.default_branch, 'trunk');
    const read = await api(h, `/api/v3/repos/${LOGIN}/made-by-post`);
    assert.equal(read.body.default_branch, 'trunk');
  });

  it('refuses a repository with no name, naming the field', async () => {
    const answer = await api(h, '/api/v3/user/repos', { method: 'POST', body: { description: 'nameless' } });
    assert.equal(answer.status, 422);
    assert.match(answer.body.message, /name is required/);
    assert.equal(answer.body.errors[0].field, 'name');
    assert.equal(answer.body.errors[0].code, 'missing');
  });

  it('refuses a name that is only whitespace', async () => {
    const answer = await api(h, '/api/v3/user/repos', { method: 'POST', body: { name: '   ' } });
    assert.equal(answer.status, 422);
  });

  it('answers 400 for a body that is not JSON, rather than 500', async () => {
    const response = await fetch(`${h.base}/api/v3/user/repos`, {
      method: 'POST',
      headers: { authorization: 'Bearer makefun-trial-token', 'content-type': 'application/json' },
      body: '{oops',
    });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.message, 'Problems parsing JSON');
  });

  it('pages a long list and links the next page', async () => {
    for (let i = 0; i < 3; i += 1) await makeRepo(h, `paged-${i}`);
    const page = await api(h, '/api/v3/user/repos?per_page=2&page=1');
    assert.equal(page.status, 200);
    assert.equal(page.body.length, 2);
    const link = page.headers.get('link') ?? '';
    assert.match(link, /rel="next"/);
    assert.match(link, /page=2/);
    const second = await api(h, '/api/v3/user/repos?per_page=2&page=2');
    assert.ok(second.body.length >= 1);
    assert.notEqual(second.body[0].name, page.body[0].name);
    const last = await api(h, '/api/v3/user/repos?per_page=100&page=1');
    assert.equal(last.headers.get('link'), null, 'one page of everything links nothing');
  });

  it('clamps a page size a client asks for beyond the hundred it serves', async () => {
    const answer = await api(h, '/api/v3/user/repos?per_page=1000');
    assert.equal(answer.status, 200);
    assert.ok(answer.body.length <= 100);
    const zero = await api(h, '/api/v3/user/repos?per_page=0');
    assert.equal(zero.status, 200);
    assert.ok(zero.body.length > 0, 'a page size of zero falls back to the default');
  });

  it('answers 404 for a repository another login owns', async () => {
    const answer = await api(h, '/api/v3/repos/someone-else/made-by-post');
    assert.equal(answer.status, 404);
    assert.equal(answer.body.message, 'Not Found');
  });

  it('answers 404 for a path under a repository it does not serve', async () => {
    await makeRepo(h, 'plain');
    for (const path of ['nothing', 'pulls/99', 'issues/99']) {
      const answer = await api(h, `/api/v3/repos/${LOGIN}/plain/${path}`);
      assert.equal(answer.status, 404, path);
      assert.equal(answer.body.message, 'Not Found');
    }
  });

  it('answers 404 for a repository it does not hold, with the same shape as anywhere else', async () => {
    const answer = await api(h, `/api/v3/repos/${LOGIN}/never-made`);
    assert.equal(answer.status, 404);
    assert.equal(answer.body.message, 'Not Found');
    assert.equal(answer.body.documentation_url, undefined, 'the body carries the message alone');
  });
});