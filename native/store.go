package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// The metadata one repository holds, as its JSON file stores it. The field names are the ones the
// TypeScript store writes, so a store written by either build reads in the other.
type Label struct {
	ID          int    `json:"id"`
	Name        string `json:"name"`
	Color       string `json:"color"`
	Description string `json:"description"`
}

// Comment is one comment on an issue.
type Comment struct {
	ID        int    `json:"id"`
	Body      string `json:"body"`
	User      string `json:"user"`
	CreatedAt string `json:"created_at"`
}

// Issue is one issue with its comments.
type Issue struct {
	ID        int       `json:"id"`
	Number    int       `json:"number"`
	Title     string    `json:"title"`
	Body      string    `json:"body"`
	State     string    `json:"state"`
	Labels    []string  `json:"labels"`
	User      string    `json:"user"`
	CreatedAt string    `json:"created_at"`
	UpdatedAt string    `json:"updated_at"`
	ClosedAt  *string   `json:"closed_at"`
	Comments  []Comment `json:"comments"`
}

// Pull is one pull request.
type Pull struct {
	ID             int     `json:"id"`
	Number         int     `json:"number"`
	Title          string  `json:"title"`
	Body           string  `json:"body"`
	State          string  `json:"state"`
	Head           string  `json:"head"`
	Base           string  `json:"base"`
	BaseSHA        string  `json:"base_sha,omitempty"`
	User           string  `json:"user"`
	CreatedAt      string  `json:"created_at"`
	UpdatedAt      string  `json:"updated_at"`
	Merged         bool    `json:"merged"`
	MergedAt       *string `json:"merged_at"`
	MergeCommitSHA *string `json:"merge_commit_sha"`
}

// RepoMeta is everything about a repository beyond its git objects.
type RepoMeta struct {
	Owner         string            `json:"owner"`
	Name          string            `json:"name"`
	Description   string            `json:"description"`
	Private       bool              `json:"private"`
	DefaultBranch string            `json:"default_branch"`
	CreatedAt     string            `json:"created_at"`
	UpdatedAt     string            `json:"updated_at"`
	Branches      map[string]string `json:"branches"`
	Tags          map[string]string `json:"tags,omitempty"`
	Labels        []Label           `json:"labels"`
	Issues        []Issue           `json:"issues"`
	Pulls         []Pull            `json:"pulls"`
	NextLabelID   int               `json:"next_label_id"`
	NextIssueID   int               `json:"next_issue_id"`
	NextPullID    int               `json:"next_pull_id"`
	NextCommentID int               `json:"next_comment_id"`
}

// Repo is one repository: its metadata, its object store and the file the metadata is written to.
type Repo struct {
	Meta  *RepoMeta
	Store *ObjectStore
	Dir   string
	// Rev counts saves, so a cached body can tell when the repository moved.
	Rev int

	mu    sync.Mutex
	packs packCache
}

// packCache keeps the last pack a fetch built, keyed by the wants and haves that asked for it: the
// same clone arrives over and over, and sending a pack already in memory costs a copy instead of
// walking the history and deflating every object again.
type packCache struct {
	mu   sync.Mutex
	key  string
	pack []byte
}

// packCacheLimit is the largest pack worth keeping: a clone of this forge's repositories is far
// smaller, and a big pack would only cost the trial its memory.
const packCacheLimit = 4 << 20

// packFor answers the pack a fetch of these wants and haves needs, from memory when this exact
// fetch already built it.
func (r *Repo) packFor(wants, haves, shallows []string) []byte {
	key := strings.Join(wants, ",") + "|" + strings.Join(haves, ",") + "|" + strings.Join(shallows, ",")

	r.packs.mu.Lock()
	if r.packs.key == key && r.packs.pack != nil {
		pack := r.packs.pack
		r.packs.mu.Unlock()
		return pack
	}
	r.packs.mu.Unlock()

	pack := WritePack(reachableObjects(r.Store, wants, haves, shallows), r.Store)
	if len(pack) <= packCacheLimit {
		r.packs.mu.Lock()
		r.packs.key = key
		r.packs.pack = pack
		r.packs.mu.Unlock()
	}
	return pack
}

