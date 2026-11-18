// The native forge: the same entry the TypeScript files describe, compiled to one static binary.
// The suite drives it over the env's port, so everything here answers the wire formats git and the
// REST API define, from the same on-disk store the TypeScript build uses: <root>/<owner>--<name>/
// with meta.json beside a git/ directory of loose objects.
package main

import (
	"bytes"
)

// The pkt-line framing git speaks: a four-byte hex length covering the header and the payload.
const (
	pktFlush    = 0
	pktDelim    = 1
	pktRespEnd  = 2
	pktMaxLen   = 65520
	pktMaxData  = pktMaxLen - 4
	flushLine   = "0000"
	delimLine   = "0001"
	responseEnd = "0002"
)

// AppendPkt frames one payload: its four-byte length, then the bytes themselves.
func AppendPkt(dst []byte, payload []byte) []byte {
	n := len(payload) + 4
	const hexDigits = "0123456789abcdef"
	dst = append(dst,
		hexDigits[(n>>12)&0xf],
		hexDigits[(n>>8)&0xf],
		hexDigits[(n>>4)&0xf],
		hexDigits[n&0xf],
	)
	return append(dst, payload...)
}

// AppendPktString frames one textual payload.
func AppendPktString(dst []byte, payload string) []byte {
	return AppendPkt(dst, []byte(payload))
}

// AppendFlush ends a packet list, as git's side-band and the ref advertisement do.
func AppendFlush(dst []byte) []byte {
	return append(dst, flushLine...)
}

// AppendDelim separates the sections of a protocol v2 answer.
func AppendDelim(dst []byte) []byte {
	return append(dst, delimLine...)
}

// Packet kinds a decoder answers.
const (
	kindData = iota
	kindFlush
	kindDelim
	kindRespEnd
	kindInvalid
)

// Packet is one decoded frame: its kind and, for a data frame, its payload.
type Packet struct {
	Kind int
	Data []byte
}

// DecodePackets reads the frames at the start of buf. used is how many bytes they took, and
// incomplete says whether the buffer simply ran out in the middle of a frame (a caller reading a
// stream keeps the rest and tries again) rather than holding something that is not a pkt-line.
func DecodePackets(buf []byte) (packets []Packet, used int, incomplete bool) {
	off := 0
	for off+4 <= len(buf) {
		header := buf[off : off+4]
		var n int
		for _, c := range header {
			var digit int
			switch {
			case c >= '0' && c <= '9':
				digit = int(c - '0')
			case c >= 'a' && c <= 'f':
				digit = int(c-'a') + 10
			case c >= 'A' && c <= 'F':
				digit = int(c-'A') + 10
			default:
				return packets, off, false
			}
			n = n<<4 | digit
		}
		switch {
		case n == pktFlush:
			packets = append(packets, Packet{Kind: kindFlush})
			off += 4
		case n == pktDelim:
			packets = append(packets, Packet{Kind: kindDelim})
			off += 4
		case n == pktRespEnd:
			packets = append(packets, Packet{Kind: kindRespEnd})
			off += 4
		case n < 4:
			return packets, off, false
		case off+n > len(buf):
			return packets, off, true
		default:
			payload := make([]byte, n-4)
			copy(payload, buf[off+4:off+n])
			packets = append(packets, Packet{Kind: kindData, Data: payload})
			off += n
		}
	}
	return packets, off, off < len(buf)
}

// DataLines answers the data payloads as text lines, dropping the special frames and the newline
// each line ends with, which is how git's advertisement is read.
func DataLines(packets []Packet) []string {
	out := make([]string, 0, len(packets))
	for _, p := range packets {
		if p.Kind != kindData {
			continue
		}
		out = append(out, string(bytes.TrimSuffix(p.Data, []byte("\n"))))
	}
	return out
}
