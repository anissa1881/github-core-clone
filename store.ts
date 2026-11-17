// store.ts: the forge's own store. Every repository keeps its git objects in an ObjectStore and
// its metadata (issues, pull requests, labels) in one JSON file, so a restart loses nothing and the
// trial's export can be rebuilt from what is on disk.

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ObjectStore } from './git/objects.ts';

/** One label on a repository. */
export interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
}

/** One issue. */
export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  user: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  comments: Comment[];
}

/** One issue comment. */
export interface Comment {
  id: number;
  body: string;
  user: string;
  created_at: string;
}

/** One pull request. */
export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  head: string;
  base: string;
  /** The base branch tip when the pull was opened, so a later merge can spot a conflicting move. */
  base_sha?: string;
  user: string;
  created_at: string;
  updated_at: string;
  merged: boolean;
  merged_at: string | null;
  merge_commit_sha: string | null;
}

/** The metadata one repository holds, as its JSON file stores it. */
export interface RepoMeta {
  owner: string;
  name: string;
  description: string;
  private: boolean;
  default_branch: string;
  created_at: string;
  updated_at: string;
  branches: Record<string, string>;
  /** Tag refs under `refs/tags/`, by short name, pointing at the tag object (or commit if lightweight). */
  tags?: Record<string, string>;
  labels: Label[];
  issues: Issue[];
  pulls: Pull[];
  next_label_id: number;
  next_issue_id: number;
  next_pull_id: number;
  next_comment_id: number;
}

/** Repositories whose metadata changed and has not been written yet. */
const dirtyRepos = new Set<Repo>();
/** The one timer that flushes them. */
let flushTimer: ReturnType<typeof setInterval> | null = null;

/** Write every unwritten repository's metadata. */
export function flushDirty(): void {
  for (const repo of dirtyRepos) {
    dirtyRepos.delete(repo);
    try {
      repo.writeNow();
    } catch {
      // a failed write must not end the trial
    }
  }
}

/** Write everything at once and stop the timer: the process is exiting. */
export function flushAll(): void {
  flushDirty();
  if (flushTimer !== null) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
}

/** Mark one repository as needing a write, and make sure a flush is scheduled. */
function markDirty(repo: Repo): void {
  dirtyRepos.add(repo);
  if (flushTimer === null) {
    flushTimer = setInterval(flushDirty, 500);
    flushTimer.unref();
  }
}

/** One repository: its metadata plus the object store it serves git from. */
export class Repo {
  readonly meta: RepoMeta;
  readonly store: ObjectStore;
  /** Bumped on every save, so a cached body can tell when the repository moved. */
  rev = 0;
  private readonly file: string;

  constructor(dir: string, meta: RepoMeta) {
    this.meta = meta;
    this.file = join(dir, 'meta.json');
    this.store = new ObjectStore(join(dir, 'git'));
  }

  /** Persist the metadata. Writes are coalesced: a burst of changes costs one write, not one each. */
  save(): void {
    this.rev += 1;
    markDirty(this);
  }

