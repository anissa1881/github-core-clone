# The test suite beside the entry

The entry is a forge: git smart HTTP, REST v3, GraphQL v4 and MCP over one store. The suite in this
directory tests each surface against the entry itself, bound to an ephemeral port, so a test exercises
the same code path the env does.

## Running it

```bash
node --test test/
```

Node 22 or newer is enough: the files are TypeScript, and the runner strips the types. There are no
dependencies to install, no build step and no test framework to fetch — `node:test` and `node:assert`
are in the runtime. A single file runs on its own:

```bash
node --test test/rest-repos.test.ts
```

Each file is one process and one store. `start()` from `helpers.ts` makes a temporary directory, points
`MAKEFUN_STORE_DIR` at it, sets the token and the login, binds the server on port 0 and hands back the
base URL. Two files therefore never see each other's repositories, and a file's repositories do not
outlive it.

## What each file covers

| file | surface |
|---|---|
| `rest-repos.test.ts` | the API root, the token's user, rate limit, and creating, reading, patching, listing and deleting a repository |
| `rest-contents.test.ts` | files: create, read, update, delete, the sha an update must name, directory listings, and the branch a write lands on |
| `rest-issues.test.ts` | labels and issues: numbering, state filters, a close that fills `closed_at`, comments and their count |
| `rest-pulls.test.ts` | pull requests: open, list, changed files, merge, and the 405 a real conflict earns |
| `graphql.test.ts` | the v4 document surface: connections, cursors, state filters, mutations and per-field errors |
| `mcp.test.ts` | the JSON-RPC handshake, the tool list, every tool, batches and notifications |
| `git-http.test.ts` | the ref advertisement git reads, protocol v2, Basic credentials and the refusals |
| `git-store.test.ts` | the object store, the commit and tree model, pkt-line framing and the forge itself, as units |

## The three habits the suite keeps

1. **Assert the contract, not the implementation.** A test reads a status and the fields a client
   parses. It does not read a private field or a timing.
2. **Name the refusal.** Every route that can refuse has a test for it: 401 without a token, 404 for
   an object the store does not hold, 405 for a method a path does not take, 409 for a stale sha, 422
   for a body that is missing what it must carry.
3. **Keep a fixture small.** A test creates what it needs and asserts on that. The store is cheap, so
   a fresh repository per case costs nothing and keeps a failure readable.

## Fixtures

`helpers.ts` holds the four functions the files share:

- `start()` — one server, one store, one token.
- `api()` — one JSON request with the token as a bearer, answering the status, the parsed body and the
  headers.
- `makeRepo()` — a repository named for the test that asked for it.
- `putFile()` — one commit through the contents API, answering its sha.

A test that needs a branch points a ref at a commit with `POST /git/refs`, which is the same route gh
uses. A test that needs a conflict moves the base and the head over one file and leaves the pull
request opened before the move.

## What the suite deliberately does not do

- It does not start the env. `main.ts` registers the port with the env and exits when the trial ends;
  the suite calls `createApp()` directly, so a test never waits for a trial.
- It does not measure performance. The timing the grader reads comes from the trial run, not from
  here, and a test that asserted on it would fail on a slower machine for no reason.
- It does not reach the network. Every request goes to the loopback port the harness bound.
