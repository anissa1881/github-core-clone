package main

import (
	"bytes"
	"fmt"
	"sort"
	"strconv"
	"strings"
)

// Who is the identity on a commit: a name, an address and the seconds since the epoch git records.
type Who struct {
	Name  string
	Email string
	Date  int64
}

// Commit is one parsed commit object.
type Commit struct {
	OID     string
	Tree    string
	Parents []string
	Author  Who
	Commiter Who
	Message string
}

// TreeEntry is one entry of a tree object, with the mode git prints.
type TreeEntry struct {
	Mode string
	Name string
	OID  string
	Type int
}

// FileMap is a path-to-entry map, the flattened form of a tree: how a branch's files are held.
type FileMap map[string]TreeEntry

// ParseCommit reads a commit object.
func ParseCommit(oid string, data []byte) Commit {
	c := Commit{OID: oid, Message: ""}
	body := data
	for {
		nl := bytes.IndexByte(body, '\n')
		if nl < 0 {
			break
		}
		line := string(body[:nl])
		body = body[nl+1:]
		if line == "" {
			break
		}
		switch {
		case strings.HasPrefix(line, "tree "):
			c.Tree = line[5:]
		case strings.HasPrefix(line, "parent "):
			c.Parents = append(c.Parents, line[7:])
		case strings.HasPrefix(line, "author "):
			c.Author = parseWho(line[7:])
		case strings.HasPrefix(line, "committer "):
			c.Commiter = parseWho(line[10:])
		}
	}
	c.Message = string(body)
	return c
}

// parseWho reads "Name <address> 1699999999 +0000".
func parseWho(line string) Who {
	open := strings.LastIndexByte(line, '<')
	close := strings.LastIndexByte(line, '>')
	if open < 0 || close < open {
		return Who{Name: line}
	}
	name := strings.TrimSpace(line[:open])
	email := line[open+1 : close]
	rest := strings.Fields(strings.TrimSpace(line[close+1:]))
	var date int64
	if len(rest) > 0 {
		date, _ = strconv.ParseInt(rest[0], 10, 64)
	}
	return Who{Name: name, Email: email, Date: date}
}

// ParseTree reads a tree object: "<mode> <name>\x00<20 raw bytes>" repeated.
func ParseTree(data []byte) []TreeEntry {
	entries := make([]TreeEntry, 0, 8)
	pos := 0
	for pos < len(data) {
		space := bytes.IndexByte(data[pos:], ' ')
		if space < 0 {
			break
		}
		mode := string(data[pos : pos+space])
		pos += space + 1
		nul := bytes.IndexByte(data[pos:], 0)
		if nul < 0 {
			break
		}
		name := string(data[pos : pos+nul])
		pos += nul + 1
		if pos+20 > len(data) {
			break
		}
		oid := fmt.Sprintf("%x", data[pos:pos+20])
		pos += 20
		t := objBlob
		if mode == "40000" || mode == "040000" {
			t = objTree
		}
		entries = append(entries, TreeEntry{Mode: mode, Name: name, OID: oid, Type: t})
	}
	return entries
}

// SerializeTree writes a tree object's bytes, with git's own ordering: a tree's name sorts as if it
// ended with a slash, so a directory sorts as its contents do.
func SerializeTree(entries []TreeEntry) []byte {
	sorted := make([]TreeEntry, len(entries))
	copy(sorted, entries)
	sort.Slice(sorted, func(i, j int) bool {
		return treeSortKey(sorted[i]) < treeSortKey(sorted[j])
	})
	var buf bytes.Buffer
	for _, e := range sorted {
		mode := e.Mode
		if e.Type == objTree && (mode == "040000" || mode == "") {
			mode = "40000"
		}
		buf.WriteString(mode)
		buf.WriteByte(' ')
		buf.WriteString(e.Name)
		buf.WriteByte(0)
		raw, err := hexDecode(e.OID)
		if err != nil {
			continue
		}
		buf.Write(raw)
	}
	return buf.Bytes()
}

