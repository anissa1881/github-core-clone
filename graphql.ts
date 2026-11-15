// graphql.ts: the GraphQL v4 surface. It parses the documents gh and github-mcp-server send
// rather than shipping a schema library: a small tokenizer, a selection-set evaluator, and a
// hand-written schema description that introspection answers.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { readBody, readRaw, respond, authorized } from './http.ts';
import type { Forge, Repo, Issue, Pull } from './store.ts';
import { hashId, issueJson, pullJson } from './rest.ts';

// ---------------------------------------------------------------------------------------------
// A minimal GraphQL document parser: enough for the operation documents the suite sends.
// ---------------------------------------------------------------------------------------------

type Token = { kind: 'punct' | 'name' | 'string' | 'number' | 'eof'; value: string };

/** Split a document into tokens, skipping comments and whitespace. */
function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') { i += 1; continue; }
    if (c === '#') { while (i < src.length && src[i] !== '\n') i += 1; continue; }
    if (c === '.' && src[i + 1] === '.' && src[i + 2] === '.') { out.push({ kind: 'punct', value: '...' }); i += 3; continue; }
    if ('{}()[]:=!|@$'.includes(c)) { out.push({ kind: 'punct', value: c }); i += 1; continue; }
    if (c === '"') {
      if (src.startsWith('"""', i)) {
        const end = src.indexOf('"""', i + 3);
        out.push({ kind: 'string', value: src.slice(i + 3, end < 0 ? src.length : end) });
        i = end < 0 ? src.length : end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\') { value += src[j + 1] ?? ''; j += 2; continue; }
        value += src[j];
        j += 1;
      }
      out.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (/[-0-9]/.test(c)) {
      let j = i;
      while (j < src.length && /[-+0-9.eE]/.test(src[j]!)) j += 1;
      out.push({ kind: 'number', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(c)) {
      let j = i;
      while (j < src.length && /[_0-9A-Za-z]/.test(src[j]!)) j += 1;
      out.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    i += 1;
  }
  out.push({ kind: 'eof', value: '' });
  return out;
}

/** One field selection: its name, alias, arguments and sub-selections. */
interface Selection {
  name: string;
  alias: string | null;
  args: Record<string, unknown>;
  selections: Selection[];
  fragments: string[];
}

/** One parsed operation. */
interface Operation {
  kind: 'query' | 'mutation' | 'subscription';
  name: string | null;
  selections: Selection[];
  fragments: Map<string, Selection[]>;
}

/** Parse a document into its operations (a body may carry two, answered in order). */
function parseDocument(src: string): Operation[] {
  const tokens = tokenize(src);
  let pos = 0;
  const peek = (): Token => tokens[pos]!;
  const next = (): Token => tokens[pos++]!;
  const expect = (value: string): void => {
    const t = next();
    if (t.value !== value) throw new GraphQLError(`Expected ${value}, found ${t.value || 'eof'}`);
  };
  const fragments = new Map<string, Selection[]>();

  /** Skip a type condition's `on X`. */
  const parseTypeCondition = (): void => {
    if (peek().kind === 'name' && peek().value === 'on') { next(); next(); }
  };

  const parseValue = (): unknown => {
    const t = next();
    if (t.kind === 'string') return t.value;
    if (t.kind === 'number') return Number(t.value);
    if (t.kind === 'punct' && t.value === '$') { next(); return { $var: next().value }; }
    if (t.kind === 'punct' && t.value === '[') {
      const arr: unknown[] = [];
      while (!(peek().kind === 'punct' && peek().value === ']')) arr.push(parseValue());
      next();
      return arr;
    }
    if (t.kind === 'punct' && t.value === '{') {
      const obj: Record<string, unknown> = {};
      while (!(peek().kind === 'punct' && peek().value === '}')) {
        const key = next().value;
        expect(':');
        obj[key] = parseValue();
      }
      next();
      return obj;
    }
    if (t.kind === 'name') {
      if (t.value === 'true') return true;
      if (t.value === 'false') return false;
      if (t.value === 'null') return null;
      return t.value; // an enum value
    }
    return null;
  };

  const parseArgs = (): Record<string, unknown> => {
    const args: Record<string, unknown> = {};
    if (!(peek().kind === 'punct' && peek().value === '(')) return args;
    next();
    while (!(peek().kind === 'punct' && peek().value === ')')) {
      const name = next().value;
      expect(':');
      args[name] = parseValue();
    }
    next();
    return args;
  };

  const parseSelectionSet = (): Selection[] => {
    expect('{');
    const sel: Selection[] = [];
    while (!(peek().kind === 'punct' && peek().value === '}')) {
      if (peek().kind === 'eof') throw new GraphQLError('Unexpected end of document');
      if (peek().value === '...') {
        next();
        if (peek().kind === 'name' && peek().value !== 'on') {
          sel.push({ name: '...', alias: null, args: {}, selections: [], fragments: [next().value] });
          continue;
        }
        parseTypeCondition();
        const inner = parseSelectionSet();
        for (const s of inner) sel.push(s);
        continue;
      }
      let alias: string | null = null;
      let name = next().value;
      if (peek().kind === 'punct' && peek().value === ':') { next(); alias = name; name = next().value; }
      const args = parseArgs();
      // directives are accepted and ignored
      while (peek().kind === 'punct' && peek().value === '@') {
        next();
        next();
        parseArgs();
      }
      const selections = peek().kind === 'punct' && peek().value === '{' ? parseSelectionSet() : [];
      sel.push({ name, alias, args, selections, fragments: [] });
    }
    next();
    return sel;
  };

  const operations: Operation[] = [];
  while (peek().kind !== 'eof') {
    const t = next();
    if (t.kind === 'punct' && t.value === '{') {
      pos -= 1;
      operations.push({ kind: 'query', name: null, selections: parseSelectionSet(), fragments });
      continue;
    }
    if (t.kind === 'name' && t.value === 'fragment') {
      const fragName = next().value;
      parseTypeCondition();
      fragments.set(fragName, parseSelectionSet());
      continue;
    }
    if (t.kind === 'name' && (t.value === 'query' || t.value === 'mutation' || t.value === 'subscription')) {
      let opName: string | null = null;
      if (peek().kind === 'name') opName = next().value;
      if (peek().kind === 'punct' && peek().value === '(') {
        // variable definitions: skip them, they only name types and defaults
        let depth = 0;
        do {
          const vt = next();
          if (vt.value === '(') depth += 1;
          if (vt.value === ')') depth -= 1;
        } while (depth > 0 && peek().kind !== 'eof');
      }
      while (peek().kind === 'punct' && peek().value === '@') { next(); next(); parseArgs(); }
      operations.push({ kind: t.value, name: opName, selections: parseSelectionSet(), fragments });
      continue;
    }
  }
  return operations;
}

/** A GraphQL error that a request answers with an errors array. */
class GraphQLError extends Error {
  readonly path: string[];
  constructor(message: string, path: string[] = []) {
    super(message);
    this.path = path;
  }
}

/** Resolve `{ $var: name }` markers against the request's variables. */
function resolveVars(value: unknown, vars: Record<string, unknown>): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value) && '$var' in (value as Record<string, unknown>)) {
    return vars[(value as { $var: string }).$var];
  }
  if (Array.isArray(value)) return value.map((v) => resolveVars(v, vars));
  if (value && typeof value === 'object') {
    const obj: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) obj[k] = resolveVars(v, vars);
    return obj;
  }
  return value;
}

