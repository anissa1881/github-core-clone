// graphql.ts: the GraphQL v4 surface. It parses the documents gh and github-mcp-server send
// rather than shipping a schema library: a small tokenizer, a selection-set evaluator, and a
// hand-written schema description that introspection answers.

import { OBJ_BLOB } from './git/objects.ts';
import { diffTrees, readCommit, walkHistory } from './git/model.ts';
import type { Forge, Issue, Pull, Repo } from './store.ts';
import { readBody, respond } from './http.ts';
import { hashId } from './rest.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';

// ---------------------------------------------------------------------------------------------
// A minimal GraphQL document parser: enough for the operation documents the suite sends.
// ---------------------------------------------------------------------------------------------

/** One lexical token: punctuation, a name, a string, a number, or the end of the document. */
type Token = { kind: 'punct' | 'name' | 'string' | 'number' | 'eof'; value: string };

/** The characters that act as single-character punctuation in a GraphQL document. */
const PUNCT = new Set(['{', '}', '(', ')', ':', ',', '[', ']', '!', '=', '@', '|', '&', '$']);

/**
 * Split a document into tokens, skipping whitespace, commas and comments. A string literal is
 * read whole, with its backslash escapes decoded; a block string ("""...""") keeps its text.
 */
function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;

  while (i < src.length) {
    const ch = src[i]!;

    // whitespace and commas are insignificant between tokens
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }

    // a comment runs to the end of its line
    if (ch === '#') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }

    // a block string keeps its raw text, including newlines
    if (src.startsWith('"""', i)) {
      const end = src.indexOf('"""', i + 3);
      const stop = end < 0 ? src.length : end;
      out.push({ kind: 'string', value: src.slice(i + 3, stop) });
      i = end < 0 ? src.length : end + 3;
      continue;
    }

    // a quoted string, with its escapes decoded
    if (ch === '"') {
      let j = i + 1;
      let value = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const esc = src[j + 1]!;
          value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
          continue;
        }
        value += src[j];
        j += 1;
      }
      out.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }

    // a number, with an optional fraction and exponent
    if (/[0-9]/.test(ch) || (ch === '-' && /[0-9]/.test(src[i + 1] ?? ''))) {
      let j = i + 1;
      while (j < src.length && /[0-9.eE+-]/.test(src[j]!)) j += 1;
      out.push({ kind: 'number', value: src.slice(i, j) });
      i = j;
      continue;
    }

    // a name: letters, digits and underscores, never starting with a digit
    if (/[A-Za-z_]/.test(ch)) {
      let j = i + 1;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j]!)) j += 1;
      out.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }

    // a spread's three dots are one token, so a selection can tell "...F" from a field named F
    if (src.startsWith('...', i)) {
      out.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }

    // anything else is one punctuation character
    if (PUNCT.has(ch)) {
      out.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }

    // an unrecognised character is skipped rather than failing the whole document
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
  /** The named fragments this selection spreads (resolved once the document is read). */
  fragments: string[];
  /** The @include / @skip directives this selection carries. */
  directives?: Array<{ name: string; args: Record<string, unknown> }>;
}

/** One named fragment a document defines. */
interface Fragment {
  name: string;
  /** The type condition the fragment applies to, or null. */
  on: string | null;
  selections: Selection[];
}

/** One parsed operation. */
interface Operation {
  kind: 'query' | 'mutation' | 'subscription';
  name: string | null;
  variableDefs: Array<{ name: string; type: string; default?: unknown }>;
  selections: Selection[];
}

/** The result of parsing one document: its operations and the fragments they spread. */
interface Document {
  operations: Operation[];
  fragments: Map<string, Fragment>;
}

/**
 * The parser's own error, carrying the GraphQL error entry a request answers with. A document
 * that cannot be read is a 200 with an errors array, as GitHub answers it.
 */
export class GraphQLError extends Error {
  readonly locations?: Array<{ line: number; column: number }>;

  constructor(message: string, locations?: Array<{ line: number; column: number }>) {
    super(message);
    this.name = 'GraphQLError';
    this.locations = locations;
  }
}

/** A cursor over the token stream, with the parser's small helpers. */
class Cursor {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  /** The token under the cursor. */
  peek(offset = 0): Token {
    return this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)]!;
  }

  /** Consume and answer the token under the cursor. */
  next(): Token {
    const t = this.peek();
    if (t.kind !== 'eof') this.pos += 1;
    return t;
  }

  /** Whether the cursor sits on this punctuation or name. */
  at(value: string): boolean {
    const t = this.peek();
    return (t.kind === 'punct' || t.kind === 'name') && t.value === value;
  }

  /** Consume the expected punctuation or name, or fail. */
  expect(value: string): void {
    if (!this.at(value)) {
      throw new GraphQLError(`Syntax Error: Expected "${value}", found ${JSON.stringify(this.peek().value)}.`);
    }
    this.next();
  }

  /** Consume a name, or fail. */
  name(): string {
    const t = this.peek();
    if (t.kind !== 'name') {
      throw new GraphQLError(`Syntax Error: Expected Name, found ${JSON.stringify(t.value)}.`);
    }
    this.next();
    return t.value;
  }

  done(): boolean {
    return this.peek().kind === 'eof';
  }
}