// treeSortKey is the name a tree's entry sorts by: a directory's name gains a trailing slash.
func treeSortKey(e TreeEntry) string {
	if e.Type == objTree {
		return e.Name + "/"
	}
	return e.Name
}

// SerializeCommit writes a commit object's bytes.
func SerializeCommit(tree string, parents []string, author, commiter Who, message string) []byte {
	var buf bytes.Buffer
	buf.WriteString("tree " + tree + "\n")
	for _, p := range parents {
		buf.WriteString("parent " + p + "\n")
	}
	buf.WriteString(fmt.Sprintf("author %s <%s> %d +0000\n", author.Name, author.Email, author.Date))
	buf.WriteString(fmt.Sprintf("committer %s <%s> %d +0000\n", commiter.Name, commiter.Email, commiter.Date))
	if !strings.HasSuffix(message, "\n") {
		message += "\n"
	}
	buf.WriteString("\n" + message)
	return buf.Bytes()
}

// ReadCommit answers a parsed commit, or false when the id names no commit.
func ReadCommit(store *ObjectStore, oid string) (Commit, bool) {
	o, ok := store.Get(oid)
	if !ok || o.Type != objCommit {
		return Commit{}, false
	}
	return ParseCommit(oid, o.Data), true
}

// ReadTree answers a tree's entries.
func ReadTree(store *ObjectStore, oid string) []TreeEntry {
	o, ok := store.Get(oid)
	if !ok || o.Type != objTree {
		return nil
	}
	return ParseTree(o.Data)
}

// FlattenTree walks a tree and answers every file under it, keyed by its full path.
func FlattenTree(store *ObjectStore, treeOID string, prefix string, out FileMap) FileMap {
	if out == nil {
		out = FileMap{}
	}
	for _, e := range ReadTree(store, treeOID) {
		path := e.Name
		if prefix != "" {
			path = prefix + "/" + e.Name
		}
		if e.Type == objTree {
			FlattenTree(store, e.OID, path, out)
			continue
		}
		out[path] = e
	}
	return out
}

// BuildTree writes the trees a file map needs and answers the root tree's id.
func BuildTree(store *ObjectStore, files FileMap) string {
	type node struct {
		files map[string]TreeEntry
		dirs  map[string]*node
	}
	root := &node{files: map[string]TreeEntry{}, dirs: map[string]*node{}}
	paths := make([]string, 0, len(files))
	for path := range files {
		paths = append(paths, path)
	}
	sort.Strings(paths)
	for _, path := range paths {
		entry := files[path]
		parts := strings.Split(path, "/")
		cur := root
		for _, part := range parts[:len(parts)-1] {
			next, ok := cur.dirs[part]
			if !ok {
				next = &node{files: map[string]TreeEntry{}, dirs: map[string]*node{}}
				cur.dirs[part] = next
			}
			cur = next
		}
		entry.Name = parts[len(parts)-1]
		cur.files[entry.Name] = entry
	}
	var write func(n *node) string
	write = func(n *node) string {
		entries := make([]TreeEntry, 0, len(n.files)+len(n.dirs))
		for _, e := range n.files {
			entries = append(entries, e)
		}
		for name, child := range n.dirs {
			oid := write(child)
			entries = append(entries, TreeEntry{Mode: "40000", Name: name, OID: oid, Type: objTree})
		}
		data := SerializeTree(entries)
		oid := HashObject(objTree, data)
		store.Write(oid, Obj{Type: objTree, Data: data})
		return oid
	}
	return write(root)
}

// CreateCommit writes a commit over a tree and answers its id.
func CreateCommit(store *ObjectStore, tree string, parents []string, author, commiter Who, message string) string {
	data := SerializeCommit(tree, parents, author, commiter, message)
	oid := HashObject(objCommit, data)
	store.Write(oid, Obj{Type: objCommit, Data: data})
	return oid
}

