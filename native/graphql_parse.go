package main

// The GraphQL document reader: a tokenizer, a recursive-descent parser and the document model the
// evaluator walks. It reads the documents gh and github-mcp-server send, not a grammar library.

import (
	"fmt"
	"strconv"
	"strings"
)

// token is one lexical token: punctuation, a name, a string, a number, or the end of the document.
type token struct {
	kind  string // "punct", "name", "string", "number" or "eof"
	value string
}

// gqlError is the parser's own error. A document that cannot be read is answered as a 200 with an
// errors array, the way GitHub answers one.
type gqlError struct{ message string }

func (e gqlError) Error() string { return e.message }

// isNameChar answers whether a byte may begin or continue a GraphQL name.
func isNameChar(c byte) bool {
	return c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '_'
}

// isDigit answers whether a byte is a decimal digit.
func isDigit(c byte) bool { return c >= '0' && c <= '9' }

// tokenize splits a document into tokens, skipping whitespace, commas and comments. String literals
// are read whole with their escapes decoded, and a block string keeps its text verbatim.
func tokenize(src string) ([]token, error) {
	out := make([]token, 0, len(src)/4+1)
	i := 0
	for i < len(src) {
		ch := src[i]

		// whitespace and commas carry no meaning between tokens
		if ch == ' ' || ch == '\t' || ch == '\n' || ch == '\r' || ch == ',' {
			i++
			continue
		}

		// a spread's three dots are one token
		if strings.HasPrefix(src[i:], "...") {
			out = append(out, token{kind: "punct", value: "..."})
			i += 3
			continue
		}

		// a comment runs to the end of its line
		if ch == '#' {
			for i < len(src) && src[i] != '\n' {
				i++
			}
			continue
		}

		// a block string keeps its raw text, newlines included
		if strings.HasPrefix(src[i:], `"""`) {
			rest := src[i+3:]
			end := strings.Index(rest, `"""`)
			stop := len(src)
			if end >= 0 {
				stop = i + 3 + end
			}
			out = append(out, token{kind: "string", value: src[i+3 : stop]})
			if end < 0 {
				i = len(src)
			} else {
				i = stop + 3
			}
			continue
		}

		// a quoted string, its escapes decoded
		if ch == '"' {
			j := i + 1
			var value strings.Builder
			for j < len(src) && src[j] != '"' {
				if src[j] == '\\' && j+1 < len(src) {
					esc := src[j+1]
					if esc == 'u' && j+5 < len(src) {
						if code, err := strconv.ParseUint(src[j+2:j+6], 16, 32); err == nil {
							value.WriteRune(rune(code))
							j += 6
							continue
						}
					}
					switch esc {
					case 'n':
						value.WriteByte('\n')
					case 't':
						value.WriteByte('\t')
					case 'r':
						value.WriteByte('\r')
					case 'b':
						value.WriteByte('\b')
					case 'f':
						value.WriteByte('\f')
					case '/':
						value.WriteByte('/')
					case '"':
						value.WriteByte('"')
					case '\\':
						value.WriteByte('\\')
					default:
						value.WriteByte(esc)
					}
					j += 2
					continue
				}
				value.WriteByte(src[j])
				j++
			}
			if j >= len(src) {
				return nil, gqlError{message: "Syntax Error: Unterminated string."}
			}
			out = append(out, token{kind: "string", value: value.String()})
			i = j + 1
			continue
		}

		// punctuation stands alone
		if strings.ContainsRune("{}()[]!:,=@|&$", rune(ch)) {
			out = append(out, token{kind: "punct", value: string(ch)})
			i++
			continue
		}

		// a number: an optional sign, then digits with an optional fraction and exponent
		if ch == '-' || isDigit(ch) {
			j := i
			if src[j] == '-' {
				j++
			}
			for j < len(src) && isDigit(src[j]) {
				j++
			}
			if j < len(src) && src[j] == '.' {
				j++
				for j < len(src) && isDigit(src[j]) {
					j++
				}
			}
			if j < len(src) && (src[j] == 'e' || src[j] == 'E') {
				j++
				if j < len(src) && (src[j] == '+' || src[j] == '-') {
					j++
				}
				for j < len(src) && isDigit(src[j]) {
					j++
				}
			}
			out = append(out, token{kind: "number", value: src[i:j]})
			i = j
			continue
		}

		// anything else that looks like a name
		if isNameChar(ch) {
			j := i
			for j < len(src) && isNameChar(src[j]) {
				j++
			}
			out = append(out, token{kind: "name", value: src[i:j]})
			i = j
			continue
		}

		return nil, gqlError{message: fmt.Sprintf("Syntax Error: Unexpected character %q.", string(ch))}
	}

	out = append(out, token{kind: "eof"})
	return out, nil
}