/** Parse an argument's value: a literal, a variable, a list or an object. */
function parseValue(c: Cursor): unknown {
  const t = c.peek();

  if (t.kind === 'punct' && t.value === '$') {
    c.next();
    return { $var: c.name() };
  }
  if (t.kind === 'punct' && t.value === '[') {
    c.next();
    const list: unknown[] = [];
    while (!c.at(']')) {
      if (c.done()) throw new GraphQLError('Syntax Error: Unterminated list.');
      list.push(parseValue(c));
    }
    c.expect(']');
    return list;
  }
  if (t.kind === 'punct' && t.value === '{') {
    c.next();
    const obj: Record<string, unknown> = {};
    while (!c.at('}')) {
      if (c.done()) throw new GraphQLError('Syntax Error: Unterminated object.');
      const key = c.name();
      c.expect(':');
      obj[key] = parseValue(c);
    }
    c.expect('}');
    return obj;
  }
  if (t.kind === 'string') {
    c.next();
    return t.value;
  }
  if (t.kind === 'number') {
    c.next();
    return Number(t.value);
  }
  if (t.kind === 'name') {
    c.next();
    if (t.value === 'true') return true;
    if (t.value === 'false') return false;
    if (t.value === 'null') return null;
    // an unquoted name used as a value is an enum
    return t.value;
  }

  throw new GraphQLError(`Syntax Error: Unexpected ${JSON.stringify(t.value)}.`);
}

/** Parse a parenthesised argument list, or answer an empty object when there is none. */
function parseArgs(c: Cursor): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  if (!c.at('(')) return args;
  c.expect('(');
  while (!c.at(')')) {
    if (c.done()) throw new GraphQLError('Syntax Error: Unterminated argument list.');
    const name = c.name();
    c.expect(':');
    args[name] = parseValue(c);
  }
  c.expect(')');
  return args;
}

/** Parse a directive list, or answer an empty array when there is none. */
function parseDirectives(c: Cursor): Array<{ name: string; args: Record<string, unknown> }> {
  const out: Array<{ name: string; args: Record<string, unknown> }> = [];
  while (c.at('@')) {
    c.expect('@');
    const name = c.name();
    out.push({ name, args: parseArgs(c) });
  }
  return out;
}

/** Parse a selection set, including inline fragments and fragment spreads. */
function parseSelectionSet(c: Cursor): Selection[] {
  c.expect('{');
  const out: Selection[] = [];

  while (!c.at('}')) {
    if (c.done()) throw new GraphQLError('Syntax Error: Unterminated selection set.');

    // a spread is either an inline fragment (... on Type { ... }) or a named one (...Frag)
    if (c.at('...')) {
      c.next();
      let on: string | null = null;
      let name: string | null = null;
      if (c.at('on')) {
        c.next();
        on = c.name();
      } else if (c.peek().kind === 'name') {
        name = c.name();
      }
      const directives = parseDirectives(c);
      const nested = c.at('{') ? parseSelectionSet(c) : [];

      // an inline fragment carries its own selections; a named spread is resolved by the caller
      const spread: Selection = {
        name: name ?? '__inline',
        alias: null,
        args: on === null ? {} : { __on: on },
        selections: nested,
        fragments: name === null ? [] : [name],
        directives,
      };
      out.push(spread);
      continue;
    }

    const first = c.name();
    let alias: string | null = null;
    let name = first;
    if (c.at(':')) {
      c.next();
      alias = first;
      name = c.name();
    }
    const args = parseArgs(c);
    const directives = parseDirectives(c);
    const selections = c.at('{') ? parseSelectionSet(c) : [];
    out.push({ name, alias, args, selections, fragments: [], directives });
  }

  c.expect('}');
  return out;
}

/** Parse a fragment definition, answering its name and body. */
function parseFragment(c: Cursor): Fragment {
  c.expect('fragment');
  const name = c.name();
  let on: string | null = null;
  if (c.at('on')) {
    c.next();
    on = c.name();
  }
  parseDirectives(c);
  return { name, on, selections: parseSelectionSet(c) };
}

/**
 * Parse a document into its operations, keeping its fragments so a spread can be resolved later.
 * Throws a GraphQLError when the document cannot be read.
 */
function parseDocument(src: string): Document {
  const c = new Cursor(tokenize(src));
  const operations: Operation[] = [];
  const fragments = new Map<string, Fragment>();

  while (!c.done()) {
    if (c.at('fragment')) {
      const f = parseFragment(c);
      fragments.set(f.name, f);
      continue;
    }
    // an operation either opens with query/mutation/subscription, or is a bare selection set
    const t = c.peek();
    const keyword = t.kind === 'name' ? t.value : '';
    const isKeyword = keyword === 'query' || keyword === 'mutation' || keyword === 'subscription';
    if (isKeyword) c.next();
    operations.push(parseOperation(c, isKeyword ? keyword : null));
  }

  if (operations.length === 0) {
    throw new GraphQLError('Syntax Error: No operations in the document.');
  }
  return { operations, fragments };
}

/**
 * Read the rest of an operation whose keyword (if any) was already consumed. `word` is that
 * keyword, or an empty string for a bare selection set.
 */
function parseOperation(c: Cursor, keyword: string | null): Operation {
  const kind: Operation['kind'] = (keyword as Operation['kind'] | null) ?? 'query';
  let name: string | null = null;
  const variableDefs: Array<{ name: string; type: string; default?: unknown }> = [];

  // an anonymous query opens straight at its selection set, so a name here is the operation's
  if (c.peek().kind === 'name') name = c.name();

  if (c.at('(')) {
    c.expect('(');
    while (!c.at(')')) {
      if (c.done()) throw new GraphQLError('Syntax Error: Unterminated variable definitions.');
      c.expect('$');
      const varName = c.name();
      c.expect(':');
      let type = '';
      while (c.at('[')) {
        c.expect('[');
        type += '[';
      }
      type += c.name();
      while (c.at(']')) {
        c.expect(']');
        type += ']';
      }
      if (c.at('!')) {
        c.next();
        type += '!';
      }
      let def: unknown;
      if (c.at('=')) {
        c.next();
        def = parseValue(c);
      }
      variableDefs.push(def === undefined ? { name: varName, type } : { name: varName, type, default: def });
    }
    c.expect(')');
  }

  parseDirectives(c);
  return { kind, name, variableDefs, selections: parseSelectionSet(c) };
}

