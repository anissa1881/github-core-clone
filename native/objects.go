package main

import (
	"bytes"
	"compress/zlib"
	"crypto/sha1"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
)

// The object types a git object's header names, by number as the pack format writes them.
const (
	objCommit = 1
	objTree   = 2
	objBlob   = 3
	objTag    = 4
	objOfs    = 6
	objRef    = 7
)

// ZeroOID is the all-zero id a ref names when it points at nothing.
var ZeroOID = strings.Repeat("0", 40)

// Obj is one git object: its type number and its bytes.
type Obj struct {
	Type int
	Data []byte
}

// TypeName answers the word a loose object's header and a pack's type use.
func TypeName(t int) string {
	switch t {
	case objCommit:
		return "commit"
	case objTree:
		return "tree"
	case objBlob:
		return "blob"
	case objTag:
		return "tag"
	}
	return ""
}

// TypeNumber answers the number a name stands for, or 0 when the name is not a type.
func TypeNumber(name string) int {
	switch name {
	case "commit":
		return objCommit
	case "tree":
		return objTree
	case "blob":
		return objBlob
	case "tag":
		return objTag
	}
	return 0
}

// HashObject answers the id of an object git would store: the sha1 of "<type> <len>\x00<data>".
func HashObject(t int, data []byte) string {
	h := sha1.New()
	fmt.Fprintf(h, "%s %d", TypeName(t), len(data))
	h.Write([]byte{0})
	h.Write(data)
	return hex.EncodeToString(h.Sum(nil))
}

// ReadObject answers the type and bytes of an object whose id is known, as a loose object stores it.
func ReadObject(dir, oid string) (Obj, bool) {
	path := filepath.Join(dir, "objects", oid[:2], oid[2:])
	raw, err := os.ReadFile(path)
	if err != nil {
		return Obj{}, false
	}
	r, err := zlib.NewReader(bytes.NewReader(raw))
	if err != nil {
		return Obj{}, false
	}
	defer r.Close()
	plain, err := io.ReadAll(r)
	if err != nil {
		return Obj{}, false
	}
	nul := bytes.IndexByte(plain, 0)
	if nul < 0 {
		return Obj{}, false
	}
	header := string(plain[:nul])
	space := strings.IndexByte(header, ' ')
	if space < 0 {
		return Obj{}, false
	}
	t := TypeNumber(header[:space])
	if t == 0 {
		return Obj{}, false
	}
	return Obj{Type: t, Data: plain[nul+1:]}, true
}

// ObjectStore is the loose-object directory of one repository, with the objects this process has
// already written kept in memory so a repeated write costs no syscall.
type ObjectStore struct {
	dir     string
	mu      sync.RWMutex
	mem     map[string]Obj
	written map[string]struct{}
	ensured map[string]struct{}
}

// NewObjectStore binds the git directory of one repository.
func NewObjectStore(gitDir string) *ObjectStore {
	return &ObjectStore{
		dir:     gitDir,
		mem:     map[string]Obj{},
		written: map[string]struct{}{},
		ensured: map[string]struct{}{},
	}
}

// Has answers whether the object is there, from memory first and then from disk.
func (s *ObjectStore) Has(oid string) bool {
	s.mu.RLock()
	if _, ok := s.mem[oid]; ok {
		s.mu.RUnlock()
		return true
	}
	s.mu.RUnlock()
	_, ok := ReadObject(s.dir, oid)
	return ok
}

// Get answers one object, caching what it reads.
func (s *ObjectStore) Get(oid string) (Obj, bool) {
	s.mu.RLock()
	if o, ok := s.mem[oid]; ok {
		s.mu.RUnlock()
		return o, true
	}
	s.mu.RUnlock()
	o, ok := ReadObject(s.dir, oid)
	if !ok {
		return Obj{}, false
	}
	s.mu.Lock()
	s.mem[oid] = o
	s.mu.Unlock()
	return o, true
}

// Put stores an object it was handed, so a pack that already inflated it costs no second hash.
func (s *ObjectStore) Put(oid string, o Obj) {
	s.mu.Lock()
	s.mem[oid] = o
	s.mu.Unlock()
	s.Write(oid, o)
}

