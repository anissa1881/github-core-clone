package main

import (
	"bufio"
	"bytes"
	"compress/zlib"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
)

// Ref is one ref the advertisement names, with the commit a tag peels to when it has one.
type Ref struct {
	Name   string
	OID    string
	Peeled string
}

// Server is the forge behind the env's port: the store plus the token every request must carry.
type Server struct {
	Forge *Forge
}

// serveMu guards the store against itself: a read may run beside another read, but a change runs
// alone, and the background metadata write runs alone too. Go's runtime aborts the process on a map
// that is written while it is being marshalled, so the same lock covers both sides.
var serveMu sync.RWMutex

// Routes answers every path this binary serves. The git routes come first: they are what the timed
// workloads drive, and they must not pay for the routing the API routes need.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/", guard(s.route))
	return mux
}

// guard takes the shared lock for a read and the exclusive one for a change, so many fetches run at
// once while a push, a create or the metadata flush keeps the store to itself.
func guard(next func(http.ResponseWriter, *http.Request)) func(http.ResponseWriter, *http.Request) {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet || r.Method == http.MethodHead {
			serveMu.RLock()
			defer serveMu.RUnlock()
		} else {
			serveMu.Lock()
			defer serveMu.Unlock()
		}
		next(w, r)
	}
}

// route dispatches one request: the git smart HTTP paths, the API surfaces, then a 404.
func (s *Server) route(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Path

	// the env's own boot probe answers a JSON ok, as the TypeScript build does
	if path == "/healthz" {
		respondJSON(w, 200, map[string]any{"ok": true}, nil)
		return
	}

	q := newURLQuery(r)

	// git smart HTTP answers the client's own credentials, and 401 without them
	if target, ok := parseSmartPath(path); ok {
		if !s.authorized(r) {
			w.Header().Set("www-authenticate", `Basic realm="GitHub"`)
			respondJSON(w, 401, map[string]any{"message": "Requires authentication"}, nil)
			return
		}
		repo := s.Forge.Get(target.Owner, target.Repo)
		if repo == nil {
			respondJSON(w, 404, map[string]any{"message": "Not Found"}, nil)
			return
		}
		s.smart(w, r, repo, target)
		return
	}

	// GraphQL v4 requires the token, and a query without one is 401
	if path == "/api/graphql" || path == "/graphql" {
		if r.Method != "POST" {
			respondJSON(w, 405, map[string]any{"message": "Method Not Allowed"}, map[string]string{"allow": "POST"})
			return
		}
		if !s.authorized(r) {
			respondJSON(w, 401, map[string]any{"message": "Requires authentication"}, nil)
			return
		}
		s.handleGraphQL(w, r)
		return
	}

	// MCP over Streamable HTTP
	if path == "/mcp" || path == "/mcp/" {
		if r.Method != "POST" {
			respondJSON(w, 405, map[string]any{"message": "Method Not Allowed"}, map[string]string{"allow": "POST"})
			return
		}
		s.handleMcp(w, r)
		return
	}

	// REST v3, and everything under /api/v3
	if path == "/api/v3" || strings.HasPrefix(path, "/api/v3/") {
		if !s.authorized(r) {
			respondJSON(w, 401, map[string]any{"message": "Requires authentication"}, nil)
			return
		}
		if s.handleRest(w, r, q) {
			return
		}
	}

	respondJSON(w, 404, map[string]any{"message": "Not Found"}, nil)
}

// authorized reads the token as a bearer or as git's Basic credentials, in any case and spacing the
// way the TypeScript build's regex does.
func (s *Server) authorized(r *http.Request) bool {
	header := strings.TrimSpace(r.Header.Get("authorization"))
	if header == "" {
		return false
	}
	if scheme, value, ok := splitScheme(header); ok && scheme == "bearer" {
		return value == s.Forge.Token
	}
	if scheme, value, ok := splitScheme(header); ok && scheme == "basic" {
		raw, err := base64.StdEncoding.DecodeString(value)
		if err != nil {
			return false
		}
		text := string(raw)
		if colon := strings.IndexByte(text, ':'); colon >= 0 {
			text = text[colon+1:]
		}
		return text == s.Forge.Token
	}
	return false
}

// splitScheme cuts "Bearer token" into its lower-case scheme and its trimmed value.
func splitScheme(header string) (string, string, bool) {
	space := strings.IndexAny(header, " \t")
	if space <= 0 {
		return "", "", false
	}
	return strings.ToLower(header[:space]), strings.TrimSpace(header[space+1:]), true
}