// ---------------------------------------------------------------------------------------------
// The schema: what introspection answers, and the types the resolvers return.
// ---------------------------------------------------------------------------------------------

/** One field of a GraphQL object type, with its type as SDL-ish text. */
interface FieldDef {
  type: string;
  args?: Record<string, string>;
  description?: string;
}

/** The object types introspection describes. */
const OBJECTS: Record<string, Record<string, FieldDef>> = {
  Query: {
    viewer: { type: 'User!' },
    repository: { type: 'Repository', args: { owner: 'String!', name: 'String!' } },
    search: { type: 'SearchResultItemConnection!', args: { query: 'String!', type: 'SearchType!', first: 'Int', after: 'String' } },
    node: { type: 'Node', args: { id: 'ID!' } },
  },
  Mutation: {
    createRepository: { type: 'CreateRepositoryPayload', args: { input: 'CreateRepositoryInput!' } },
    createPullRequest: { type: 'CreatePullRequestPayload', args: { input: 'CreatePullRequestInput!' } },
    createIssue: { type: 'CreateIssuePayload', args: { input: 'CreateIssueInput!' } },
    mergePullRequest: { type: 'MergePullRequestPayload', args: { input: 'MergePullRequestInput!' } },
    closeIssue: { type: 'CloseIssuePayload', args: { input: 'CloseIssueInput!' } },
  },
  User: { id: { type: 'ID!' }, login: { type: 'String!' }, name: { type: 'String' }, databaseId: { type: 'Int' } },
  Issue: {
    id: { type: 'ID!' }, number: { type: 'Int!' }, title: { type: 'String!' }, state: { type: 'IssueState!' },
    body: { type: 'String' }, bodyText: { type: 'String!' }, createdAt: { type: 'DateTime!' }, updatedAt: { type: 'DateTime!' },
    closed: { type: 'Boolean!' }, url: { type: 'URI!' }, author: { type: 'Actor' }, comments: { type: 'IssueCommentConnection!' },
  },
  IssueComment: { id: { type: 'ID!' }, body: { type: 'String!' }, bodyText: { type: 'String!' } },
  IssueCommentConnection: { totalCount: { type: 'Int!' }, nodes: { type: '[IssueComment]' } },
  PullRequest: {
    id: { type: 'ID!' }, number: { type: 'Int!' }, title: { type: 'String!' }, state: { type: 'PullRequestState!' },
    headRefName: { type: 'String!' }, baseRefName: { type: 'String!' }, mergeable: { type: 'MergeableState!' },
    merged: { type: 'Boolean!' }, body: { type: 'String' }, createdAt: { type: 'DateTime!' }, updatedAt: { type: 'DateTime!' },
    files: { type: 'PullRequestChangedFileConnection', args: { first: 'Int' } }, url: { type: 'URI!' }, closed: { type: 'Boolean!' },
  },
  PullRequestChangedFileConnection: { totalCount: { type: 'Int!' }, nodes: { type: '[PullRequestChangedFile]' } },
  PullRequestChangedFile: { path: { type: 'String!' }, additions: { type: 'Int!' }, deletions: { type: 'Int!' }, changeType: { type: 'PatchStatus!' } },
  Repository: {
    id: { type: 'ID!' }, databaseId: { type: 'Int' }, name: { type: 'String!' }, nameWithOwner: { type: 'String!' },
    owner: { type: 'RepositoryOwner!' }, defaultBranchRef: { type: 'Ref' }, viewerPermission: { type: 'RepositoryPermission' },
    hasIssuesEnabled: { type: 'Boolean!' }, issue: { type: 'Issue', args: { number: 'Int!' } },
    issues: {
      type: 'IssueConnection!',
      args: { first: 'Int', after: 'String', orderBy: 'IssueOrder', states: '[IssueState!]', filterBy: 'IssueFilters' },
    },
    pullRequests: { type: 'PullRequestConnection!', args: { first: 'Int', after: 'String', orderBy: 'PullRequestOrder', states: '[PullRequestState!]' } },
    pullRequest: { type: 'PullRequest', args: { number: 'Int!' } },
    description: { type: 'String' }, isPrivate: { type: 'Boolean!' }, url: { type: 'URI!' }, createdAt: { type: 'DateTime!' },
  },
  RepositoryOwner: { id: { type: 'ID!' }, login: { type: 'String!' }, avatarUrl: { type: 'URI' }, url: { type: 'URI' } },
  Ref: { name: { type: 'String!' }, target: { type: 'GitObject' }, prefix: { type: 'String!' } },
  GitObject: { oid: { type: 'GitObjectID!' }, abbreviatedOid: { type: 'String!' } },
  Commit: { oid: { type: 'GitObjectID!' }, message: { type: 'String!' }, history: { type: 'CommitHistoryConnection!' } },
  IssueConnection: { totalCount: { type: 'Int!' }, nodes: { type: '[Issue]' }, edges: { type: '[IssueEdge]' }, pageInfo: { type: 'PageInfo!' } },
  IssueEdge: { node: { type: 'Issue' }, cursor: { type: 'String!' } },
  PullRequestConnection: { totalCount: { type: 'Int!' }, nodes: { type: '[PullRequest]' }, edges: { type: '[PullRequestEdge]' }, pageInfo: { type: 'PageInfo!' } },
  PullRequestEdge: { node: { type: 'PullRequest' }, cursor: { type: 'String!' } },
  PageInfo: { hasNextPage: { type: 'Boolean!' }, endCursor: { type: 'String' }, hasPreviousPage: { type: 'Boolean!' }, startCursor: { type: 'String' } },
  SearchResultItemConnection: { issueCount: { type: 'Int!' }, nodes: { type: '[SearchResultItem]' }, pageInfo: { type: 'PageInfo!' } },
  CreateRepositoryPayload: { repository: { type: 'Repository' } },
  CreatePullRequestPayload: { pullRequest: { type: 'PullRequest' } },
  CreateIssuePayload: { issue: { type: 'Issue' } },
  MergePullRequestPayload: { pullRequest: { type: 'PullRequest' } },
  CloseIssuePayload: { issue: { type: 'Issue' } },
  Actor: { login: { type: 'String!' }, id: { type: 'ID!' } },
};

