package main

// The issues routes: create, list, read, patch, and the comments under one issue.

import (
	"net/http"
	"sort"
	"strconv"
	"strings"
)

// issuesRoute answers the issues routes under one repository.
func (s *Server) issuesRoute(repo *Repo, w http.ResponseWriter, r *http.Request, q *urlQuery, base string, method string, tail []string) {
	m := repo.Meta

	if len(tail) == 1 {
		if method == http.MethodPost {
			body, ok := readBody(w, r)
			if !ok {
				return
			}
			title := strings.TrimSpace(textOf(body, "title"))
			if title == "" {
				respondJSON(w, 422, map[string]any{"message": "title is required"}, nil)
				return
			}
			wanted := listOf(body, "labels")
			missing := make([]any, 0, len(wanted))
			for _, name := range wanted {
				found := false
				for _, label := range m.Labels {
					if label.Name == name {
						found = true
						break
					}
				}
				if !found {
					missing = append(missing, map[string]any{
						"resource": "Issue", "field": "labels", "code": "invalid", "value": name,
					})
				}
			}
			if len(missing) > 0 {
				respondJSON(w, 422, map[string]any{
					"message": "Validation Failed", "errors": missing,
				}, nil)
				return
			}
			now := nowISO()
			user := textOf(body, "user")
			if user == "" {
				user = m.Owner
			}
			issue := Issue{
				ID:        hashID("issue:" + m.Owner + "/" + m.Name + ":" + strconv.Itoa(m.NextIssueID)),
				Number:    m.NextIssueID,
				Title:     title,
				Body:      textOf(body, "body"),
				State:     "open",
				Labels:    wanted,
				User:      user,
				CreatedAt: now,
				UpdatedAt: now,
				Comments:  []Comment{},
			}
			m.NextIssueID++
			m.Issues = append(m.Issues, issue)
			repo.Save()
			respondJSON(w, 201, issueJSON(repo, &m.Issues[len(m.Issues)-1], base), nil)
			return
		}

		if method == http.MethodGet {
			state := q.get("state")
			if state == "" {
				state = "open"
			}
			sortKey := q.get("sort")
			if sortKey == "" {
				sortKey = "created"
			}
			direction := q.get("direction")
			if direction == "" {
				direction = "desc"
			}
			wanted := q.get("labels")

			list := make([]*Issue, 0, len(m.Issues))
			for i := range m.Issues {
				issue := &m.Issues[i]
				if state != "all" && issue.State != state {
					continue
				}
				if wanted != "" {
					all := true
					for _, name := range strings.Split(wanted, ",") {
						name = strings.TrimSpace(name)
						if name == "" {
							continue
						}
						has := false
						for _, own := range issue.Labels {
							if own == name {
								has = true
								break
							}
						}
						if !has {
							all = false
							break
						}
					}
					if !all {
						continue
					}
				}
				list = append(list, issue)
			}

			sort.SliceStable(list, func(i, j int) bool {
				a, b := list[i], list[j]
				av, bv := a.CreatedAt, b.CreatedAt
				if sortKey == "updated" {
					av, bv = a.UpdatedAt, b.UpdatedAt
				}
				// two writes can land in the same second, and their timestamps then compare equal:
				// the issue opened later carries the higher number, so the number breaks the tie
				if av == bv {
					if direction == "asc" {
						return a.Number < b.Number
					}
					return a.Number > b.Number
				}
				if direction == "asc" {
					return av < bv
				}
				return av > bv
			})

			items := make([]any, 0, len(list))
			for _, issue := range list {
				items = append(items, issueJSON(repo, issue, base))
			}
			respondJSON(w, 200, items, nil)
			return
		}
	}

	if len(tail) >= 2 {
		number := parseInt(tail[1])
		index := -1
		for i := range m.Issues {
			if m.Issues[i].Number == number {
				index = i
				break
			}
		}
		if index < 0 {
			respondJSON(w, 404, map[string]any{"message": "Not Found"}, nil)
			return
		}
		issue := &m.Issues[index]

		if len(tail) == 2 {
			if method == http.MethodGet {
				respondText(w, 200, string(issueBody(repo, issue, base)), nil)
				return
			}
			if method == http.MethodPatch || method == http.MethodPost {
				body, ok := readBody(w, r)
				if !ok {
					return
				}
				if v, isText := body["title"].(string); isText {
					issue.Title = v
				}
				if v, isText := body["body"].(string); isText {
					issue.Body = v
				}
				if v, isText := body["state"].(string); isText && (v == "open" || v == "closed") {
					issue.State = v
					if v == "closed" {
						closed := nowISO()
						issue.ClosedAt = &closed
					} else {
						issue.ClosedAt = nil
					}
				}
				if labels := listOf(body, "labels"); labels != nil {
					issue.Labels = labels
				}
				issue.UpdatedAt = nowISO()
				repo.Save()
				respondJSON(w, 200, issueJSON(repo, issue, base), nil)
				return
			}
		}

		if len(tail) >= 3 && tail[2] == "comments" {
			if method == http.MethodGet {
				items := make([]any, 0, len(issue.Comments))
				for _, c := range issue.Comments {
					items = append(items, map[string]any{
						"id":         c.ID,
						"body":       c.Body,
						"user":       map[string]any{"login": c.User, "type": "User"},
						"created_at": c.CreatedAt,
						"url": base + "/api/v3/repos/" + m.Owner + "/" + m.Name + "/issues/" +
							strconv.Itoa(issue.Number) + "/comments/" + strconv.Itoa(c.ID),
					})
				}
				respondJSON(w, 200, items, nil)
				return
			}
			if method == http.MethodPost {
				body, ok := readBody(w, r)
				if !ok {
					return
				}
				now := nowISO()
				comment := Comment{ID: m.NextCommentID, Body: textOf(body, "body"), User: m.Owner, CreatedAt: now}
				m.NextCommentID++
				issue.Comments = append(issue.Comments, comment)
				issue.UpdatedAt = now
				repo.Save()
				respondJSON(w, 201, map[string]any{
					"id":         comment.ID,
					"body":       comment.Body,
					"user":       map[string]any{"login": comment.User, "type": "User"},
					"created_at": comment.CreatedAt,
					"url": base + "/api/v3/repos/" + m.Owner + "/" + m.Name + "/issues/" +
						strconv.Itoa(issue.Number) + "/comments/" + strconv.Itoa(comment.ID),
				}, nil)
				return
			}
		}
	}

	respondJSON(w, 404, map[string]any{"message": "Not Found"}, nil)
}