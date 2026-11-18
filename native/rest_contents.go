package main

// The contents routes (read, create, update and delete one file at one path) and the labels routes.

import (
	"encoding/base64"
	"net/http"
	"strings"
)

// fileJSON answers one file's JSON at one path.
func fileJSON(repo *Repo, base, path, oid string) map[string]any {
	m := repo.Meta
	var data []byte
	if o, ok := repo.Store.Get(oid); ok {
		data = o.Data
	}
	name := path
	if slash := strings.LastIndexByte(path, '/'); slash >= 0 {
		name = path[slash+1:]
	}
	full := m.Owner + "/" + m.Name
	return map[string]any{
		"name":         name,
		"path":         path,
		"sha":          oid,
		"size":         len(data),
		"type":         "file",
		"encoding":     "base64",
		"content":      b64Wrapped(data),
		"url":          base + "/api/v3/repos/" + full + "/contents/" + path,
		"git_url":      base + "/api/v3/repos/" + full + "/git/blobs/" + oid,
		"download_url": nil,
	}
}

// contentsRoute answers the contents API for one path on one branch.
func (s *Server) contentsRoute(repo *Repo, w http.ResponseWriter, r *http.Request, q *urlQuery, base string, method string, path string) {
	m := repo.Meta
	branch := q.get("ref")
	if branch == "" {
		branch = m.DefaultBranch
	}
	files := filesOfBranch(repo, branch)

	if method == http.MethodGet {
		if path == "" {
			names := make([]string, 0, len(files))
			for name := range files {
				names = append(names, name)
			}
			sortStrings(names)
			items := make([]any, 0, len(names))
			for _, name := range names {
				items = append(items, fileJSON(repo, base, name, files[name].OID))
			}
			respondJSON(w, 200, items, nil)
			return
		}

		tip, hasTip := repo.BranchTip(branch)
		blob := ""
		if hasTip {
			if oid, ok := FileAtCommit(repo.Store, tip, path); ok {
				blob = oid
			}
		}
		if blob == "" {
			// a directory answers a listing of its entries instead
			dirTree := ""
			if hasTip {
				if oid, ok := TreeAtPath(repo.Store, treeOfBranch(repo, branch), path); ok {
					dirTree = oid
				}
			}
			if dirTree == "" {
				respondJSON(w, 404, map[string]any{"message": "Not Found"}, nil)
				return
			}
			entries := ReadTree(repo.Store, dirTree)
			items := make([]any, 0, len(entries))
			for _, e := range entries {
				size := 0
				kind := "file"
				if e.Type == objTree {
					kind = "dir"
				} else if o, ok := repo.Store.Get(e.OID); ok {
					size = len(o.Data)
				}
				items = append(items, map[string]any{
					"name": e.Name,
					"path": path + "/" + e.Name,
					"sha":  e.OID,
					"size": size,
					"type": kind,
					"url":  base + "/api/v3/repos/" + m.Owner + "/" + m.Name + "/contents/" + path + "/" + e.Name,
				})
			}
			respondJSON(w, 200, items, nil)
			return
		}
		respondJSON(w, 200, fileJSON(repo, base, path, blob), nil)
		return
	}

	// a write names its branch in the body, which wins over the ref query; GET uses the query
	targetOf := func(body map[string]any) string {
		asked := branch
		if fromBody := textOf(body, "branch"); fromBody != "" {
			asked = fromBody
		}
		if asked == m.DefaultBranch {
			return asked
		}
		if _, ok := repo.BranchTip(asked); ok {
			return asked
		}
		return ""
	}

	if method == http.MethodPut || method == http.MethodPost {
		body, ok := readBody(w, r)
		if !ok {
			return
		}
		target := targetOf(body)
		if target == "" {
			respondJSON(w, 404, map[string]any{"message": "Branch " + textOf(body, "branch") + " not found"}, nil)
			return
		}
		targetFiles := files
		if target != branch {
			targetFiles = filesOfBranch(repo, target)
		}

		decoded, err := base64.StdEncoding.DecodeString(strings.ReplaceAll(textOf(body, "content"), "\n", ""))
		if err != nil {
			decoded = nil
		}
		givenSHA := textOf(body, "sha")
		existing, exists := targetFiles[path]

		// an update must name the sha it replaces, and a create must not name one
		if exists {
			if givenSHA != existing.OID {
				respondJSON(w, 409, map[string]any{
					"message":           path + " does not match " + existing.OID,
					"documentation_url": "https://docs.github.com/rest/repos/contents",
				}, nil)
				return
			}
		} else if givenSHA != "" {
			respondJSON(w, 422, map[string]any{"message": "sha does not match any file"}, nil)
			return
		}

		blob := repo.Store.Write(HashObject(objBlob, decoded), Obj{Type: objBlob, Data: decoded})
		next := FileMap{}
		for name, entry := range targetFiles {
			next[name] = entry
		}
		next[path] = TreeEntry{Mode: "100644", Name: "", OID: blob, Type: objBlob}
		message := textOf(body, "message")
		if message == "" {
			message = "Update " + path
		}
		commit := commitFiles(repo, target, next, message, nil)
		status := 201
		if exists {
			status = 200
		}
		respondJSON(w, status, map[string]any{
			"content": fileJSON(repo, base, path, blob),
			"commit": map[string]any{
				"sha":     commit,
				"message": message,
				"url":     base + "/api/v3/repos/" + m.Owner + "/" + m.Name + "/commits/" + commit,
			},
		}, nil)
		return
	}

	if method == http.MethodDelete {
		body, ok := readBody(w, r)
		if !ok {
			return
		}
		target := targetOf(body)
		if target == "" {
			respondJSON(w, 404, map[string]any{"message": "Branch " + textOf(body, "branch") + " not found"}, nil)
			return
		}
		targetFiles := files
		if target != branch {
			targetFiles = filesOfBranch(repo, target)
		}
		if _, present := targetFiles[path]; !present {
			respondJSON(w, 404, map[string]any{"message": "Not Found"}, nil)
			return
		}
		next := FileMap{}
		for name, entry := range targetFiles {
			if name == path {
				continue
			}
			next[name] = entry
		}
		message := textOf(body, "message")
		if message == "" {
			message = "Delete " + path
		}
		commit := commitFiles(repo, target, next, message, nil)
		respondJSON(w, 200, map[string]any{
			"commit":  map[string]any{"sha": commit, "message": message},
			"content": nil,
		}, nil)
		return
	}

	respondJSON(w, 404, map[string]any{"message": "Not Found"}, nil)
}

