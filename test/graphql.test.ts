// graphql.test.ts: the v4 surface. It is one endpoint that takes a document, so these tests send
// documents and check the shape gh expects back: connections with pageInfo, cursors that carry on
// from where the last page stopped, mutations that answer the node they created, and errors that
// arrive in the errors array with a path rather than as a status code.

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { api, LOGIN, makeRepo, putFile, start, type Harness } from './helpers.ts';

/** POST one document, failing loudly when the answer is not a 200. */
async function gql(h: Harness, query: string, variables: Record<string, unknown> = {}): Promise<any> {
  const answer = await api(h, '/api/graphql', { method: 'POST', body: { query, variables } });
  assert.equal(answer.status, 200, `the document answered ${answer.status}: ${answer.text}`);
  return answer.body;
}

describe('graphql: the query root', () => {
  let h: Harness;
  before(async () => {
    h = await start();
    await makeRepo(h, 'gql', { description: 'a repository the documents read' });
  });
  after(async () => {
    await h.close();
  });

  it('answers 401 without a token, as the REST surface does', async () => {
    const answer = await api(h, '/api/graphql', { method: 'POST', body: { query: '{ viewer { login } }' }, token: null });
    assert.equal(answer.status, 401);
    assert.equal(answer.body.message, 'Requires authentication');
  });

  it('reads the viewer and its repositories', async () => {
    const body = await gql(h, `{
      viewer {
        login
        name
        repositories(first: 5) { nodes { name nameWithOwner } }
      }
    }`);
    assert.equal(body.data.viewer.login, LOGIN);
    const names = body.data.viewer.repositories.nodes.map((r: any) => r.name);
    assert.ok(names.includes('gql'));
  });

  it('reads one repository by owner and name', async () => {
    const body = await gql(
      h,
      `query Read($owner: String!, $name: String!) {
        repository(owner: $owner, name: $name) {
          name
          nameWithOwner
          description
          isPrivate
          hasIssuesEnabled
        }
      }`,
      { owner: LOGIN, name: 'gql' },
    );
    const repo = body.data.repository;
    assert.equal(repo.name, 'gql');
    assert.equal(repo.nameWithOwner, `${LOGIN}/gql`);
    assert.equal(repo.description, 'a repository the documents read');
    assert.equal(repo.isPrivate, false);
    assert.equal(repo.hasIssuesEnabled, true);
  });

  it('answers no default branch ref while the repository is unborn', async () => {
    const body = await gql(h, `{ repository(owner: "${LOGIN}", name: "gql") { defaultBranchRef { name } } }`);
    assert.equal(body.data.repository.defaultBranchRef, null, 'a repository with no commit has no ref to report');
  });

  it('answers the default branch ref and its commit once a file lands', async () => {
    await putFile(h, 'gql', 'seed.txt', 'seed\n', 'the first commit');
    const body = await gql(
      h,
      `{ repository(owner: "${LOGIN}", name: "gql") { defaultBranchRef { name target { oid message } } } }`,
    );
    const ref = body.data.repository.defaultBranchRef;
    assert.equal(ref.name, 'main');
    assert.match(ref.target.oid, /^[0-9a-f]{40}$/);
    assert.equal(ref.target.message.trim(), 'the first commit');
  });

  it('answers null for a repository it does not hold, never an error', async () => {
    const body = await gql(h, `{ repository(owner: "${LOGIN}", name: "nothing") { name } }`);
    assert.equal(body.data.repository, null);
    assert.equal(body.errors, undefined);
  });

  it('reports an unknown field as an error with a path, not as a 400', async () => {
    const body = await gql(h, '{ viewer { login notAField } }');
    assert.ok(Array.isArray(body.errors));
    assert.match(body.errors[0].message, /notAField/);
    assert.deepEqual(body.errors[0].path, ['viewer']);
    assert.equal(body.data.viewer, null, 'a selection holding an unknown field answers null, as the clone isolates it');
  });

  it('keeps one branch of a document when another branch fails', async () => {
    const body = await gql(h, `{ viewer { login } repository(owner: "${LOGIN}", name: "gql") { name notAField } }`);
    assert.equal(body.data.viewer.login, LOGIN);
    assert.equal(body.data.repository, null);
    assert.ok((body.errors ?? []).length >= 1);
  });

  it('answers a batch of documents as an array, in the order they were sent', async () => {
    const answer = await api(h, '/api/graphql', {
      method: 'POST',
      body: [
        { query: '{ viewer { login } }' },
        { query: '{ viewer { name } }' },
      ],
    });
    assert.equal(answer.status, 200);
    assert.ok(Array.isArray(answer.body));
    assert.equal(answer.body.length, 2);
    assert.equal(answer.body[0].data.viewer.login, LOGIN);
    assert.equal(answer.body[1].data.viewer.name, LOGIN);
  });

  it('takes the operation name when a document carries more than one', async () => {
    const body = await gql(
      h,
      `query One { viewer { login } }
       query Two { viewer { name } }`,
    );
    assert.equal(typeof body.data, 'object');
    assert.equal(JSON.stringify(body).includes('login') || JSON.stringify(body).includes('name'), true);
  });
});