// directive is one @include / @skip annotation a selection carries.
type directive struct {
	name string
	args map[string]any
}

// selection is one field selection: its name, alias, arguments and sub-selections.
type selection struct {
	name       string
	alias      string
	hasAlias   bool
	args       map[string]any
	selections []selection
	fragments  []string
	directives []directive
}

// fragment is one named fragment a document defines.
type fragment struct {
	name       string
	on         string
	selections []selection
}

// operation is one parsed operation.
type operation struct {
	kind       string // "query", "mutation" or "subscription"
	name       string
	varDefs    []varDef
	selections []selection
}

// varDef is one variable definition, with the default the document may give it.
type varDef struct {
	name       string
	varType    string
	defaultVal any
	hasDefault bool
}

// document is the result of parsing one document: its operations and the fragments they spread.
type document struct {
	operations []operation
	fragments  map[string]fragment
}

// cursor walks the token stream with the parser's small helpers.
type cursor struct {
	tokens []token
	pos    int
}

// peek answers the token under the cursor, or one of the tokens just after it.
func (c *cursor) peek(offset int) token {
	at := c.pos + offset
	if at < 0 {
		at = 0
	}
	if at >= len(c.tokens) {
		at = len(c.tokens) - 1
	}
	return c.tokens[at]
}

// next consumes and answers the token under the cursor.
func (c *cursor) next() token {
	t := c.peek(0)
	if t.kind != "eof" {
		c.pos++
	}
	return t
}

// at answers whether the cursor sits on this punctuation or name.
func (c *cursor) at(value string) bool {
	t := c.peek(0)
	return (t.kind == "punct" || t.kind == "name") && t.value == value
}

// expect consumes the expected punctuation or name, or fails.
func (c *cursor) expect(value string) error {
	if !c.at(value) {
		return gqlError{message: fmt.Sprintf("Syntax Error: Expected %q, found %q.", value, c.peek(0).value)}
	}
	c.next()
	return nil
}

// name consumes a name, or fails.
func (c *cursor) name() (string, error) {
	t := c.peek(0)
	if t.kind != "name" {
		return "", gqlError{message: fmt.Sprintf("Syntax Error: Expected Name, found %q.", t.value)}
	}
	c.next()
	return t.value, nil
}

// done answers whether the cursor has reached the end of the document.
func (c *cursor) done() bool {
	return c.peek(0).kind == "eof"
}

// parseValue parses an argument's value: a literal, a variable, a list or an object.
func parseValue(c *cursor) (any, error) {
	t := c.peek(0)

	if t.kind == "punct" && t.value == "$" {
		c.next()
		name, err := c.name()
		if err != nil {
			return nil, err
		}
		return map[string]any{"$var": name}, nil
	}
	if t.kind == "string" {
		c.next()
		return t.value, nil
	}
	if t.kind == "number" {
		c.next()
		if value, err := strconv.ParseFloat(t.value, 64); err == nil {
			return value, nil
		}
		return float64(0), nil
	}
	if t.kind == "name" {
		c.next()
		switch t.value {
		case "true":
			return true, nil
		case "false":
			return false, nil
		case "null":
			return nil, nil
		}
		return t.value, nil
	}
	if t.kind == "punct" && t.value == "[" {
		c.next()
		list := make([]any, 0, 4)
		for !c.at("]") {
			if c.done() {
				return nil, gqlError{message: "Syntax Error: Unterminated list."}
			}
			value, err := parseValue(c)
			if err != nil {
				return nil, err
			}
			list = append(list, value)
		}
		if err := c.expect("]"); err != nil {
			return nil, err
		}
		return list, nil
	}
	if t.kind == "punct" && t.value == "{" {
		c.next()
		obj := map[string]any{}
		for !c.at("}") {
			if c.done() {
				return nil, gqlError{message: "Syntax Error: Unterminated object."}
			}
			key, err := c.name()
			if err != nil {
				return nil, err
			}
			if err := c.expect(":"); err != nil {
				return nil, err
			}
			value, err := parseValue(c)
			if err != nil {
				return nil, err
			}
			obj[key] = value
		}
		if err := c.expect("}"); err != nil {
			return nil, err
		}
		return obj, nil
	}
	return nil, gqlError{message: fmt.Sprintf("Syntax Error: Unexpected token %q.", t.value)}
}

