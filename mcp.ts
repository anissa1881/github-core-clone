// mcp.ts: the Model Context Protocol endpoint at /mcp. JSON-RPC 2.0 over Streamable HTTP, speaking
// revision 2026-07-28 (server/discover) and the earlier handshake (initialize), with tools that act
// on the same store REST does.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { authorized, readRaw, requestId } from './http.ts';
import type { Forge, Issue, Pull, Repo } from './store.ts';
import { hashId } from './rest.ts';
import { mergeViaMcp } from './merge.ts';

/** The protocol revision this endpoint speaks. */
export const REVISION = '2026-07-28';
/** The earlier revisions it still answers through initialize. */
export const SUPPORTED_REVISIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2024-11-05'];

/** One piece of content a tool result carries. */
interface Content {
  type: string;
  text: string;
}

/** A tool result: its content, and whether it reports a failure. */
interface ToolResult {
  content: Content[];
  isError?: boolean;
}

/** One tool the endpoint offers. */
interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run(args: Record<string, unknown>): ToolResult;
}

/** A JSON-RPC error with its code. */
class RpcError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

/** A tool result carrying JSON text. */
function jsonResult(value: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

/** A tool result reporting a failure: isError, never a transport error. */
function errorResult(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** A required non-empty string argument, or a -32602 refusal. */
function requireString(args: Record<string, unknown>, name: string): string {
  const v = args[name];
  if (typeof v !== 'string' || v === '') throw new RpcError(-32602, `Missing required argument: ${name}`);
  return v;
}

/** An optional string argument, or the fallback. */
function optionalString(args: Record<string, unknown>, name: string, fallback = ''): string {
  return typeof args[name] === 'string' ? (args[name] as string) : fallback;
}

/** The owner and repository a tool call names, from owner+repo or from full_name. */
function ownerRepo(args: Record<string, unknown>, forge: Forge): { owner: string; repo: string } {
  const full = optionalString(args, 'full_name');
  if (full.includes('/')) {
    const [owner, repo] = full.split('/');
    return { owner: owner ?? forge.login, repo: repo ?? '' };
  }
  const owner = optionalString(args, 'owner') || forge.login;
  const repo = optionalString(args, 'repo') || optionalString(args, 'name');
  if (repo === '') throw new RpcError(-32602, 'Missing required argument: repo');
  return { owner, repo };
}

/** Look a repository up, or answer the tool's own not-found result. */
function findRepo(forge: Forge, args: Record<string, unknown>): Repo | ToolResult {
  const { owner, repo } = ownerRepo(args, forge);
  const found = forge.get(owner, repo);
  return found ?? errorResult(`Repository ${owner}/${repo} not found`);
}

/** Whether a value is a tool result rather than a repository. */
function isResult(v: Repo | ToolResult): v is ToolResult {
  return (v as ToolResult).content !== undefined;
}

/** The issue JSON a tool answers. */
function issueJson(i: Issue): Record<string, unknown> {
  return { number: i.number, id: i.id, title: i.title, body: i.body, state: i.state };
}

/** The pull JSON a tool answers. */
function pullJson(p: Pull): Record<string, unknown> {
  return { number: p.number, id: p.id, title: p.title, state: p.state, head: p.head, base: p.base, merged: p.merged };
}

/** The two arguments every repository-scoped tool shares, as JSON Schema. */
function repoArgs(extra: Record<string, unknown> = {}, required: string[] = []): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'The repository owner.' },
      repo: { type: 'string', description: 'The repository name.' },
      full_name: { type: 'string', description: 'owner/repo, when the caller sends it instead.' },
      ...extra,
    },
    required,
  };
}