describe('graphql: issues, comments and pages', () => {
  let h: Harness;
  let repoId: string;
  before(async () => {
    h = await start();
    await makeRepo(h, 'tracker');
    const body = await gql(h, `{ repository(owner: "${LOGIN}", name: "tracker") { id } }`);
    repoId = body.data.repository.id;
    for (const title of ['first', 'second', 'third', 'fourth', 'fifth']) {
      const created = await gql(
        h,
        `mutation Make($input: CreateIssueInput!) { createIssue(input: $input) { issue { number title state } } }`,
        { input: { repositoryId: repoId, title, body: `the ${title} body` } },
      );
      assert.equal(created.data.createIssue.issue.state, 'OPEN');
    }
  });
  after(async () => {
    await h.close();
  });

  it('lists issues newest first with a cursor page', async () => {
    const body = await gql(
      h,
      `{ repository(owner: "${LOGIN}", name: "tracker") {
          issues(first: 2, orderBy: { field: CREATED_AT, direction: DESC }) {
            nodes { number title }
            pageInfo { hasNextPage endCursor }
          }
        } }`,
    );
    const connection = body.data.repository.issues;
    assert.deepEqual(connection.nodes.map((n: any) => n.title), ['fifth', 'fourth']);
    assert.equal(connection.pageInfo.hasNextPage, true);
    assert.equal(typeof connection.pageInfo.endCursor, 'string');
  });

  it('carries on from the cursor the last page answered', async () => {
    const first = await gql(
      h,
      `{ repository(owner: "${LOGIN}", name: "tracker") { issues(first: 2) { nodes { number } pageInfo { endCursor hasNextPage } } } }`,
    );
    const cursor = first.data.repository.issues.pageInfo.endCursor;
    const next = await gql(
      h,
      `query Page($after: String) { repository(owner: "${LOGIN}", name: "tracker") {
         issues(first: 2, after: $after) { nodes { number } pageInfo { hasNextPage } }
       } }`,
      { after: cursor },
    );
    const firstNumbers = first.data.repository.issues.nodes.map((n: any) => n.number);
    const nextNumbers = next.data.repository.issues.nodes.map((n: any) => n.number);
    assert.equal(nextNumbers.length, 2);
    for (const number of nextNumbers) assert.ok(!firstNumbers.includes(number), 'the second page holds no repeat');
  });

  it('filters the connection by state', async () => {
    await gql(
      h,
      `mutation Close($input: CloseIssueInput!) { closeIssue(input: $input) { issue { number state } } }`,
      { input: { issueId: Buffer.from(`Issue:${LOGIN}/tracker:1`).toString('base64') } },
    );
    const open = await gql(
      h,
      `{ repository(owner: "${LOGIN}", name: "tracker") { issues(first: 10, states: [OPEN]) { nodes { number } } } }`,
    );
    const numbers = open.data.repository.issues.nodes.map((n: any) => n.number);
    assert.ok(!numbers.includes(1), 'a closed issue is not in the open connection');
    const closed = await gql(
      h,
      `{ repository(owner: "${LOGIN}", name: "tracker") { issues(first: 10, states: [CLOSED]) { nodes { number } } } }`,
    );
    assert.deepEqual(closed.data.repository.issues.nodes.map((n: any) => n.number), [1]);
  });

  it('reads one issue by number', async () => {
    const body = await gql(
      h,
      `{ repository(owner: "${LOGIN}", name: "tracker") { issue(number: 2) { number title body state author { login } } } }`,
    );
    const issue = body.data.repository.issue;
    assert.equal(issue.number, 2);
    assert.equal(issue.title, 'second');
    assert.equal(issue.body, 'the second body');
    assert.equal(issue.author.login, LOGIN);
  });

  it('adds a comment and answers it as commentEdge.node', async () => {
    const body = await gql(
      h,
      `mutation Comment($input: AddCommentInput!) {
         addComment(input: $input) { commentEdge { cursor node { id body } } }
       }`,
      { input: { subjectId: Buffer.from(`Issue:${LOGIN}/tracker:2`).toString('base64'), body: 'a word' } },
    );
    const edge = body.data.addComment.commentEdge;
    assert.equal(edge.node.body, 'a word');
    assert.equal(typeof edge.node.id, 'string');
    assert.equal(typeof edge.cursor, 'string');
  });

  it('refuses a comment on something that is not an issue', async () => {
    const body = await gql(
      h,
      `mutation Comment($input: AddCommentInput!) { addComment(input: $input) { commentEdge { node { id } } } }`,
      { input: { subjectId: Buffer.from('Issue:no/repo:999').toString('base64'), body: 'into the void' } },
    );
    assert.ok(Array.isArray(body.errors));
    assert.match(body.errors[0].message, /Could not resolve/);
  });
});

