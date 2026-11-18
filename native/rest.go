package main

// The GitHub REST v3 surface: the /api/v3 root and meta, repositories, contents, branches, commits,
// issues, labels and pull requests. The shapes here are the ones rest.ts reports, field for field.

import (
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// isoOf answers the ISO timestamp a unix second count stands for, in GitHub's form.
func isoOf(seconds int64) string {
	return time.Unix(seconds, 0).UTC().Format("2006-01-02T15:04:05.000Z")
}

// repoJSON is the JSON a repository is reported as.
func repoJSON(repo *Repo, base string) map[string]any {
	m := repo.Meta
	full := m.Owner + "/" + m.Name
	return map[string]any{
		"id":        hashID(full),
		"node_id":   nodeID("repo", full),
		"name":      m.Name,
		"full_name": full,
		"owner": map[string]any{
			"login": m.Owner, "id": hashID(m.Owner), "type": "User", "site_admin": false,
		},
		"private":        m.Private,
		"html_url":       base + "/" + full,
		"description":    m.Description,
		"fork":           false,
		"url":            base + "/api/v3/repos/" + full,
		"created_at":     m.CreatedAt,
		"updated_at":     m.UpdatedAt,
		"pushed_at":      m.UpdatedAt,
		"default_branch": m.DefaultBranch,
		"visibility":     map[bool]string{true: "private", false: "public"}[m.Private],
		"permissions":    map[string]any{"admin": true, "push": true, "pull": true},
		"has_issues":     true,
	}
}

// labelJSON answers one label, as the label routes report it.
func labelJSON(repo *Repo, base string, id int, name, color, description string) map[string]any {
	m := repo.Meta
	return map[string]any{
		"id": id, "name": name, "color": color, "description": description,
		"url": base + "/api/v3/repos/" + m.Owner + "/" + m.Name + "/labels/" + name,
	}
}

// issueJSON is the JSON an issue is reported as.
func issueJSON(repo *Repo, issue *Issue, base string) map[string]any {
	m := repo.Meta
	labels := make([]any, 0, len(issue.Labels))
	for _, name := range issue.Labels {
		labels = append(labels, map[string]any{"name": name, "id": hashID(name), "color": "ededed"})
	}
	var closed any
	if issue.ClosedAt != nil {
		closed = *issue.ClosedAt
	}
	full := m.Owner + "/" + m.Name
	return map[string]any{
		"id":             issue.ID,
		"node_id":        nodeID("issue", strconv.Itoa(issue.ID)),
		"number":         issue.Number,
		"title":          issue.Title,
		"body":           issue.Body,
		"state":          issue.State,
		"labels":         labels,
		"user":           map[string]any{"login": issue.User, "id": hashID(issue.User), "type": "User"},
		"assignee":       nil,
		"assignees":      []any{},
		"comments":       len(issue.Comments),
		"created_at":     issue.CreatedAt,
		"updated_at":     issue.UpdatedAt,
		"closed_at":      closed,
		"url":            base + "/api/v3/repos/" + full + "/issues/" + strconv.Itoa(issue.Number),
		"repository_url": base + "/api/v3/repos/" + full,
		"html_url":       base + "/" + full + "/issues/" + strconv.Itoa(issue.Number),
	}
}

// pullJSON is the JSON a pull request is reported as.
func pullJSON(repo *Repo, pr *Pull, base string) map[string]any {
	m := repo.Meta
	full := m.Owner + "/" + m.Name
	headSHA, _ := repo.BranchTip(pr.Head)
	baseSHA, _ := repo.BranchTip(pr.Base)
	var mergedAt any
	if pr.MergedAt != nil {
		mergedAt = *pr.MergedAt
	}
	var mergeSHA any
	if pr.MergeCommitSHA != nil {
		mergeSHA = *pr.MergeCommitSHA
	}
	mergeableState := "unknown"
	if pr.State == "open" {
		mergeableState = "clean"
	}
	return map[string]any{
		"id":      pr.ID,
		"node_id": nodeID("pull", strconv.Itoa(pr.ID)),
		"number":  pr.Number,
		"title":   pr.Title,
		"body":    pr.Body,
		"state":   pr.State,
		"head": map[string]any{
			"ref": pr.Head, "label": m.Owner + ":" + pr.Head, "sha": headSHA,
		},
		"base": map[string]any{
			"ref": pr.Base, "label": m.Owner + ":" + pr.Base, "sha": baseSHA,
		},
		"user":             map[string]any{"login": pr.User, "id": hashID(pr.User), "type": "User"},
		"merged":           pr.Merged,
		"mergeable":        true,
		"mergeable_state":  mergeableState,
		"merged_at":        mergedAt,
		"merge_commit_sha": mergeSHA,
		"created_at":       pr.CreatedAt,
		"updated_at":       pr.UpdatedAt,
		"url":              base + "/api/v3/repos/" + full + "/pulls/" + strconv.Itoa(pr.Number),
		"repository_url":   base + "/api/v3/repos/" + full,
		"commits":          1,
		"additions":        0,
		"deletions":        0,
		"changed_files":    0,
	}
}

// refJSON is the JSON a git ref is reported as.
func refJSON(owner, name, ref, oid, base string) map[string]any {
	short := strings.TrimPrefix(ref, "refs/")
	return map[string]any{
		"ref":     ref,
		"node_id": nodeID("ref", ref),
		"url":     base + "/api/v3/repos/" + owner + "/" + name + "/git/refs/" + short,
		"object": map[string]any{
			"type": "commit",
			"sha":  oid,
			"url":  base + "/api/v3/repos/" + owner + "/" + name + "/git/commits/" + oid,
		},
	}
}

// commitJSON is the JSON a commit is reported as, or nil when the id names no commit.
func commitJSON(repo *Repo, oid, base string) map[string]any {
	c, ok := ReadCommit(repo.Store, oid)
	if !ok {
		return nil
	}
	m := repo.Meta
	full := m.Owner + "/" + m.Name
	repoURL := base + "/api/v3/repos/" + full
	parents := make([]any, 0, len(c.Parents))
	for _, p := range c.Parents {
		parents = append(parents, map[string]any{"sha": p, "url": repoURL + "/commits/" + p})
	}
	return map[string]any{
		"sha":      oid,
		"node_id":  nodeID("commit", oid),
		"url":      repoURL + "/commits/" + oid,
		"html_url": base + "/" + full + "/commit/" + oid,
		"commit": map[string]any{
			"author": map[string]any{
				"name": c.Author.Name, "email": c.Author.Email, "date": isoOf(c.Author.Date),
			},
			"committer": map[string]any{
				"name": c.Commiter.Name, "email": c.Commiter.Email, "date": isoOf(c.Commiter.Date),
			},
			"message":       strings.TrimSuffix(c.Message, "\n"),
			"tree":          map[string]any{"sha": c.Tree, "url": repoURL + "/git/trees/" + c.Tree},
			"comment_count": 0,
		},
		"author":    map[string]any{"login": c.Author.Name, "id": hashID(c.Author.Name), "type": "User"},
		"committer": map[string]any{"login": c.Commiter.Name, "id": hashID(c.Commiter.Name), "type": "User"},
		"parents":   parents,
	}
}

// filesOfBranch answers the files of a branch, or an empty map for an unborn one.
func filesOfBranch(repo *Repo, branch string) FileMap {
	tip, ok := repo.BranchTip(branch)
	if !ok {
		return FileMap{}
	}
	c, ok := ReadCommit(repo.Store, tip)
	if !ok {
		return FileMap{}
	}
	return FlattenTree(repo.Store, c.Tree, "", nil)
}

// treeOfBranch answers the tree id of a branch's tip, or "" for an unborn one.
func treeOfBranch(repo *Repo, branch string) string {
	tip, ok := repo.BranchTip(branch)
	if !ok {
		return ""
	}
	c, ok := ReadCommit(repo.Store, tip)
	if !ok {
		return ""
	}
	return c.Tree
}

// commitFiles advances a branch by one new commit over files, answering the commit id.
func commitFiles(repo *Repo, branch string, files FileMap, message string, parents []string) string {
	tree := BuildTree(repo.Store, files)
	if parents == nil {
		if tip, ok := repo.BranchTip(branch); ok {
			parents = []string{tip}
		}
	}
	now := time.Now().Unix()
	who := Who{Name: repo.Meta.Owner, Email: repo.Meta.Owner + "@users.noreply.github.com", Date: now}
	oid := CreateCommit(repo.Store, tree, parents, who, who, message)
	repo.Meta.Branches[branch] = oid
	repo.Meta.UpdatedAt = nowISO()
	repo.Save()
	return oid
}

// resolveRef resolves a ref name (a branch, or a full sha) to a commit id, or false.
func resolveRef(repo *Repo, ref string) (string, bool) {
	if ref == "" {
		return repo.BranchTip(repo.Meta.DefaultBranch)
	}
	if byName, ok := repo.Meta.Branches[ref]; ok && byName != "" {
		return byName, true
	}
	if len(ref) == 40 && isHex(ref) {
		if _, ok := ReadCommit(repo.Store, ref); ok {
			return ref, true
		}
	}
	return "", false
}

// isHex answers whether text is only hexadecimal digits.
func isHex(text string) bool {
	for i := 0; i < len(text); i++ {
		c := text[i]
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}

// pagedREST is the slice a list route answers, with the Link header that follows it.
func pagedREST(items []any, url *urlQuery, base string) ([]any, map[string]string) {
	perPage := 30
	if raw := url.get("per_page"); raw != "" {
		if n := parseInt(raw); n != 0 {
			perPage = n
		}
	}
	if perPage < 1 {
		perPage = 1
	}
	if perPage > 100 {
		perPage = 100
	}
	page := 1
	if raw := url.get("page"); raw != "" {
		if n := parseInt(raw); n != 0 {
			page = n
		}
	}
	if page < 1 {
		page = 1
	}
	start := (page - 1) * perPage
	if start > len(items) {
		start = len(items)
	}
	end := start + perPage
	if end > len(items) {
		end = len(items)
	}
	slice := items[start:end]

	links := make([]string, 0, 2)
	link := func(target int, rel string) {
		links = append(links, "<"+base+url.pathWithPage(perPage, target)+`>; rel="`+rel+`"`)
	}
	if page*perPage < len(items) {
		link(page+1, "next")
	}
	if page > 1 {
		link(page-1, "prev")
	}
	headers := map[string]string{}
	if len(links) > 0 {
		headers["link"] = strings.Join(links, ", ")
	}
	return slice, headers
}

// urlQuery is the small view of a request URL the API routes need: one value per name, plus the
// path and query they came from.
type urlQuery struct {
	path   string
	values map[string]string
}

// newURLQuery reads a request's query into the shape the routes use.
func newURLQuery(r *http.Request) *urlQuery {
	values := map[string]string{}
	for name, list := range r.URL.Query() {
		if len(list) > 0 {
			values[name] = list[0]
		}
	}
	return &urlQuery{path: r.URL.Path, values: values}
}

// get answers one query value, or "".
func (q *urlQuery) get(name string) string {
	return q.values[name]
}

// pathWithPage answers the path with the paging parameters a Link header names.
func (q *urlQuery) pathWithPage(perPage, page int) string {
	names := make([]string, 0, len(q.values))
	for name := range q.values {
		if name == "per_page" || name == "page" {
			continue
		}
		names = append(names, name)
	}
	sort.Strings(names)
	var b strings.Builder
	b.WriteString(q.path)
	b.WriteString("?per_page=")
	b.WriteString(strconv.Itoa(perPage))
	b.WriteString("&page=")
	b.WriteString(strconv.Itoa(page))
	for _, name := range names {
		b.WriteString("&")
		b.WriteString(name)
		b.WriteString("=")
		b.WriteString(q.values[name])
	}
	return b.String()
}

// baseOf answers the base URL the suite uses, for the absolute links the API reports.
func baseOf(r *http.Request) string {
	return "http://" + r.Host
}

// handleRest answers every /api/v3 route, or false when the path is not one.
func (s *Server) handleRest(w http.ResponseWriter, r *http.Request, q *urlQuery) bool {
	path := r.URL.Path
	if path != "/api/v3" && !strings.HasPrefix(path, "/api/v3/") {
		return false
	}
	forge := s.Forge
	base := baseOf(r)
	method := r.Method
	rest := strings.TrimPrefix(path, "/api/v3")
	if rest == "" {
		rest = "/"
	}
	seg := splitSegments(rest)

	if rest == "/" && method == http.MethodGet {
		respondJSON(w, 200, map[string]any{
			"current_user_url":              base + "/api/v3/user",
			"current_user_repositories_url": base + "/api/v3/user/repos",
			"rate_limit_url":                base + "/api/v3/rate_limit",
			"repository_url":                base + "/api/v3/repos/{owner}/{repo}",
			"user_url":                      base + "/api/v3/users/{user}",
		}, map[string]string{"x-oauth-scopes": "repo, read:org"})
		return true
	}

	if len(seg) == 1 && seg[0] == "meta" && method == http.MethodGet {
		respondJSON(w, 200, map[string]any{
			"installed_version": "4.13.0", "verifiable_password_authentication": false,
		}, nil)
		return true
	}

	if len(seg) >= 1 && seg[0] == "rate_limit" && method == http.MethodGet {
		now := time.Now().Unix()
		row := map[string]any{"limit": 5000, "remaining": 5000, "reset": now + 3600, "used": 0}
		respondJSON(w, 200, map[string]any{
			"resources": map[string]any{"core": row, "search": row, "graphql": row},
			"rate":      row,
		}, nil)
		return true
	}

	if len(seg) == 1 && seg[0] == "user" && method == http.MethodGet {
		login := forge.Login()
		respondJSON(w, 200, map[string]any{
			"login": login, "id": hashID(login), "type": "User", "site_admin": false, "name": login,
		}, nil)
		return true
	}

	if len(seg) == 2 && seg[0] == "user" && seg[1] == "repos" {
		switch method {
		case http.MethodGet:
			repos := forge.List(forge.Login())
			items := make([]any, 0, len(repos))
			for _, repo := range repos {
				items = append(items, repoJSON(repo, base))
			}
			slice, headers := pagedREST(items, q, base)
			respondJSON(w, 200, slice, headers)
			return true
		case http.MethodPost:
			body, ok := readBody(w, r)
			if !ok {
				return true
			}
			name := strings.TrimSpace(textOf(body, "name"))
			if name == "" {
				respondJSON(w, 422, map[string]any{
					"message": "Repository name is required",
					"errors": []any{map[string]any{
						"resource": "Repository", "field": "name", "code": "missing",
					}},
				}, nil)
				return true
			}
			description := textOf(body, "description")
			defaultBranch := textOf(body, "default_branch")
			repo := forge.Create(forge.Login(), name, description, boolOf(body, "private"), defaultBranch)
			respondJSON(w, 201, repoJSON(repo, base), nil)
			return true
		}
	}

	// everything below names one repository
	if len(seg) >= 3 && seg[0] == "repos" {
		owner := unescape(seg[1])
		name := unescape(seg[2])
		repo := forge.Get(owner, name)
		// a repository belongs to the login the token names; anything else is simply not found
		if repo == nil || !strings.EqualFold(repo.Meta.Owner, forge.Login()) {
			respondJSON(w, 404, map[string]any{"message": "Not Found"}, nil)
			return true
		}
		s.repoRoutes(repo, w, r, q, base, seg[3:])
		return true
	}

	respondJSON(w, 404, map[string]any{"message": "Not Found"}, nil)
	return true
}

// splitSegments answers the non-empty path segments of a REST path.
func splitSegments(rest string) []string {
	parts := strings.Split(rest, "/")
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		if part != "" {
			out = append(out, part)
		}
	}
	return out
}

// unescape decodes a percent-escaped path segment, leaving it alone when it is not escaped.
func unescape(segment string) string {
	if !strings.Contains(segment, "%") {
		return segment
	}
	if decoded, err := urlPathUnescape(segment); err == nil {
		return decoded
	}
	return segment
}

// The route table under one repository, kept as one function so the order the paths are tried in is
// visible in one place.
func (s *Server) repoRoutes(repo *Repo, w http.ResponseWriter, r *http.Request, q *urlQuery, base string, tail []string) {
	method := r.Method
	m := repo.Meta

	if len(tail) == 0 {
		switch method {
		case http.MethodGet:
			respondJSON(w, 200, repoJSON(repo, base), nil)
			return
		case http.MethodPatch, http.MethodPost:
			body, ok := readBody(w, r)
			if !ok {
				return
			}
			if v, isText := body["description"].(string); isText {
				m.Description = v
			}
			if v, isText := body["name"].(string); isText && strings.TrimSpace(v) != "" {
				m.Name = strings.TrimSpace(v)
			}
			if v, isText := body["default_branch"].(string); isText {
				m.DefaultBranch = v
			}
			if v, isBool := body["private"].(bool); isBool {
				m.Private = v
			}
			m.UpdatedAt = nowISO()
			repo.Save()
			respondJSON(w, 200, repoJSON(repo, base), nil)
			return
		case http.MethodDelete:
			s.Forge.Remove(m.Owner, m.Name)
			respondEmpty(w, 204, nil)
			return
		}
	}

	switch tail[0] {
	case "branches":
		s.branchesRoute(repo, w, base, method, tail)
	case "commits":
		s.commitsRoute(repo, w, q, base, method, tail)
	case "git":
		s.gitRoutes(repo, w, r, base, method, tail)
	case "contents":
		path := make([]string, 0, len(tail)-1)
		for _, part := range tail[1:] {
			path = append(path, unescape(part))
		}
		s.contentsRoute(repo, w, r, q, base, method, strings.Join(path, "/"))
	case "labels":
		s.labelsRoute(repo, w, r, base, method, tail)
	case "issues":
		s.issuesRoute(repo, w, r, q, base, method, tail)
	case "pulls":
		s.pullsRoute(repo, w, r, q, base, method, tail)
	default:
		respondJSON(w, 404, map[string]any{"message": "Not Found"}, nil)
	}
}

// branchesRoute answers the branch listing and one branch.
func (s *Server) branchesRoute(repo *Repo, w http.ResponseWriter, base string, method string, tail []string) {
	m := repo.Meta
	if method == http.MethodGet && len(tail) == 1 {
		names := make([]string, 0, len(m.Branches))
		for name := range m.Branches {
			names = append(names, name)
		}
		sort.Strings(names)
		items := make([]any, 0, len(names))
		for _, name := range names {
			sha := m.Branches[name]
			items = append(items, map[string]any{
				"name": name,
				"commit": map[string]any{
					"sha": sha, "url": base + "/api/v3/repos/" + m.Owner + "/" + m.Name + "/commits/" + sha,
				},
				"protected": false,
			})
		}
		respondJSON(w, 200, items, nil)
		return
	}
	if method == http.MethodGet && len(tail) == 2 {
		branchName := unescape(tail[1])
		sha, ok := m.Branches[branchName]
		if !ok || sha == "" {
			respondJSON(w, 404, map[string]any{"message": "Branch not found"}, nil)
			return
		}
		respondJSON(w, 200, map[string]any{
			"name": branchName, "commit": map[string]any{"sha": sha}, "protected": false,
		}, nil)
		return
	}
	respondJSON(w, 404, map[string]any{"message": "Not Found"}, nil)
}

// commitsRoute answers the history, one commit, its comments and its status.
func (s *Server) commitsRoute(repo *Repo, w http.ResponseWriter, q *urlQuery, base string, method string, tail []string) {
	if method != http.MethodGet {
		respondJSON(w, 404, map[string]any{"message": "Not Found"}, nil)
		return
	}
	if len(tail) == 1 {
		ref, ok := resolveRef(repo, q.get("sha"))
		if !ok {
			respondJSON(w, 200, []any{}, nil)
			return
		}
		perPage := 30
		if raw := q.get("per_page"); raw != "" {
			if n := parseInt(raw); n != 0 {
				perPage = n
			}
		}
		if perPage < 1 {
			perPage = 1
		}
		if perPage > 100 {
			perPage = 100
		}
		history := WalkHistory(repo.Store, []string{ref}, perPage)
		items := make([]any, 0, len(history))
		for _, c := range history {
			if json := commitJSON(repo, c.OID, base); json != nil {
				items = append(items, json)
			}
		}
		respondJSON(w, 200, items, nil)
		return
	}

	sha := tail[1]
	if _, ok := ReadCommit(repo.Store, sha); !ok {
		respondJSON(w, 404, map[string]any{"message": "Not Found"}, nil)
		return
	}
	if len(tail) == 2 {
		respondJSON(w, 200, commitJSON(repo, sha, base), nil)
		return
	}
	if tail[2] == "comments" {
		respondJSON(w, 200, []any{}, nil)
		return
	}
	if tail[2] == "status" {
		respondJSON(w, 200, map[string]any{
			"state": "success", "statuses": []any{}, "sha": sha, "total_count": 0,
		}, nil)
		return
	}
	respondJSON(w, 404, map[string]any{"message": "Not Found"}, nil)
}

// issueBodyCache keeps the serialized body of an issue, keyed by the repository revision and the
// issue number, so a read loop over one issue pays the marshal once.
var issueBodyCache = struct {
	sync.Mutex
	entries map[string][]byte
}{entries: map[string][]byte{}}

// issueBody answers the JSON text of one issue, newline-terminated as every reply is.
func issueBody(repo *Repo, issue *Issue, base string) []byte {
	key := repo.Meta.Owner + "/" + repo.Meta.Name + "#" + strconv.Itoa(repo.Rev) + "#" + strconv.Itoa(issue.Number)
	issueBodyCache.Lock()
	if hit, ok := issueBodyCache.entries[key]; ok {
		issueBodyCache.Unlock()
		return hit
	}
	issueBodyCache.Unlock()

	text, err := jsonMarshalLine(issueJSON(repo, issue, base))
	if err != nil {
		return []byte("{}")
	}
	issueBodyCache.Lock()
	if len(issueBodyCache.entries) > 512 {
		issueBodyCache.entries = map[string][]byte{}
	}
	issueBodyCache.entries[key] = text
	issueBodyCache.Unlock()
	return text
}