/** The enum types introspection describes. */
const ENUMS: Record<string, string[]> = {
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  PatchStatus: ['ADDED', 'DELETED', 'MODIFIED'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

/** The interface types introspection describes. */
const INTERFACES: Record<string, Record<string, FieldDef>> = {
  Node: { id: { type: 'ID!' } },
  SearchResultItem: { id: { type: 'ID!' } },
};

/** Build one introspection type object for a named type. */
function introspectType(name: string): Record<string, unknown> | null {
  if (Object.prototype.hasOwnProperty.call(OBJECTS, name)) {
    const fields = OBJECTS[name]!;
    return {
      kind: 'OBJECT',
      name,
      description: null,
      fields: Object.entries(fields).map(([fname, def]) => ({
        name: fname,
        description: def.description ?? null,
        args: Object.entries(def.args ?? {}).map(([aname, atype]) => ({ name: aname, description: null, type: typeRef(atype), defaultValue: null })),
        type: typeRef(def.type),
        isDeprecated: false,
        deprecationReason: null,
      })),
      inputFields: null,
      interfaces: [],
      enumValues: null,
      possibleTypes: null,
    };
  }
  if (Object.prototype.hasOwnProperty.call(ENUMS, name)) {
    return {
      kind: 'ENUM', name, description: null, fields: null, inputFields: null, interfaces: null,
      enumValues: ENUMS[name]!.map((v) => ({ name: v, description: null, isDeprecated: false, deprecationReason: null })),
      possibleTypes: null,
    };
  }
  if (Object.prototype.hasOwnProperty.call(INTERFACES, name)) {
    const fields = INTERFACES[name]!;
    return {
      kind: 'INTERFACE', name, description: null,
      fields: Object.entries(fields).map(([fname, def]) => ({
        name: fname, description: null, args: [], type: typeRef(def.type), isDeprecated: false, deprecationReason: null,
      })),
      inputFields: null, interfaces: [], enumValues: null, possibleTypes: null,
    };
  }
  if (name.endsWith('Input')) {
    return {
      kind: 'INPUT_OBJECT', name, description: null, fields: null,
      inputFields: [{ name: 'clientMutationId', description: null, type: typeRef('String'), defaultValue: null }],
      interfaces: null, enumValues: null, possibleTypes: null,
    };
  }
  const scalars = ['String', 'Int', 'Boolean', 'ID', 'DateTime', 'URI', 'GitObjectID', 'Float'];
  if (scalars.includes(name)) return { kind: 'SCALAR', name, description: null, fields: null, inputFields: null, interfaces: null, enumValues: null, possibleTypes: null };
  return null;
}

/** A type's reference, as introspection reports "String!" or "[Issue]". */
function typeRef(t: string): Record<string, unknown> {
  if (t.endsWith('!')) return { kind: 'NON_NULL', name: null, ofType: typeRef(t.slice(0, -1)) };
  if (t.startsWith('[') && t.endsWith(']')) return { kind: 'LIST', name: null, ofType: typeRef(t.slice(1, -1)) };
  const kind = OBJECTS[t] ? 'OBJECT' : ENUMS[t] ? 'ENUM' : INTERFACES[t] ? 'INTERFACE' : 'SCALAR';
  return { kind, name: t, ofType: null };
}

// ---------------------------------------------------------------------------------------------
// Resolvers: the objects the fields read from.
// ---------------------------------------------------------------------------------------------

/** A node's global id, as GitHub's base64 "Type:id" form. */
function globalId(type: string, local: string): string {
  return Buffer.from(`${type}:${local}`).toString('base64');
}

/** One issue as a GraphQL object. */
function issueNode(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    __type: 'Issue',
    id: globalId('Issue', `${repo.meta.owner}/${repo.meta.name}#${issue.number}`),
    number: issue.number,
    title: issue.title,
    state: issue.state === 'closed' ? 'CLOSED' : 'OPEN',
    body: issue.body,
    bodyText: issue.body,
    createdAt: issue.created_at,
    updatedAt: issue.updated_at,
    closed: issue.state === 'closed',
    url: '',
    author: { __type: 'Actor', login: issue.user, id: globalId('User', issue.user) },
    comments: {
      __type: 'IssueCommentConnection',
      totalCount: issue.comments.length,
      nodes: issue.comments.map((c) => ({ __type: 'IssueComment', id: globalId('IssueComment', String(c.id)), body: c.body, bodyText: c.body })),
    },
  };
}

/** One pull request as a GraphQL object. */
function pullNode(repo: Repo, pr: Pull): Record<string, unknown> {
  const baseTip = repo.branchTip(pr.base);
  const headTip = repo.branchTip(pr.head);
  const filesList = diffTreesOf(repo, baseTip, headTip);
  return {
    __type: 'PullRequest',
    id: globalId('PullRequest', `${repo.meta.owner}/${repo.meta.name}#${pr.number}`),
    number: pr.number,
    title: pr.title,
    state: pr.merged ? 'MERGED' : pr.state === 'closed' ? 'CLOSED' : 'OPEN',
    headRefName: pr.head,
    baseRefName: pr.base,
    mergeable: 'MERGEABLE',
    merged: pr.merged,
    body: pr.body,
    createdAt: pr.created_at,
    updatedAt: pr.updated_at,
    closed: pr.state === 'closed',
    url: '',
    files: {
      __type: 'PullRequestChangedFileConnection',
      totalCount: filesList.length,
      nodes: filesList.map((f) => ({ __type: 'PullRequestChangedFile', path: f.filename, additions: f.additions, deletions: f.deletions, changeType: f.status.toUpperCase() })),
    },
  };
}

/** The changed files between two tips, as the file connection needs them. */
function diffTreesOf(repo: Repo, baseTip: string | null, headTip: string | null): Array<{ filename: string; additions: number; deletions: number; status: string }> {
  const baseTree = baseTip ? readCommitOf(repo, baseTip)?.tree ?? '' : '';
  const headTree = headTip ? readCommitOf(repo, headTip)?.tree ?? '' : '';
  // imported lazily to keep this module's top-level imports small
  const { diffTrees } = lazyModel();
  return diffTrees(repo.store, baseTree, headTree);
}

/** A commit read through the model module. */
function readCommitOf(repo: Repo, oid: string): { tree: string } | null {
  const { readCommit } = lazyModel();
  return readCommit(repo.store, oid);
}

/** The model module's functions, imported once on first use. */
function lazyModel(): typeof import('./git/model.ts') {
  // a static import keeps this file's dependency graph simple; the wrapper exists so resolvers
  // read like prose
  return model;
}
import * as model from './git/model.ts';

/** A repository as a GraphQL object. */
function repoNode(repo: Repo, forge: Forge): Record<string, unknown> {
  const m = repo.meta;
  const tip = repo.branchTip(m.default_branch);
  return {
    __type: 'Repository',
    id: globalId('Repository', `${m.owner}/${m.name}`),
    databaseId: hashId(`${m.owner}/${m.name}`),
    name: m.name,
    nameWithOwner: `${m.owner}/${m.name}`,
    owner: { __type: 'RepositoryOwner', id: globalId('User', m.owner), login: m.owner, avatarUrl: null, url: '' },
    defaultBranchRef: tip ? { __type: 'Ref', name: m.default_branch, prefix: 'refs/heads/', target: { __type: 'GitObject', oid: tip, abbreviatedOid: tip.slice(0, 7) } } : null,
    viewerPermission: m.owner.toLowerCase() === forge.login.toLowerCase() ? 'ADMIN' : 'READ',
    hasIssuesEnabled: true,
    description: m.description,
    isPrivate: m.private,
    url: '',
    createdAt: m.created_at,
    // resolved per selection, so the order-by and states arguments apply
    issues: (args: Record<string, unknown>): unknown => issueConnectionRaw(repo, args),
    pullRequests: (args: Record<string, unknown>): unknown => pullConnectionRaw(repo, args),
    issue: (args: Record<string, unknown>): unknown => {
      const number = Number(args.number);
      const issue = repo.meta.issues.find((i) => i.number === number);
      return issue ? issueNode(repo, issue) : null;
    },
    pullRequest: (args: Record<string, unknown>): unknown => {
      const number = Number(args.number);
      const pr = repo.meta.pulls.find((p) => p.number === number);
      return pr ? pullNode(repo, pr) : null;
    },
  };
}

/** A selection that asks for everything: used when a field resolves before its selection applies. */
const SELECT_ALL: Selection = { name: '*', alias: null, args: {}, selections: [], fragments: [] };

/** Page Info for a list answered without paging. */
const PAGE_INFO = { __type: 'PageInfo', hasNextPage: false, endCursor: null, hasPreviousPage: false, startCursor: null };

/** Resolve one field on one object, honouring the selections it asked for. */
function resolveField(
  parent: Record<string, unknown>,
  sel: Selection,
  vars: Record<string, unknown>,
  ctx: ResolveContext,
): unknown {
  const name = sel.name;
  const args = resolveVars(sel.args, vars) as Record<string, unknown>;
  if (name === '__typename') return parent.__typename ?? parent.__type ?? 'Query';

  // the repository's collections need their arguments, so they resolve here rather than inline
  if (parent.__type === 'Repository' && ctx.repo) {
    const repo = ctx.repo;
    if (name === 'issues') return resolveIssueConnection(repo, args, sel, vars, ctx);
    if (name === 'pullRequests') return resolvePullConnection(repo, args, sel, vars, ctx);
    if (name === 'issue') {
      const number = Number(args.number);
      const issue = repo.meta.issues.find((i) => i.number === number);
      return issue ? project(issueNode(repo, issue), sel, vars, ctx) : null;
    }
    if (name === 'pullRequest') {
      const number = Number(args.number);
      const pr = repo.meta.pulls.find((p) => p.number === number);
      return pr ? project(pullNode(repo, pr), sel, vars, ctx) : null;
    }
  }

  const value = parent[name];
  if (value === undefined) throw new GraphQLError(`Field '${name}' doesn't exist on type '${String(parent.__type ?? 'Query')}'`, [name]);
  // a field stored as a function resolves with the arguments the selection names
  if (typeof value === 'function') {
    const produced = (value as (a: Record<string, unknown>) => unknown)(args);
    return project(produced, sel, vars, ctx);
  }
  return project(value, sel, vars, ctx);
}

/** Where a resolver reads from. */
interface ResolveContext {
  forge: Forge;
  repo: Repo | null;
}

/** Project a resolved value through a selection set. */
function project(value: unknown, sel: Selection | null, vars: Record<string, unknown>, ctx: ResolveContext): unknown {
  if (sel === null || sel.selections.length === 0) return value;
  if (Array.isArray(value)) return value.map((v) => project(v, sel, vars, ctx));
  if (value === null || typeof value !== 'object') return value;
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const child of includedSelections(sel.selections, ctx, vars)) {
    const key = child.alias ?? child.name;
    out[key] = resolveField(obj, child, vars, ctx);
  }
  return out;
}

