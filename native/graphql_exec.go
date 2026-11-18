package main

// The GraphQL evaluator: the shapes the fields read from, the selection-set projection, the Query
// and Mutation roots, introspection, and the HTTP handler.

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"
)

// The keys the evaluator uses to tag a shape and to hand out its lazy lists.
const (
	tagKey    = "__type"
	gidKey    = "__gid"
	issuesKey = "__issues"
	pullsKey  = "__pulls"
	nodesKey  = "__nodesOf"
)

// globalID answers a node's global id, as GitHub's base64 "Type:id" form.
func globalID(kind, local string) string {
	return base64.StdEncoding.EncodeToString([]byte(kind + ":" + local))
}

// decodeGID answers the text a global id carries.
func decodeGID(gid string) string {
	raw, err := base64.StdEncoding.DecodeString(gid)
	if err != nil {
		return ""
	}
	return string(raw)
}

// pageInfo answers the page info of a list that carries no paging.
func pageInfo() map[string]any {
	return map[string]any{
		tagKey: "PageInfo", "hasNextPage": false, "hasPreviousPage": false,
		"startCursor": nil, "endCursor": nil,
	}
}

// issueNode answers one issue as the resolver sees it.
func issueNode(repo *Repo, issue *Issue) map[string]any {
	state := "OPEN"
	if issue.State == "closed" {
		state = "CLOSED"
	}
	labels := make([]any, 0, len(issue.Labels))
	for _, name := range issue.Labels {
		labels = append(labels, map[string]any{
			tagKey: "Label", "id": globalID("Label", name), "name": name, "color": "ededed",
		})
	}
	comments := make([]any, 0, len(issue.Comments))
	for _, c := range issue.Comments {
		comments = append(comments, map[string]any{
			tagKey: "IssueComment", "id": globalID("IssueComment", strconv.Itoa(c.ID)), "body": c.Body,
		})
	}
	return map[string]any{
		tagKey:       "Issue",
		gidKey:       globalID("Issue", strconv.Itoa(issue.ID)),
		"id":         globalID("Issue", strconv.Itoa(issue.ID)),
		"number":     issue.Number,
		"title":      issue.Title,
		"body":       issue.Body,
		"state":      state,
		"created_at": issue.CreatedAt,
		"updated_at": issue.UpdatedAt,
		"author": map[string]any{
			tagKey: "User", "login": issue.User, "id": globalID("User", issue.User), "name": issue.User,
		},
		"labels": map[string]any{
			tagKey: "LabelConnection", "nodes": labels,
			"totalCount": len(issue.Labels), "pageInfo": pageInfo(),
		},
		"__comments": comments,
	}
}

// commitShape answers a commit as the resolver sees it, or nil when the id names no commit.
func commitShape(repo *Repo, oid string) map[string]any {
	c, ok := ReadCommit(repo.Store, oid)
	if !ok {
		return nil
	}
	return map[string]any{
		tagKey: "Commit", "oid": oid, "message": c.Message,
		"tree": map[string]any{tagKey: "Tree", "oid": c.Tree},
	}
}

// pullNode answers one pull request as the resolver sees it, with its changed files ready.
func pullNode(repo *Repo, pr *Pull) map[string]any {
	baseTip, hasBase := repo.BranchTip(pr.Base)
	headTip, hasHead := repo.BranchTip(pr.Head)
	baseTree, headTree := "", ""
	if hasBase {
		baseTree = treeOfCommit(repo.Store, baseTip)
	}
	if hasHead {
		headTree = treeOfCommit(repo.Store, headTip)
	}
	changed := []FileDiff{}
	if hasHead {
		changed = DiffTreePatch(repo.Store, baseTree, headTree)
	}

	state := "OPEN"
	switch {
	case pr.Merged:
		state = "MERGED"
	case pr.State == "closed":
		state = "CLOSED"
	}
	mergeable := "MERGEABLE"
	if pr.Merged {
		mergeable = "UNKNOWN"
	}
	var mergeCommit any
	if pr.MergeCommitSHA != nil {
		if shape := commitShape(repo, *pr.MergeCommitSHA); shape != nil {
			mergeCommit = shape
		}
	}
	files := make([]any, 0, len(changed))
	for _, d := range changed {
		files = append(files, map[string]any{
			tagKey: "PullRequestChangedFile", "path": d.Filename,
			"additions": d.Additions, "deletions": d.Deletions,
		})
	}
	return map[string]any{
		tagKey:        "PullRequest",
		gidKey:        globalID("PullRequest", strconv.Itoa(pr.ID)),
		"id":          globalID("PullRequest", strconv.Itoa(pr.ID)),
		"number":      pr.Number,
		"title":       pr.Title,
		"body":        pr.Body,
		"state":       state,
		"merged":      pr.Merged,
		"mergeable":   mergeable,
		"headRefName": pr.Head,
		"baseRefName": pr.Base,
		"mergeCommit": mergeCommit,
		"files": map[string]any{
			tagKey: "PullRequestChangedFileConnection", "nodes": files,
			"totalCount": len(changed), "pageInfo": pageInfo(),
		},
	}
}