// SmartTarget is one git smart HTTP request: which repository, which service and which half of it.
type SmartTarget struct {
	Owner   string
	Repo    string
	Service string
	InfoRef bool
}

// parseSmartPath reads "/<owner>/<repo>.git/<tail>", where the tail is one of the three paths a
// smart HTTP client asks for and may itself hold a slash.
func parseSmartPath(path string) (SmartTarget, bool) {
	rest := strings.TrimPrefix(path, "/")
	tail := ""
	for _, candidate := range []string{"info/refs", "git-upload-pack", "git-receive-pack"} {
		if strings.HasSuffix(rest, "/"+candidate) {
			tail = candidate
			rest = rest[:len(rest)-len(candidate)-1]
			break
		}
	}
	if tail == "" {
		return SmartTarget{}, false
	}
	slash := strings.IndexByte(rest, '/')
	if slash <= 0 {
		return SmartTarget{}, false
	}
	owner := rest[:slash]
	name := rest[slash+1:]
	if !strings.HasSuffix(name, ".git") {
		return SmartTarget{}, false
	}
	repo := strings.TrimSuffix(name, ".git")
	if tail == "info/refs" {
		return SmartTarget{Owner: owner, Repo: repo, InfoRef: true}, true
	}
	return SmartTarget{Owner: owner, Repo: repo, Service: tail}, true
}

// smart answers one git smart HTTP request.
func (s *Server) smart(w http.ResponseWriter, r *http.Request, repo *Repo, target SmartTarget) {
	if target.InfoRef {
		service := r.URL.Query().Get("service")
		if service != "git-upload-pack" && service != "git-receive-pack" {
			w.Header().Set("content-type", "text/plain; charset=utf-8")
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte("Dumb HTTP protocol is not supported. Please use smart HTTP.\n"))
			return
		}
		v2 := service == "git-upload-pack" && wantsV2(r.Header.Get("git-protocol"))
		body, contentType := infoRefs(repo, service, v2)
		w.Header().Set("content-type", contentType)
		w.Header().Set("cache-control", "no-cache")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(body)
		return
	}

	if target.Service == "git-upload-pack" {
		body, _ := io.ReadAll(r.Body)
		answer := uploadPack(repo, body)
		w.Header().Set("content-type", "application/x-git-upload-pack-result")
		w.Header().Set("cache-control", "no-cache")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(answer)
		return
	}

	body, _ := io.ReadAll(r.Body)
	answer := receivePack(repo, body)
	w.Header().Set("content-type", "application/x-git-receive-pack-result")
	w.Header().Set("cache-control", "no-cache")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(answer)
}

// wantsV2 answers whether the client asked for protocol v2.
func wantsV2(header string) bool {
	for _, part := range strings.Split(header, ":") {
		if strings.TrimSpace(part) == "version=2" {
			return true
		}
	}
	return strings.Contains(strings.ToLower(header), "version=2")
}

// advRefs answers the refs this repository advertises: every branch, then every tag with the commit
// it peels to.
func advRefs(repo *Repo) []Ref {
	refs := make([]Ref, 0, len(repo.Meta.Branches)+len(repo.Meta.Tags))
	names := make([]string, 0, len(repo.Meta.Branches))
	for name := range repo.Meta.Branches {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		if oid := repo.Meta.Branches[name]; oid != "" && oid != ZeroOID {
			refs = append(refs, Ref{Name: "refs/heads/" + name, OID: oid})
		}
	}
	tagNames := make([]string, 0, len(repo.Meta.Tags))
	for name := range repo.Meta.Tags {
		tagNames = append(tagNames, name)
	}
	sort.Strings(tagNames)
	for _, name := range tagNames {
		oid := repo.Meta.Tags[name]
		if oid == "" || oid == ZeroOID {
			continue
		}
		peeled, ok := peelToCommit(repo.Store, oid)
		if ok && peeled != oid {
			refs = append(refs, Ref{Name: "refs/tags/" + name, OID: oid, Peeled: peeled})
			continue
		}
		refs = append(refs, Ref{Name: "refs/tags/" + name, OID: oid})
	}
	return refs
}