/** The tool list, in a stable order so two tools/list calls answer byte for byte. */
export function tools(forge: Forge): Tool[] {
  const stateArg = {
    type: 'string',
    enum: ['open', 'closed', 'all'],
    description: 'Which ones to list.',
  };

  return [
    {
      name: 'create_repo',
      description: 'Create a repository owned by the authenticated user.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'The repository name.' },
          description: { type: 'string', description: 'The repository description.' },
          private: { type: 'boolean', description: 'Whether the repository is private.' },
          full_name: { type: 'string', description: 'owner/repo, when the caller sends it.' },
        },
        required: ['name'],
      },
      run: (args) => {
        const name = requireString(args, 'name');
        const repo = forge.create(forge.login, name, {
          description: optionalString(args, 'description'),
          private: args.private === true,
        });
        const full = `${repo.meta.owner}/${repo.meta.name}`;
        return jsonResult({ name: repo.meta.name, full_name: full, id: hashId(full) });
      },
    },

    {
      name: 'get_repo',
      description: 'Get one repository by owner and name.',
      inputSchema: repoArgs(),
      run: (args) => {
        const repo = findRepo(forge, args);
        if (isResult(repo)) return repo;
        return jsonResult({
          name: repo.meta.name,
          full_name: `${repo.meta.owner}/${repo.meta.name}`,
          description: repo.meta.description,
          default_branch: repo.meta.default_branch,
          private: repo.meta.private,
        });
      },
    },

    {
      name: 'create_issue',
      description: 'Create an issue in a repository.',
      inputSchema: repoArgs(
        {
          title: { type: 'string', description: 'The issue title.' },
          body: { type: 'string', description: 'The issue body.' },
        },
        ['title'],
      ),
      run: (args) => {
        const repo = findRepo(forge, args);
        if (isResult(repo)) return repo;
        const now = new Date().toISOString();
        const issue: Issue = {
          id: hashId(`issue:${repo.meta.owner}/${repo.meta.name}:${repo.meta.next_issue_id}`),
          number: repo.meta.next_issue_id++,
          title: requireString(args, 'title'),
          body: optionalString(args, 'body'),
          state: 'open',
          labels: [],
          user: forge.login,
          created_at: now,
          updated_at: now,
          closed_at: null,
          comments: [],
        };
        repo.meta.issues.push(issue);
        repo.save();
        return jsonResult(issueJson(issue));
      },
    },

    {
      name: 'list_issues',
      description: "List a repository's issues, optionally filtered by state.",
      inputSchema: repoArgs({ state: stateArg }),
      run: (args) => {
        const repo = findRepo(forge, args);
        if (isResult(repo)) return repo;
        const state = optionalString(args, 'state', 'open').toLowerCase();
        const list = repo.meta.issues.filter((i) => (state === 'all' ? true : i.state === state));
        return jsonResult(list.map(issueJson));
      },
    },

    {
      name: 'get_issue',
      description: 'Get one issue by number.',
      inputSchema: repoArgs({ issue_number: { type: 'number', description: 'The issue number.' } }, [
        'issue_number',
      ]),
      run: (args) => {
        const repo = findRepo(forge, args);
        if (isResult(repo)) return repo;
        const issue = repo.meta.issues.find((i) => i.number === Number(args.issue_number));
        if (!issue) return errorResult(`Issue #${String(args.issue_number)} not found`);
        return jsonResult(issueJson(issue));
      },
    },

    {
      name: 'create_pull_request',
      description: 'Open a pull request from a head branch into a base branch.',
      inputSchema: repoArgs(
        {
          title: { type: 'string', description: 'The pull request title.' },
          head: { type: 'string', description: 'The branch with the changes.' },
          base: { type: 'string', description: 'The branch to merge into.' },
          body: { type: 'string', description: 'The pull request body.' },
        },
        ['title', 'head', 'base'],
      ),
      run: (args) => {
        const repo = findRepo(forge, args);
        if (isResult(repo)) return repo;
        const now = new Date().toISOString();
        const pr: Pull = {
          id: hashId(`pull:${repo.meta.owner}/${repo.meta.name}:${repo.meta.next_pull_id}`),
          number: repo.meta.next_pull_id++,
          title: requireString(args, 'title'),
          body: optionalString(args, 'body'),
          state: 'open',
          // a head may arrive as "owner:branch"; only the branch name matters here
          head: optionalString(args, 'head').replace(/^[^:]+:/, ''),
          base: requireString(args, 'base'),
          user: forge.login,
          created_at: now,
          updated_at: now,
          merged: false,
          merged_at: null,
          merge_commit_sha: null,
        };
        repo.meta.pulls.push(pr);
        repo.save();
        return jsonResult(pullJson(pr));
      },
    },

    {
      name: 'merge_pull_request',
      description: 'Merge an open pull request into its base branch.',
      inputSchema: repoArgs({ pull_number: { type: 'number', description: 'The pull request number.' } }, [
        'pull_number',
      ]),
      run: (args) => {
        const repo = findRepo(forge, args);
        if (isResult(repo)) return repo;
        const number = Number(args.pull_number);
        const pr = repo.meta.pulls.find((p) => p.number === number);
        if (!pr) return errorResult(`Pull request #${number} not found`);
        if (!repo.branchTip(pr.head)) return errorResult(`Head branch ${pr.head} not found`);
        // the merge runs through the one path REST shares, so both surfaces agree byte for byte
        const sha = mergeViaMcp(repo, pr);
        return jsonResult({ number: pr.number, merged: true, sha, state: pr.state });
      },
    },

    {
      name: 'list_pull_requests',
      description: "List a repository's pull requests.",
      inputSchema: repoArgs({ state: stateArg }),
      run: (args) => {
        const repo = findRepo(forge, args);
        if (isResult(repo)) return repo;
        const state = optionalString(args, 'state', 'open').toLowerCase();
        const list = repo.meta.pulls.filter((p) => (state === 'all' ? true : p.state === state));
        return jsonResult(list.map(pullJson));
      },
    },
  ];
}