/** Resolve `{ $var: name }` markers against the request's variables. */
function resolveVars(value: unknown, vars: Record<string, unknown>): unknown {
  if (Array.isArray(value)) return value.map((v) => resolveVars(v, vars));
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record['$var'] === 'string') return vars[record['$var']];
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(record)) out[k] = resolveVars(v, vars);
    return out;
  }
  return value;
}

/** Expose the parser to the test file only; the entry uses it through handleGraphQL. */
export function parseDocumentForTest(src: string): Document {
  return parseDocument(src);
}

// ---------------------------------------------------------------------------------------------
// The schema: what introspection answers, and the types the resolvers return.
// ---------------------------------------------------------------------------------------------

/** One field of an object type, with its type as SDL-ish text. */
interface FieldDef {
  type: string;
  args?: Record<string, string>;
}

/** One type reference as introspection reports it: a named type, a list, or a non-null wrapper. */
function typeRef(t: string): Record<string, unknown> {
  let text = t.trim();

  if (text.endsWith('!')) {
    return { kind: 'NON_NULL', name: null, ofType: typeRef(text.slice(0, -1)) };
  }
  if (text.startsWith('[') && text.endsWith(']')) {
    return { kind: 'LIST', name: null, ofType: typeRef(text.slice(1, -1)) };
  }
  const kind = SCALARS.has(text) ? 'SCALAR' : ENUMS[text] ? 'ENUM' : INTERFACES[text] ? 'INTERFACE' : 'OBJECT';
  return { kind, name: text, ofType: null };
}

/** The scalar types the schema names. */
const SCALARS = new Set(['String', 'Int', 'Float', 'Boolean', 'ID', 'DateTime', 'URI', 'GitObjectID', 'HTML', 'Base64String']);

/** The object types introspection describes. */
const OBJECTS: Record<string, Record<string, FieldDef>> = {
  Query: {
    viewer: { type: 'User!' },
    repository: { type: 'Repository', args: { owner: 'String!', name: 'String!' } },
    node: { type: 'Node', args: { id: 'ID!' } },
    search: { type: 'SearchResultItemConnection!', args: { query: 'String!', first: 'Int', type: 'SearchType!' } },
  },
  Mutation: {
    createRepository: { type: 'CreateRepositoryPayload', args: { input: 'CreateRepositoryInput!' } },
    createIssue: { type: 'CreateIssuePayload', args: { input: 'CreateIssueInput!' } },
    closeIssue: { type: 'CloseIssuePayload', args: { input: 'CloseIssueInput!' } },
    addComment: { type: 'AddCommentPayload', args: { input: 'AddCommentInput!' } },
    createPullRequest: { type: 'CreatePullRequestPayload', args: { input: 'CreatePullRequestInput!' } },
    mergePullRequest: { type: 'MergePullRequestPayload', args: { input: 'MergePullRequestInput!' } },
  },
  User: {
    login: { type: 'String!' },
    id: { type: 'ID!' },
    name: { type: 'String' },
    repositories: { type: 'RepositoryConnection!', args: { first: 'Int' } },
  },
  Repository: {
    id: { type: 'ID!' },
    databaseId: { type: 'Int' },
    name: { type: 'String!' },
    nameWithOwner: { type: 'String!' },
    description: { type: 'String' },
    isPrivate: { type: 'Boolean!' },
    owner: { type: 'User!' },
    viewerPermission: { type: 'String' },
    hasIssuesEnabled: { type: 'Boolean!' },
    defaultBranchRef: { type: 'Ref' },
    issue: { type: 'Issue', args: { number: 'Int!' } },
    pullRequest: { type: 'PullRequest', args: { number: 'Int!' } },
    issues: { type: 'IssueConnection!', args: { first: 'Int', states: '[IssueState!]', orderBy: 'IssueOrder' } },
    pullRequests: { type: 'PullRequestConnection!', args: { first: 'Int', states: '[PullRequestState!]' } },
  },
  Ref: { name: { type: 'String!' }, target: { type: 'Commit' } },
  Commit: { oid: { type: 'GitObjectID!' }, message: { type: 'String!' }, tree: { type: 'Tree' } },
  Tree: { oid: { type: 'GitObjectID!' }, entries: { type: '[TreeEntry!]!' } },
  TreeEntry: { name: { type: 'String!' }, type: { type: 'String!' }, oid: { type: 'GitObjectID!' } },
  Issue: {
    id: { type: 'ID!' },
    number: { type: 'Int!' },
    title: { type: 'String!' },
    body: { type: 'String' },
    state: { type: 'IssueState!' },
    author: { type: 'User' },
    labels: { type: 'LabelConnection!', args: { first: 'Int' } },
  },
  PullRequest: {
    id: { type: 'ID!' },
    number: { type: 'Int!' },
    title: { type: 'String!' },
    body: { type: 'String' },
    state: { type: 'PullRequestState!' },
    merged: { type: 'Boolean!' },
    mergeable: { type: 'MergeableState!' },
    headRefName: { type: 'String!' },
    baseRefName: { type: 'String!' },
    mergeCommit: { type: 'Commit' },
    files: { type: 'PullRequestChangedFileConnection!', args: { first: 'Int' } },
  },
  PullRequestChangedFile: { path: { type: 'String!' }, additions: { type: 'Int!' }, deletions: { type: 'Int!' } },
  Label: { id: { type: 'ID!' }, name: { type: 'String!' }, color: { type: 'String!' } },
  PageInfo: {
    hasNextPage: { type: 'Boolean!' },
    hasPreviousPage: { type: 'Boolean!' },
    startCursor: { type: 'String' },
    endCursor: { type: 'String' },
  },
  IssueConnection: { nodes: { type: '[Issue]' }, totalCount: { type: 'Int!' }, pageInfo: { type: 'PageInfo!' } },
  PullRequestConnection: { nodes: { type: '[PullRequest]' }, totalCount: { type: 'Int!' }, pageInfo: { type: 'PageInfo!' } },
  RepositoryConnection: { nodes: { type: '[Repository]' }, totalCount: { type: 'Int!' }, pageInfo: { type: 'PageInfo!' } },
  LabelConnection: { nodes: { type: '[Label]' }, totalCount: { type: 'Int!' }, pageInfo: { type: 'PageInfo!' } },
  PullRequestChangedFileConnection: { nodes: { type: '[PullRequestChangedFile]' }, totalCount: { type: 'Int!' }, pageInfo: { type: 'PageInfo!' } },
  SearchResultItemConnection: { nodes: { type: '[SearchResultItem]' }, issueCount: { type: 'Int!' }, pageInfo: { type: 'PageInfo!' } },
  SearchResultItem: { id: { type: 'ID!' } },
  CreateRepositoryPayload: { repository: { type: 'Repository' } },
  CreateIssuePayload: { issue: { type: 'Issue' } },
  CloseIssuePayload: { issue: { type: 'Issue' } },
  AddCommentPayload: { issueComment: { type: 'IssueComment' } },
  CreatePullRequestPayload: { pullRequest: { type: 'PullRequest' } },
  MergePullRequestPayload: { pullRequest: { type: 'PullRequest' } },
  IssueComment: { id: { type: 'ID!' }, body: { type: 'String!' } },
};