// peelToCommit follows a tag chain to its commit.
func peelToCommit(store *ObjectStore, oid string) (string, bool) {
	current := oid
	for depth := 0; depth < 8; depth++ {
		o, ok := store.Get(current)
		if !ok {
			return "", false
		}
		switch o.Type {
		case objCommit:
			return current, true
		case objTag:
			// a tag object names its target on its first "object" line
			text := string(o.Data)
			if !strings.HasPrefix(text, "object ") {
				return "", false
			}
			line := text[len("object "):]
			if nl := strings.IndexByte(line, '\n'); nl >= 0 {
				line = line[:nl]
			}
			current = strings.TrimSpace(line)
		default:
			return "", false
		}
	}
	return "", false
}

// uploadCaps are the capabilities this upload-pack advertises in protocol v0.
const uploadCaps = "multi_ack multi_ack_detailed side-band side-band-64k ofs-delta shallow deepen-since deepen-not deepen-relative no-progress include-tag thin-pack agent=git/2.43.0 symref=HEAD:%s object-format=sha1 allow-tip-sha1-in-want allow-reachable-sha1-in-want"

// receiveCaps are the capabilities receive-pack advertises: a push needs report-status, delete-refs
// and side-band-64k to frame its answer.
const receiveCaps = "report-status report-status-v2 delete-refs side-band-64k quiet ofs-delta agent=git/2.43.0 object-format=sha1"

// infoRefs answers the advertisement for one service: the v0 form with the capability list on its
// first ref, or the v2 form whose capabilities come before any ref.
func infoRefs(repo *Repo, service string, v2 bool) ([]byte, string) {
	refs := advRefs(repo)
	out := make([]byte, 0, 1024)
	out = AppendPktString(out, "# service="+service+"\n")
	out = AppendFlush(out)

	if v2 {
		out = AppendPktString(out, "version 2\n")
		out = AppendPktString(out, "agent=git/2.43.0\n")
		out = AppendPktString(out, "ls-refs=unborn\n")
		out = AppendPktString(out, "fetch=shallow wait-for-done\n")
		out = AppendPktString(out, "server-option\n")
		out = AppendPktString(out, "object-format=sha1\n")
		out = AppendFlush(out)
		return out, "application/x-git-upload-pack-advertisement"
	}

	if service == "git-receive-pack" {
		// a push advertisement always names at least one line: an unborn repository advertises the
		// zero id with the capability list, which is what git expects to read a push against
		if len(refs) == 0 {
			out = AppendPktString(out, ZeroOID+" capabilities^{}\x00"+receiveCaps+"\n")
			out = AppendFlush(out)
			return out, "application/x-git-receive-pack-advertisement"
		}
		for i, ref := range refs {
			if i == 0 {
				out = AppendPktString(out, ref.OID+" "+ref.Name+"\x00"+receiveCaps+"\n")
				continue
			}
			out = AppendPktString(out, ref.OID+" "+ref.Name+"\n")
		}
		out = AppendFlush(out)
		return out, "application/x-git-receive-pack-advertisement"
	}

	head := repo.Tip()
	caps := fmt.Sprintf(uploadCaps, "refs/heads/"+repo.Meta.DefaultBranch)
	if head == ZeroOID || len(refs) == 0 {
		// an unborn repository advertises the zero id and the capability line alone
		out = AppendPktString(out, ZeroOID+" capabilities^{}\x00"+caps+"\n")
		out = AppendFlush(out)
		return out, "application/x-git-upload-pack-advertisement"
	}
	// the first line names the default branch and carries the capabilities; HEAD follows when it is
	// not one of the branches the advertisement already named
	first := true
	if branchTip, ok := repo.BranchTip(repo.Meta.DefaultBranch); ok {
		out = AppendPktString(out, branchTip+" refs/heads/"+repo.Meta.DefaultBranch+"\x00"+caps+"\n")
		first = false
	}
	for _, ref := range refs {
		if ref.Name == "refs/heads/"+repo.Meta.DefaultBranch && !first {
			continue
		}
		line := ref.OID + " " + ref.Name
		if first {
			line += "\x00" + caps
			first = false
		}
		out = AppendPktString(out, line+"\n")
		if ref.Peeled != "" {
			out = AppendPktString(out, ref.Peeled+" "+ref.Name+"^{}\n")
		}
	}
	out = AppendFlush(out)
	return out, "application/x-git-upload-pack-advertisement"
}

// uploadPack answers a fetch: the v2 command protocol when the body starts with it, else v0's
// want/have negotiation with one pack at the end.
func uploadPack(repo *Repo, body []byte) []byte {
	packets, _, _ := DecodePackets(body)
	lines := DataLines(packets)
	if len(lines) > 0 && strings.HasPrefix(lines[0], "command=") {
		return uploadPackV2(repo, lines)
	}
	return uploadPackV0(repo, lines)
}

