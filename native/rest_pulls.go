package main

// The pulls routes: create, list, read, the changed files, and the merge.

import (
	"net/http"
	"strconv"
	"strings"
)

// pullsRoute answers the pull-request routes under one repository.
func (s *Server) pullsRoute(repo *Repo, w http.ResponseWriter, r *http.Request, q *urlQuery, base string, method string, tail []string) {
	m := repo.Meta

	if len(tail) == 1 {
		if method == http.MethodPost {
			body, ok := readBody(w, r)
			if !ok {
				return
			}
			head := textOf(body, "head")
			if colon := strings.IndexByte(head, ':'); colon >= 0 {
				head = head[colon+1:]
			}
			baseBranch := textOf(body, "base")
			if baseBranch == "" {
				baseBranch = m.DefaultBranch
			}
			if head == "" || baseBranch == "" {
				respondJSON(w, 422, map[string]any{"message": "head and base are required"}, nil)
				return
			}
			now := nowISO()
			title := textOf(body, "title")
			if title == "" {
				title = head
			}
			baseSHA, _ := repo.BranchTip(baseBranch)
			pr := Pull{
				ID:        hashID("pull:" + m.Owner + "/" + m.Name + ":" + strconv.Itoa(m.NextPullID)),
				Number:    m.NextPullID,
				Title:     title,
				Body:      textOf(body, "body"),
				State:     "open",
				Head:      head,
				Base:      baseBranch,
				BaseSHA:   baseSHA,
				User:      m.Owner,
				CreatedAt: now,
				UpdatedAt: now,
			}
			m.NextPullID++
			m.Pulls = append(m.Pulls, pr)
			repo.Save()
			respondJSON(w, 201, pullJSON(repo, &m.Pulls[len(m.Pulls)-1], base), nil)
			return
		}
		if method == http.MethodGet {
			state := q.get("state")
			if state == "" {
				state = "open"
			}
			items := make([]any, 0, len(m.Pulls))
			for i := range m.Pulls {
				pr := &m.Pulls[i]
				if state != "all" && pr.State != state {
					continue
				}
				items = append(items, pullJSON(repo, pr, base))
			}
			respondJSON(w, 200, items, nil)
			return
		}
	}

	if len(tail) >= 2 {
		number := parseInt(tail[1])
		index := -1
		for i := range m.Pulls {
			if m.Pulls[i].Number == number {
				index = i
				break
			}
		}
		if index < 0 {
			respondJSON(w, 404, map[string]any{"message": "Not Found"}, nil)
			return
		}
		pr := &m.Pulls[index]

		if len(tail) == 2 && method == http.MethodGet {
			respondJSON(w, 200, pullJSON(repo, pr, base), nil)
			return
		}

		if len(tail) >= 3 && tail[2] == "files" && method == http.MethodGet {
			items := make([]any, 0, 4)
			for _, d := range DiffTreePatch(repo.Store, treeOfBranch(repo, pr.Base), treeOfBranch(repo, pr.Head)) {
				items = append(items, map[string]any{
					"sha":           d.SHA,
					"filename":      d.Filename,
					"status":        d.Status,
					"additions":     d.Additions,
					"deletions":     d.Deletions,
					"changes":       d.Changes,
					"blob_url":      "",
					"raw_url":       "",
					"contents_url":  "",
					"patch":         d.Patch,
				})
			}
			respondJSON(w, 200, items, nil)
			return
		}

		if len(tail) >= 3 && tail[2] == "merge" {
			if method == http.MethodGet {
				respondJSON(w, 200, map[string]any{
					"merged": pr.Merged, "mergeable": true, "sha": pr.MergeCommitSHA,
				}, nil)
				return
			}
			if method == http.MethodPut || method == http.MethodPost {
				if _, ok := repo.BranchTip(pr.Head); !ok {
					respondJSON(w, 404, map[string]any{"message": "Head branch not found"}, nil)
					return
				}
				// the merge runs through the one path the MCP tool shares, so both surfaces answer
				// the same sha; a head and a base that both moved over one file is a conflict, 405
				sha, err := MergeViaMcp(repo, pr)
				if err != nil {
					if conflict, isConflict := err.(MergeConflictError); isConflict {
						respondJSON(w, 405, map[string]any{
							"message":           conflict.Message,
							"documentation_url": "https://docs.github.com/rest/pulls/pulls#merge-a-pull-request",
						}, nil)
						return
					}
					respondJSON(w, 500, map[string]any{"message": err.Error()}, nil)
					return
				}
				respondJSON(w, 200, map[string]any{
					"sha": sha, "merged": true, "message": "Pull Request successfully merged",
				}, nil)
				return
			}
		}
	}

	respondJSON(w, 404, map[string]any{"message": "Not Found"}, nil)
}