// repoNode answers a repository as the resolver sees it.
func repoNode(repo *Repo, forge *Forge) map[string]any {
	m := repo.Meta
	full := m.Owner + "/" + m.Name
	description := any(nil)
	if m.Description != "" {
		description = m.Description
	}
	var defaultBranchRef any
	if tip, ok := repo.BranchTip(m.DefaultBranch); ok {
		defaultBranchRef = map[string]any{
			tagKey: "Ref", "name": m.DefaultBranch, "target": commitShape(repo, tip),
		}
	}
	return map[string]any{
		tagKey:          "Repository",
		gidKey:          globalID("Repository", full),
		"id":            globalID("Repository", full),
		"databaseId":    hashID("repo:"+full) % 2147483647,
		"name":          m.Name,
		"nameWithOwner": full,
		"description":   description,
		"isPrivate":     m.Private,
		"owner": map[string]any{
			tagKey: "User", "login": m.Owner, "id": globalID("User", m.Owner), "name": m.Owner,
		},
		"viewerPermission": "ADMIN",
		"hasIssuesEnabled": true,
		"defaultBranchRef": defaultBranchRef,
		issuesKey: func() []any {
			out := make([]any, 0, len(m.Issues))
			for i := range m.Issues {
				out = append(out, issueNode(repo, &m.Issues[i]))
			}
			return out
		},
		pullsKey: func() []any {
			out := make([]any, 0, len(m.Pulls))
			for i := range m.Pulls {
				out = append(out, pullNode(repo, &m.Pulls[i]))
			}
			return out
		},
		"__owner": m.Owner,
		"__name":  m.Name,
	}
}

// connection answers the connection shape both the issue and pull list fields report.
func connection(kind string, nodes []any, info map[string]any) map[string]any {
	if info == nil {
		info = pageInfo()
	}
	return map[string]any{tagKey: kind, "nodes": nodes, "totalCount": len(nodes), "pageInfo": info}
}

// cursorOf answers the cursor a paged list hands back: an opaque token naming the node's position.
func cursorOf(node map[string]any) string {
	key := ""
	switch value := node["number"].(type) {
	case int:
		key = strconv.Itoa(value)
	case string:
		key = value
	default:
		if id, ok := node["id"].(string); ok {
			key = id
		}
	}
	return base64.StdEncoding.EncodeToString([]byte("cursor:" + key))
}

// paged slices a list by first/after/last/before, answering the slice and its page info.
func paged(nodes []any, args map[string]any) ([]any, map[string]any) {
	after := ""
	if v, ok := args["after"].(string); ok {
		after = v
	}
	before := ""
	if v, ok := args["before"].(string); ok {
		before = v
	}
	start, end := 0, len(nodes)
	if after != "" {
		start = 0
		for i, node := range nodes {
			if shape, isMap := node.(map[string]any); isMap && cursorOf(shape) == after {
				start = i + 1
				break
			}
		}
	}
	if before != "" {
		for i, node := range nodes {
			if shape, isMap := node.(map[string]any); isMap && cursorOf(shape) == before {
				end = i
				break
			}
		}
	}
	if end < start {
		end = start
	}
	slice := append([]any{}, nodes[start:end]...)
	hasNext := end < len(nodes)
	hasPrevious := start > 0

	if first, ok := numberValue(args["first"]); ok && first >= 0 && first < len(slice) {
		slice = slice[:first]
		hasNext = true
	}
	if last, ok := numberValue(args["last"]); ok && last >= 0 && last < len(slice) {
		slice = slice[len(slice)-last:]
	}

	info := map[string]any{
		tagKey: "PageInfo", "hasNextPage": hasNext, "hasPreviousPage": hasPrevious,
		"startCursor": nil, "endCursor": nil,
	}
	if len(slice) > 0 {
		info["startCursor"] = cursorOf(slice[0].(map[string]any))
		info["endCursor"] = cursorOf(slice[len(slice)-1].(map[string]any))
	}
	return slice, info
}

