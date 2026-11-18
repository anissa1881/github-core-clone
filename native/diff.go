package main

// The unified diff the pull-request routes report: the common ends trimmed, then an LCS over the
// middle, written as unified-diff lines. The shapes match git/model.ts, so a patch here and a patch
// there read the same.

import (
	"fmt"
	"sort"
	"strings"
)

// FileDiff is one changed path between two trees.
type FileDiff struct {
	Filename  string
	Status    string
	Additions int
	Deletions int
	Changes   int
	Patch     string
	SHA       string
}

// lcsCellLimit is the size past which the middle is reported rather than diffed with a table.
const lcsCellLimit = 4_000_000

// lineDiff answers the unified-diff lines between two files, with their added and removed counts.
func lineDiff(a, b []string) (added, removed int, lines []string) {
	start := 0
	for start < len(a) && start < len(b) && a[start] == b[start] {
		start++
	}
	endA, endB := len(a), len(b)
	for endA > start && endB > start && a[endA-1] == b[endB-1] {
		endA--
		endB--
	}

	midA := a[start:endA]
	midB := b[start:endB]
	lines = make([]string, 0, len(a)+len(b))
	for _, l := range a[:start] {
		lines = append(lines, " "+l)
	}

	if len(midA)*len(midB) > lcsCellLimit {
		for _, l := range midA {
			lines = append(lines, "-"+l)
			removed++
		}
		for _, l := range midB {
			lines = append(lines, "+"+l)
			added++
		}
	} else {
		n, m := len(midA), len(midB)
		w := m + 1
		table := make([]uint32, (n+1)*w)
		for i := n - 1; i >= 0; i-- {
			for j := m - 1; j >= 0; j-- {
				if midA[i] == midB[j] {
					table[i*w+j] = table[(i+1)*w+j+1] + 1
					continue
				}
				below := table[(i+1)*w+j]
				right := table[i*w+j+1]
				if below >= right {
					table[i*w+j] = below
				} else {
					table[i*w+j] = right
				}
			}
		}
		i, j := 0, 0
		for i < n && j < m {
			switch {
			case midA[i] == midB[j]:
				lines = append(lines, " "+midA[i])
				i++
				j++
			case table[(i+1)*w+j] >= table[i*w+j+1]:
				lines = append(lines, "-"+midA[i])
				removed++
				i++
			default:
				lines = append(lines, "+"+midB[j])
				added++
				j++
			}
		}
		for ; i < n; i++ {
			lines = append(lines, "-"+midA[i])
			removed++
		}
		for ; j < m; j++ {
			lines = append(lines, "+"+midB[j])
			added++
		}
	}

	for _, l := range a[endA:] {
		lines = append(lines, " "+l)
	}
	return added, removed, lines
}

// makePatch answers the unified patch body for one file's diff.
func makePatch(filename string, a, b, lines []string) string {
	var buf strings.Builder
	fmt.Fprintf(&buf, "diff --git a/%s b/%s\n", filename, filename)
	fmt.Fprintf(&buf, "--- a/%s\n", filename)
	fmt.Fprintf(&buf, "+++ b/%s\n", filename)
	fmt.Fprintf(&buf, "@@ -1,%d +1,%d @@\n", len(a), len(b))
	for _, line := range lines {
		buf.WriteString(line)
		buf.WriteByte('\n')
	}
	return buf.String()
}

// linesOf answers a file's text lines, without its final newline making an empty trailing line.
func linesOf(text string) []string {
	if text == "" {
		return nil
	}
	return strings.Split(strings.TrimSuffix(text, "\n"), "\n")
}

// DiffTreePatch diffs two trees into the pull-request files list, with each file's patch.
func DiffTreePatch(store *ObjectStore, baseTree, headTree string) []FileDiff {
	before := FileMap{}
	if baseTree != "" {
		before = FlattenTree(store, baseTree, "", nil)
	}
	after := FileMap{}
	if headTree != "" {
		after = FlattenTree(store, headTree, "", nil)
	}
	names := make([]string, 0, len(before)+len(after))
	seen := map[string]struct{}{}
	for name := range before {
		names = append(names, name)
		seen[name] = struct{}{}
	}
	for name := range after {
		if _, ok := seen[name]; !ok {
			names = append(names, name)
		}
	}
	sort.Strings(names)

	out := make([]FileDiff, 0, len(names))
	for _, name := range names {
		b, inBase := before[name]
		a, inHead := after[name]
		if inBase && inHead && b.OID == a.OID {
			continue
		}
		status := "modified"
		switch {
		case !inBase:
			status = "added"
		case !inHead:
			status = "removed"
		}
		textA, textB := "", ""
		if inBase {
			if o, ok := store.Get(b.OID); ok {
				textA = string(o.Data)
			}
		}
		if inHead {
			if o, ok := store.Get(a.OID); ok {
				textB = string(o.Data)
			}
		}
		linesA, linesB := linesOf(textA), linesOf(textB)
		added, removed, body := lineDiff(linesA, linesB)
		sha := b.OID
		if inHead {
			sha = a.OID
		}
		out = append(out, FileDiff{
			Filename:  name,
			Status:    status,
			Additions: added,
			Deletions: removed,
			Changes:   added + removed,
			Patch:     makePatch(name, linesA, linesB, body),
			SHA:       sha,
		})
	}
	return out
}