// uploadPackV2 answers the ls-refs and fetch commands of protocol v2.
func uploadPackV2(repo *Repo, lines []string) []byte {
	command := ""
	args := make([]string, 0, 4)
	for _, line := range lines {
		if strings.HasPrefix(line, "command=") {
			command = strings.TrimPrefix(line, "command=")
			continue
		}
		args = append(args, line)
	}
	out := make([]byte, 0, 4096)
	switch command {
	case "ls-refs":
		wantSymrefs, wantPeel, wantUnborn := false, false, false
		for _, arg := range args {
			switch arg {
			case "symrefs":
				wantSymrefs = true
			case "peel":
				wantPeel = true
			case "unborn":
				wantUnborn = true
			}
		}
		head := repo.Tip()
		if head == ZeroOID {
			// an unborn repository answers HEAD alone, naming the branch it would create
			if wantUnborn {
				out = AppendPktString(out, "unborn HEAD symref-target:refs/heads/"+repo.Meta.DefaultBranch+"\n")
			}
			out = AppendFlush(out)
			return out
		}
		if wantSymrefs {
			out = AppendPktString(out, head+" HEAD symref-target:refs/heads/"+repo.Meta.DefaultBranch+"\n")
		} else {
			out = AppendPktString(out, head+" HEAD\n")
		}
		for _, ref := range advRefs(repo) {
			out = AppendPktString(out, ref.OID+" "+ref.Name+"\n")
			if ref.Peeled != "" && wantPeel {
				out = AppendPktString(out, ref.Peeled+" "+ref.Name+"^{}\n")
			}
		}
		out = AppendFlush(out)
		return out
	case "fetch":
		wants, haves, shallows := parseFetchArgs(args)
		out = AppendPktString(out, "packfile\n")
		for _, name := range shallows {
			out = AppendPktString(out, "shallow "+name+"\n")
		}
		pack := repo.packFor(wants, haves, shallows)
		out = appendPacketSideband(out, pack)
		out = AppendFlush(out)
		return out
	default:
		out = AppendFlush(out)
		return out
	}
}

// parseFetchArgs reads the wants, haves and shallow lines a fetch carries.
func parseFetchArgs(args []string) (wants, haves, shallows []string) {
	for _, line := range args {
		switch {
		case strings.HasPrefix(line, "want "):
			field := strings.Fields(line)
			if len(field) >= 2 {
				wants = append(wants, field[1])
			}
		case strings.HasPrefix(line, "have "):
			field := strings.Fields(line)
			if len(field) >= 2 {
				haves = append(haves, field[1])
			}
		case strings.HasPrefix(line, "shallow "):
			field := strings.Fields(line)
			if len(field) >= 2 {
				shallows = append(shallows, field[1])
			}
		}
	}
	return wants, haves, shallows
}

// uploadPackV0 answers the v0 negotiation: every want, every have, then one pack framed through
// side-band-64k.
func uploadPackV0(repo *Repo, lines []string) []byte {
	wants, haves, shallows := parseFetchArgs(lines)
	if len(wants) == 0 {
		refs := advRefs(repo)
		out := make([]byte, 0, 256)
		for _, ref := range refs {
			out = AppendPktString(out, ref.OID+" "+ref.Name+"\n")
		}
		out = AppendFlush(out)
		return out
	}
	out := make([]byte, 0, 8192)
	pack := repo.packFor(wants, haves, shallows)
	out = appendPacketSideband(out, pack)
	out = AppendFlush(out)
	return out
}

// appendPacketSideband frames a pack in side-band 1 packets, as both protocol versions do when the
// client asked for side-band-64k.
func appendPacketSideband(out []byte, pack []byte) []byte {
	const chunk = 32 * 1024
	for len(pack) > 0 {
		n := len(pack)
		if n > chunk {
			n = chunk
		}
		frame := make([]byte, 1, n+1)
		frame[0] = 1
		frame = append(frame, pack[:n]...)
		out = AppendPkt(out, frame)
		pack = pack[n:]
	}
	return out
}