// numberValue answers a JSON number as an integer, and whether it was one.
func numberValue(value any) (int, bool) {
	switch typed := value.(type) {
	case float64:
		return int(typed), true
	case int:
		return typed, true
	case json.Number:
		n, err := typed.Int64()
		return int(n), err == nil
	}
	return 0, false
}

// selectionApplies answers whether a selection's @skip / @include directives let it apply.
func selectionApplies(sel selection, vars map[string]any) bool {
	for _, d := range sel.directives {
		if d.name == "skip" && resolveVars(d.args["if"], vars) == true {
			return false
		}
		if d.name == "include" && resolveVars(d.args["if"], vars) == false {
			return false
		}
	}
	return true
}

// expand answers the selections that apply, with named fragment spreads expanded in place.
func expand(selections []selection, frags map[string]fragment, vars map[string]any) ([]selection, error) {
	out := make([]selection, 0, len(selections))
	for _, sel := range selections {
		if !selectionApplies(sel, vars) {
			continue
		}
		// a named spread contributes the fragment's own selections
		for _, name := range sel.fragments {
			f, ok := frags[name]
			if !ok {
				return nil, gqlError{message: fmt.Sprintf("Unknown fragment %q.", name)}
			}
			nested, err := expand(f.selections, frags, vars)
			if err != nil {
				return nil, err
			}
			out = append(out, nested...)
		}
		// an inline fragment contributes its nested selections
		if len(sel.fragments) == 0 && sel.name == "__inline" {
			nested, err := expand(sel.selections, frags, vars)
			if err != nil {
				return nil, err
			}
			out = append(out, nested...)
			continue
		}
		if len(sel.fragments) > 0 {
			continue
		}
		out = append(out, sel)
	}
	return out, nil
}

// projectObject answers the fields one object reports from its projection.
func projectObject(value map[string]any, selections []selection, vars map[string]any, frags map[string]fragment) (map[string]any, error) {
	active, err := expand(selections, frags, vars)
	if err != nil {
		return nil, err
	}
	out := make(map[string]any, len(active))
	for _, sel := range active {
		key := sel.name
		if sel.hasAlias {
			key = sel.alias
		}
		field, err := resolveOne(value, sel, vars, frags)
		if err != nil {
			return nil, err
		}
		out[key] = field
	}
	return out, nil
}

// projectAny projects any value: an object through its selection set, a scalar as itself.
func projectAny(value any, selections []selection, vars map[string]any, frags map[string]fragment) (any, error) {
	if value == nil {
		return nil, nil
	}
	switch typed := value.(type) {
	case []any:
		out := make([]any, 0, len(typed))
		for _, item := range typed {
			projected, err := projectAny(item, selections, vars, frags)
			if err != nil {
				return nil, err
			}
			out = append(out, projected)
		}
		return out, nil
	case map[string]any:
		if len(selections) == 0 {
			return nil, nil
		}
		return projectObject(typed, selections, vars, frags)
	}
	return value, nil
}