/** The enum types introspection describes. */
const ENUMS: Record<string, string[]> = {
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  SearchType: ['ISSUE', 'REPOSITORY', 'USER'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
};

/** The interface types introspection describes. */
const INTERFACES: Record<string, Record<string, FieldDef>> = {
  Node: { id: { type: 'ID!' } },
};

/** One input object type's fields, for the mutation arguments. */
const INPUTS: Record<string, Record<string, string>> = {
  CreateRepositoryInput: { name: 'String!', description: 'String', isPrivate: 'Boolean' },
  CreateIssueInput: { repositoryId: 'ID!', title: 'String!', body: 'String' },
  CloseIssueInput: { issueId: 'ID!' },
  AddCommentInput: { subjectId: 'ID!', body: 'String!' },
  CreatePullRequestInput: { repositoryId: 'ID!', baseRefName: 'String!', headRefName: 'String!', title: 'String!', body: 'String' },
  MergePullRequestInput: { pullRequestId: 'ID!' },
};

/** Build one introspection type object for a named type, or null when it is unknown. */
function introspectType(name: string): Record<string, unknown> | null {
  const fields = OBJECTS[name];
  if (fields) {
    return {
      kind: 'OBJECT',
      name,
      description: null,
      fields: Object.entries(fields).map(([fieldName, def]) => ({
        name: fieldName,
        description: null,
        args: Object.entries(def.args ?? {}).map(([argName, argType]) => ({
          name: argName,
          description: null,
          type: typeRef(argType),
          defaultValue: null,
        })),
        type: typeRef(def.type),
        isDeprecated: false,
        deprecationReason: null,
      })),
      inputFields: null,
      interfaces: name === 'Repository' || name === 'Issue' || name === 'PullRequest' || name === 'User' ? [] : [],
      enumValues: null,
      possibleTypes: null,
    };
  }

  const values = ENUMS[name];
  if (values) {
    return {
      kind: 'ENUM',
      name,
      description: null,
      fields: null,
      inputFields: null,
      interfaces: null,
      enumValues: values.map((v) => ({ name: v, description: null, isDeprecated: false, deprecationReason: null })),
      possibleTypes: null,
    };
  }

  const input = INPUTS[name];
  if (input) {
    return {
      kind: 'INPUT_OBJECT',
      name,
      description: null,
      fields: null,
      inputFields: Object.entries(input).map(([n, t]) => ({ name: n, description: null, type: typeRef(t), defaultValue: null })),
      interfaces: null,
      enumValues: null,
      possibleTypes: null,
    };
  }

  const iface = INTERFACES[name];
  if (iface) {
    return {
      kind: 'INTERFACE',
      name,
      description: null,
      fields: Object.entries(iface).map(([n, def]) => ({
        name: n,
        description: null,
        args: [],
        type: typeRef(def.type),
        isDeprecated: false,
        deprecationReason: null,
      })),
      inputFields: null,
      interfaces: [],
      enumValues: null,
      possibleTypes: [{ kind: 'OBJECT', name: 'Repository', ofType: null }],
    };
  }

  if (SCALARS.has(name)) {
    return {
      kind: 'SCALAR',
      name,
      description: null,
      fields: null,
      inputFields: null,
      interfaces: null,
      enumValues: null,
      possibleTypes: null,
    };
  }

  return null;
}

/** Every type name the schema knows. */
function allTypeNames(): string[] {
  return [...Object.keys(OBJECTS), ...Object.keys(ENUMS), ...Object.keys(INPUTS), ...Object.keys(INTERFACES), ...SCALARS];
}

// ---------------------------------------------------------------------------------------------
// Resolvers: the shapes the fields read from, and the evaluator that projects a selection set.
// ---------------------------------------------------------------------------------------------

/** A node's global id, as GitHub's base64 "Type:id" form. */
function globalId(type: string, local: string): string {
  return Buffer.from(`${type}:${local}`).toString('base64');
}

/** The one id an object answers, from its global id field. */
const GID = '__gid';

/** Page info for a list answered without paging. */
const PAGE_INFO = { __type: 'PageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null };

/** The type tag a node carries, so a connection can name its kind. */
const TYPE_TAG = '__type';

/** One issue as the resolver answers it. */
function issueNode(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    [TYPE_TAG]: 'Issue',
    [GID]: globalId('Issue', String(issue.id)),
    id: globalId('Issue', String(issue.id)),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state === 'closed' ? 'CLOSED' : 'OPEN',
    author: { [TYPE_TAG]: 'User', login: issue.user, id: globalId('User', issue.user), name: issue.user },
    labels: {
      [TYPE_TAG]: 'LabelConnection',
      nodes: issue.labels.map((name) => ({
        [TYPE_TAG]: 'Label',
        id: globalId('Label', name),
        name,
        color: 'ededed',
      })),
      totalCount: issue.labels.length,
      pageInfo: PAGE_INFO,
    },
    __comments: issue.comments.map((c) => ({
      [TYPE_TAG]: 'IssueComment',
      id: globalId('IssueComment', String(c.id)),
      body: c.body,
    })),
  };
}

/** One pull request as the resolver answers it, with its changed files ready. */
function pullNode(repo: Repo, pr: Pull): Record<string, unknown> {
  const baseTip = repo.branchTip(pr.base);
  const headTip = repo.branchTip(pr.head);
  const baseTree = baseTip ? (readCommit(repo.store, baseTip)?.tree ?? '') : '';
  const headTree = headTip ? (readCommit(repo.store, headTip)?.tree ?? '') : '';
  const changed = headTip ? diffTrees(repo.store, baseTree, headTree) : [];

  return {
    [TYPE_TAG]: 'PullRequest',
    [GID]: globalId('PullRequest', String(pr.id)),
    id: globalId('PullRequest', String(pr.id)),
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.merged ? 'MERGED' : pr.state === 'closed' ? 'CLOSED' : 'OPEN',
    merged: pr.merged,
    mergeable: pr.merged ? 'UNKNOWN' : 'MERGEABLE',
    headRefName: pr.head,
    baseRefName: pr.base,
    mergeCommit: pr.merge_commit_sha === null ? null : commitShape(repo, pr.merge_commit_sha),
    files: {
      [TYPE_TAG]: 'PullRequestChangedFileConnection',
      nodes: changed.map((d) => ({
        [TYPE_TAG]: 'PullRequestChangedFile',
        path: d.filename,
        additions: d.additions,
        deletions: d.deletions,
      })),
      totalCount: changed.length,
      pageInfo: PAGE_INFO,
    },
  };
}

/** A commit as the resolver answers it. */
function commitShape(repo: Repo, oid: string): Record<string, unknown> | null {
  const c = readCommit(repo.store, oid);
  if (!c) return null;
  return { [TYPE_TAG]: 'Commit', oid, message: c.message, tree: { [TYPE_TAG]: 'Tree', oid: c.tree } };
}

/** A repository as the resolver answers it. */
function repoNode(repo: Repo, forge: Forge): Record<string, unknown> {
  const m = repo.meta;
  const tip = repo.branchTip(m.default_branch);
  return {
    [TYPE_TAG]: 'Repository',
    [GID]: globalId('Repository', `${m.owner}/${m.name}`),
    id: globalId('Repository', `${m.owner}/${m.name}`),
    databaseId: hashId(`repo:${m.owner}/${m.name}`) % 2147483647,
    name: m.name,
    nameWithOwner: `${m.owner}/${m.name}`,
    description: m.description === '' ? null : m.description,
    isPrivate: m.private,
    owner: { [TYPE_TAG]: 'User', login: m.owner, id: globalId('User', m.owner), name: m.owner },
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    defaultBranchRef:
      tip === null
        ? null
        : { [TYPE_TAG]: 'Ref', name: m.default_branch, target: commitShape(repo, tip) },
    __issues: () => m.issues.map((i) => issueNode(repo, i)),
    __pulls: () => m.pulls.map((p) => pullNode(repo, p)),
    __owner: m.owner,
    __name: m.name,
  };
}

/** The connection shape both issue and pull list fields answer. */
function connection(kind: string, nodes: unknown[]): Record<string, unknown> {
  return { [TYPE_TAG]: kind, nodes, totalCount: nodes.length, pageInfo: PAGE_INFO };
}

/** Whether a selection's @skip / @include directives let it apply. */
function selectionApplies(sel: Selection, vars: Record<string, unknown>): boolean {
  for (const d of sel.directives ?? []) {
    if (d.name === 'skip' && resolveVars(d.args.if, vars) === true) return false;
    if (d.name === 'include' && resolveVars(d.args.if, vars) === false) return false;
  }
  return true;
}

/** The selections that apply, with named fragment spreads expanded in place. */
function expand(selections: ReadonlyArray<Selection>, frags: Map<string, Fragment>, vars: Record<string, unknown>): Selection[] {
  const out: Selection[] = [];
  for (const sel of selections) {
    if (!selectionApplies(sel, vars)) continue;
    // a named spread contributes the fragment's own selections
    for (const name of sel.fragments) {
      const f = frags.get(name);
      if (f) out.push(...expand(f.selections, frags, vars));
      else throw new GraphQLError(`Unknown fragment ${JSON.stringify(name)}.`);
    }
    // an inline fragment contributes its nested selections
    if (sel.fragments.length === 0 && sel.name === '__inline') {
      out.push(...expand(sel.selections, frags, vars));
      continue;
    }
    if (sel.fragments.length > 0) continue;
    out.push(sel);
  }
  return out;
}

/** The fields one object answers from its projection. */
function projectObject(value: Record<string, unknown>, selections: Selection[], vars: Record<string, unknown>, frags: Map<string, Fragment>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of expand(selections, frags, vars)) {
    const key = sel.alias ?? sel.name;
    out[key] = resolveOne(value, sel, vars, frags);
  }
  return out;
}

