// mcp.ts: the Model Context Protocol endpoint at /mcp. JSON-RPC 2.0 over Streamable HTTP, speaking
// revision 2026-07-28 (server/discover) and the earlier handshake (initialize), with tools that act
// on the same store REST does.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { readRaw, authorized, requestId } from './http.ts';
import type { Forge, Repo, Issue, Pull } from './store.ts';
import { hashId } from './rest.ts';

/** The protocol revision this endpoint speaks. */
export const REVISION = '2026-07-28';
/** The earlier revisions it still answers through initialize. */
export const SUPPORTED_REVISIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2024-11-05'];

/** One tool the endpoint offers. */
interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Run it, answering the tool result's content and a structured result. */
  run(args: Record<string, unknown>): { content: Array<{ type: string; text: string }>; isError?: boolean; structured?: unknown };
}

/** A JSON-RPC error with its code. */
class RpcError extends Error {
  readonly code: number;
  readonly data?: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

/** The tool list, in a stable order so two tools/list calls answer byte for byte. */
export function tools(forge: Forge): Tool[] {
  const repoArg = { type: 'string', description: 'The repository name.' };
  const ownerArg = { type: 'string', description: 'The repository owner.' };
  return [
    {
      name: 'create_repo',
      description: 'Create a repository owned by the authenticated user.',
      inputSchema: {
        type: 'object',
        properties: {
          name: repoArg,
          description: { type: 'string', description: 'The repository description.' },
          private: { type: 'boolean', description: 'Whether the repository is private.' },
          full_name: { type: 'string', description: 'owner/repo, when the caller sends it.' },
        },
        required: ['name'],
      },
      run: (args) => {
        const name = requireString(args, 'name');
        const repo = forge.create(forge.login, name, {
          description: typeof args.description === 'string' ? args.description : '',
          private: args.private === true,
        });
        return jsonResult({ name: repo.meta.name, full_name: `${repo.meta.owner}/${repo.meta.name}`, id: hashId(`${repo.meta.owner}/${repo.meta.name}`) });
      },
    },
    {
      name: 'get_repo',
      description: 'Get one repository by owner and name.',
      inputSchema: {
        type: 'object',
        properties: { owner: ownerArg, repo: repoArg, full_name: { type: 'string', description: 'owner/repo.' } },
        required: [],
      },
      run: (args) => {
        const { owner, repo: name } = ownerRepo(args, forge);
        const repo = forge.get(owner, name);
        if (!repo) return errorResult(`Repository ${owner}/${name} not found`);
        return jsonResult({ name: repo.meta.name, full_name: `${repo.meta.owner}/${repo.meta.name}`, description: repo.meta.description, default_branch: repo.meta.default_branch, private: repo.meta.private });
      },
    },
    {
      name: 'create_issue',
      description: 'Create an issue in a repository.',
      inputSchema: {
        type: 'object',
        properties: {
          owner: ownerArg, repo: repoArg,
          title: { type: 'string', description: 'The issue title.' },
          body: { type: 'string', description: 'The issue body.' },
          full_name: { type: 'string', description: 'owner/repo.' },
        },
        required: ['title'],
      },
      run: (args) => {
        const { owner, repo: name } = ownerRepo(args, forge);
        const repo = forge.get(owner, name);
        if (!repo) return errorResult(`Repository ${owner}/${name} not found`);
        const now = new Date().toISOString();
        const issue: Issue = {
          id: hashId(`issue:${repo.meta.owner}/${repo.meta.name}:${repo.meta.next_issue_id}`),
          number: repo.meta.next_issue_id++, title: requireString(args, 'title'),
          body: typeof args.body === 'string' ? args.body : '', state: 'open', labels: [], user: forge.login,
          created_at: now, updated_at: now, closed_at: null, comments: [],
        };
        repo.meta.issues.push(issue);
        repo.save();
        return jsonResult({ number: issue.number, id: issue.id, title: issue.title, body: issue.body, state: issue.state });
      },
    },
    {
      name: 'list_issues',
      description: 'List a repository\'s issues, optionally filtered by state.',
      inputSchema: {
        type: 'object',
        properties: {
          owner: ownerArg, repo: repoArg,
          state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Which issues to list.' },
          full_name: { type: 'string', description: 'owner/repo.' },
        },
        required: [],
      },
      run: (args) => {
        const { owner, repo: name } = ownerRepo(args, forge);
        const repo = forge.get(owner, name);
        if (!repo) return errorResult(`Repository ${owner}/${name} not found`);
        const state = typeof args.state === 'string' ? args.state.toLowerCase() : 'open';
        const list = repo.meta.issues.filter((i) => (state === 'all' ? true : i.state === state));
        return jsonResult(list.map((i) => ({ number: i.number, id: i.id, title: i.title, body: i.body, state: i.state })));
      },
    },
    {
      name: 'create_pull_request',
      description: 'Open a pull request from a head branch into a base branch.',
      inputSchema: {
        type: 'object',
        properties: {
          owner: ownerArg, repo: repoArg,
          title: { type: 'string', description: 'The pull request title.' },
          head: { type: 'string', description: 'The branch with the changes.' },
          base: { type: 'string', description: 'The branch to merge into.' },
          body: { type: 'string', description: 'The pull request body.' },
          full_name: { type: 'string', description: 'owner/repo.' },
        },
        required: ['title', 'head', 'base'],
      },
      run: (args) => {
        const { owner, repo: name } = ownerRepo(args, forge);
        const repo = forge.get(owner, name);
        if (!repo) return errorResult(`Repository ${owner}/${name} not found`);
        const now = new Date().toISOString();
        const pr: Pull = {
          id: hashId(`pull:${repo.meta.owner}/${repo.meta.name}:${repo.meta.next_pull_id}`),
          number: repo.meta.next_pull_id++, title: requireString(args, 'title'),
          body: typeof args.body === 'string' ? args.body : '', state: 'open',
          head: String(args.head ?? '').replace(/^[^:]+:/, ''), base: requireString(args, 'base'),
          user: forge.login, created_at: now, updated_at: now, merged: false, merged_at: null, merge_commit_sha: null,
        };
        repo.meta.pulls.push(pr);
        repo.save();
        return jsonResult({ number: pr.number, id: pr.id, title: pr.title, state: pr.state, head: pr.head, base: pr.base });
      },
    },
    {
      name: 'merge_pull_request',
      description: 'Merge an open pull request into its base branch.',
      inputSchema: {
        type: 'object',
        properties: {
          owner: ownerArg, repo: repoArg,
          pull_number: { type: 'number', description: 'The pull request number to merge.' },
          full_name: { type: 'string', description: 'owner/repo.' },
        },
        required: ['pull_number'],
      },
      run: (args) => {
        const { owner, repo: name } = ownerRepo(args, forge);
        const repo = forge.get(owner, name);
        if (!repo) return errorResult(`Repository ${owner}/${name} not found`);
        const number = Number(args.pull_number);
        const pr = repo.meta.pulls.find((p) => p.number === number);
        if (!pr) return errorResult(`Pull request #${number} not found`);
        return mergePull(repo, pr);
      },
    },
    {
      name: 'get_issue',
      description: 'Get one issue by number.',
      inputSchema: {
        type: 'object',
        properties: {
          owner: ownerArg, repo: repoArg,
          issue_number: { type: 'number', description: 'The issue number.' },
          full_name: { type: 'string', description: 'owner/repo.' },
        },
        required: ['issue_number'],
      },
      run: (args) => {
        const { owner, repo: name } = ownerRepo(args, forge);
        const repo = forge.get(owner, name);
        if (!repo) return errorResult(`Repository ${owner}/${name} not found`);
        const issue = repo.meta.issues.find((i) => i.number === Number(args.issue_number));
        if (!issue) return errorResult(`Issue #${String(args.issue_number)} not found`);
        return jsonResult({ number: issue.number, id: issue.id, title: issue.title, body: issue.body, state: issue.state });
      },
    },
    {
      name: 'list_pull_requests',
      description: 'List a repository\'s pull requests.',
      inputSchema: {
        type: 'object',
        properties: {
          owner: ownerArg, repo: repoArg,
          state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Which pull requests to list.' },
          full_name: { type: 'string', description: 'owner/repo.' },
        },
        required: [],
      },
      run: (args) => {
        const { owner, repo: name } = ownerRepo(args, forge);
        const repo = forge.get(owner, name);
        if (!repo) return errorResult(`Repository ${owner}/${name} not found`);
        const state = typeof args.state === 'string' ? args.state.toLowerCase() : 'open';
        const list = repo.meta.pulls.filter((p) => (state === 'all' ? true : p.state === state));
        return jsonResult(list.map((p) => ({ number: p.number, id: p.id, title: p.title, state: p.state, head: p.head, base: p.base, merged: p.merged })));
      },
    },
  ];
}

/** Merge one pull request through MCP, sharing REST's merge path. */
function mergePull(repo: Repo, pr: Pull): { content: Array<{ type: string; text: string }> } {
  const baseTip = repo.branchTip(pr.base);
  const headTip = repo.branchTip(pr.head);
  if (!headTip) return errorResult(`Head branch ${pr.head} not found`);
  // the merge itself is done by the REST module so both surfaces agree byte for byte
  const { mergeViaMcp } = mergeModule();
  const sha = mergeViaMcp(repo, pr);
  void baseTip;
  return jsonResult({ number: pr.number, merged: true, sha, state: pr.state });
}

/** The merge helper, imported once. */
function mergeModule(): { mergeViaMcp: (repo: Repo, pr: Pull) => string } {
  return mergeImpl;
}
import { mergeViaMcp } from './merge.ts';
const mergeImpl = { mergeViaMcp };

/** A tool result carrying JSON. */
function jsonResult(value: unknown): { content: Array<{ type: string; text: string }> } {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

/** A tool result reporting a failure (isError, never a transport error). */
function errorResult(message: string): { content: Array<{ type: string; text: string }>; isError: boolean } {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** A required string argument, or a -32602 refusal. */
function requireString(args: Record<string, unknown>, name: string): string {
  const v = args[name];
  if (typeof v !== 'string' || v === '') throw new RpcError(-32602, `Missing required argument: ${name}`);
  return v;
}

/** The owner and repository a tool call names, from owner+repo or from full_name. */
function ownerRepo(args: Record<string, unknown>, forge: Forge): { owner: string; repo: string } {
  const full = typeof args.full_name === 'string' ? args.full_name : '';
  if (full.includes('/')) {
    const [owner, repo] = full.split('/');
    return { owner: owner ?? forge.login, repo: repo ?? '' };
  }
  const owner = typeof args.owner === 'string' && args.owner !== '' ? args.owner : forge.login;
  const repo = typeof args.repo === 'string' ? args.repo : typeof args.name === 'string' ? args.name : '';
  if (repo === '') throw new RpcError(-32602, 'Missing required argument: repo');
  return { owner, repo };
}

/** Answer one /mcp request. */
export async function handleMcp(forge: Forge, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!authorized(req, forge.token)) {
    res.writeHead(401, { 'content-type': 'application/json', 'x-github-request-id': requestId() });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } }));
    return;
  }
  const raw = await readRaw(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    // a body that is not JSON is -32700, with HTTP 400 for a revision this one speaks
    res.writeHead(400, { 'content-type': 'application/json', 'x-github-request-id': requestId() });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
    return;
  }
  const batch = Array.isArray(parsed);
  const requests = batch ? (parsed as Array<Record<string, unknown>>) : [parsed as Record<string, unknown>];
  const answers: unknown[] = [];
  for (const request of requests) answers.push(await answerRpc(forge, request));
  const body = batch ? answers.filter((a) => a !== null) : answers[0];
  if (!batch && body === null) {
    res.writeHead(202, { 'x-github-request-id': requestId() });
    res.end();
    return;
  }
  const text = JSON.stringify(body);
  res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), 'x-github-request-id': requestId() });
  res.end(text);
}