// resolveOne resolves one field on one object, following nested selections.
func resolveOne(value map[string]any, sel selection, vars map[string]any, frags map[string]fragment) (any, error) {
	args, _ := resolveVars(sel.args, vars).(map[string]any)
	if args == nil {
		args = map[string]any{}
	}
	tag, _ := value[tagKey].(string)

	// __typename answers any object's own type name
	if sel.name == "__typename" {
		if tag == "" {
			return nil, nil
		}
		return tag, nil
	}

	// a list, a connection, or a lazy list of nodes
	if sel.name == "nodes" {
		if nodes, ok := value["nodes"].([]any); ok {
			return projectAny(nodes, sel.selections, vars, frags)
		}
		if lazy, ok := value[nodesKey].(func() []any); ok {
			return projectAny(lazy(), sel.selections, vars, frags)
		}
	}

	// a single issue or pull request by number
	if tag == "Repository" && (sel.name == "issue" || sel.name == "pullRequest") {
		key := issuesKey
		if sel.name == "pullRequest" {
			key = pullsKey
		}
		wanted, _ := numberValue(args["number"])
		var hit any
		if lazy, ok := value[key].(func() []any); ok {
			for _, node := range lazy() {
				shape, isMap := node.(map[string]any)
				if !isMap {
					continue
				}
				if number, _ := numberValue(shape["number"]); number == wanted {
					hit = shape
					break
				}
			}
		}
		if hit == nil {
			return nil, nil
		}
		return projectAny(hit, sel.selections, vars, frags)
	}

	if tag == "Repository" && sel.name == "issues" {
		lazy, _ := value[issuesKey].(func() []any)
		all := []any{}
		if lazy != nil {
			all = lazy()
		}
		// GitHub's default issue order is CREATED_AT DESC; the connection pages that order
		sorted := append([]any{}, all...)
		sort.SliceStable(sorted, func(i, j int) bool {
			a := sorted[i].(map[string]any)
			b := sorted[j].(map[string]any)
			at, _ := a["created_at"].(string)
			bt, _ := b["created_at"].(string)
			if at != bt {
				return at > bt
			}
			an, _ := numberValue(b["number"])
			bn, _ := numberValue(a["number"])
			return an < bn
		})
		filtered := applyStates(sorted, args["states"], "OPEN")
		nodes, info := paged(filtered, args)
		return projectAny(connection("IssueConnection", nodes, info), sel.selections, vars, frags)
	}
	if tag == "Repository" && sel.name == "pullRequests" {
		lazy, _ := value[pullsKey].(func() []any)
		all := []any{}
		if lazy != nil {
			all = lazy()
		}
		filtered := applyStates(all, args["states"], "OPEN")
		nodes, info := paged(filtered, args)
		return projectAny(connection("PullRequestConnection", nodes, info), sel.selections, vars, frags)
	}

	direct, present := value[sel.name]
	if !present {
		// a field the shape does not carry is a schema error, as GitHub answers it
		name := tag
		if name == "" {
			name = "User"
		}
		return nil, gqlError{message: fmt.Sprintf("Field '%s' doesn't exist on type '%s'", sel.name, name)}
	}
	if direct == nil {
		return nil, nil
	}
	if _, isList := direct.([]any); isList && len(sel.selections) > 0 {
		return projectAny(direct, sel.selections, vars, frags)
	}
	if _, isMap := direct.(map[string]any); isMap && len(sel.selections) > 0 {
		return projectAny(direct, sel.selections, vars, frags)
	}
	return direct, nil
}

// applyStates narrows a list of nodes to the states asked for; the states arrive as enum names.
func applyStates(nodes []any, states any, openName string) []any {
	wanted := []string{}
	if list, ok := states.([]any); ok {
		for _, value := range list {
			wanted = append(wanted, asText(value))
		}
	}
	out := make([]any, 0, len(nodes))
	for _, node := range nodes {
		shape, isMap := node.(map[string]any)
		if !isMap {
			continue
		}
		state, _ := shape["state"].(string)
		if len(wanted) == 0 {
			if state == openName {
				out = append(out, shape)
			}
			continue
		}
		for _, want := range wanted {
			if state == want {
				out = append(out, shape)
				break
			}
		}
	}
	return out
}

// viewerShape answers the viewer: the account the token names, with its repositories.
func viewerShape(forge *Forge) map[string]any {
	repos := forge.List(forge.Login())
	return map[string]any{
		tagKey:  "User",
		gidKey:  globalID("User", forge.Login()),
		"id":    globalID("User", forge.Login()),
		"login": forge.Login(),
		"name":  forge.Login(),
		"repositories": map[string]any{
			tagKey: "RepositoryConnection",
			nodesKey: func() []any {
				out := make([]any, 0, len(repos))
				for _, repo := range repos {
					out = append(out, repoNode(repo, forge))
				}
				return out
			},
			"totalCount": len(repos),
			"pageInfo":   pageInfo(),
		},
	}
}