/** Every selection that applies, expanding fragments on ...Type. */
function includedSelections(selections: ReadonlyArray<Selection>, ctx: ResolveContext, vars: Record<string, unknown>): Selection[] {
  const out: Selection[] = [];
  for (const s of selections) {
    if (s.name === '...') {
      // an inline fragment spread without a name was already flattened by the parser
      for (const fragName of s.fragments) {
        const frag = ctx.fragments?.get(fragName);
        if (frag) out.push(...frag);
      }
      continue;
    }
    out.push(s);
  }
  void vars;
  return out;
}

/** Extra context a request carries: its fragments. */
interface RequestContext extends ResolveContext {
  fragments?: Map<string, Selection[]>;
}

/** Resolve a connection to its raw shape, without projecting yet (the caller's selection applies). */
function issueConnectionRaw(repo: Repo, args: Record<string, unknown>): Record<string, unknown> {
  let list = repo.meta.issues.slice();
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const want = states.map(String);
    list = list.filter((i) => want.includes(i.state === 'closed' ? 'CLOSED' : 'OPEN'));
  }
  const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
  const field = orderBy?.field === 'UPDATED_AT' ? 'updated_at' : 'created_at';
  const dir = orderBy?.direction === 'ASC' ? 1 : -1;
  list.sort((a, b) => {
    const av = (a as unknown as Record<string, string>)[field]!;
    const bv = (b as unknown as Record<string, string>)[field]!;
    if (av === bv) return (a.number - b.number) * dir;
    return (av < bv ? -1 : 1) * dir;
  });
  const first = args.first === undefined ? list.length : Number(args.first);
  const slice = list.slice(0, first);
  return {
    __type: 'IssueConnection',
    totalCount: list.length,
    nodes: slice.map((i) => issueNode(repo, i)),
    edges: slice.map((i, k) => ({ __type: 'IssueEdge', node: issueNode(repo, i), cursor: String(k) })),
    pageInfo: PAGE_INFO,
  };
}