/** Answer one JSON-RPC request; null for a notification (no id). */
async function answerRpc(forge: Forge, request: Record<string, unknown>): Promise<unknown> {
  const id = request.id ?? null;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = (request.params ?? {}) as Record<string, unknown>;
  const isNotification = request.id === undefined;

  const ok = (result: unknown): Record<string, unknown> => ({ jsonrpc: '2.0', id, result });
  const fail = (code: number, message: string, data?: unknown): Record<string, unknown> => ({ jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } });

  try {
    switch (method) {
      case 'server/discover': {
        const result = {
          protocolVersion: REVISION,
          supportedVersions: SUPPORTED_REVISIONS,
          serverInfo: { name: 'makefun-forge', version: '1.0.0' },
          capabilities: { tools: { listChanged: false } },
        };
        return isNotification ? null : ok(result);
      }
      case 'initialize': {
        const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : REVISION;
        const version = SUPPORTED_REVISIONS.includes(requested) ? requested : REVISION;
        return isNotification ? null : ok({
          protocolVersion: version,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'makefun-forge', version: '1.0.0' },
        });
      }
      case 'notifications/initialized':
      case 'notifications/cancelled':
      case 'ping':
        return isNotification ? null : ok({});
      case 'tools/list': {
        const list = tools(forge).map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
        return isNotification ? null : ok({ tools: list });
      }
      case 'tools/call': {
        const name = typeof params.name === 'string' ? params.name : '';
        const args = (params.arguments ?? {}) as Record<string, unknown>;
        const tool = matchTool(forge, name);
        if (!tool) return fail(-32601, `Unknown tool: ${name}`);
        try {
          const result = tool.run(args);
          return isNotification ? null : ok(result);
        } catch (err) {
          if (err instanceof RpcError) return fail(err.code, err.message);
          const message = err instanceof Error ? err.message : String(err);
          // a tool that fails on its arguments answers isError, never a transport error
          if (/required argument/i.test(message)) return fail(-32602, message);
          return isNotification ? null : ok({ content: [{ type: 'text', text: message }], isError: true });
        }
      }
      case 'resources/list':
        return isNotification ? null : ok({ resources: [] });
      case 'prompts/list':
        return isNotification ? null : ok({ prompts: [] });
      default:
        return isNotification ? null : fail(-32601, `Method not found: ${method}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return fail(-32603, message);
  }
}

/**
 * Find a tool by name. A server prefix on the name is allowed (github__create_issue), matched as a
 * suffix and case-insensitively.
 */
function matchTool(forge: Forge, name: string): Tool | null {
  const lower = name.toLowerCase();
  const list = tools(forge);
  const exact = list.find((t) => t.name.toLowerCase() === lower);
  if (exact) return exact;
  return list.find((t) => lower.endsWith(`__${t.name.toLowerCase()}`) || lower.endsWith(`/${t.name.toLowerCase()}`)) ?? null;
}