// parseArgs parses an argument list, answering it as a record (empty when the field takes none).
func parseArgs(c *cursor) (map[string]any, error) {
	out := map[string]any{}
	if !c.at("(") {
		return out, nil
	}
	c.next()
	for !c.at(")") {
		if c.done() {
			return nil, gqlError{message: "Syntax Error: Unterminated argument list."}
		}
		name, err := c.name()
		if err != nil {
			return nil, err
		}
		if err := c.expect(":"); err != nil {
			return nil, err
		}
		value, err := parseValue(c)
		if err != nil {
			return nil, err
		}
		out[name] = value
	}
	if err := c.expect(")"); err != nil {
		return nil, err
	}
	return out, nil
}

// parseDirectives reads any directives attached to a field or fragment spread.
func parseDirectives(c *cursor) ([]directive, error) {
	out := make([]directive, 0, 1)
	for c.at("@") {
		c.next()
		name, err := c.name()
		if err != nil {
			return nil, err
		}
		args, err := parseArgs(c)
		if err != nil {
			return nil, err
		}
		out = append(out, directive{name: name, args: args})
	}
	return out, nil
}

// parseSelectionSet parses a selection set, including inline fragments and fragment spreads.
func parseSelectionSet(c *cursor) ([]selection, error) {
	if err := c.expect("{"); err != nil {
		return nil, err
	}
	out := make([]selection, 0, 4)
	for !c.at("}") {
		if c.done() {
			return nil, gqlError{message: "Syntax Error: Unterminated selection set."}
		}

		// a spread is either an inline fragment (... on Type { ... }) or a named one (...Frag)
		if c.at("...") {
			c.next()
			on := ""
			name := ""
			if c.at("on") {
				c.next()
				read, err := c.name()
				if err != nil {
					return nil, err
				}
				on = read
			} else if c.peek(0).kind == "name" {
				read, err := c.name()
				if err != nil {
					return nil, err
				}
				name = read
			}
			directives, err := parseDirectives(c)
			if err != nil {
				return nil, err
			}
			nested := []selection{}
			if c.at("{") {
				nested, err = parseSelectionSet(c)
				if err != nil {
					return nil, err
				}
			}
			entry := selection{args: map[string]any{}, selections: nested, directives: directives}
			if name != "" {
				entry.name = name
				entry.fragments = []string{name}
			} else {
				entry.name = "__inline"
				if on != "" {
					entry.args = map[string]any{"__on": on}
				}
			}
			out = append(out, entry)
			continue
		}

		first, err := c.name()
		if err != nil {
			return nil, err
		}
		alias := ""
		hasAlias := false
		name := first
		if c.at(":") {
			c.next()
			alias = first
			hasAlias = true
			name, err = c.name()
			if err != nil {
				return nil, err
			}
		}
		args, err := parseArgs(c)
		if err != nil {
			return nil, err
		}
		directives, err := parseDirectives(c)
		if err != nil {
			return nil, err
		}
		selections := []selection{}
		if c.at("{") {
			selections, err = parseSelectionSet(c)
			if err != nil {
				return nil, err
			}
		}
		out = append(out, selection{
			name: name, alias: alias, hasAlias: hasAlias, args: args,
			selections: selections, directives: directives,
		})
	}
	if err := c.expect("}"); err != nil {
		return nil, err
	}
	return out, nil
}

