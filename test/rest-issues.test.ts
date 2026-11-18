// rest-issues.test.ts: labels and issues. The clone keeps issue state in the repository's own
// metadata, so the checks here are about the contract gh relies on: a numbered issue that is 201 on
// create, filters that narrow the list, a close that fills closed_at, a comment count that counts,
// and a single-issue read that answers the markdown body rather than JSON.

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { api, LOGIN, makeRepo, start, type Harness } from './helpers.ts';

/** Create one issue and answer its JSON. */
async function openIssue(h: Harness, repo: string, title: string, extra: Record<string, unknown> = {}): Promise<any> {
  const answer = await api(h, `/api/v3/repos/${LOGIN}/${repo}/issues`, {
    method: 'POST',
    body: { title, ...extra },
  });
  assert.equal(answer.status, 201, `creating the issue answered ${answer.status}: ${answer.text}`);
  return answer.body;
}

describe('issues: create, read, list', () => {
  let h: Harness;
  before(async () => {
    h = await start();
    await makeRepo(h, 'issues');
  });
  after(async () => {
    await h.close();
  });

  it('creates an issue, numbering it from one', async () => {
    const issue = await openIssue(h, 'issues', 'the first issue', { body: 'a body' });
    assert.equal(issue.number, 1);
    assert.equal(issue.title, 'the first issue');
    assert.equal(issue.body, 'a body');
    assert.equal(issue.state, 'open');
    assert.equal(issue.closed_at, null);
    assert.equal(issue.comments, 0);
    assert.deepEqual(issue.labels, []);
    assert.deepEqual(issue.assignees, []);
    assert.equal(issue.user.login, LOGIN);
    assert.match(issue.url, /\/issues\/1$/);
    assert.match(issue.repository_url, /\/issues$/);
  });

  it('refuses an issue with no title', async () => {
    const answer = await api(h, `/api/v3/repos/${LOGIN}/issues/issues`, { method: 'POST', body: { body: 'no title' } });
    assert.equal(answer.status, 422);
    assert.equal(answer.body.message, 'title is required');
  });

  it('numbers the next issue after the ones already there', async () => {
    const second = await openIssue(h, 'issues', 'the second issue');
    assert.equal(second.number, 2);
    const third = await openIssue(h, 'issues', 'the third issue');
    assert.equal(third.number, 3);
  });

  it('lists the open issues, newest first by default', async () => {
    const answer = await api(h, `/api/v3/repos/${LOGIN}/issues/issues`);
    assert.equal(answer.status, 200);
    const numbers = (answer.body as any[]).map((i) => i.number);
    assert.deepEqual(numbers, [3, 2, 1]);
  });

  it('lists oldest first when the direction says so', async () => {
    const answer = await api(h, `/api/v3/repos/${LOGIN}/issues/issues?direction=asc`);
    const numbers = (answer.body as any[]).map((i) => i.number);
    assert.deepEqual(numbers, [1, 2, 3]);
  });

  it('breaks a same-second tie by number, newest first', async () => {
    // Issues opened back to back share a timestamp to the millisecond often enough that the sort has
    // to be total: GitHub answers the higher number first, so the list is stable whatever the clock
    // resolution. This is the order gh prints, and a list that tied would fall back to insertion order
    // and print the oldest of the burst first.
    await makeRepo(h, 'burst');
    for (let i = 1; i <= 5; i += 1) await openIssue(h, 'burst', `a burst, number ${i}`);
    const desc = await api(h, `/api/v3/repos/${LOGIN}/burst/issues?sort=created&direction=desc`);
    const down = (desc.body as any[]).map((i) => i.number);
    assert.deepEqual(down, [5, 4, 3, 2, 1]);
    const asc = await api(h, `/api/v3/repos/${LOGIN}/burst/issues?sort=created&direction=asc`);
    const up = (asc.body as any[]).map((i) => i.number);
    assert.deepEqual(up, [1, 2, 3, 4, 5]);
    const byUpdated = await api(h, `/api/v3/repos/${LOGIN}/burst/issues?sort=updated&direction=desc`);
    assert.equal(byUpdated.status, 200);
    assert.equal(byUpdated.body.length, 5);
    const asked = await api(h, `/api/v3/repos/${LOGIN}/burst/issues?per_page=2&page=2`);
    assert.equal(asked.body.length, 5, 'the issues list answers every issue it holds, so a page size changes nothing');
  });

  it('closes an issue through a patch, and stops listing it as open', async () => {
    const closed = await api(h, `/api/v3/repos/${LOGIN}/issues/issues/2`, {
      method: 'PATCH',
      body: { state: 'closed' },
    });
    assert.equal(closed.status, 200);
    assert.equal(closed.body.state, 'closed');
    assert.equal(typeof closed.body.closed_at, 'string');
    const open = await api(h, `/api/v3/repos/${LOGIN}/issues/issues`);
    assert.deepEqual((open.body as any[]).map((i) => i.number), [3, 1]);
    const all = await api(h, `/api/v3/repos/${LOGIN}/issues/issues?state=all`);
    assert.deepEqual((all.body as any[]).map((i) => i.number), [3, 2, 1]);
    const closedOnly = await api(h, `/api/v3/repos/${LOGIN}/issues/issues?state=closed`);
    assert.deepEqual((closedOnly.body as any[]).map((i) => i.number), [2]);
  });

  it('answers a single issue as the markdown body, not as JSON', async () => {
    const answer = await api(h, `/api/v3/repos/${LOGIN}/issues/issues/1`);
    assert.equal(answer.status, 200);
    const parsed = JSON.parse(answer.text);
    assert.equal(parsed.number, 1);
    assert.equal(parsed.title, 'the first issue');
  });

  it('answers 404 for an issue number it never issued', async () => {
    const answer = await api(h, `/api/v3/repos/${LOGIN}/issues/issues/999`);
    assert.equal(answer.status, 404);
    assert.equal(answer.body.message, 'Not Found');
  });

  it('answers 404 for issues under a repository that does not exist', async () => {
    const answer = await api(h, `/api/v3/repos/${LOGIN}/no-such-repo/issues`);
    assert.equal(answer.status, 404);
    assert.equal(answer.body.message, 'Not Found');
  });
});

