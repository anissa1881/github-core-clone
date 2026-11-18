package main

// Small helpers the API routes share: a stable sort for names, a percent-decoder for one path
// segment, and a marshal that ends with the newline every reply carries.

import (
	"encoding/json"
	"net/url"
	"sort"
)

// sortStrings sorts names in place, so a listing is the same on every request.
func sortStrings(names []string) {
	sort.Strings(names)
}

// urlPathUnescape decodes one percent-escaped path segment.
func urlPathUnescape(segment string) (string, error) {
	return url.PathUnescape(segment)
}

// jsonMarshalLine answers a body as JSON followed by one newline.
func jsonMarshalLine(body any) ([]byte, error) {
	text, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	return append(text, '\n'), nil
}
