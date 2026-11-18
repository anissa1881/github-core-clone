package main

// The small HTTP helpers every API route shares: a JSON reply that carries GitHub's request-id
// header, a body reader that rejects malformed JSON with 400, and the id helpers the API reports.

import (
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync/atomic"
	"time"
)

// requestSeq counts requests, so two answers made in the same millisecond still differ.
var requestSeq uint64

// requestID answers a short unique id: the header GitHub's clients expect on every reply.
func requestID() string {
	seq := atomic.AddUint64(&requestSeq, 1)
	return strings.ToUpper(strconv.FormatInt(time.Now().UnixMilli(), 36)) + ":" + strings.ToUpper(strconv.FormatUint(seq, 36))
}

// respondJSON sends one JSON reply with the request-id header and any extra headers.
func respondJSON(w http.ResponseWriter, status int, body any, extra map[string]string) {
	text, err := json.Marshal(body)
	if err != nil {
		http.Error(w, `{"message":"Internal Server Error"}`, http.StatusInternalServerError)
		return
	}
	text = append(text, '\n')
	respondText(w, status, string(text), extra)
}

// respondText sends one already-serialized JSON reply with the same headers respondJSON sets.
func respondText(w http.ResponseWriter, status int, text string, extra map[string]string) {
	w.Header().Set("content-type", "application/json; charset=utf-8")
	w.Header().Set("content-length", strconv.Itoa(len(text)))
	w.Header().Set("x-github-request-id", requestID())
	for name, value := range extra {
		w.Header().Set(name, value)
	}
	w.WriteHeader(status)
	_, _ = io.WriteString(w, text)
}

// respondEmpty sends an empty reply, as 204 and a delete answer do.
func respondEmpty(w http.ResponseWriter, status int, extra map[string]string) {
	w.Header().Set("x-github-request-id", requestID())
	for name, value := range extra {
		w.Header().Set(name, value)
	}
	w.WriteHeader(status)
}

// readBody reads a request's body as a JSON object. A body that is not one answers 400 and false so
// the caller stops; an empty body is an empty object, as GitHub treats a missing body.
func readBody(w http.ResponseWriter, r *http.Request) (map[string]any, bool) {
	raw, _ := io.ReadAll(r.Body)
	text := strings.TrimSpace(string(raw))
	if text == "" {
		return map[string]any{}, true
	}
	var parsed any
	if err := json.Unmarshal([]byte(text), &parsed); err != nil {
		respondJSON(w, http.StatusBadRequest, map[string]any{"message": "Problems parsing JSON"}, nil)
		return nil, false
	}
	obj, ok := parsed.(map[string]any)
	if !ok {
		respondJSON(w, http.StatusBadRequest, map[string]any{"message": "Problems parsing JSON"}, nil)
		return nil, false
	}
	return obj, true
}

// hashID answers a stable small integer for an id string, the way the API reports ids.
func hashID(s string) int {
	var h uint32 = 2166136261
	for i := 0; i < len(s); i++ {
		h ^= uint32(s[i])
		h *= 16777619
	}
	signed := int32(h)
	if signed < 0 {
		return int(-signed)
	}
	if signed == 0 {
		return 1
	}
	return int(signed)
}

// nodeID answers GitHub's node_id: a base64 of "<type>:<id>".
func nodeID(kind, id string) string {
	return base64.StdEncoding.EncodeToString([]byte(kind + ":" + id))
}

// b64Wrapped answers the base64 form GitHub wraps: sixty characters a line.
func b64Wrapped(data []byte) string {
	raw := base64.StdEncoding.EncodeToString(data)
	var out strings.Builder
	out.Grow(len(raw) + len(raw)/60 + 1)
	for i := 0; i < len(raw); i += 60 {
		end := i + 60
		if end > len(raw) {
			end = len(raw)
		}
		if i > 0 {
			out.WriteByte('\n')
		}
		out.WriteString(raw[i:end])
	}
	return out.String()
}

// textOf answers a string field of a JSON body, or "" when it is absent or not a string.
func textOf(body map[string]any, key string) string {
	if v, ok := body[key].(string); ok {
		return v
	}
	return ""
}

// boolOf answers a boolean field, or false.
func boolOf(body map[string]any, key string) bool {
	if v, ok := body[key].(bool); ok {
		return v
	}
	return false
}

// listOf answers an array field as strings, or nil when it is absent.
func listOf(body map[string]any, key string) []string {
	raw, ok := body[key].([]any)
	if !ok {
		return nil
	}
	out := make([]string, 0, len(raw))
	for _, v := range raw {
		out = append(out, asText(v))
	}
	return out
}

// asText answers a JSON scalar as the string the API would print.
func asText(v any) string {
	switch value := v.(type) {
	case string:
		return value
	case float64:
		if value == float64(int64(value)) {
			return strconv.FormatInt(int64(value), 10)
		}
		return strconv.FormatFloat(value, 'f', -1, 64)
	case bool:
		return strconv.FormatBool(value)
	case nil:
		return ""
	}
	return ""
}