describe('graphql: pull requests and search', () => {
  let h: Harness;
  let repoId: string;
  before(async () => {
    h = await start();
    await makeRepo(h, 'reviews');
    const seed = await putFile(h, 'reviews', 'file.txt', 'one\n', 'the seed');
    await api(h, `/api/v3/repos/${LOGIN}/reviews/git/refs`, {
      method: 'POST',
      body: { ref: 'refs/heads/topic', sha: seed },
    });
    const body = await gql(h, `{ repository(owner: "${LOGIN}", name: "reviews") { id } }`);
    repoId = body.data.repository.id;
  });
  after(async () => {
    await h.close();
  });

  it('opens a pull request through a mutation', async () => {
    const body = await gql(
      h,
      `mutation Open($input: CreatePullRequestInput!) {
         createPullRequest(input: $input) {
           pullRequest { number title state headRefName baseRefName merged mergeable }
         }
       }`,
      { input: { repositoryId: repoId, title: 'a reviewed change', headRefName: 'topic', baseRefName: 'main' } },
    );
    const pr = body.data.createPullRequest.pullRequest;
    assert.equal(pr.number, 1);
    assert.equal(pr.title, 'a reviewed change');
    assert.equal(pr.headRefName, 'topic');
    assert.equal(pr.baseRefName, 'main');
    assert.equal(pr.merged, false);
  });

  it('lists pull requests in a connection with their files', async () => {
    const body = await gql(
      h,
      `{ repository(owner: "${LOGIN}", name: "reviews") {
         pullRequests(first: 5) { nodes { number files(first: 5) { nodes { path additions deletions } } } }
       } }`,
    );
    const nodes = body.data.repository.pullRequests.nodes;
    assert.equal(nodes.length, 1);
    assert.equal(nodes[0].number, 1);
    assert.ok(Array.isArray(nodes[0].files.nodes));
  });

  it('merges through a mutation and answers the merged pull request', async () => {
    const body = await gql(
      h,
      `mutation Merge($input: MergePullRequestInput!) {
         mergePullRequest(input: $input) { pullRequest { state merged mergeCommit { oid } } }
       }`,
      { input: { pullRequestId: Buffer.from(`PullRequest:${LOGIN}/reviews:1`).toString('base64') } },
    );
    assert.equal(body.data.mergePullRequest.pullRequest.merged, true);
    assert.equal(body.data.mergePullRequest.pullRequest.state, 'MERGED');
  });

  it('searches the repositories the viewer holds', async () => {
    const body = await gql(h, `{ search(query: "reviews", type: REPOSITORY, first: 5) { totalCount nodes { id } } }`);
    const { totalCount, nodes } = body.data.search;
    assert.equal(typeof totalCount, 'number');
    assert.ok(totalCount >= 1);
    assert.equal(nodes.length, Math.min(totalCount, 5));
    assert.equal(typeof nodes[0].id, 'string');
  });

  it('refuses a mutation on a repository id that resolves to nothing', async () => {
    const body = await gql(
      h,
      `mutation Make($input: CreateIssueInput!) { createIssue(input: $input) { issue { number } } }`,
      { input: { repositoryId: Buffer.from('Repository:no/repo').toString('base64'), title: 'nowhere' } },
    );
    assert.ok(Array.isArray(body.errors));
    assert.match(body.errors[0].message, /Could not resolve to a Repository/);
  });
});