// findRepoByGID answers a repository from a global id ("Repository:owner/name").
func findRepoByGID(forge *Forge, gid string) *Repo {
	decoded := decodeGID(gid)
	if colon := strings.IndexByte(decoded, ':'); colon >= 0 {
		decoded = decoded[colon+1:]
	}
	slash := strings.IndexByte(decoded, '/')
	if slash < 0 {
		return nil
	}
	return forge.Get(decoded[:slash], decoded[slash+1:])
}

// findRepoByName answers a repository by owner and name, restricted to the token's own repositories.
func findRepoByName(forge *Forge, owner, name string) *Repo {
	repo := forge.Get(owner, name)
	if repo == nil {
		return nil
	}
	if !strings.EqualFold(repo.Meta.Owner, forge.Login()) {
		return nil
	}
	return repo
}

// createIssueIn writes one new issue into a repository, answering its shape.
func createIssueIn(repo *Repo, title, body string) map[string]any {
	m := repo.Meta
	now := nowISO()
	issue := Issue{
		ID:        hashID("issue:" + m.Owner + "/" + m.Name + ":" + strconv.Itoa(m.NextIssueID)),
		Number:    m.NextIssueID,
		Title:     title,
		Body:      body,
		State:     "open",
		Labels:    []string{},
		User:      m.Owner,
		CreatedAt: now,
		UpdatedAt: now,
		Comments:  []Comment{},
	}
	m.NextIssueID++
	m.Issues = append(m.Issues, issue)
	repo.Save()
	return issueNode(repo, &m.Issues[len(m.Issues)-1])
}

// findIssueByLocal answers an issue from the local part of its global id.
func findIssueByLocal(forge *Forge, local string) (*Repo, *Issue, bool) {
	for _, repo := range forge.List(forge.Login()) {
		for i := range repo.Meta.Issues {
			issue := &repo.Meta.Issues[i]
			if strconv.Itoa(issue.ID) == local ||
				repo.Meta.Owner+"/"+repo.Meta.Name+":"+strconv.Itoa(issue.Number) == local {
				return repo, issue, true
			}
		}
	}
	return nil, nil, false
}

// findPullByLocal answers a pull request from the local part of its global id.
func findPullByLocal(forge *Forge, local string) (*Repo, *Pull, bool) {
	for _, repo := range forge.List(forge.Login()) {
		for i := range repo.Meta.Pulls {
			pr := &repo.Meta.Pulls[i]
			if strconv.Itoa(pr.ID) == local ||
				repo.Meta.Owner+"/"+repo.Meta.Name+":"+strconv.Itoa(pr.Number) == local {
				return repo, pr, true
			}
		}
	}
	return nil, nil, false
}

// requestContext is what one request resolves against.
type requestContext struct {
	forge *Forge
	vars  map[string]any
	frags map[string]fragment
}

// queryRoot answers the Query root's fields.
func queryRoot(ctx *requestContext, selections []selection) (map[string]any, error) {
	root := map[string]any{}
	for _, sel := range selections {
		args, _ := resolveVars(sel.args, ctx.vars).(map[string]any)
		if args == nil {
			args = map[string]any{}
		}
		switch sel.name {
		case "viewer":
			root["viewer"] = viewerShape(ctx.forge)
		case "repository":
			repo := findRepoByName(ctx.forge, asText(args["owner"]), asText(args["name"]))
			if repo == nil {
				root["repository"] = nil
			} else {
				root["repository"] = repoNode(repo, ctx.forge)
			}
		case "node":
			gid := asText(args["id"])
			decoded := decodeGID(gid)
			kind := decoded
			if colon := strings.IndexByte(decoded, ':'); colon >= 0 {
				kind = decoded[:colon]
			}
			if kind == "Repository" {
				if repo := findRepoByGID(ctx.forge, gid); repo != nil {
					root["node"] = repoNode(repo, ctx.forge)
				} else {
					root["node"] = nil
				}
			} else {
				root["node"] = nil
			}
		case "search":
			repos := ctx.forge.List(ctx.forge.Login())
			nodes := make([]any, 0, len(repos))
			for _, repo := range repos {
				nodes = append(nodes, repoNode(repo, ctx.forge))
			}
			root["search"] = connection("SearchResultItemConnection", nodes, nil)
		default:
			return nil, gqlError{message: fmt.Sprintf("Cannot query field %q on type \"Query\".", sel.name)}
		}
	}
	return root, nil
}