// labelsRoute answers the labels routes.
func (s *Server) labelsRoute(repo *Repo, w http.ResponseWriter, r *http.Request, base string, method string, tail []string) {
	m := repo.Meta

	if method == http.MethodGet && len(tail) == 1 {
		items := make([]any, 0, len(m.Labels))
		for _, l := range m.Labels {
			items = append(items, labelJSON(repo, base, l.ID, l.Name, l.Color, l.Description))
		}
		respondJSON(w, 200, items, nil)
		return
	}

	if method == http.MethodPost && len(tail) == 1 {
		body, ok := readBody(w, r)
		if !ok {
			return
		}
		name := strings.TrimSpace(textOf(body, "name"))
		if name == "" {
			respondJSON(w, 422, map[string]any{"message": "name is required"}, nil)
			return
		}
		for _, l := range m.Labels {
			if l.Name == name {
				respondJSON(w, 422, map[string]any{
					"message": "Validation Failed",
					"errors": []any{map[string]any{
						"resource": "Label", "code": "already_exists", "field": "name",
					}},
				}, nil)
				return
			}
		}
		color := textOf(body, "color")
		if color == "" {
			color = "ededed"
		}
		color = strings.TrimPrefix(color, "#")
		label := Label{ID: m.NextLabelID, Name: name, Color: color, Description: textOf(body, "description")}
		m.NextLabelID++
		m.Labels = append(m.Labels, label)
		repo.Save()
		respondJSON(w, 201, labelJSON(repo, base, label.ID, label.Name, label.Color, label.Description), nil)
		return
	}

	respondJSON(w, 404, map[string]any{"message": "Not Found"}, nil)
}
