package main

// The one merge path the REST pull routes and the MCP merge tool share, so both surfaces move the
// same branch to the same commit and answer the same sha.

import (
	"fmt"
	"time"
)

// MergeConflictError is a merge that cannot go through: the head and the base both moved over the
// same path.
type MergeConflictError struct{ Message string }

func (e MergeConflictError) Error() string { return e.Message }

// treeOfCommit answers the tree of a commit id, or "" when there is none.
func treeOfCommit(store *ObjectStore, oid string) string {
	if oid == "" {
		return ""
	}
	c, ok := ReadCommit(store, oid)
	if !ok {
		return ""
	}
	return c.Tree
}

// changedPaths answers the paths whose bytes differ between two trees.
func changedPaths(store *ObjectStore, fromTree, toTree string) map[string]struct{} {
	out := map[string]struct{}{}
	for _, d := range DiffTrees(store, fromTree, toTree) {
		out[d.Path] = struct{}{}
	}
	return out
}

// hasConflict answers whether merging would conflict: the base moved since the pull was opened, and
// the base's change and the head's change touch a common path.
func hasConflict(repo *Repo, pr *Pull) bool {
	baseTip, okBase := repo.BranchTip(pr.Base)
	headTip, okHead := repo.BranchTip(pr.Head)
	if !okBase || !okHead || pr.BaseSHA == "" || baseTip == pr.BaseSHA {
		return false
	}
	commonTree := treeOfCommit(repo.Store, pr.BaseSHA)
	basePaths := changedPaths(repo.Store, commonTree, treeOfCommit(repo.Store, baseTip))
	if len(basePaths) == 0 {
		return false
	}
	headPaths := changedPaths(repo.Store, commonTree, treeOfCommit(repo.Store, headTip))
	for path := range headPaths {
		if _, both := basePaths[path]; both {
			return true
		}
	}
	return false
}

// MergeViaMcp squash-merges a pull request: one commit on the base carrying the head's files, the
// pull closed and merged. It answers the new commit's sha, or a MergeConflictError.
func MergeViaMcp(repo *Repo, pr *Pull) (string, error) {
	baseTip, okBase := repo.BranchTip(pr.Base)
	_, okHead := repo.BranchTip(pr.Head)
	if !okHead {
		return "", fmt.Errorf("head branch %s not found", pr.Head)
	}
	if hasConflict(repo, pr) {
		return "", MergeConflictError{Message: fmt.Sprintf(
			"Pull request #%d cannot be merged: the base branch moved over the same files", pr.Number)}
	}

	merged := filesOfBranch(repo, pr.Base)
	for path, entry := range filesOfBranch(repo, pr.Head) {
		merged[path] = entry
	}
	tree := BuildTree(repo.Store, merged)
	parents := []string{}
	if okBase {
		parents = []string{baseTip}
	}
	now := time.Now()
	who := Who{Name: repo.Meta.Owner, Email: repo.Meta.Owner + "@users.noreply.github.com", Date: now.Unix()}
	sha := CreateCommit(repo.Store, tree, parents, who, who,
		fmt.Sprintf("%s\n\n#%d", pr.Title, pr.Number))

	iso := now.UTC().Format("2006-01-02T15:04:05.000Z")
	repo.Meta.Branches[pr.Base] = sha
	pr.State = "closed"
	pr.Merged = true
	pr.MergedAt = &iso
	pr.MergeCommitSHA = &sha
	pr.UpdatedAt = iso
	repo.Meta.UpdatedAt = iso
	repo.Save()
	return sha, nil
}