// mutationRoot answers the Mutation root's fields.
func mutationRoot(ctx *requestContext, selections []selection) (map[string]any, error) {
	root := map[string]any{}
	forge := ctx.forge

	for _, sel := range selections {
		args, _ := resolveVars(sel.args, ctx.vars).(map[string]any)
		input, _ := args["input"].(map[string]any)
		if input == nil {
			input = map[string]any{}
		}

		switch sel.name {
		case "createRepository":
			name := strings.TrimSpace(asText(input["name"]))
			if name == "" {
				return nil, gqlError{message: "Name is required."}
			}
			repo := forge.Create(forge.Login(), name, asText(input["description"]), input["isPrivate"] == true, "")
			root["createRepository"] = map[string]any{
				tagKey: "CreateRepositoryPayload", "repository": repoNode(repo, forge),
			}

		case "createIssue":
			repo := findRepoByGID(forge, asText(input["repositoryId"]))
			if repo == nil {
				return nil, gqlError{message: "Could not resolve to a Repository with that id."}
			}
			title := strings.TrimSpace(asText(input["title"]))
			if title == "" {
				return nil, gqlError{message: "Title is required."}
			}
			root["createIssue"] = map[string]any{
				tagKey: "CreateIssuePayload", "issue": createIssueIn(repo, title, asText(input["body"])),
			}

		case "closeIssue":
			decoded := decodeGID(asText(input["issueId"]))
			if colon := strings.IndexByte(decoded, ':'); colon >= 0 {
				decoded = decoded[colon+1:]
			}
			repo, issue, ok := findIssueByLocal(forge, decoded)
			if !ok {
				return nil, gqlError{message: "Could not resolve to an Issue with that id."}
			}
			now := nowISO()
			issue.State = "closed"
			issue.ClosedAt = &now
			issue.UpdatedAt = now
			repo.Save()
			root["closeIssue"] = map[string]any{
				tagKey: "CloseIssuePayload", "issue": issueNode(repo, issue),
			}

		case "addComment":
			decoded := decodeGID(asText(input["subjectId"]))
			if colon := strings.IndexByte(decoded, ':'); colon >= 0 {
				decoded = decoded[colon+1:]
			}
			repo, issue, ok := findIssueByLocal(forge, decoded)
			if !ok {
				return nil, gqlError{message: "Could not resolve to an Issue with that id."}
			}
			now := nowISO()
			comment := Comment{ID: repo.Meta.NextCommentID, Body: asText(input["body"]), User: repo.Meta.Owner, CreatedAt: now}
			repo.Meta.NextCommentID++
			issue.Comments = append(issue.Comments, comment)
			issue.UpdatedAt = now
			repo.Save()
			root["addComment"] = map[string]any{
				tagKey: "AddCommentPayload",
				"commentEdge": map[string]any{
					tagKey:   "IssueCommentEdge",
					"cursor": base64.StdEncoding.EncodeToString([]byte("comment:" + strconv.Itoa(comment.ID))),
					"node": map[string]any{
						tagKey: "IssueComment", "id": globalID("IssueComment", strconv.Itoa(comment.ID)),
						"body": comment.Body,
					},
				},
			}

		case "createPullRequest":
			repo := findRepoByGID(forge, asText(input["repositoryId"]))
			if repo == nil {
				return nil, gqlError{message: "Could not resolve to a Repository with that id."}
			}
			m := repo.Meta
			now := nowISO()
			baseBranch := asText(input["baseRefName"])
			if baseBranch == "" {
				baseBranch = m.DefaultBranch
			}
			baseSHA, _ := repo.BranchTip(baseBranch)
			pr := Pull{
				ID:        hashID("pull:" + m.Owner + "/" + m.Name + ":" + strconv.Itoa(m.NextPullID)),
				Number:    m.NextPullID,
				Title:     asText(input["title"]),
				Body:      asText(input["body"]),
				State:     "open",
				Head:      asText(input["headRefName"]),
				Base:      baseBranch,
				BaseSHA:   baseSHA,
				User:      m.Owner,
				CreatedAt: now,
				UpdatedAt: now,
			}
			m.NextPullID++
			m.Pulls = append(m.Pulls, pr)
			repo.Save()
			root["createPullRequest"] = map[string]any{
				tagKey: "CreatePullRequestPayload", "pullRequest": pullNode(repo, &m.Pulls[len(m.Pulls)-1]),
			}

		case "mergePullRequest":
			decoded := decodeGID(asText(input["pullRequestId"]))
			if colon := strings.IndexByte(decoded, ':'); colon >= 0 {
				decoded = decoded[colon+1:]
			}
			repo, pr, ok := findPullByLocal(forge, decoded)
			if !ok {
				return nil, gqlError{message: "Could not resolve to a PullRequest with that id."}
			}
			if _, hasHead := repo.BranchTip(pr.Head); !hasHead {
				return nil, gqlError{message: "Head branch " + pr.Head + " not found."}
			}
			if _, err := MergeViaMcp(repo, pr); err != nil {
				return nil, gqlError{message: err.Error()}
			}
			root["mergePullRequest"] = map[string]any{
				tagKey: "MergePullRequestPayload", "pullRequest": pullNode(repo, pr),
			}

		default:
			return nil, gqlError{message: fmt.Sprintf("Cannot query field %q on type \"Mutation\".", sel.name)}
		}
	}
	return root, nil
}

