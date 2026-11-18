package main

// The Model Context Protocol endpoint at /mcp: JSON-RPC 2.0 over Streamable HTTP, answering both the
// server/discover revision and the earlier initialize handshake, with tools that act on the same
// store REST does.

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
)

// The protocol revision this endpoint speaks.
const mcpRevision = "2026-07-28"

// The earlier revisions it still answers through initialize.
var mcpSupportedRevisions = []string{"2026-07-28", "2025-11-25", "2025-06-18", "2024-11-05"}

// rpcError is a JSON-RPC error with its code.
type rpcError struct {
	code    int
	message string
}

func (e rpcError) Error() string { return e.message }

// toolResult is one tool's answer: its content lines, and whether it reports a failure.
type toolResult struct {
	Content []map[string]any `json:"content"`
	IsError bool             `json:"isError,omitempty"`
}

// jsonResult answers a tool result carrying JSON text.
func jsonResult(value any) toolResult {
	text, err := json.Marshal(value)
	if err != nil {
		text = []byte("{}")
	}
	return toolResult{Content: []map[string]any{{"type": "text", "text": string(text)}}}
}

// errorResult answers a tool result reporting a failure, never a transport error.
func errorResult(message string) toolResult {
	return toolResult{
		Content: []map[string]any{{"type": "text", "text": message}},
		IsError: true,
	}
}

// throwError is the Go form of throwing an rpcError out of a tool.
func throwError(code int, message string) {
	panic(rpcError{code: code, message: message})
}

// requireString answers a required non-empty string argument, or refuses with -32602.
func requireString(args map[string]any, name string) string {
	if v, ok := args[name].(string); ok && v != "" {
		return v
	}
	throwError(-32602, "Missing required argument: "+name)
	return ""
}

// optionalString answers an optional string argument, or the fallback.
func optionalString(args map[string]any, name, fallback string) string {
	if v, ok := args[name].(string); ok {
		return v
	}
	return fallback
}

// ownerRepo answers the owner and repository a tool call names, from owner+repo or from full_name.
func ownerRepo(args map[string]any, forge *Forge) (string, string) {
	if full := optionalString(args, "full_name", ""); strings.Contains(full, "/") {
		parts := strings.SplitN(full, "/", 2)
		return parts[0], parts[1]
	}
	owner := optionalString(args, "owner", "")
	if owner == "" {
		owner = forge.Login()
	}
	repo := optionalString(args, "repo", "")
	if repo == "" {
		repo = optionalString(args, "name", "")
	}
	if repo == "" {
		throwError(-32602, "Missing required argument: repo")
	}
	return owner, repo
}

// findRepo looks a repository up, or answers the tool's own not-found result.
func findRepo(forge *Forge, args map[string]any) (*Repo, *toolResult) {
	owner, name := ownerRepo(args, forge)
	repo := forge.Get(owner, name)
	if repo == nil {
		result := errorResult("Repository " + owner + "/" + name + " not found")
		return nil, &result
	}
	return repo, nil
}

// issueToolJSON is the issue JSON a tool answers.
func issueToolJSON(i *Issue) map[string]any {
	return map[string]any{
		"number": i.Number, "id": i.ID, "title": i.Title, "body": i.Body, "state": i.State,
	}
}

// pullToolJSON is the pull JSON a tool answers.
func pullToolJSON(p *Pull) map[string]any {
	return map[string]any{
		"number": p.Number, "id": p.ID, "title": p.Title, "state": p.State,
		"head": p.Head, "base": p.Base, "merged": p.Merged,
	}
}

// repoArgs answers the two arguments every repository-scoped tool shares, as JSON Schema.
func repoArgs(extra map[string]any, required []string) map[string]any {
	properties := map[string]any{
		"owner":     map[string]any{"type": "string", "description": "The repository owner."},
		"repo":      map[string]any{"type": "string", "description": "The repository name."},
		"full_name": map[string]any{"type": "string", "description": "owner/repo, when the caller sends it instead."},
	}
	for name, schema := range extra {
		properties[name] = schema
	}
	if required == nil {
		required = []string{}
	}
	return map[string]any{"type": "object", "properties": properties, "required": required}
}

// tool is one tool the endpoint offers.
type tool struct {
	name        string
	description string
	schema      map[string]any
	run         func(args map[string]any) toolResult
}