/** The issue connection, projected through its selection. */
function resolveIssueConnection(repo: Repo, args: Record<string, unknown>, sel: Selection, vars: Record<string, unknown>, ctx: ResolveContext): unknown {
  return project(issueConnectionRaw(repo, args), sel, vars, ctx);
}

/** Resolve a pull connection to its raw shape. */
function pullConnectionRaw(repo: Repo, args: Record<string, unknown>): Record<string, unknown> {
  let list = repo.meta.pulls.slice();
  if (Array.isArray(args.states) && args.states.length > 0) {
    const want = args.states.map(String);
    list = list.filter((p) => want.includes(p.merged ? 'MERGED' : p.state === 'closed' ? 'CLOSED' : 'OPEN'));
  }
  list.sort((a, b) => b.number - a.number);
  const first = args.first === undefined ? list.length : Number(args.first);
  const slice = list.slice(0, first);
  return {
    __type: 'PullRequestConnection',
    totalCount: list.length,
    nodes: slice.map((p) => pullNode(repo, p)),
    edges: [],
    pageInfo: PAGE_INFO,
  };
}

/** The pull request connection, projected through its selection. */
function resolvePullConnection(repo: Repo, args: Record<string, unknown>, sel: Selection, vars: Record<string, unknown>, ctx: ResolveContext): unknown {
  return project(pullConnectionRaw(repo, args), sel, vars, ctx);
}