describe('issues: labels and comments', () => {
  let h: Harness;
  before(async () => {
    h = await start();
    await makeRepo(h, 'labelled');
  });
  after(async () => {
    await h.close();
  });

  it('starts with no labels', async () => {
    const answer = await api(h, `/api/v3/repos/${LOGIN}/labelled/labels`);
    assert.equal(answer.status, 200);
    assert.deepEqual(answer.body, []);
  });

  it('creates a label, and refuses the same name twice', async () => {
    const created = await api(h, `/api/v3/repos/${LOGIN}/labelled/labels`, {
      method: 'POST',
      body: { name: 'bug', color: '#d73a4a', description: 'something is broken' },
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.name, 'bug');
    assert.equal(created.body.color, 'd73a4a', 'the leading hash is stripped, as GitHub strips it');
    assert.equal(created.body.description, 'something is broken');
    const again = await api(h, `/api/v3/repos/${LOGIN}/labelled/labels`, {
      method: 'POST',
      body: { name: 'bug' },
    });
    assert.equal(again.status, 422);
    assert.equal(again.body.errors[0].code, 'already_exists');
  });

  it('refuses a label with no name, and a colour it was not given defaults', async () => {
    const nameless = await api(h, `/api/v3/repos/${LOGIN}/labelled/labels`, { method: 'POST', body: {} });
    assert.equal(nameless.status, 422);
    assert.equal(nameless.body.message, 'name is required');
    const plain = await api(h, `/api/v3/repos/${LOGIN}/labelled/labels`, { method: 'POST', body: { name: 'plain' } });
    assert.equal(plain.status, 201);
    assert.equal(plain.body.color, 'ededed');
  });

  it('lists the labels it holds', async () => {
    const answer = await api(h, `/api/v3/repos/${LOGIN}/labelled/labels`);
    const names = (answer.body as any[]).map((l) => l.name).sort();
    assert.deepEqual(names, ['bug', 'plain']);
  });

  it('refuses an issue labelled with a name the repository does not hold', async () => {
    const answer = await api(h, `/api/v3/repos/${LOGIN}/labelled/issues`, {
      method: 'POST',
      body: { title: 'a labelled issue', labels: ['nope'] },
    });
    assert.equal(answer.status, 422);
    assert.equal(answer.body.errors[0].field, 'labels');
    assert.equal(answer.body.errors[0].value, 'nope');
  });

  it('creates an issue with labels, and filters the list by them', async () => {
    await api(h, `/api/v3/repos/${LOGIN}/labelled/issues`, {
      method: 'POST',
      body: { title: 'the bug report', labels: ['bug'] },
    });
    await api(h, `/api/v3/repos/${LOGIN}/labelled/issues`, {
      method: 'POST',
      body: { title: 'the other one', labels: ['plain'] },
    });
    const filtered = await api(h, `/api/v3/repos/${LOGIN}/labelled/issues?labels=bug`);
    assert.equal(filtered.status, 200);
    assert.equal(filtered.body.length, 1);
    assert.equal(filtered.body[0].title, 'the bug report');
    assert.deepEqual(filtered.body[0].labels.map((l: any) => l.name), ['bug']);
  });

  it('adds a comment and counts it on the issue', async () => {
    const issue = await openIssue(h, 'labelled', 'worth a discussion');
    const comment = await api(h, `/api/v3/repos/${LOGIN}/labelled/issues/${issue.number}/comments`, {
      method: 'POST',
      body: { body: 'the first word' },
    });
    assert.equal(comment.status, 201);
    assert.equal(comment.body.body, 'the first word');
    assert.equal(comment.body.user.login, LOGIN);
    const again = await api(h, `/api/v3/repos/${LOGIN}/labelled/issues/${issue.number}`);
    assert.equal(JSON.parse(again.text).comments, 1);
  });

  it('lists the comments it holds, oldest first', async () => {
    const listed = await api(h, `/api/v3/repos/${LOGIN}/labelled/issues/3/comments`);
    assert.equal(listed.status, 200);
    assert.equal(listed.body.length, 1);
    await api(h, `/api/v3/repos/${LOGIN}/labelled/issues/3/comments`, { method: 'POST', body: { body: 'and the second' } });
    const both = await api(h, `/api/v3/repos/${LOGIN}/labelled/issues/3/comments`);
    assert.deepEqual((both.body as any[]).map((c) => c.body), ['the first word', 'and the second']);
  });

  it('answers 404 for comments on an issue that does not exist', async () => {
    const answer = await api(h, `/api/v3/repos/${LOGIN}/labelled/issues/404/comments`);
    assert.equal(answer.status, 404);
  });
});