// toolsFor answers the tool list, in a stable order so two tools/list calls answer byte for byte.
func toolsFor(forge *Forge) []tool {
	stateArg := func() map[string]any {
		return map[string]any{
			"type": "string", "enum": []string{"open", "closed", "all"},
			"description": "Which ones to list.",
		}
	}

	return []tool{
		{
			name:        "create_repo",
			description: "Create a repository owned by the authenticated user.",
			schema: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"name":        map[string]any{"type": "string", "description": "The repository name."},
					"description": map[string]any{"type": "string", "description": "The repository description."},
					"private":     map[string]any{"type": "boolean", "description": "Whether the repository is private."},
					"full_name":   map[string]any{"type": "string", "description": "owner/repo, when the caller sends it."},
				},
				"required": []string{"name"},
			},
			run: func(args map[string]any) toolResult {
				name := requireString(args, "name")
				repo := forge.Create(forge.Login(), name, optionalString(args, "description", ""), boolOf(args, "private"), "")
				full := repo.Meta.Owner + "/" + repo.Meta.Name
				return jsonResult(map[string]any{
					"name": repo.Meta.Name, "full_name": full, "id": hashID(full),
				})
			},
		},
		{
			name:        "get_repo",
			description: "Get one repository by owner and name.",
			schema:      repoArgs(nil, nil),
			run: func(args map[string]any) toolResult {
				repo, failed := findRepo(forge, args)
				if failed != nil {
					return *failed
				}
				return jsonResult(map[string]any{
					"name":           repo.Meta.Name,
					"full_name":      repo.Meta.Owner + "/" + repo.Meta.Name,
					"description":    repo.Meta.Description,
					"default_branch": repo.Meta.DefaultBranch,
					"private":        repo.Meta.Private,
				})
			},
		},
		{
			name:        "create_issue",
			description: "Create an issue in a repository.",
			schema: repoArgs(map[string]any{
				"title": map[string]any{"type": "string", "description": "The issue title."},
				"body":  map[string]any{"type": "string", "description": "The issue body."},
			}, []string{"title"}),
			run: func(args map[string]any) toolResult {
				repo, failed := findRepo(forge, args)
				if failed != nil {
					return *failed
				}
				now := nowISO()
				issue := Issue{
					ID:        hashID("issue:" + repo.Meta.Owner + "/" + repo.Meta.Name + ":" + strconv.Itoa(repo.Meta.NextIssueID)),
					Number:    repo.Meta.NextIssueID,
					Title:     requireString(args, "title"),
					Body:      optionalString(args, "body", ""),
					State:     "open",
					Labels:    []string{},
					User:      forge.Login(),
					CreatedAt: now,
					UpdatedAt: now,
					Comments:  []Comment{},
				}
				repo.Meta.NextIssueID++
				repo.Meta.Issues = append(repo.Meta.Issues, issue)
				repo.Save()
				return jsonResult(issueToolJSON(&repo.Meta.Issues[len(repo.Meta.Issues)-1]))
			},
		},
		{
			name:        "list_issues",
			description: "List a repository's issues, optionally filtered by state.",
			schema:      repoArgs(map[string]any{"state": stateArg()}, nil),
			run: func(args map[string]any) toolResult {
				repo, failed := findRepo(forge, args)
				if failed != nil {
					return *failed
				}
				state := strings.ToLower(optionalString(args, "state", "open"))
				list := make([]any, 0, len(repo.Meta.Issues))
				for i := range repo.Meta.Issues {
					issue := &repo.Meta.Issues[i]
					if state != "all" && issue.State != state {
						continue
					}
					list = append(list, issueToolJSON(issue))
				}
				return jsonResult(list)
			},
		},
		{
			name:        "get_issue",
			description: "Get one issue by number.",
			schema: repoArgs(map[string]any{
				"issue_number": map[string]any{"type": "number", "description": "The issue number."},
			}, []string{"issue_number"}),
			run: func(args map[string]any) toolResult {
				repo, failed := findRepo(forge, args)
				if failed != nil {
					return *failed
				}
				number := numberArg(args, "issue_number")
				for i := range repo.Meta.Issues {
					if repo.Meta.Issues[i].Number == number {
						return jsonResult(issueToolJSON(&repo.Meta.Issues[i]))
					}
				}
				return errorResult("Issue #" + strconv.Itoa(number) + " not found")
			},
		},
		{
			name:        "create_pull_request",
			description: "Open a pull request from a head branch into a base branch.",
			schema: repoArgs(map[string]any{
				"title": map[string]any{"type": "string", "description": "The pull request title."},
				"head":  map[string]any{"type": "string", "description": "The branch with the changes."},
				"base":  map[string]any{"type": "string", "description": "The branch to merge into."},
				"body":  map[string]any{"type": "string", "description": "The pull request body."},
			}, []string{"title", "head", "base"}),
			run: func(args map[string]any) toolResult {
				repo, failed := findRepo(forge, args)
				if failed != nil {
					return *failed
				}
				now := nowISO()
				head := optionalString(args, "head", "")
				if colon := strings.IndexByte(head, ':'); colon >= 0 {
					head = head[colon+1:]
				}
				baseSHA, _ := repo.BranchTip(requireString(args, "base"))
				pr := Pull{
					ID:        hashID("pull:" + repo.Meta.Owner + "/" + repo.Meta.Name + ":" + strconv.Itoa(repo.Meta.NextPullID)),
					Number:    repo.Meta.NextPullID,
					Title:     requireString(args, "title"),
					Body:      optionalString(args, "body", ""),
					State:     "open",
					Head:      head,
					Base:      requireString(args, "base"),
					BaseSHA:   baseSHA,
					User:      forge.Login(),
					CreatedAt: now,
					UpdatedAt: now,
				}
				repo.Meta.NextPullID++
				repo.Meta.Pulls = append(repo.Meta.Pulls, pr)
				repo.Save()
				return jsonResult(pullToolJSON(&repo.Meta.Pulls[len(repo.Meta.Pulls)-1]))
			},
		},
		{
			name:        "merge_pull_request",
			description: "Merge an open pull request into its base branch.",
			schema: repoArgs(map[string]any{
				"pull_number": map[string]any{"type": "number", "description": "The pull request number."},
			}, []string{"pull_number"}),
			run: func(args map[string]any) toolResult {
				repo, failed := findRepo(forge, args)
				if failed != nil {
					return *failed
				}
				number := numberArg(args, "pull_number")
				index := -1
				for i := range repo.Meta.Pulls {
					if repo.Meta.Pulls[i].Number == number {
						index = i
						break
					}
				}
				if index < 0 {
					return errorResult("Pull request #" + strconv.Itoa(number) + " not found")
				}
				pr := &repo.Meta.Pulls[index]
				if _, ok := repo.BranchTip(pr.Head); !ok {
					return errorResult("Head branch " + pr.Head + " not found")
				}
				// the merge runs through the one path REST shares, so both surfaces agree byte for byte
				sha, err := MergeViaMcp(repo, pr)
				if err != nil {
					return errorResult(err.Error())
				}
				return jsonResult(map[string]any{
					"number": pr.Number, "merged": true, "sha": sha, "state": pr.State,
				})
			},
		},
		{
			name:        "list_pull_requests",
			description: "List a repository's pull requests.",
			schema:      repoArgs(map[string]any{"state": stateArg()}, nil),
			run: func(args map[string]any) toolResult {
				repo, failed := findRepo(forge, args)
				if failed != nil {
					return *failed
				}
				state := strings.ToLower(optionalString(args, "state", "open"))
				list := make([]any, 0, len(repo.Meta.Pulls))
				for i := range repo.Meta.Pulls {
					pr := &repo.Meta.Pulls[i]
					if state != "all" && pr.State != state {
						continue
					}
					list = append(list, pullToolJSON(pr))
				}
				return jsonResult(list)
			},
		},
	}
}