// NewRepo binds a directory and its metadata.
func NewRepo(dir string, meta *RepoMeta) *Repo {
	if meta.Branches == nil {
		meta.Branches = map[string]string{}
	}
	if meta.Tags == nil {
		meta.Tags = map[string]string{}
	}
	return &Repo{Meta: meta, Store: NewObjectStore(filepath.Join(dir, "git")), Dir: dir}
}

// Save marks the metadata changed and schedules one write for the whole burst.
func (r *Repo) Save() {
	r.mu.Lock()
	r.Rev++
	r.mu.Unlock()
	dirty.add(r)
}

// WriteNow writes the metadata to its JSON file through a temporary name, so a reader never sees a
// half-written file.
func (r *Repo) WriteNow() {
	path := filepath.Join(r.Dir, "meta.json")
	data, err := json.Marshal(r.Meta)
	if err != nil {
		return
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return
	}
	_ = os.Rename(tmp, path)
}

// Tip answers the default branch's commit, or the zero id while the repository is unborn.
func (r *Repo) Tip() string {
	if oid, ok := r.Meta.Branches[r.Meta.DefaultBranch]; ok && oid != "" {
		return oid
	}
	return ZeroOID
}

// BranchTip answers one branch's commit, or false when the branch does not exist.
func (r *Repo) BranchTip(name string) (string, bool) {
	oid, ok := r.Meta.Branches[name]
	return oid, ok && oid != ""
}

// The repositories whose metadata changed but has not been written yet.
var dirty = &dirtySet{repos: map[*Repo]struct{}{}}

// dirtySet coalesces metadata writes: a burst of changes costs one write, not one each.
type dirtySet struct {
	mu    sync.Mutex
	repos map[*Repo]struct{}
	once  sync.Once
}

// add records a repository and starts the flush timer on first use.
func (d *dirtySet) add(r *Repo) {
	d.mu.Lock()
	d.repos[r] = struct{}{}
	d.mu.Unlock()
	d.once.Do(func() {
		go func() {
			for {
				time.Sleep(250 * time.Millisecond)
				d.flush()
			}
		}()
	})
}

// flush writes every repository waiting, alone: it marshals the metadata a request may be changing.
func (d *dirtySet) flush() {
	d.mu.Lock()
	waiting := make([]*Repo, 0, len(d.repos))
	for r := range d.repos {
		waiting = append(waiting, r)
	}
	d.repos = map[*Repo]struct{}{}
	d.mu.Unlock()
	if len(waiting) == 0 {
		return
	}
	serveMu.Lock()
	defer serveMu.Unlock()
	for _, r := range waiting {
		r.WriteNow()
	}
}

// Forge is every repository this process serves, keyed by "owner/name" lowercased.
type Forge struct {
	Root  string
	Token string

	mu           sync.RWMutex
	configured   string
	adoptedOwner string
	repos        map[string]*Repo
}

// NewForge binds a store root and the login this process was configured with.
func NewForge(root, token, login string) *Forge {
	_ = os.MkdirAll(root, 0o755)
	return &Forge{Root: root, Token: token, configured: login, repos: map[string]*Repo{}}
}

// Login answers the login this forge speaks as: the owner a client named, else the configured one.
func (f *Forge) Login() string {
	f.mu.RLock()
	defer f.mu.RUnlock()
	if f.adoptedOwner != "" {
		return f.adoptedOwner
	}
	return f.configured
}

// LearnOwner adopts the first owner a client names, and never another.
func (f *Forge) LearnOwner(owner string) {
	if owner == "" {
		return
	}
	f.mu.Lock()
	if f.adoptedOwner == "" {
		f.adoptedOwner = owner
	}
	f.mu.Unlock()
}

// Load reads every repository already on disk, so a restart loses nothing.
func (f *Forge) Load() {
	entries, err := os.ReadDir(f.Root)
	if err != nil {
		return
	}
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		dir := filepath.Join(f.Root, entry.Name())
		raw, err := os.ReadFile(filepath.Join(dir, "meta.json"))
		if err != nil {
			continue
		}
		meta := &RepoMeta{}
		if err := json.Unmarshal(raw, meta); err != nil {
			continue
		}
		f.mu.Lock()
		f.repos[strings.ToLower(meta.Owner+"/"+meta.Name)] = NewRepo(dir, meta)
		f.mu.Unlock()
	}
}