// Write stores one object and answers its id.
func (s *ObjectStore) Write(oid string, o Obj) string {
	s.mu.RLock()
	_, known := s.written[oid]
	s.mu.RUnlock()
	if known {
		return oid
	}
	sub := oid[:2]
	dir := filepath.Join(s.dir, "objects", sub)
	s.mu.RLock()
	_, ready := s.ensured[dir]
	s.mu.RUnlock()
	if !ready {
		_ = os.MkdirAll(dir, 0o755)
		s.mu.Lock()
		s.ensured[dir] = struct{}{}
		s.mu.Unlock()
	}
	var buf bytes.Buffer
	zw, _ := zlib.NewWriterLevel(&buf, zlib.BestSpeed)
	fmt.Fprintf(zw, "%s %d", TypeName(o.Type), len(o.Data))
	zw.Write([]byte{0})
	zw.Write(o.Data)
	_ = zw.Close()
	path := filepath.Join(dir, oid[2:])
	if err := os.WriteFile(path, buf.Bytes(), 0o644); err != nil {
		return oid
	}
	s.mu.Lock()
	s.written[oid] = struct{}{}
	s.mem[oid] = o
	s.mu.Unlock()
	return oid
}

// ApplyDelta rebuilds an object from its base and the delta the pack carries: a source size, a
// target size, then copy and insert instructions.
func ApplyDelta(base, delta []byte) ([]byte, error) {
	pos := 0
	readSize := func() (int, error) {
		value, shift := 0, uint(0)
		for {
			if pos >= len(delta) {
				return 0, errors.New("delta ended inside a size")
			}
			c := delta[pos]
			pos++
			value |= int(c&0x7f) << shift
			shift += 7
			if c&0x80 == 0 {
				return value, nil
			}
		}
	}
	sourceSize, err := readSize()
	if err != nil {
		return nil, err
	}
	if sourceSize != len(base) {
		return nil, fmt.Errorf("delta base is %d bytes, the delta says %d", len(base), sourceSize)
	}
	targetSize, err := readSize()
	if err != nil {
		return nil, err
	}
	out := make([]byte, 0, targetSize)
	for pos < len(delta) {
		op := delta[pos]
		pos++
		if op&0x80 != 0 {
			var offset, size int
			for bit := 0; bit < 4; bit++ {
				if op&(1<<bit) != 0 {
					if pos >= len(delta) {
						return nil, errors.New("delta ended inside a copy offset")
					}
					offset |= int(delta[pos]) << (8 * bit)
					pos++
				}
			}
			for bit := 0; bit < 3; bit++ {
				if op&(0x10<<bit) != 0 {
					if pos >= len(delta) {
						return nil, errors.New("delta ended inside a copy size")
					}
					size |= int(delta[pos]) << (8 * bit)
					pos++
				}
			}
			if size == 0 {
				size = 0x10000
			}
			if offset+size > len(base) {
				return nil, errors.New("delta copies past the end of its base")
			}
			out = append(out, base[offset:offset+size]...)
			continue
		}
		if op == 0 {
			return nil, errors.New("delta holds a zero opcode")
		}
		size := int(op)
		if pos+size > len(delta) {
			return nil, errors.New("delta ended inside an insert")
		}
		out = append(out, delta[pos:pos+size]...)
		pos += size
	}
	if len(out) != targetSize {
		return nil, fmt.Errorf("delta built %d bytes, it promised %d", len(out), targetSize)
	}
	return out, nil
}

// InflateOne reads one zlib stream starting at start, answering its bytes and where the next stream
// begins, which is how a pack's entries follow each other.
func InflateOne(buf []byte, start int) (data []byte, next int, err error) {
	counter := &countingReader{r: bytes.NewReader(buf[start:])}
	r, err := zlib.NewReader(counter)
	if err != nil {
		return nil, start, err
	}
	data, err = io.ReadAll(r)
	_ = r.Close()
	next = start + counter.n
	if err != nil {
		return data, next, err
	}
	return data, next, nil
}

// countingReader records how many bytes a zlib reader consumed from its source. It answers ReadByte
// so the decompressor reads exactly its stream instead of buffering a whole window past the end,
// which would make the next entry's offset wrong.
type countingReader struct {
	r io.Reader
	n int
	br io.ByteReader
}

func (c *countingReader) Read(p []byte) (int, error) {
	n, err := c.r.Read(p)
	c.n += n
	return n, err
}

func (c *countingReader) ReadByte() (byte, error) {
	if c.br == nil {
		br, ok := c.r.(io.ByteReader)
		if !ok {
			return 0, io.ErrUnexpectedEOF
		}
		c.br = br
	}
	b, err := c.br.ReadByte()
	if err != nil {
		return 0, err
	}
	c.n++
	return b, nil
}

