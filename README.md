# github-core-clone

A standalone, GitHub-compatible git forge served by one process from its own store: git smart
HTTP (upload-pack protocol v2 for clone and fetch, receive-pack v0 for push), the REST v3 API,
GraphQL v4 and a Model Context Protocol endpoint at `/mcp`. No UI, no outside service, no git
binary, and only Node's standard library.

Entry for make.fun's `github-core-clone-01` bounty.

## Layout

| File | What it holds |
| --- | --- |
| `main.ts` | the entry ↔ env lifecycle: bind an ephemeral port, register it, poll until done |
| `app.ts` | the router that dispatches one request across the four surfaces |
| `store.ts` | the forge's store: repositories, issues, pull requests, labels, on disk |
| `rest.ts` | `/api/v3`: repositories, contents, branches, commits, issues, labels, pulls, merge |
| `graphql.ts` | `/api/graphql`: a tokenizer, the selection-set evaluator, introspection, mutations |
| `mcp.ts` | `/mcp`: JSON-RPC 2.0, `server/discover` and `initialize`, eight tools over the same store |
| `merge.ts` | the one squash-merge path REST and MCP share |
| `http.ts` | the shared JSON reply, request id, body reader and bearer/basic token check |
| `git/pktline.ts` | the pkt-line codec (flush, delim, response-end, 4-hex framing) |
| `git/objects.ts` | loose objects, packfiles both ways, OFS_DELTA and REF_DELTA resolution |
| `git/model.ts` | commits, trees, history walks, tree building, tree diffs |
| `git/http.ts` | the smart-HTTP protocol: v2 ls-refs/fetch, v0 upload-pack, receive-pack |

## Run it

```sh
MAKEFUN_ENV_URL=http://store:8080 MAKEFUN_SHOP_TOKEN=<token> node main.ts
```

The process binds port 0, registers the port it bound with the env, serves until the env says
done, then exits 0.

## Licence

MIT.