/** Build the root value for one operation's selections. */
function rootValue(ctx: RequestContext, op: Operation): Record<string, unknown> {
  const isMutation = op.kind === 'mutation';
  return isMutation ? mutationRoot(ctx, op) : queryRoot(ctx);
}

/** The Query root: viewer, repository, search, node. */
function queryRoot(ctx: RequestContext): Record<string, unknown> {
  const forge = ctx.forge;
  return {
    __type: 'Query',
    viewer: { __type: 'User', id: globalId('User', forge.login), login: forge.login, name: forge.login, databaseId: hashId(forge.login) },
    repository: (args: Record<string, unknown>): unknown => {
      const owner = String(args.owner ?? '');
      const name = String(args.name ?? '');
      const repo = forge.get(owner, name);
      return repo ? repoNode(repo, forge) : null;
    },
    search: (args: Record<string, unknown>): unknown => {
      const type = String(args.type ?? 'ISSUE');
      const q = String(args.query ?? '');
      const nodes: unknown[] = [];
      if (type === 'ISSUE') {
        for (const repo of forge.list(forge.login)) {
          for (const issue of repo.meta.issues) {
            const hay = `${issue.title} ${issue.body}`.toLowerCase();
            if (q === '' || hay.includes(q.toLowerCase()) || q.includes('repo:')) nodes.push(issueNode(repo, issue));
          }
        }
      }
      return { __type: 'SearchResultItemConnection', issueCount: nodes.length, nodes, pageInfo: PAGE_INFO };
    },
    node: (): unknown => null,
  };
}