// introspection answers a __schema / __type / __typename selection.
func introspection(selections []selection, vars map[string]any, frags map[string]fragment) (map[string]any, error) {
	out := map[string]any{}
	active, err := expand(selections, frags, vars)
	if err != nil {
		return nil, err
	}
	for _, sel := range active {
		args, _ := resolveVars(sel.args, vars).(map[string]any)
		if args == nil {
			args = map[string]any{}
		}

		switch sel.name {
		case "__schema":
			nested, err := expand(sel.selections, frags, vars)
			if err != nil {
				return nil, err
			}
			wanted := map[string]struct{}{}
			for _, sub := range nested {
				wanted[sub.name] = struct{}{}
			}
			schema := map[string]any{}
			if _, ok := wanted["queryType"]; ok {
				schema["queryType"] = map[string]any{"name": "Query", "kind": "OBJECT"}
			}
			if _, ok := wanted["mutationType"]; ok {
				schema["mutationType"] = map[string]any{"name": "Mutation", "kind": "OBJECT"}
			}
			if _, ok := wanted["subscriptionType"]; ok {
				schema["subscriptionType"] = nil
			}
			if _, ok := wanted["types"]; ok {
				names := allTypeNames()
				types := make([]any, 0, len(names))
				for _, name := range names {
					if shape := introspectType(name); shape != nil {
						types = append(types, shape)
					}
				}
				sort.SliceStable(types, func(i, j int) bool {
					return asText(types[i].(map[string]any)["name"]) < asText(types[j].(map[string]any)["name"])
				})
				schema["types"] = types
			}
			out["__schema"] = schema
		case "__type":
			out["__type"] = introspectType(asText(args["name"]))
		case "__typename":
			out["__typename"] = "Query"
		}
	}
	return out, nil
}

// errorEntry is one error in the shape a GraphQL response carries it.
func errorEntry(message string, path []any) map[string]any {
	if path == nil {
		path = []any{}
	}
	return map[string]any{"message": message, "locations": []any{}, "path": path}
}