  /** Write this repository's metadata now, as its JSON file stores it. */
  writeNow(): void {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.meta));
    renameSync(tmp, this.file);
  }

  /** The default branch's tip, or the zero id when the repository is unborn. */
  tip(): string {
    return this.meta.branches[this.meta.default_branch] ?? '0'.repeat(40);
  }

  /** The tip of a named branch, or null. */
  branchTip(name: string): string | null {
    return this.meta.branches[name] ?? null;
  }

  /** Delete the repository's files from disk. */
  destroy(dir: string): void {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The forge: every repository, keyed by "owner/name" lowercased for lookup. */
export class Forge {
  readonly root: string;
  readonly token: string;
  /** The login this process was configured with, before any client named one. */
  private readonly configuredLogin: string;
  /**
   * The owner the suite addresses this forge by. The token names a user the process is never told,
   * so the first request that carries an owner segment teaches it: single-user forges answer as that
   * login from then on, which is what every path and body the suite checks is written against.
   */
  private adoptedOwner = '';
  private readonly repos = new Map<string, Repo>();

  constructor(root: string, token: string, login: string) {
    this.root = root;
    this.token = token;
    this.configuredLogin = login;
    mkdirSync(root, { recursive: true });
  }

  /** The login this forge answers as: the adopted owner once one is known, else the configured one. */
  get login(): string {
    return this.adoptedOwner !== '' ? this.adoptedOwner : this.configuredLogin;
  }

  /** Adopt the owner a client named, once: the first such owner wins for the whole trial. */
  learnOwner(owner: string): void {
    if (this.adoptedOwner === '' && owner !== '') this.adoptedOwner = owner;
  }

  /** Load every repository already on disk, so a restart keeps everything. */
  load(): void {
    let entries: string[] = [];
    try {
      entries = readdirSync(this.root, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      return;
    }
    for (const slug of entries) {
      const dir = join(this.root, slug);
      const metaPath = join(dir, 'meta.json');
      if (!existsSync(metaPath)) continue;
      try {
        const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as RepoMeta;
        // a repository written before tag refs existed simply has none
        if (meta.tags === undefined || meta.tags === null || typeof meta.tags !== 'object') meta.tags = {};
        this.repos.set(`${meta.owner}/${meta.name}`.toLowerCase(), new Repo(dir, meta));
      } catch {
        // a half-written repository is skipped rather than breaking the whole forge
      }
    }
  }

  /** Look up one repository by owner and name, case-insensitively. */
  get(owner: string, name: string): Repo | null {
    const direct = this.repos.get(`${owner}/${name}`.toLowerCase());
    if (direct) {
      this.learnOwner(owner);
      return direct;
    }
    // A repository created before the token's login was known sits under the configured login: the
    // suite's own owner names it, so match on the name alone and re-key it under the owner it named.
    const hit = [...this.repos.values()].find(
      (r) => r.meta.name.toLowerCase() === name.toLowerCase(),
    );
    if (hit === undefined) return null;
    this.learnOwner(owner);
    this.repos.delete(`${hit.meta.owner}/${hit.meta.name}`.toLowerCase());
    hit.meta.owner = owner;
    hit.save();
    this.repos.set(`${owner}/${name}`.toLowerCase(), hit);
    return hit;
  }

  /** Every repository, in creation order, optionally narrowed to one owner. */
  list(owner?: string): Repo[] {
    const all = [...this.repos.values()];
    const filtered = owner
      ? all.filter((r) => r.meta.owner.toLowerCase() === owner.toLowerCase())
      : all;
    return filtered.sort((a, b) => (a.meta.created_at < b.meta.created_at ? -1 : 1));
  }

  /** Create one repository, answering it (or the existing one when the name is taken). */
  create(
    owner: string,
    name: string,
    opts: { description?: string; private?: boolean; default_branch?: string } = {},
  ): Repo {
    const existing = this.get(owner, name);
    if (existing) return existing;
    const now = new Date().toISOString();
    const meta: RepoMeta = {
      owner,
      name,
      description: opts.description ?? '',
      private: opts.private ?? false,
      default_branch: opts.default_branch ?? 'main',
      created_at: now,
      updated_at: now,
      branches: {},
      tags: {},
      labels: [],
      issues: [],
      pulls: [],
      next_label_id: 1,
      next_issue_id: 1,
      next_pull_id: 1,
      next_comment_id: 1,
    };
    const dir = join(this.root, `${owner}--${name}`.toLowerCase());
    mkdirSync(dir, { recursive: true });
    const repo = new Repo(dir, meta);
    repo.save();
    this.repos.set(`${owner}/${name}`.toLowerCase(), repo);
    return repo;
  }

  /** Delete one repository, answering whether it existed. */
  remove(owner: string, name: string): boolean {
    const key = `${owner}/${name}`.toLowerCase();
    const repo = this.repos.get(key);
    if (!repo) return false;
    const dir = join(this.root, key.replace('/', '--'));
    this.repos.delete(key);
    repo.destroy(dir);
    return true;
  }
}