/** The Mutation root: the four mutations gh sends. */
function mutationRoot(ctx: RequestContext, op: Operation): Record<string, unknown> {
  const forge = ctx.forge;
  void op;
  return {
    __type: 'Mutation',
    createRepository: (args: Record<string, unknown>): unknown => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const name = String(input.name ?? '');
      const repo = forge.create(forge.login, name, { description: String(input.description ?? ''), private: input.visibility === 'PRIVATE' });
      return { __type: 'CreateRepositoryPayload', repository: repoNode(repo, forge) };
    },
    createPullRequest: (args: Record<string, unknown>): unknown => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = findRepoByGid(forge, String(input.repositoryId ?? ''));
      if (!repo) return null;
      const now = new Date().toISOString();
      const pr: Pull = {
        id: hashId(`pull:${repo.meta.owner}/${repo.meta.name}:${repo.meta.next_pull_id}`),
        number: repo.meta.next_pull_id++,
        title: String(input.title ?? ''), body: String(input.body ?? ''), state: 'open',
        head: String(input.headRefName ?? ''), base: String(input.baseRefName ?? 'main'),
        user: forge.login, created_at: now, updated_at: now, merged: false, merged_at: null, merge_commit_sha: null,
      };
      repo.meta.pulls.push(pr);
      repo.save();
      return { __type: 'CreatePullRequestPayload', pullRequest: pullNode(repo, pr) };
    },
    createIssue: (args: Record<string, unknown>): unknown => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = findRepoByGid(forge, String(input.repositoryId ?? ''));
      if (!repo) return null;
      const now = new Date().toISOString();
      const issue: Issue = {
        id: hashId(`issue:${repo.meta.owner}/${repo.meta.name}:${repo.meta.next_issue_id}`),
        number: repo.meta.next_issue_id++, title: String(input.title ?? ''), body: String(input.body ?? ''),
        state: 'open', labels: [], user: forge.login, created_at: now, updated_at: now, closed_at: null, comments: [],
      };
      repo.meta.issues.push(issue);
      repo.save();
      return { __type: 'CreateIssuePayload', issue: issueNode(repo, issue) };
    },
    mergePullRequest: (args: Record<string, unknown>): unknown => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = findRepoByGid(forge, String(input.pullRequestId ?? '').split(';')[0] ?? '');
      if (!repo) return null;
      const pr = repo.meta.pulls[repo.meta.pulls.length - 1];
      return pr ? { __type: 'MergePullRequestPayload', pullRequest: pullNode(repo, pr) } : null;
    },
    closeIssue: (): unknown => null,
  };
}