/** Resolve one field on one object, following nested selections. */
function resolveOne(value: Record<string, unknown>, sel: Selection, vars: Record<string, unknown>, frags: Map<string, Fragment>): unknown {
  const args = resolveVars(sel.args, vars) as Record<string, unknown>;
  const tag = String(value[TYPE_TAG] ?? '');

  // __typename answers any object's own type name
  if (sel.name === '__typename') return tag === '' ? null : tag;

  // a list, a connection, or a lazy list of nodes
  if (sel.name === 'nodes' && Array.isArray(value.nodes)) {
    return (value.nodes as unknown[]).map((n) => projectAny(n, sel.selections, vars, frags));
  }
  if (sel.name === 'nodes' && typeof value.__nodesOf === 'function') {
    const list = (value.__nodesOf as () => unknown[])();
    return list.map((n) => projectAny(n, sel.selections, vars, frags));
  }

  // a single issue or pull request by number
  if (tag === 'Repository' && sel.name === 'issue') {
    const all = (value.__issues as () => unknown[])();
    const hit = all.find((n) => (n as Record<string, unknown>).number === Number(args.number));
    return hit === undefined ? null : projectAny(hit, sel.selections, vars, frags);
  }
  if (tag === 'Repository' && sel.name === 'pullRequest') {
    const all = (value.__pulls as () => unknown[])();
    const hit = all.find((n) => (n as Record<string, unknown>).number === Number(args.number));
    return hit === undefined ? null : projectAny(hit, sel.selections, vars, frags);
  }

  // repository lists resolve through the lazy accessors
  if (tag === 'Repository' && sel.name === 'issues') {
    const all = (value.__issues as () => unknown[])();
    return projectAny(connection('IssueConnection', applyStates(all, args.states, 'OPEN')), sel.selections, vars, frags);
  }
  if (tag === 'Repository' && sel.name === 'pullRequests') {
    const all = (value.__pulls as () => unknown[])();
    return projectAny(connection('PullRequestConnection', applyStates(all, args.states, 'OPEN')), sel.selections, vars, frags);
  }

  const direct = value[sel.name];
  if (direct === undefined) {
    // a field the shape does not carry is a schema error, as GitHub answers it
    throw new GraphQLError(`Field '${sel.name}' doesn't exist on type '${tag === '' ? 'User' : tag}'`);
  }
  if (direct !== null && typeof direct === 'object' && !Buffer.isBuffer(direct) && sel.selections.length > 0) {
    return projectAny(direct, sel.selections, vars, frags);
  }
  if (Array.isArray(direct)) {
    return direct.map((v) => projectAny(v, sel.selections, vars, frags));
  }
  return direct;
}