/** Answer one /mcp request. */
export async function handleMcp(forge: Forge, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!authorized(req, forge.token)) {
    sendJson(res, 401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } });
    return;
  }

  const raw = await readRaw(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }

  const batch = Array.isArray(parsed);
  const requests = (batch ? parsed : [parsed]) as Array<Record<string, unknown>>;
  const answers: unknown[] = [];
  for (const request of requests) answers.push(await answerRpc(forge, request));

  if (batch) {
    const kept = answers.filter((a) => a !== null);
    if (kept.length === 0) {
      res.writeHead(202, { 'x-github-request-id': requestId() });
      res.end();
      return;
    }
    sendJson(res, 200, kept);
    return;
  }

  const only = answers[0];
  if (only === null || only === undefined) {
    // a notification is acknowledged with no body at all
    res.writeHead(202, { 'x-github-request-id': requestId() });
    res.end();
    return;
  }
  sendJson(res, 200, only);
}

/** Write one JSON body with the request-id header. */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': requestId(),
  });
  res.end(text);
}

/** Answer one JSON-RPC request; null for a notification, which carries no id. */
async function answerRpc(forge: Forge, request: Record<string, unknown>): Promise<unknown> {
  const id = request.id ?? null;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = (request.params ?? {}) as Record<string, unknown>;
  const isNotification = request.id === undefined;

  const ok = (result: unknown): Record<string, unknown> => ({ jsonrpc: '2.0', id, result });
  const fail = (code: number, message: string): Record<string, unknown> => ({
    jsonrpc: '2.0',
    id,
    error: { code, message },
  });

  try {
    switch (method) {
      case 'server/discover':
        return isNotification
          ? null
          : ok({
              protocolVersion: REVISION,
              supportedVersions: SUPPORTED_REVISIONS,
              serverInfo: { name: 'makefun-forge', version: '1.0.0' },
              capabilities: { tools: { listChanged: false } },
            });

      case 'initialize': {
        const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : REVISION;
        const version = SUPPORTED_REVISIONS.includes(requested) ? requested : REVISION;
        return isNotification
          ? null
          : ok({
              protocolVersion: version,
              capabilities: { tools: { listChanged: false } },
              serverInfo: { name: 'makefun-forge', version: '1.0.0' },
            });
      }

      case 'ping':
        return isNotification ? null : ok({});

      case 'notifications/initialized':
      case 'notifications/cancelled':
      case 'notifications/roots/list_changed':
        return null;

      case 'tools/list':
        return isNotification
          ? null
          : ok({
              tools: tools(forge).map((t) => ({
                name: t.name,
                description: t.description,
                inputSchema: t.inputSchema,
              })),
            });

      case 'tools/call': {
        const name = typeof params.name === 'string' ? params.name : '';
        const args = (params.arguments ?? {}) as Record<string, unknown>;
        const tool = matchTool(forge, name);
        if (!tool) return fail(-32601, `Unknown tool: ${name}`);
        try {
          return isNotification ? null : ok(tool.run(args));
        } catch (err) {
          if (err instanceof RpcError) return fail(err.code, err.message);
          return isNotification ? null : ok(errorResult(err instanceof Error ? err.message : String(err)));
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
    return fail(-32603, err instanceof Error ? err.message : String(err));
  }
}

/**
 * Find a tool by name. A server prefix is allowed (github__create_issue, github/create_issue),
 * matched as a suffix and case-insensitively.
 */
function matchTool(forge: Forge, name: string): Tool | null {
  const lower = name.toLowerCase();
  const list = tools(forge);
  const exact = list.find((t) => t.name.toLowerCase() === lower);
  if (exact) return exact;
  return (
    list.find(
      (t) => lower.endsWith(`__${t.name.toLowerCase()}`) || lower.endsWith(`/${t.name.toLowerCase()}`),
    ) ?? null
  );
}