// numberArg reads a numeric argument, as a JSON number or a numeric string.
func numberArg(args map[string]any, name string) int {
	switch v := args[name].(type) {
	case float64:
		return int(v)
	case string:
		return parseInt(v)
	}
	return 0
}

// handleMcp answers one /mcp request.
func (s *Server) handleMcp(w http.ResponseWriter, r *http.Request) {
	if !s.authorized(r) {
		mcpSend(w, 401, map[string]any{
			"jsonrpc": "2.0", "id": nil,
			"error": map[string]any{"code": -32001, "message": "Unauthorized"},
		})
		return
	}

	raw, _ := readAll(r)
	var parsed any
	if err := json.Unmarshal(raw, &parsed); err != nil {
		mcpSend(w, 400, map[string]any{
			"jsonrpc": "2.0", "id": nil,
			"error": map[string]any{"code": -32700, "message": "Parse error"},
		})
		return
	}

	batch, isBatch := parsed.([]any)
	requests := []any{parsed}
	if isBatch {
		requests = batch
	}

	answers := make([]any, 0, len(requests))
	for _, request := range requests {
		answer := s.answerRpc(request)
		if answer != nil {
			answers = append(answers, answer)
		}
	}

	if isBatch {
		if len(answers) == 0 {
			respondEmpty(w, 202, nil)
			return
		}
		mcpSend(w, 200, answers)
		return
	}
	if len(answers) == 0 {
		// a notification is acknowledged with no body at all
		respondEmpty(w, 202, nil)
		return
	}
	mcpSend(w, 200, answers[0])
}

// mcpSend writes one JSON body with the request-id header.
func mcpSend(w http.ResponseWriter, status int, body any) {
	text, err := json.Marshal(body)
	if err != nil {
		text = []byte("{}")
	}
	w.Header().Set("content-type", "application/json")
	w.Header().Set("content-length", strconv.Itoa(len(text)))
	w.Header().Set("x-github-request-id", requestID())
	w.WriteHeader(status)
	_, _ = w.Write(text)
}