/** Project any value: an object through its selection set, a scalar as itself. */
function projectAny(value: unknown, selections: Selection[], vars: Record<string, unknown>, frags: Map<string, Fragment>): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => projectAny(v, selections, vars, frags));
  return projectObject(value as Record<string, unknown>, selections, vars, frags);
}

/** Narrow a list of nodes to the states asked for; the states arrive as enum names. */
function applyStates(nodes: unknown[], states: unknown, openName: string): unknown[] {
  const wanted = Array.isArray(states) ? states.map(String) : [];
  if (wanted.length === 0) return nodes.filter((n) => (n as Record<string, unknown>).state === openName);
  return nodes.filter((n) => wanted.includes(String((n as Record<string, unknown>).state)));
}

// ---------------------------------------------------------------------------------------------
// Operations: the Query and Mutation roots, introspection, and the HTTP handler.
// ---------------------------------------------------------------------------------------------

/** The context one request resolves against. */
interface RequestContext {
  forge: Forge;
  vars: Record<string, unknown>;
  frags: Map<string, Fragment>;
}

/** The viewer: the account the token names, with its repositories. */
function viewerShape(forge: Forge): Record<string, unknown> {
  const repos = forge.list(forge.login);
  return {
    [TYPE_TAG]: 'User',
    [GID]: globalId('User', forge.login),
    id: globalId('User', forge.login),
    login: forge.login,
    name: forge.login,
    repositories: {
      [TYPE_TAG]: 'RepositoryConnection',
      __nodesOf: () => repos.map((r) => repoNode(r, forge)),
      totalCount: repos.length,
      pageInfo: PAGE_INFO,
    },
  };
}