// Get answers one repository by owner and name, case-insensitively, adopting the owner it named.
func (f *Forge) Get(owner, name string) *Repo {
	f.mu.Lock()
	defer f.mu.Unlock()
	key := strings.ToLower(owner + "/" + name)
	if repo, ok := f.repos[key]; ok {
		if f.adoptedOwner == "" {
			f.adoptedOwner = owner
		}
		return repo
	}
	// a repository created before the token's login was known sits under the configured login: the
	// client's owner names it, so match the name alone and re-key it under the owner it named
	for oldKey, repo := range f.repos {
		if !strings.EqualFold(repo.Meta.Name, name) {
			continue
		}
		if f.adoptedOwner == "" {
			f.adoptedOwner = owner
		}
		delete(f.repos, oldKey)
		repo.Meta.Owner = owner
		repo.Save()
		f.repos[key] = repo
		return repo
	}
	return nil
}

// List answers the repositories in creation order, narrowed to one owner when it is given.
func (f *Forge) List(owner string) []*Repo {
	f.mu.RLock()
	all := make([]*Repo, 0, len(f.repos))
	for _, repo := range f.repos {
		if owner != "" && !strings.EqualFold(repo.Meta.Owner, owner) {
			continue
		}
		all = append(all, repo)
	}
	f.mu.RUnlock()
	sort.SliceStable(all, func(i, j int) bool {
		if all[i].Meta.CreatedAt != all[j].Meta.CreatedAt {
			return all[i].Meta.CreatedAt < all[j].Meta.CreatedAt
		}
		return all[i].Meta.Name < all[j].Meta.Name
	})
	return all
}

// Create makes a repository, or answers the one that already holds the name.
func (f *Forge) Create(owner, name string, description string, private bool, defaultBranch string) *Repo {
	if repo := f.Get(owner, name); repo != nil {
		return repo
	}
	if defaultBranch == "" {
		defaultBranch = "main"
	}
	now := nowISO()
	slug := slugOf(owner, name)
	dir := filepath.Join(f.Root, slug)
	_ = os.MkdirAll(filepath.Join(dir, "git"), 0o755)
	meta := &RepoMeta{
		Owner:         owner,
		Name:          name,
		Description:   description,
		Private:       private,
		DefaultBranch: defaultBranch,
		CreatedAt:     now,
		UpdatedAt:     now,
		Branches:      map[string]string{},
		Tags:          map[string]string{},
		Labels:        []Label{},
		Issues:        []Issue{},
		Pulls:         []Pull{},
		NextLabelID:   1,
		NextIssueID:   1,
		NextPullID:    1,
		NextCommentID: 1,
	}
	repo := NewRepo(dir, meta)
	repo.WriteNow()
	f.mu.Lock()
	f.repos[strings.ToLower(owner+"/"+name)] = repo
	if f.adoptedOwner == "" && owner != "" {
		f.adoptedOwner = owner
	}
	f.mu.Unlock()
	return repo
}

// Remove deletes a repository and its files, answering whether it was there.
func (f *Forge) Remove(owner, name string) bool {
	f.mu.Lock()
	key := strings.ToLower(owner + "/" + name)
	repo, ok := f.repos[key]
	if ok {
		delete(f.repos, key)
	}
	f.mu.Unlock()
	if !ok {
		return false
	}
	_ = os.RemoveAll(repo.Dir)
	return true
}

// slugOf is the directory name a repository lives under.
func slugOf(owner, name string) string {
	return strings.ToLower(owner) + "--" + strings.ToLower(name)
}

// nowISO is the timestamp the API reports, in GitHub's own form.
func nowISO() string {
	return time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
}

// Count answers how many repositories this forge holds, for the startup line the env log shows.
func (f *Forge) Count() int {
	f.mu.RLock()
	defer f.mu.RUnlock()
	return len(f.repos)
}
