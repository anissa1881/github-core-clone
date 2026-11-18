package main

// The git object routes gh uses to open a branch, create a commit, or read a tree and a blob.

import (
	"net/http"
	"strings"
	"time"
)

// gitRoutes answers /git/refs, /git/commits, /git/trees and /git/blobs under one repository.
func (s *Server) gitRoutes(repo *Repo, w http.ResponseWriter, r *http.Request, base string, method string, tail []string) {
	m := repo.Meta

	if len(tail) >= 2 && tail[1] == "refs" {
		if method == http.MethodPost && len(tail) == 2 {
			body, ok := readBody(w, r)
			if !ok {
				return
			}
			ref := textOf(body, "ref")
			sha := textOf(body, "sha")
			if sha == "" {
				if object, isMap := body["object"].(map[string]any); isMap {
					sha = textOf(object, "sha")
				}
			}
			branch := strings.TrimPrefix(ref, "refs/heads/")
			if len(sha) != 40 || !isHex(sha) {
				respondJSON(w, 422, map[string]any{
					"message": "Object does not exist",
					"errors": []any{map[string]any{
						"resource": "GitRef", "field": "sha", "code": "invalid",
					}},
				}, nil)
				return
			}
			if _, isCommit := ReadCommit(repo.Store, sha); !isCommit {
				respondJSON(w, 422, map[string]any{
					"message": "Object does not exist",
					"errors": []any{map[string]any{
						"resource": "GitRef", "field": "sha", "code": "invalid",
					}},
				}, nil)
				return
			}
			if existing, taken := m.Branches[branch]; taken && existing != "" {
				respondJSON(w, 422, map[string]any{"message": "Reference already exists"}, nil)
				return
			}
			m.Branches[branch] = sha
			m.UpdatedAt = nowISO()
			repo.Save()
			respondJSON(w, 201, refJSON(m.Owner, m.Name, "refs/heads/"+branch, sha, base), nil)
			return
		}
		if method == http.MethodGet {
			names := make([]string, 0, len(m.Branches))
			for name := range m.Branches {
				names = append(names, name)
			}
			sortStrings(names)
			all := make([]any, 0, len(names))
			for _, name := range names {
				all = append(all, refJSON(m.Owner, m.Name, "refs/heads/"+name, m.Branches[name], base))
			}
			if len(tail) > 2 {
				want := "refs/" + strings.Join(tail[2:], "/")
				for i, entry := range all {
					if entry.(map[string]any)["ref"] == want {
						respondJSON(w, 200, all[i], nil)
						return
					}
				}
				respondJSON(w, 404, map[string]any{"message": "Not Found"}, nil)
				return
			}
			respondJSON(w, 200, all, nil)
			return
		}
	}

	if len(tail) >= 2 && tail[1] == "commits" && method == http.MethodPost {
		body, ok := readBody(w, r)
		if !ok {
			return
		}
		tree := textOf(body, "tree")
		if tree == "" {
			if tip, hasTip := repo.BranchTip(m.DefaultBranch); hasTip {
				if c, isCommit := ReadCommit(repo.Store, tip); isCommit {
					tree = c.Tree
				}
			}
		}
		parents := listOf(body, "parents")
		if parents == nil {
			parents = []string{}
		}
		if tree == "" || !repo.Store.Has(tree) {
			respondJSON(w, 422, map[string]any{"message": "Tree not found"}, nil)
			return
		}
		who := Who{Name: m.Owner, Email: m.Owner + "@users.noreply.github.com", Date: time.Now().Unix()}
		oid := CreateCommit(repo.Store, tree, parents, who, who, textOf(body, "message"))
		respondJSON(w, 201, commitJSON(repo, oid, base), nil)
		return
	}

	if len(tail) >= 3 && tail[1] == "trees" && method == http.MethodGet {
		treeOID := tail[2]
		if !repo.Store.Has(treeOID) {
			respondJSON(w, 404, map[string]any{"message": "Not Found"}, nil)
			return
		}
		entries := ReadTree(repo.Store, treeOID)
		items := make([]any, 0, len(entries))
		for _, e := range entries {
			kind := "blob"
			if e.Type == objTree {
				kind = "tree"
			}
			items = append(items, map[string]any{
				"path": e.Name, "mode": e.Mode, "type": kind, "sha": e.OID,
			})
		}
		respondJSON(w, 200, map[string]any{
			"sha":       treeOID,
			"url":       base + "/api/v3/repos/" + m.Owner + "/" + m.Name + "/git/trees/" + treeOID,
			"truncated": false,
			"tree":      items,
		}, nil)
		return
	}

	if len(tail) >= 3 && tail[1] == "blobs" && method == http.MethodGet {
		o, ok := repo.Store.Get(tail[2])
		if !ok {
			respondJSON(w, 404, map[string]any{"message": "Not Found"}, nil)
			return
		}
		respondJSON(w, 200, map[string]any{
			"sha": tail[2], "size": len(o.Data), "encoding": "base64", "content": b64Wrapped(o.Data),
		}, nil)
		return
	}

	respondJSON(w, 404, map[string]any{"message": "Not Found"}, nil)
}
