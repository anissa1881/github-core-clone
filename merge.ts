// merge.ts: the one merge path REST and MCP share, so both surfaces move the same branch to the
// same commit and answer the same sha.

import { buildTree, createCommit, diffTrees, flattenTree, readCommit } from './git/model.ts';
import type { Pull, Repo } from './store.ts';

/** A merge that cannot go through: the head and the base both moved over the same path. */
export class MergeConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MergeConflictError';
  }
}

/** The files of a branch, or an empty map for an unborn one. */
function filesOf(repo: Repo, branch: string): Map<string, { oid: string; mode: string }> {
  const tip = repo.branchTip(branch);
  if (!tip) return new Map();
  const c = readCommit(repo.store, tip);
  if (!c) return new Map();
  return flattenTree(repo.store, c.tree);
}

/** The tree of a commit id, or '' when there is none. */
function treeOfCommit(repo: Repo, oid: string | null | undefined): string {
  if (!oid) return '';
  return readCommit(repo.store, oid)?.tree ?? '';
}

/** The paths whose bytes differ between two trees. */
function changedPaths(repo: Repo, fromTree: string, toTree: string): Set<string> {
  return new Set(diffTrees(repo.store, fromTree, toTree).map((d) => d.filename));
}

/**
 * Whether merging would conflict: the base moved since the pull was opened, and the base's change
 * and the head's change touch a common path. A squash merge cannot resolve that, so the answer is
 * GitHub's 405 rather than a silent last-writer-wins.
 */
export function hasConflict(repo: Repo, pr: Pull): boolean {
  const baseTip = repo.branchTip(pr.base);
  const headTip = repo.branchTip(pr.head);
  if (!baseTip || !headTip || !pr.base_sha || baseTip === pr.base_sha) return false;
  const commonTree = treeOfCommit(repo, pr.base_sha);
  const basePaths = changedPaths(repo, commonTree, treeOfCommit(repo, baseTip));
  if (basePaths.size === 0) return false;
  const headPaths = changedPaths(repo, commonTree, treeOfCommit(repo, headTip));
  for (const path of headPaths) if (basePaths.has(path)) return true;
  return false;
}

/**
 * Squash-merge a pull request: one commit on the base carrying the head's files, the pull closed
 * and merged. Answers the new commit's sha. Throws when the head branch has nothing to merge, or
 * MergeConflictError when both sides moved over the same file.
 */
export function mergeViaMcp(repo: Repo, pr: Pull): string {
  const baseTip = repo.branchTip(pr.base);
  const headTip = repo.branchTip(pr.head);
  if (!headTip) throw new Error(`Head branch ${pr.head} not found`);
  if (hasConflict(repo, pr)) {
    throw new MergeConflictError(`Pull request #${pr.number} cannot be merged: the base branch moved over the same files`);
  }
  const merged = filesOf(repo, pr.base);
  for (const [p, v] of filesOf(repo, pr.head)) merged.set(p, v);
  const tree = buildTree(repo.store, merged);
  const parents = baseTip ? [baseTip] : [];
  const now = new Date().toISOString();
  const sha = createCommit(repo.store, {
    tree,
    parents,
    message: `${pr.title}\n\n#${pr.number}`,
    name: repo.meta.owner,
    email: `${repo.meta.owner}@users.noreply.github.com`,
  });
  repo.meta.branches[pr.base] = sha;
  pr.state = 'closed';
  pr.merged = true;
  pr.merged_at = now;
  pr.merge_commit_sha = sha;
  pr.updated_at = now;
  repo.meta.updated_at = now;
  repo.save();
  return sha;
}

/** Whether a pull request has anything to merge (its head differs from its base). */
export function hasChanges(repo: Repo, pr: Pull): boolean {
  const a = filesOf(repo, pr.base);
  const b = filesOf(repo, pr.head);
  if (a.size !== b.size) return true;
  for (const [p, v] of a) if (b.get(p)?.oid !== v.oid) return true;
  return false;
}