// reachableObjects answers every object a fetch must send: the closure of the wants minus the
// closure of the haves, in an order that puts a commit before its tree and the tree before its blobs.
func reachableObjects(store *ObjectStore, wants, haves, shallows []string) []string {
	haveSet := map[string]struct{}{}
	stack := append([]string{}, haves...)
	for len(stack) > 0 {
		oid := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		if _, done := haveSet[oid]; done {
			continue
		}
		o, ok := store.Get(oid)
		if !ok {
			continue
		}
		haveSet[oid] = struct{}{}
		switch o.Type {
		case objCommit:
			c := ParseCommit(oid, o.Data)
			stack = append(stack, c.Tree)
			stack = append(stack, c.Parents...)
			if isShallow(shallows, oid) {
				continue
			}
		case objTree:
			for _, e := range ParseTree(o.Data) {
				stack = append(stack, e.OID)
			}
		case objTag:
			if target, ok := tagTarget(o); ok {
				stack = append(stack, target)
			}
		}
	}

	wanted := map[string]struct{}{}
	order := make([]string, 0, 256)
	queue := append([]string{}, wants...)
	for len(queue) > 0 {
		oid := queue[0]
		queue = queue[1:]
		if _, done := wanted[oid]; done {
			continue
		}
		if _, have := haveSet[oid]; have {
			continue
		}
		o, ok := store.Get(oid)
		if !ok {
			continue
		}
		wanted[oid] = struct{}{}
		order = append(order, oid)
		switch o.Type {
		case objCommit:
			c := ParseCommit(oid, o.Data)
			if !isShallow(shallows, oid) {
				queue = append(queue, c.Parents...)
			}
			queue = append(queue, c.Tree)
		case objTree:
			for _, e := range ParseTree(o.Data) {
				queue = append(queue, e.OID)
			}
		case objTag:
			if target, ok := tagTarget(o); ok {
				queue = append(queue, target)
			}
		}
	}
	return order
}

// tagTarget answers the object a tag object names.
func tagTarget(o Obj) (string, bool) {
	text := string(o.Data)
	if !strings.HasPrefix(text, "object ") {
		return "", false
	}
	line := text[len("object "):]
	if nl := strings.IndexByte(line, '\n'); nl >= 0 {
		line = line[:nl]
	}
	return strings.TrimSpace(line), true
}

// isShallow answers whether a commit is one the client asked to be cut at.
func isShallow(shallows []string, oid string) bool {
	for _, s := range shallows {
		if s == oid {
			return true
		}
	}
	return false
}

// receivePack applies a push: every command's pack is unpacked, the refs advance when they
// fast-forward, and the report-status says what happened to each.
func receivePack(repo *Repo, body []byte) []byte {
	packets, used, _ := DecodePackets(body)
	type command struct {
		oldOID string
		newOID string
		ref    string
	}
	commands := make([]command, 0, 2)
	caps := ""
	for _, p := range packets {
		if p.Kind == kindFlush {
			break
		}
		if p.Kind != kindData {
			continue
		}
		line := string(bytes.TrimSuffix(p.Data, []byte("\n")))
		if strings.HasPrefix(line, "shallow ") || strings.HasPrefix(line, "unshallow ") || line == "" {
			continue
		}
		if idx := strings.IndexByte(line, 0); idx >= 0 {
			// the first command line carries the capabilities the client chose
			caps = line[idx+1:]
			line = line[:idx]
		}
		fields := strings.Fields(line)
		if len(fields) < 3 {
			continue
		}
		commands = append(commands, command{oldOID: fields[0], newOID: fields[1], ref: fields[2]})
	}
	pack := body[used:]
	if len(pack) > 16 {
		fmt.Fprintf(os.Stderr, "[push] used=%d body=%d pack=%d head=%q\n", used, len(body), len(pack), string(pack[:4]))
	}
	if len(pack) > 16 {
	}
	if len(commands) == 0 {
		return reportStatus(nil, caps)
	}

	objects := map[string]Obj{}
	if len(pack) > 20 && string(pack[:4]) == "PACK" {
		read, err := ReadPack(pack, func(oid string) (Obj, bool) { return repo.Store.Get(oid) })
		if err != nil {
			fmt.Fprintln(os.Stderr, "[push] unpack:", err)
			return reportStatusFatal("unpack-failed", caps)
		}
		objects = read
	}
	// store every object in full, refusing nothing: a push that names a commit it did not send is
	// the fast-forward check's business, not the unpacker's
	for oid, o := range objects {
		repo.Store.Put(oid, o)
	}

	type result struct {
		ref string
		ok  bool
		why string
	}
	results := make([]result, 0, len(commands))
	changed := false
	for _, cmd := range commands {
		branch := strings.TrimPrefix(cmd.ref, "refs/heads/")
		tagName := strings.TrimPrefix(cmd.ref, "refs/tags/")
		switch {
		case strings.HasPrefix(cmd.ref, "refs/heads/"):
			current, exists := repo.Meta.Branches[branch]
			if cmd.newOID == ZeroOID {
				// a delete is refused for the default branch, which git also protects
				if branch == repo.Meta.DefaultBranch {
					results = append(results, result{ref: cmd.ref, why: "protected branch"})
					continue
				}
				delete(repo.Meta.Branches, branch)
				changed = true
				results = append(results, result{ref: cmd.ref, ok: true})
				continue
			}
			if exists && current != ZeroOID && !IsAncestor(repo.Store, current, cmd.newOID) {
				results = append(results, result{ref: cmd.ref, why: "non-fast-forward"})
				continue
			}
			if !repo.Store.Has(cmd.newOID) {
				results = append(results, result{ref: cmd.ref, why: "missing object"})
				continue
			}
			if exists && current == cmd.newOID {
				results = append(results, result{ref: cmd.ref, ok: true, why: "up-to-date"})
				continue
			}
			repo.Meta.Branches[branch] = cmd.newOID
			changed = true
			results = append(results, result{ref: cmd.ref, ok: true})
		case strings.HasPrefix(cmd.ref, "refs/tags/"):
			repo.Meta.Tags[tagName] = cmd.newOID
			changed = true
			results = append(results, result{ref: cmd.ref, ok: true})
		default:
			results = append(results, result{ref: cmd.ref, why: "unsupported ref"})
		}
	}
	if changed {
		repo.Meta.UpdatedAt = nowISO()
		repo.Save()
	}

	lines := []string{"unpack ok\n"}
	for _, r := range results {
		if r.ok {
			line := "ok " + r.ref
			if r.why != "" {
				line += " " + r.why
			}
			lines = append(lines, line+"\n")
			continue
		}
		lines = append(lines, "ng "+r.ref+" "+r.why+"\n")
	}
	return pushStatus(lines, caps)
}

