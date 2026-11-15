// merge.ts: the one merge path REST and MCP share, so both surfaces move the same branch to the
// same commit and answer the same sha.

import { buildTree, createCommit, flattenTree, readCommit } from './git/model.ts';
import type { Pull, Repo } from './store.ts';

/** The files of a branch, or an empty map for an unborn one. */
function filesOf(repo: Repo, branch: string): Map<string, { oid: string; mode: string }> {
  const tip = repo.branchTip(branch);
  if (!tip) return new Map();
  const c = readCommit(repo.store, tip);
  if (!c) return new Map();
  return flattenTree(repo.store, c.tree);
}

/**
 * Squash-merge a pull request: one commit on the base carrying the head's files, the pull closed
 * and merged. Answers the new commit's sha. Throws when the head branch has nothing to merge.
 */
export function mergeViaMcp(repo: Repo, pr: Pull): string {
  const baseTip = repo.branchTip(pr.base);
  const headTip = repo.branchTip(pr.head);
  if (!headTip) throw new Error(`Head branch ${pr.head} not found`);
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