/** Find a repository from a global id ("Repository:owner/name"). */
function findRepoByGid(forge: Forge, gid: string): Repo | null {
  const decoded = Buffer.from(gid, 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  const body = colon >= 0 ? decoded.slice(colon + 1) : decoded;
  const slash = body.indexOf('/');
  if (slash < 0) return null;
  return forge.get(body.slice(0, slash), body.slice(slash + 1));
}

/** Find a repository by owner and name, restricted to the token's own repositories. */
function findRepoByName(forge: Forge, owner: unknown, name: unknown): Repo | null {
  const repo = forge.get(String(owner ?? ''), String(name ?? ''));
  if (!repo) return null;
  return repo.meta.owner.toLowerCase() === forge.login.toLowerCase() ? repo : null;
}

/** Write one new issue into a repository, answering its shape. */
function createIssueIn(repo: Repo, title: string, body: string): Record<string, unknown> {
  const m = repo.meta;
  const now = new Date().toISOString();
  const issue: Issue = {
    id: hashId(`issue:${m.owner}/${m.name}:${m.next_issue_id}`),
    number: m.next_issue_id++,
    title,
    body,
    state: 'open',
    labels: [],
    user: m.owner,
    created_at: now,
    updated_at: now,
    closed_at: null,
    comments: [],
  };
  m.issues.push(issue);
  repo.save();
  return issueNode(repo, issue);
}

/** The Query root's resolvers. */
function queryRoot(ctx: RequestContext, selections: Selection[]): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  for (const sel of selections) {
    // introspection fields are answered by the schema, never by the store
    if (sel.name.startsWith('__')) continue;
    const args = resolveVars(sel.args, ctx.vars) as Record<string, unknown>;
    switch (sel.name) {
      case 'viewer':
        root.viewer = viewerShape(ctx.forge);
        break;
      case 'repository': {
        const repo = findRepoByName(ctx.forge, args.owner, args.name);
        root.repository = repo ? repoNode(repo, ctx.forge) : null;
        break;
      }
      case 'node': {
        const gid = String(args.id ?? '');
        const kind = Buffer.from(gid, 'base64').toString('utf8').split(':')[0] ?? '';
        if (kind === 'Repository') {
          const repo = findRepoByGid(ctx.forge, gid);
          root.node = repo ? repoNode(repo, ctx.forge) : null;
        } else {
          root.node = null;
        }
        break;
      }
      case 'search': {
        const repos = ctx.forge.list(ctx.forge.login);
        root.search = connection('SearchResultItemConnection', repos.map((r) => repoNode(r, ctx.forge)));
        break;
      }
      default:
        throw new GraphQLError(`Cannot query field "${sel.name}" on type "Query".`);
    }
  }
  return root;
}

/** The Mutation root's resolvers. */
async function mutationRoot(ctx: RequestContext, selections: Selection[]): Promise<Record<string, unknown>> {
  const root: Record<string, unknown> = {};
  const forge = ctx.forge;

  for (const sel of selections) {
    const args = resolveVars(sel.args, ctx.vars) as Record<string, unknown>;
    const input = (args.input ?? {}) as Record<string, unknown>;

    switch (sel.name) {
      case 'createRepository': {
        const name = String(input.name ?? '').trim();
        if (name === '') throw new GraphQLError('Name is required.');
        const repo = forge.create(forge.login, name, {
          description: typeof input.description === 'string' ? input.description : '',
          private: input.isPrivate === true,
        });
        root.createRepository = { [TYPE_TAG]: 'CreateRepositoryPayload', repository: repoNode(repo, forge) };
        break;
      }

      case 'createIssue': {
        const repo = findRepoByGid(forge, String(input.repositoryId ?? ''));
        if (!repo) throw new GraphQLError('Could not resolve to a Repository with that id.');
        const title = String(input.title ?? '').trim();
        if (title === '') throw new GraphQLError('Title is required.');
        const issue = createIssueIn(repo, title, typeof input.body === 'string' ? input.body : '');
        root.createIssue = { [TYPE_TAG]: 'CreateIssuePayload', issue };
        break;
      }

      case 'closeIssue': {
        // the issue id names the repository and the issue number
        const decoded = Buffer.from(String(input.issueId ?? ''), 'base64').toString('utf8');
        const local = decoded.slice(decoded.indexOf(':') + 1);
        const found = findIssueByLocal(forge, local);
        if (!found) throw new GraphQLError('Could not resolve to an Issue with that id.');
        found.issue.state = 'closed';
        found.issue.closed_at = new Date().toISOString();
        found.issue.updated_at = found.issue.closed_at;
        found.repo.save();
        root.closeIssue = { [TYPE_TAG]: 'CloseIssuePayload', issue: issueNode(found.repo, found.issue) };
        break;
      }

      case 'addComment': {
        const decoded = Buffer.from(String(input.subjectId ?? ''), 'base64').toString('utf8');
        const local = decoded.slice(decoded.indexOf(':') + 1);
        const found = findIssueByLocal(forge, local);
        if (!found) throw new GraphQLError('Could not resolve to an Issue with that id.');
        const now = new Date().toISOString();
        const comment = { id: found.repo.meta.next_comment_id++, body: String(input.body ?? ''), user: found.repo.meta.owner, created_at: now };
        found.issue.comments.push(comment);
        found.issue.updated_at = now;
        found.repo.save();
        root.addComment = {
          [TYPE_TAG]: 'AddCommentPayload',
          issueComment: { [TYPE_TAG]: 'IssueComment', id: globalId('IssueComment', String(comment.id)), body: comment.body },
        };
        break;
      }

      case 'createPullRequest': {
        const repo = findRepoByGid(forge, String(input.repositoryId ?? ''));
        if (!repo) throw new GraphQLError('Could not resolve to a Repository with that id.');
        const m = repo.meta;
        const now = new Date().toISOString();
        const pr: Pull = {
          id: hashId(`pull:${m.owner}/${m.name}:${m.next_pull_id}`),
          number: m.next_pull_id++,
          title: String(input.title ?? ''),
          body: typeof input.body === 'string' ? input.body : '',
          state: 'open',
          head: String(input.headRefName ?? ''),
          base: String(input.baseRefName ?? m.default_branch),
          user: m.owner,
          created_at: now,
          updated_at: now,
          merged: false,
          merged_at: null,
          merge_commit_sha: null,
        };
        m.pulls.push(pr);
        repo.save();
        root.createPullRequest = { [TYPE_TAG]: 'CreatePullRequestPayload', pullRequest: pullNode(repo, pr) };
        break;
      }

      case 'mergePullRequest': {
        const decoded = Buffer.from(String(input.pullRequestId ?? ''), 'base64').toString('utf8');
        const local = decoded.slice(decoded.indexOf(':') + 1);
        const found = findPullByLocal(forge, local);
        if (!found) throw new GraphQLError('Could not resolve to a PullRequest with that id.');
        if (!found.repo.branchTip(found.pr.head)) throw new GraphQLError(`Head branch ${found.pr.head} not found.`);
        const { mergeViaMcp } = await import('./merge.ts');
        mergeViaMcp(found.repo, found.pr);
        root.mergePullRequest = { [TYPE_TAG]: 'MergePullRequestPayload', pullRequest: pullNode(found.repo, found.pr) };
        break;
      }

      default:
        throw new GraphQLError(`Cannot query field "${sel.name}" on type "Mutation".`);
    }
  }

  return root;
}

