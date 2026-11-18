// mcp.test.ts: the Streamable HTTP endpoint. One POST carries one JSON-RPC request or a batch of
// them; a notification answers 202 with no body; a tool answers a text block holding JSON. These
// tests walk the handshake, the tool list and every tool, plus the four ways a request can fail:
// no token, bad JSON, an unknown method and a missing argument.

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { api, LOGIN, makeRepo, putFile, start, type Harness } from './helpers.ts';

/** POST one JSON-RPC body to /mcp and answer the status and the parsed body. */
async function rpc(h: Harness, body: unknown, token: string | null = 'makefun-trial-token'): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`${h.base}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text === '' ? null : JSON.parse(text) };
}

/** Call one tool and answer the JSON it put in its text block. */
async function call(h: Harness, name: string, args: Record<string, unknown>): Promise<any> {
  const answer = await rpc(h, { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name, arguments: args } });
  assert.equal(answer.status, 200, `calling ${name} answered ${answer.status}`);
  assert.ok(answer.body.result, `calling ${name} answered no result: ${JSON.stringify(answer.body)}`);
  const block = answer.body.result.content[0];
  assert.equal(block.type, 'text');
  if (answer.body.result.isError === true) return { refused: block.text };
  return JSON.parse(block.text);
}

describe('mcp: the handshake and the tool list', () => {
  let h: Harness;
  before(async () => {
    h = await start();
  });
  after(async () => {
    await h.close();
  });

  it('answers 401 to a request with no token', async () => {
    const answer = await rpc(h, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, null);
    assert.equal(answer.status, 401);
    assert.equal(answer.body.error.code, -32001);
  });

  it('answers 400, not a crash, for a body that is not JSON', async () => {
    const response = await fetch(`${h.base}/mcp`, {
      method: 'POST',
      headers: { authorization: 'Bearer makefun-trial-token', 'content-type': 'application/json' },
      body: '{not json',
    });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.error.code, -32700);
  });

  it('initializes with the revision the client asked for, or its own', async () => {
    const answer = await rpc(h, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
    });
    assert.equal(answer.status, 200);
    assert.equal(answer.body.jsonrpc, '2.0');
    assert.equal(answer.body.id, 1);
    assert.equal(answer.body.result.protocolVersion, '2025-06-18');
    assert.equal(answer.body.result.serverInfo.name, 'makefun-forge');
    assert.equal(answer.body.result.capabilities.tools.listChanged, false);
  });

  it('falls back to its own revision for one it does not speak', async () => {
    const answer = await rpc(h, { jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } });
    assert.equal(typeof answer.body.result.protocolVersion, 'string');
    assert.notEqual(answer.body.result.protocolVersion, '1999-01-01');
  });

  it('answers a notification with 202 and no body', async () => {
    const answer = await rpc(h, { jsonrpc: '2.0', method: 'notifications/initialized' });
    assert.equal(answer.status, 202);
    assert.equal(answer.body, null);
  });

  it('answers ping', async () => {
    const answer = await rpc(h, { jsonrpc: '2.0', id: 3, method: 'ping' });
    assert.deepEqual(answer.body.result, {});
  });

  it('lists the tools with a name, a description and a schema each', async () => {
    const answer = await rpc(h, { jsonrpc: '2.0', id: 4, method: 'tools/list' });
    const tools = answer.body.result.tools as any[];
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      'create_issue',
      'create_pull_request',
      'create_repo',
      'get_issue',
      'get_repo',
      'list_issues',
      'list_pull_requests',
      'merge_pull_request',
    ]);
    for (const tool of tools) {
      assert.equal(typeof tool.description, 'string');
      assert.ok(tool.description.length > 0);
      assert.equal(tool.inputSchema.type, 'object');
    }
    const create = tools.find((t) => t.name === 'create_issue');
    assert.deepEqual(create.inputSchema.required, ['title']);
  });

  it('answers the same tool list twice, byte for byte', async () => {
    const first = await rpc(h, { jsonrpc: '2.0', id: 5, method: 'tools/list' });
    const second = await rpc(h, { jsonrpc: '2.0', id: 5, method: 'tools/list' });
    assert.equal(JSON.stringify(first.body), JSON.stringify(second.body));
  });

  it('answers empty resource and prompt lists', async () => {
    const resources = await rpc(h, { jsonrpc: '2.0', id: 6, method: 'resources/list' });
    assert.deepEqual(resources.body.result.resources, []);
    const prompts = await rpc(h, { jsonrpc: '2.0', id: 7, method: 'prompts/list' });
    assert.deepEqual(prompts.body.result.prompts, []);
  });

  it('refuses an unknown method with -32601', async () => {
    const answer = await rpc(h, { jsonrpc: '2.0', id: 8, method: 'tools/nope' });
    assert.equal(answer.body.error.code, -32601);
    assert.match(answer.body.error.message, /tools\/nope/);
  });

  it('refuses an unknown tool with -32601, naming it', async () => {
    const answer = await rpc(h, { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'delete_everything', arguments: {} } });
    assert.equal(answer.body.error.code, -32601);
    assert.match(answer.body.error.message, /delete_everything/);
  });

  it('answers a batch as one array, keeping only the requests that carry an id', async () => {
    const answer = await rpc(h, [
      { jsonrpc: '2.0', id: 10, method: 'ping' },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 11, method: 'resources/list' },
    ]);
    assert.equal(answer.status, 200);
    assert.ok(Array.isArray(answer.body));
    assert.deepEqual(answer.body.map((a: any) => a.id), [10, 11]);
  });

  it('answers 202 for a batch of notifications alone', async () => {
    const answer = await rpc(h, [
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', method: 'notifications/cancelled' },
    ]);
    assert.equal(answer.status, 202);
    assert.equal(answer.body, null);
  });
});

describe('mcp: the tools against a real store', () => {
  let h: Harness;
  before(async () => {
    h = await start();
  });
  after(async () => {
    await h.close();
  });

  it('creates a repository and reads it back', async () => {
    const created = await call(h, 'create_repo', { name: 'tools', description: 'made over MCP' });
    assert.equal(created.name, 'tools');
    assert.equal(created.full_name, `${LOGIN}/tools`);
    assert.equal(typeof created.id, 'number');
    const read = await call(h, 'get_repo', { repo: 'tools' });
    assert.equal(read.name, 'tools');
    assert.equal(read.description, 'made over MCP');
    assert.equal(read.default_branch, 'main');
    assert.equal(read.private, false);
  });

  it('refuses a repository with no name, naming the argument', async () => {
    const answer = await rpc(h, { jsonrpc: '2.0', id: 20, method: 'tools/call', params: { name: 'create_repo', arguments: {} } });
    assert.equal(answer.body.error.code, -32602);
    assert.match(answer.body.error.message, /name/);
  });

  it('answers a not-found repository as a tool error, not a transport error', async () => {
    const answer = await call(h, 'get_repo', { repo: 'nothing-here' });
    assert.match(answer.refused, /not found/);
  });

  it('creates an issue and lists it', async () => {
    const created = await call(h, 'create_issue', { repo: 'tools', title: 'from the agent', body: 'a body' });
    assert.equal(created.number, 1);
    assert.equal(created.title, 'from the agent');
    assert.equal(created.state, 'open');
    const listed = await call(h, 'list_issues', { repo: 'tools' });
    assert.equal(listed.length, 1);
    const one = await call(h, 'get_issue', { repo: 'tools', issue_number: 1 });
    assert.equal(one.title, 'from the agent');
  });

  it('refuses an issue that is not there, by number', async () => {
    const answer = await call(h, 'get_issue', { repo: 'tools', issue_number: 42 });
    assert.match(answer.refused, /#42 not found/);
  });

  it('opens a pull request and merges it, moving the base branch', async () => {
    const seed = await putFile(h, 'tools', 'work.txt', 'one\n', 'the seed');
    await api(h, `/api/v3/repos/${LOGIN}/tools/git/refs`, { method: 'POST', body: { ref: 'refs/heads/topic', sha: seed } });
    const opened = await call(h, 'create_pull_request', { repo: 'tools', title: 'over MCP', head: 'topic', base: 'main' });
    assert.equal(opened.number, 1);
    assert.equal(opened.state, 'open');
    assert.equal(opened.merged, false);
    const merged = await call(h, 'merge_pull_request', { repo: 'tools', pull_number: 1 });
    assert.equal(merged.merged, true);
    assert.match(merged.sha, /^[0-9a-f]{40}$/);
    const listed = await call(h, 'list_pull_requests', { repo: 'tools', state: 'all' });
    assert.equal(listed.length, 1);
    assert.equal(listed[0].merged, true);
  });

  it('refuses a merge of a pull request that does not exist', async () => {
    const answer = await call(h, 'merge_pull_request', { repo: 'tools', pull_number: 9 });
    assert.match(answer.refused, /#9 not found/);
  });

  it('accepts owner/repo through full_name', async () => {
    await makeRepo(h, 'by-full-name');
    const read = await call(h, 'get_repo', { full_name: `${LOGIN}/by-full-name` });
    assert.equal(read.name, 'by-full-name');
  });
});