// parseFragment parses a fragment definition, answering its name, type condition and body.
func parseFragment(c *cursor) (fragment, error) {
	if err := c.expect("fragment"); err != nil {
		return fragment{}, err
	}
	name, err := c.name()
	if err != nil {
		return fragment{}, err
	}
	on := ""
	if c.at("on") {
		c.next()
		if on, err = c.name(); err != nil {
			return fragment{}, err
		}
	}
	if _, err := parseDirectives(c); err != nil {
		return fragment{}, err
	}
	selections, err := parseSelectionSet(c)
	if err != nil {
		return fragment{}, err
	}
	return fragment{name: name, on: on, selections: selections}, nil
}

// parseDocument parses a whole document: its operations and every fragment it defines.
func parseDocument(src string) (*document, error) {
	tokens, err := tokenize(src)
	if err != nil {
		return nil, err
	}
	c := &cursor{tokens: tokens}
	doc := &document{fragments: map[string]fragment{}}

	for !c.done() {
		if c.at("fragment") {
			f, err := parseFragment(c)
			if err != nil {
				return nil, err
			}
			doc.fragments[f.name] = f
			continue
		}
		// an operation either opens with query/mutation/subscription, or is a bare selection set
		keyword := ""
		if c.peek(0).kind == "name" {
			switch c.peek(0).value {
			case "query", "mutation", "subscription":
				keyword = c.peek(0).value
				c.next()
			}
		}
		op, err := parseOperation(c, keyword)
		if err != nil {
			return nil, err
		}
		doc.operations = append(doc.operations, op)
	}

	if len(doc.operations) == 0 {
		return nil, gqlError{message: "Syntax Error: No operations in the document."}
	}
	return doc, nil
}

// parseOperation reads the rest of an operation whose keyword (if any) was already consumed.
func parseOperation(c *cursor, keyword string) (operation, error) {
	op := operation{kind: "query", selections: nil}
	if keyword != "" {
		op.kind = keyword
	}

	// an anonymous query opens straight at its selection set, so a name here is the operation's
	if c.peek(0).kind == "name" {
		name, err := c.name()
		if err != nil {
			return op, err
		}
		op.name = name
	}

	if c.at("(") {
		c.next()
		for !c.at(")") {
			if c.done() {
				return op, gqlError{message: "Syntax Error: Unterminated variable definitions."}
			}
			if err := c.expect("$"); err != nil {
				return op, err
			}
			varName, err := c.name()
			if err != nil {
				return op, err
			}
			if err := c.expect(":"); err != nil {
				return op, err
			}
			varType := ""
			for c.at("[") {
				c.next()
				varType += "["
			}
			base, err := c.name()
			if err != nil {
				return op, err
			}
			varType += base
			for c.at("]") {
				c.next()
				varType += "]"
			}
			if c.at("!") {
				c.next()
				varType += "!"
			}
			def := varDef{name: varName, varType: varType}
			if c.at("=") {
				c.next()
				value, err := parseValue(c)
				if err != nil {
					return op, err
				}
				def.defaultVal = value
				def.hasDefault = true
			}
			op.varDefs = append(op.varDefs, def)
		}
		if err := c.expect(")"); err != nil {
			return op, err
		}
	}

	if _, err := parseDirectives(c); err != nil {
		return op, err
	}
	selections, err := parseSelectionSet(c)
	if err != nil {
		return op, err
	}
	op.selections = selections
	return op, nil
}

// resolveVars resolves a {"$var": name} marker against the request's variables.
func resolveVars(value any, vars map[string]any) any {
	switch typed := value.(type) {
	case []any:
		out := make([]any, 0, len(typed))
		for _, item := range typed {
			out = append(out, resolveVars(item, vars))
		}
		return out
	case map[string]any:
		if name, ok := typed["$var"].(string); ok {
			return vars[name]
		}
		out := make(map[string]any, len(typed))
		for key, item := range typed {
			out[key] = resolveVars(item, vars)
		}
		return out
	}
	return value
}