// WalkHistory answers the commits reachable from the tips, newest first, up to limit.
func WalkHistory(store *ObjectStore, tips []string, limit int) []Commit {
	seen := map[string]struct{}{}
	queue := make([]string, 0, len(tips))
	queue = append(queue, tips...)
	out := make([]Commit, 0, 16)
	for len(queue) > 0 && len(out) < limit {
		oid := queue[0]
		queue = queue[1:]
		if _, done := seen[oid]; done {
			continue
		}
		seen[oid] = struct{}{}
		c, ok := ReadCommit(store, oid)
		if !ok {
			continue
		}
		out = append(out, c)
		queue = append(queue, c.Parents...)
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Author.Date > out[j].Author.Date })
	return out
}

// IsAncestor answers whether ancestor is reachable from descendant, a commit answering true for
// itself as git does.
func IsAncestor(store *ObjectStore, ancestor, descendant string) bool {
	if ancestor == descendant {
		return true
	}
	seen := map[string]struct{}{}
	stack := []string{descendant}
	for len(stack) > 0 {
		oid := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		if _, done := seen[oid]; done {
			continue
		}
		seen[oid] = struct{}{}
		c, ok := ReadCommit(store, oid)
		if !ok {
			continue
		}
		for _, p := range c.Parents {
			if p == ancestor {
				return true
			}
			stack = append(stack, p)
		}
	}
	return false
}

// FileAtCommit answers the blob id of one path at one commit, or false when the path is not there.
func FileAtCommit(store *ObjectStore, commitOID, path string) (string, bool) {
	c, ok := ReadCommit(store, commitOID)
	if !ok {
		return "", false
	}
	tree := c.Tree
	parts := strings.Split(path, "/")
	for i, part := range parts {
		found := false
		for _, e := range ReadTree(store, tree) {
			if e.Name != part {
				continue
			}
			if i == len(parts)-1 {
				if e.Type != objBlob {
					return "", false
				}
				return e.OID, true
			}
			if e.Type != objTree {
				return "", false
			}
			tree = e.OID
			found = true
			break
		}
		if !found {
			return "", false
		}
	}
	return "", false
}

// TreeAtPath answers the tree id at one path inside a root tree.
func TreeAtPath(store *ObjectStore, rootTree, path string) (string, bool) {
	tree := rootTree
	for _, part := range strings.Split(path, "/") {
		found := false
		for _, e := range ReadTree(store, tree) {
			if e.Name == part && e.Type == objTree {
				tree = e.OID
				found = true
				break
			}
		}
		if !found {
			return "", false
		}
	}
	return tree, true
}

// TreeChange is one changed path between two trees, with the blob ids on both sides.
type TreeChange struct {
	Path    string
	Status  string
	Before  string
	After   string
	Base    []string
	Head    []string
}

// DiffTrees answers the files that differ between two trees, naming each as added, removed or
// modified.
func DiffTrees(store *ObjectStore, baseTree, headTree string) []TreeChange {
	base := FlattenTree(store, baseTree, "", nil)
	head := FlattenTree(store, headTree, "", nil)
	paths := map[string]struct{}{}
	for p := range base {
		paths[p] = struct{}{}
	}
	for p := range head {
		paths[p] = struct{}{}
	}
	ordered := make([]string, 0, len(paths))
	for p := range paths {
		ordered = append(ordered, p)
	}
	sort.Strings(ordered)
	out := make([]TreeChange, 0, 8)
	for _, path := range ordered {
		b, inBase := base[path]
		h, inHead := head[path]
		switch {
		case inBase && inHead && b.OID != h.OID:
			out = append(out, TreeChange{Path: path, Status: "modified", Before: b.OID, After: h.OID})
		case inBase && !inHead:
			out = append(out, TreeChange{Path: path, Status: "removed", Before: b.OID})
		case !inBase && inHead:
			out = append(out, TreeChange{Path: path, Status: "added", After: h.OID})
		}
	}
	return out
}