// answerRpc answers one JSON-RPC request; nil for a notification, which carries no id.
func (s *Server) answerRpc(request any) any {
	forge := s.Forge
	fields, ok := request.(map[string]any)
	if !ok {
		return map[string]any{
			"jsonrpc": "2.0", "id": nil,
			"error": map[string]any{"code": -32600, "message": "Invalid Request"},
		}
	}
	id, hasID := fields["id"]
	if !hasID {
		id = nil
	}
	isNotification := !hasID
	method, _ := fields["method"].(string)
	params, _ := fields["params"].(map[string]any)
	if params == nil {
		params = map[string]any{}
	}

	reply := func(result any) map[string]any {
		if isNotification {
			return nil
		}
		return map[string]any{"jsonrpc": "2.0", "id": id, "result": result}
	}
	rpcFail := func(code int, message string) map[string]any {
		if isNotification {
			return nil
		}
		return map[string]any{"jsonrpc": "2.0", "id": id, "error": map[string]any{"code": code, "message": message}}
	}

	switch method {
	case "server/discover":
		return reply(map[string]any{
			"protocolVersion":   mcpRevision,
			"supportedVersions": mcpSupportedRevisions,
			"serverInfo":        map[string]any{"name": "makefun-forge", "version": "1.0.0"},
			"capabilities":      map[string]any{"tools": map[string]any{"listChanged": false}},
		})
	case "initialize":
		requested, _ := params["protocolVersion"].(string)
		version := mcpRevision
		for _, supported := range mcpSupportedRevisions {
			if supported == requested {
				version = requested
				break
			}
		}
		return reply(map[string]any{
			"protocolVersion": version,
			"capabilities":    map[string]any{"tools": map[string]any{"listChanged": false}},
			"serverInfo":      map[string]any{"name": "makefun-forge", "version": "1.0.0"},
		})
	case "ping":
		return reply(map[string]any{})
	case "notifications/initialized", "notifications/cancelled", "notifications/roots/list_changed":
		return nil
	case "tools/list":
		list := toolsFor(forge)
		items := make([]any, 0, len(list))
		for _, t := range list {
			items = append(items, map[string]any{
				"name": t.name, "description": t.description, "inputSchema": t.schema,
			})
		}
		return reply(map[string]any{"tools": items})
	case "tools/call":
		name, _ := params["name"].(string)
		args, _ := params["arguments"].(map[string]any)
		if args == nil {
			args = map[string]any{}
		}
		chosen := matchTool(forge, name)
		if chosen == nil {
			return rpcFail(-32601, "Unknown tool: "+name)
		}
		result, refused := s.runTool(chosen, args)
		if refused != nil {
			return rpcFail(refused.code, refused.message)
		}
		return reply(result)
	case "resources/list":
		return reply(map[string]any{"resources": []any{}})
	case "prompts/list":
		return reply(map[string]any{"prompts": []any{}})
	default:
		return rpcFail(-32601, "Method not found: "+method)
	}
}

// runTool runs one tool, turning a refusal into the JSON-RPC error it is rather than a crash.
func (s *Server) runTool(chosen *tool, args map[string]any) (result any, refused *rpcError) {
	defer func() {
		if recovered := recover(); recovered != nil {
			if err, isRpc := recovered.(rpcError); isRpc {
				refused = &err
				return
			}
			text := errorResult(asText(recovered))
			result = text
		}
	}()
	return chosen.run(args), nil
}

// matchTool finds a tool by name. A server prefix is allowed (github__create_issue,
// github/create_issue), matched as a suffix and case-insensitively.
func matchTool(forge *Forge, name string) *tool {
	lower := strings.ToLower(name)
	list := toolsFor(forge)
	for i := range list {
		if strings.ToLower(list[i].name) == lower {
			return &list[i]
		}
	}
	for i := range list {
		toolName := strings.ToLower(list[i].name)
		if strings.HasSuffix(lower, "__"+toolName) || strings.HasSuffix(lower, "/"+toolName) {
			return &list[i]
		}
	}
	return nil
}

// readAll answers a request's whole body.
func readAll(r *http.Request) ([]byte, error) {
	defer r.Body.Close()
	buf := make([]byte, 0, 1024)
	tmp := make([]byte, 4096)
	for {
		n, err := r.Body.Read(tmp)
		buf = append(buf, tmp[:n]...)
		if err != nil {
			if err.Error() == "EOF" {
				return buf, nil
			}
			return buf, err
		}
	}
}