// answerOne answers one GraphQL request body.
func answerOne(forge *Forge, body map[string]any) map[string]any {
	source := asText(body["query"])
	provided := map[string]any{}
	if vars, ok := body["variables"].(map[string]any); ok {
		provided = vars
	}

	if strings.TrimSpace(source) == "" {
		return map[string]any{"errors": []any{errorEntry("A query string is required.", nil)}}
	}

	doc, err := parseDocument(source)
	if err != nil {
		message := "Syntax Error."
		if typed, isGql := err.(gqlError); isGql {
			message = typed.message
		} else {
			message = err.Error()
		}
		return map[string]any{"errors": []any{errorEntry(message, nil)}}
	}

	// a subscription has nothing to stream here; the first query or mutation is what runs
	visible := doc.operations[0]
	for _, op := range doc.operations {
		if op.kind != "subscription" {
			visible = op
			break
		}
	}

	// a variable's default fills in for anything the caller did not send
	vars := make(map[string]any, len(provided)+len(visible.varDefs))
	for key, value := range provided {
		vars[key] = value
	}
	for _, def := range visible.varDefs {
		if _, given := vars[def.name]; !given && def.hasDefault {
			vars[def.name] = def.defaultVal
		}
	}

	ctx := &requestContext{forge: forge, vars: vars, frags: doc.fragments}
	errors := make([]any, 0, 2)
	data := map[string]any{}

	fields, err := expand(visible.selections, doc.fragments, vars)
	if err != nil {
		message := err.Error()
		if typed, isGql := err.(gqlError); isGql {
			message = typed.message
		}
		return map[string]any{"errors": []any{errorEntry(message, nil)}, "data": nil}
	}

	var root map[string]any
	if visible.kind == "mutation" {
		root, err = mutationRoot(ctx, fields)
	} else {
		root, err = queryRoot(ctx, fields)
	}
	if err != nil {
		message := err.Error()
		if typed, isGql := err.(gqlError); isGql {
			message = typed.message
		}
		errors = append(errors, errorEntry(message, nil))
		root = map[string]any{}
	}

	for _, sel := range fields {
		key := sel.name
		if sel.hasAlias {
			key = sel.alias
		}
		if sel.name == "__type" || sel.name == "__schema" || sel.name == "__typename" {
			answered, err := introspection([]selection{sel}, vars, doc.fragments)
			if err != nil {
				data[key] = nil
				errors = append(errors, errorEntry(err.Error(), []any{key}))
				continue
			}
			if len(sel.selections) == 0 {
				data[key] = answered[sel.name]
				continue
			}
			projected, err := projectAny(answered[sel.name], sel.selections, vars, doc.fragments)
			if err != nil {
				data[key] = nil
				errors = append(errors, errorEntry(graphqlMessage(err), []any{key}))
				continue
			}
			data[key] = projected
			continue
		}

		value, err := resolveOne(root, sel, vars, doc.fragments)
		if err != nil {
			// a field that throws nulls its own key, and the rest of the answer stands
			data[key] = nil
			errors = append(errors, errorEntry(graphqlMessage(err), []any{key}))
			continue
		}
		if len(sel.selections) == 0 {
			if value == nil {
				data[key] = nil
			} else {
				data[key] = value
			}
			continue
		}
		projected, err := projectAny(value, sel.selections, vars, doc.fragments)
		if err != nil {
			data[key] = nil
			errors = append(errors, errorEntry(graphqlMessage(err), []any{key}))
			continue
		}
		data[key] = projected
	}

	if len(errors) > 0 {
		return map[string]any{"errors": errors, "data": data}
	}
	return map[string]any{"data": data}
}

// graphqlMessage answers the text an evaluator error reports.
func graphqlMessage(err error) string {
	if typed, isGql := err.(gqlError); isGql {
		return typed.message
	}
	return err.Error()
}

// handleGraphQL answers one POST /api/graphql or /graphql request, including GitHub's operation
// batching (an array body).
func (s *Server) handleGraphQL(w http.ResponseWriter, r *http.Request) {
	raw, _ := readAll(r)
	text := strings.TrimSpace(string(raw))
	var parsed any
	if text != "" {
		if err := json.Unmarshal([]byte(text), &parsed); err != nil {
			respondJSON(w, 400, map[string]any{"message": "Problems parsing JSON"}, nil)
			return
		}
	}

	if entries, isBatch := parsed.([]any); isBatch {
		// one answer per operation document, in the order the body held them
		answers := make([]any, 0, len(entries))
		for _, entry := range entries {
			body, isMap := entry.(map[string]any)
			if !isMap {
				body = map[string]any{}
			}
			answers = append(answers, answerOne(s.Forge, body))
		}
		respondJSON(w, 200, answers, nil)
		return
	}

	body, isMap := parsed.(map[string]any)
	if parsed != nil && !isMap {
		respondJSON(w, 400, map[string]any{"message": "Problems parsing JSON"}, nil)
		return
	}
	if body == nil {
		body = map[string]any{}
	}
	respondJSON(w, 200, answerOne(s.Forge, body), nil)
}