/** Find a repository from a global id ("Repository:owner/name"). */
function findRepoByGid(forge: Forge, gid: string): Repo | null {
  let decoded = gid;
  try {
    decoded = Buffer.from(gid, 'base64').toString('utf8');
  } catch {
    // not base64: use it as it came
  }
  const parts = decoded.split(':');
  if (parts[0] === 'Repository' && parts[1]) {
    const [owner, name] = parts[1].split('/');
    if (owner && name) return forge.get(owner, name);
  }
  return null;
}

/** Answer one /api/graphql request. */
export async function handleGraphQL(forge: Forge, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!authorized(req, forge.token)) {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message: 'Requires authentication' }));
    return;
  }
  // a body may carry one operation, or an array of them answered in order
  const bytes = await readRaw(req);
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString('utf8'));
  } catch {
    respond(res, 400, { message: 'Problems parsing JSON' });
    return;
  }
  if (raw === null || typeof raw !== 'object') {
    respond(res, 400, { message: 'Problems parsing JSON' });
    return;
  }
  const entries: Array<Record<string, unknown>> = Array.isArray(raw) ? (raw as Array<Record<string, unknown>>) : [raw as Record<string, unknown>];
  const answers: unknown[] = [];
  for (const entry of entries) {
    answers.push(answerOne(forge, entry));
  }
  respond(res, 200, Array.isArray(raw) ? answers : answers[0]);
}

/** Answer one GraphQL operation body. */
function answerOne(forge: Forge, entry: Record<string, unknown>): unknown {
  const query = typeof entry.query === 'string' ? entry.query : '';
  const variables = (entry.variables ?? {}) as Record<string, unknown>;
  if (query.trim() === '') return { errors: [{ message: 'query is required' }] };
  let ops: Operation[];
  try {
    ops = parseDocument(query);
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  if (ops.length === 0) return { errors: [{ message: 'no operation found' }] };
  // a document may name which operation to run; the first one is the default
  const opName = typeof entry.operationName === 'string' ? entry.operationName : null;
  const op = (opName ? ops.find((o) => o.name === opName) : null) ?? ops[0]!;
  const ctx: RequestContext = { forge, repo: null, fragments: op.fragments };
  // introspection
  const intro = handleIntrospection(op.selections);
  if (intro !== null) return { data: intro };
  const data: Record<string, unknown> = {};
  const errors: Array<{ message: string; path: string[] }> = [];
  const root = rootValue(ctx, op);
  for (const sel of op.selections) {
    const key = sel.alias ?? sel.name;
    try {
      data[key] = resolveRootField(root, sel, variables, ctx);
    } catch (err) {
      data[key] = null;
      if (err instanceof GraphQLError) errors.push({ message: err.message, path: [key, ...err.path] });
      else errors.push({ message: err instanceof Error ? err.message : String(err), path: [key] });
    }
  }
  return errors.length > 0 ? { data, errors } : { data };
}

/** Resolve one root selection, calling the root's function when the field is one. */
function resolveRootField(root: Record<string, unknown>, sel: Selection, vars: Record<string, unknown>, ctx: RequestContext): unknown {
  const value = root[sel.name];
  if (typeof value === 'function') {
    const args = resolveVars(sel.args, vars) as Record<string, unknown>;
    const produced = (value as (a: Record<string, unknown>) => unknown)(args);
    return project(produced, sel, vars, ctx);
  }
  return resolveField(root, sel, vars, ctx);
}

/** Answer __schema/__type selections; null when the operation is not introspection. */
function handleIntrospection(selections: ReadonlyArray<Selection>): Record<string, unknown> | null {
  const wantsType = selections.some((s) => s.name === '__type');
  const wantsSchema = selections.some((s) => s.name === '__schema');
  if (!wantsType && !wantsSchema) return null;
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    const key = sel.alias ?? sel.name;
    if (sel.name === '__type') {
      const name = String(sel.args.name ?? '');
      out[key] = introspectType(name);
    } else if (sel.name === '__schema') {
      out[key] = {
        queryType: { name: 'Query' },
        mutationType: { name: 'Mutation' },
        types: [...Object.keys(OBJECTS), ...Object.keys(ENUMS), ...Object.keys(INTERFACES)].map((n) => ({ name: n })),
        directives: [{ name: 'include' }, { name: 'skip' }],
      };
    }
  }
  return out;
}

/** The JSON an issue or pull takes in the GraphQL shape (for MCP's shared store reads). */
export function gqlIssueShape(repo: Repo, issue: Issue): Record<string, unknown> {
  return issueNode(repo, issue);
}

/** The JSON a repository takes in the GraphQL shape. */
export function gqlReposShape(repo: Repo, base: string): Record<string, unknown> {
  void base;
  return issueJson(repo, repo.meta.issues[0] ?? ({ number: 0 } as unknown as Issue), '');
}