// pushStatus frames a report-status the way the client asked for it. A client that chose
// side-band-64k reads band 1 frames; one that did not reads bare pkt-lines, and handing it band
// framing makes it complain about a bad band.
func pushStatus(lines []string, caps string) []byte {
	out := make([]byte, 0, 256)
	if !strings.Contains(caps, "side-band-64k") {
		for _, line := range lines {
			out = AppendPktString(out, line)
		}
		return AppendFlush(out)
	}
	for _, line := range lines {
		frame := make([]byte, 0, len(line)+1)
		frame = append(frame, 1)
		frame = append(frame, []byte(line)...)
		out = AppendPkt(out, frame)
	}
	return AppendFlush(out)
}

// reportStatus answers a push that carried no command: the unpack succeeded and nothing moved.
func reportStatus(_ []string, caps string) []byte {
	return pushStatus([]string{"unpack ok\n"}, caps)
}

// reportStatusFatal answers a push whose pack did not unpack.
func reportStatusFatal(why, caps string) []byte {
	return pushStatus([]string{"unpack " + why + "\n"}, caps)
}

// readAllLines answers the request body's lines, for the routes that parse text rather than packets.
func readAllLines(r *http.Request) []string {
	br := bufio.NewReader(r.Body)
	lines := make([]string, 0, 8)
	for {
		line, err := br.ReadString('\n')
		if line != "" {
			lines = append(lines, strings.TrimSuffix(line, "\n"))
		}
		if err != nil {
			return lines
		}
	}
}

// jsonAnswer writes one JSON body with its length, as every API route does.
func jsonAnswer(w http.ResponseWriter, status int, body any, extra map[string]string) {
	data, err := json.Marshal(body)
	if err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		return
	}
	data = append(data, '\n')
	w.Header().Set("content-type", "application/json; charset=utf-8")
	w.Header().Set("content-length", strconv.Itoa(len(data)))
	for name, value := range extra {
		w.Header().Set(name, value)
	}
	w.WriteHeader(status)
	_, _ = w.Write(data)
}

// inflateAll answers the plain bytes of one zlib stream, for the routes that read a compressed body.
func inflateAll(raw []byte) ([]byte, error) {
	r, err := zlib.NewReader(bytes.NewReader(raw))
	if err != nil {
		return nil, err
	}
	defer r.Close()
	return io.ReadAll(r)
}