/** Find an issue from the local part of its global id ("id:owner/name:number" style keys). */
function findIssueByLocal(forge: Forge, local: string): { repo: Repo; issue: Issue } | null {
  for (const repo of forge.list(forge.login)) {
    for (const issue of repo.meta.issues) {
      if (String(issue.id) === local || `${repo.meta.owner}/${repo.meta.name}:${issue.number}` === local) {
        return { repo, issue };
      }
    }
  }
  return null;
}

/** Find a pull request from the local part of its global id. */
function findPullByLocal(forge: Forge, local: string): { repo: Repo; pr: Pull } | null {
  for (const repo of forge.list(forge.login)) {
    for (const pr of repo.meta.pulls) {
      if (String(pr.id) === local || `${repo.meta.owner}/${repo.meta.name}:${pr.number}` === local) {
        return { repo, pr };
      }
    }
  }
  return null;
}

/** The introspection answer for a __schema / __type selection. */
function introspection(selections: Selection[], vars: Record<string, unknown>, frags: Map<string, Fragment>): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  for (const sel of expand(selections, frags, vars)) {
    const args = resolveVars(sel.args, vars) as Record<string, unknown>;

    if (sel.name === '__schema') {
      const sub = expand(sel.selections, frags, vars).map((s) => s.name);
      const schema: Record<string, unknown> = {};
      if (sub.includes('queryType')) schema.queryType = { name: 'Query', kind: 'OBJECT' };
      if (sub.includes('mutationType')) schema.mutationType = { name: 'Mutation', kind: 'OBJECT' };
      if (sub.includes('subscriptionType')) schema.subscriptionType = null;
      if (sub.includes('types')) {
        schema.types = allTypeNames()
          .map((n) => introspectType(n))
          .filter((t) => t !== null)
          .sort((a, b) => (String(a!.name) < String(b!.name) ? -1 : 1));
      }
      out.__schema = schema;
      continue;
    }

    if (sel.name === '__type') {
      const typeName = String(args.name ?? '');
      out.__type = introspectType(typeName);
      continue;
    }

    if (sel.name === '__typename') {
      out.__typename = 'Query';
      continue;
    }
  }

  return out;
}

/** Answer one GraphQL request body. */
async function answerOne(forge: Forge, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const source = typeof body.query === 'string' ? body.query : '';
  const provided = body.variables !== null && typeof body.variables === 'object' ? (body.variables as Record<string, unknown>) : {};

  if (source.trim() === '') {
    return { errors: [{ message: 'A query string is required.', locations: [], path: [] }] };
  }

  let doc: Document;
  try {
    doc = parseDocument(source);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Syntax Error.';
    return { errors: [{ message }] };
  }

  const visible = doc.operations.find((o) => o.kind !== 'subscription') ?? doc.operations[0]!;

  // a variable's default fills in for anything the caller did not send
  const vars: Record<string, unknown> = { ...provided };
  for (const def of visible.variableDefs) {
    if (vars[def.name] === undefined && def.default !== undefined) vars[def.name] = def.default;
  }

  const ctx: RequestContext = { forge, vars, frags: doc.fragments };

  try {
    const fields = expand(visible.selections, doc.fragments, vars);
    const root = visible.kind === 'mutation' ? await mutationRoot(ctx, fields) : queryRoot(ctx, fields);
    const data: Record<string, unknown> = {};

    for (const sel of fields) {
      const key = sel.alias ?? sel.name;

      // an introspection field answers from the schema, under whatever alias it was asked for
      if (sel.name === '__type' || sel.name === '__schema' || sel.name === '__typename') {
        const answered = introspection([sel], vars, doc.fragments);
        data[key] = sel.selections.length === 0 ? answered[sel.name] ?? null : projectAny(answered[sel.name], sel.selections, vars, doc.fragments);
        continue;
      }

      const value = root[sel.name];
      data[key] = sel.selections.length === 0 ? value ?? null : projectAny(value, sel.selections, vars, doc.fragments);
    }
    return { data };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal error.';
    return { errors: [{ message, locations: [], path: [] }], data: null };
  }
}

/** Answer one POST /api/graphql or /graphql request. */
export async function handleGraphQL(forge: Forge, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req, res);
  if (body === null) return;
  const answer = await answerOne(forge, body);
  respond(res, 200, answer);
}