// ReadPack answers every object a pack holds, keyed by its id. Objects the pack builds from a base
// outside itself are read through external when it is not nil.
func ReadPack(pack []byte, external func(string) (Obj, bool)) (map[string]Obj, error) {
	if len(pack) < 12 || string(pack[:4]) != "PACK" {
		return nil, errors.New("not a pack")
	}
	version := int(pack[4])<<24 | int(pack[5])<<16 | int(pack[6])<<8 | int(pack[7])
	if version != 2 && version != 3 {
		return nil, fmt.Errorf("unsupported pack version %d", version)
	}
	count := int(pack[8])<<24 | int(pack[9])<<16 | int(pack[10])<<8 | int(pack[11])
	out := make(map[string]Obj, count)
	byOffset := make(map[int]Obj, count)
	byID := make(map[string]Obj, count)
	pos := 12
	for i := 0; i < count; i++ {
		start := pos
		if pos >= len(pack) {
			return nil, errors.New("pack ended before its object count")
		}
		c := pack[pos]
		pos++
		t := int(c>>4) & 0x7
		size := int(c & 0x0f)
		shift := uint(4)
		for c&0x80 != 0 {
			if pos >= len(pack) {
				return nil, errors.New("pack ended inside an object header")
			}
			c = pack[pos]
			pos++
			size |= int(c&0x7f) << shift
			shift += 7
		}
		baseOffset := 0
		baseID := ""
		switch t {
		case objOfs:
			if pos >= len(pack) {
				return nil, errors.New("pack ended inside an offset delta")
			}
			c = pack[pos]
			pos++
			value := int(c & 0x7f)
			for c&0x80 != 0 {
				if pos >= len(pack) {
					return nil, errors.New("pack ended inside an offset delta")
				}
				c = pack[pos]
				pos++
				value = ((value + 1) << 7) | int(c&0x7f)
			}
			baseOffset = start - value
		case objRef:
			if pos+20 > len(pack) {
				return nil, errors.New("pack ended inside a ref delta")
			}
			baseID = hex.EncodeToString(pack[pos : pos+20])
			pos += 20
		}
		plain, nextPos, err := InflateOne(pack, pos)
		if err != nil {
			return nil, err
		}
		pos = nextPos
		var resolved Obj
		switch t {
		case objOfs, objRef:
			var base Obj
			var ok bool
			if t == objOfs {
				base, ok = byOffset[baseOffset]
			} else {
				base, ok = byID[baseID]
				if !ok && external != nil {
					base, ok = external(baseID)
				}
			}
			if !ok {
				return nil, fmt.Errorf("delta base %d/%s is not in the pack", baseOffset, baseID)
			}
			data, err := ApplyDelta(base.Data, plain)
			if err != nil {
				return nil, err
			}
			resolved = Obj{Type: base.Type, Data: data}
		default:
			if len(plain) != size {
				return nil, fmt.Errorf("pack entry says %d bytes, holds %d", size, len(plain))
			}
			resolved = Obj{Type: t, Data: plain}
		}
		oid := HashObject(resolved.Type, resolved.Data)
		out[oid] = resolved
		byID[oid] = resolved
		byOffset[start] = resolved
	}
	return out, nil
}

// WritePack builds a pack holding the objects named, in the order given. Every object is written in
// full: the pack is small and a reader that has to resolve deltas against its own store would cost
// more than the bytes saved.
func WritePack(oids []string, store *ObjectStore) []byte {
	var body bytes.Buffer
	body.WriteString("PACK")
	header := []byte{0, 0, 0, 2, 0, 0, 0, 0}
	count := len(oids)
	header[4] = byte(count >> 24)
	header[5] = byte(count >> 16)
	header[6] = byte(count >> 8)
	header[7] = byte(count)
	body.Write(header)
	for _, oid := range oids {
		o, ok := store.Get(oid)
		if !ok {
			continue
		}
		// the type and the size share a header, little endian in seven-bit groups
		size := len(o.Data)
		first := byte(o.Type<<4) | byte(size&0x0f)
		size >>= 4
		if size > 0 {
			first |= 0x80
		}
		body.WriteByte(first)
		for size > 0 {
			c := byte(size & 0x7f)
			size >>= 7
			if size > 0 {
				c |= 0x80
			}
			body.WriteByte(c)
		}
		var zbuf bytes.Buffer
		zw, _ := zlib.NewWriterLevel(&zbuf, zlib.BestSpeed)
		_, _ = zw.Write(o.Data)
		_ = zw.Close()
		body.Write(zbuf.Bytes())
	}
	sum := sha1.Sum(body.Bytes())
	return append(body.Bytes(), sum[:]...)
}

// sortedOIDs answers the ids in a stable order, so a pack built twice from the same set is the same
// bytes and a client's cache stays useful.
func sortedOIDs(set map[string]struct{}) []string {
	out := make([]string, 0, len(set))
	for oid := range set {
		out = append(out, oid)
	}
	sort.Strings(out)
	return out
}

// parseInt answers a decimal number, or 0 when the text is not one.
func parseInt(s string) int {
	n, err := strconv.Atoi(strings.TrimSpace(s))
	if err != nil {
		return 0
	}
	return n
}