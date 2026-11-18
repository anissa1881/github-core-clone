package main

// The schema the GraphQL surface describes: the object, enum, interface and input types, and the
// introspection answer built from them. The field order is the order introspection reports.

import "sort"

// fieldDef is one field of an object type, with its type as SDL-ish text.
type fieldDef struct {
	name string
	typ  string
	args [][2]string
}

// objectDef is one object type with its fields, in the order introspection reports them.
type objectDef struct {
	name   string
	fields []fieldDef
}

// The scalar type names the schema knows.
var gqlScalars = []string{
	"String", "Int", "Float", "Boolean", "ID", "DateTime", "URI", "GitObjectID", "HTML", "Base64String",
}

// The enum types and their values, in the order introspection reports them.
var gqlEnums = [][2]any{
	{"IssueState", []string{"OPEN", "CLOSED"}},
	{"PullRequestState", []string{"OPEN", "CLOSED", "MERGED"}},
	{"SearchType", []string{"ISSUE", "REPOSITORY", "USER"}},
	{"MergeableState", []string{"MERGEABLE", "CONFLICTING", "UNKNOWN"}},
}

// The interface types and their fields.
var gqlInterfaces = []objectDef{
	{name: "Node", fields: []fieldDef{{name: "id", typ: "ID!"}}},
}

// The input object types, for the mutation arguments.
var gqlInputs = [][2]any{
	{"CreateRepositoryInput", [][2]string{{"name", "String!"}, {"description", "String"}, {"isPrivate", "Boolean"}}},
	{"CreateIssueInput", [][2]string{{"repositoryId", "ID!"}, {"title", "String!"}, {"body", "String"}}},
	{"CloseIssueInput", [][2]string{{"issueId", "ID!"}}},
	{"AddCommentInput", [][2]string{{"subjectId", "ID!"}, {"body", "String!"}}},
	{"CreatePullRequestInput", [][2]string{
		{"repositoryId", "ID!"}, {"baseRefName", "String!"}, {"headRefName", "String!"},
		{"title", "String!"}, {"body", "String"},
	}},
	{"MergePullRequestInput", [][2]string{{"pullRequestId", "ID!"}}},
}

// The object types introspection describes.
var gqlObjects = []objectDef{
	{name: "Query", fields: []fieldDef{
		{name: "viewer", typ: "User!"},
		{name: "repository", typ: "Repository", args: [][2]string{{"owner", "String!"}, {"name", "String!"}}},
		{name: "node", typ: "Node", args: [][2]string{{"id", "ID!"}}},
		{name: "search", typ: "SearchResultItemConnection!", args: [][2]string{
			{"query", "String!"}, {"first", "Int"}, {"type", "SearchType!"},
		}},
	}},
	{name: "Mutation", fields: []fieldDef{
		{name: "createRepository", typ: "CreateRepositoryPayload", args: [][2]string{{"input", "CreateRepositoryInput!"}}},
		{name: "createIssue", typ: "CreateIssuePayload", args: [][2]string{{"input", "CreateIssueInput!"}}},
		{name: "closeIssue", typ: "CloseIssuePayload", args: [][2]string{{"input", "CloseIssueInput!"}}},
		{name: "addComment", typ: "AddCommentPayload", args: [][2]string{{"input", "AddCommentInput!"}}},
		{name: "createPullRequest", typ: "CreatePullRequestPayload", args: [][2]string{{"input", "CreatePullRequestInput!"}}},
		{name: "mergePullRequest", typ: "MergePullRequestPayload", args: [][2]string{{"input", "MergePullRequestInput!"}}},
	}},
	{name: "User", fields: []fieldDef{
		{name: "login", typ: "String!"},
		{name: "id", typ: "ID!"},
		{name: "name", typ: "String"},
		{name: "repositories", typ: "RepositoryConnection!", args: [][2]string{{"first", "Int"}}},
	}},
	{name: "Repository", fields: []fieldDef{
		{name: "id", typ: "ID!"},
		{name: "databaseId", typ: "Int"},
		{name: "name", typ: "String!"},
		{name: "nameWithOwner", typ: "String!"},
		{name: "description", typ: "String"},
		{name: "isPrivate", typ: "Boolean!"},
		{name: "owner", typ: "User!"},
		{name: "viewerPermission", typ: "String"},
		{name: "hasIssuesEnabled", typ: "Boolean!"},
		{name: "defaultBranchRef", typ: "Ref"},
		{name: "issue", typ: "Issue", args: [][2]string{{"number", "Int!"}}},
		{name: "pullRequest", typ: "PullRequest", args: [][2]string{{"number", "Int!"}}},
		{name: "issues", typ: "IssueConnection!", args: [][2]string{
			{"first", "Int"}, {"after", "String"}, {"last", "Int"}, {"before", "String"},
			{"states", "[IssueState!]"}, {"orderBy", "IssueOrder"},
		}},
		{name: "pullRequests", typ: "PullRequestConnection!", args: [][2]string{
			{"first", "Int"}, {"after", "String"}, {"last", "Int"}, {"before", "String"},
			{"states", "[PullRequestState!]"},
		}},
	}},
	{name: "Ref", fields: []fieldDef{{name: "name", typ: "String!"}, {name: "target", typ: "Commit"}}},
	{name: "Commit", fields: []fieldDef{
		{name: "oid", typ: "GitObjectID!"}, {name: "message", typ: "String!"}, {name: "tree", typ: "Tree"},
	}},
	{name: "Tree", fields: []fieldDef{
		{name: "oid", typ: "GitObjectID!"}, {name: "entries", typ: "[TreeEntry!]!"},
	}},
	{name: "TreeEntry", fields: []fieldDef{
		{name: "name", typ: "String!"}, {name: "type", typ: "String!"}, {name: "oid", typ: "GitObjectID!"},
	}},
	{name: "Issue", fields: []fieldDef{
		{name: "id", typ: "ID!"},
		{name: "number", typ: "Int!"},
		{name: "title", typ: "String!"},
		{name: "body", typ: "String"},
		{name: "state", typ: "IssueState!"},
		{name: "author", typ: "User"},
		{name: "labels", typ: "LabelConnection!", args: [][2]string{{"first", "Int"}}},
	}},
	{name: "PullRequest", fields: []fieldDef{
		{name: "id", typ: "ID!"},
		{name: "number", typ: "Int!"},
		{name: "title", typ: "String!"},
		{name: "body", typ: "String"},
		{name: "state", typ: "PullRequestState!"},
		{name: "merged", typ: "Boolean!"},
		{name: "mergeable", typ: "MergeableState!"},
		{name: "headRefName", typ: "String!"},
		{name: "baseRefName", typ: "String!"},
		{name: "mergeCommit", typ: "Commit"},
		{name: "files", typ: "PullRequestChangedFileConnection!", args: [][2]string{{"first", "Int"}}},
	}},
	{name: "PullRequestChangedFile", fields: []fieldDef{
		{name: "path", typ: "String!"}, {name: "additions", typ: "Int!"}, {name: "deletions", typ: "Int!"},
	}},
	{name: "Label", fields: []fieldDef{
		{name: "id", typ: "ID!"}, {name: "name", typ: "String!"}, {name: "color", typ: "String!"},
	}},
	{name: "PageInfo", fields: []fieldDef{
		{name: "hasNextPage", typ: "Boolean!"},
		{name: "hasPreviousPage", typ: "Boolean!"},
		{name: "startCursor", typ: "String"},
		{name: "endCursor", typ: "String"},
	}},
	{name: "IssueConnection", fields: []fieldDef{
		{name: "nodes", typ: "[Issue]"}, {name: "totalCount", typ: "Int!"}, {name: "pageInfo", typ: "PageInfo!"},
	}},
	{name: "PullRequestConnection", fields: []fieldDef{
		{name: "nodes", typ: "[PullRequest]"}, {name: "totalCount", typ: "Int!"}, {name: "pageInfo", typ: "PageInfo!"},
	}},
	{name: "RepositoryConnection", fields: []fieldDef{
		{name: "nodes", typ: "[Repository]"}, {name: "totalCount", typ: "Int!"}, {name: "pageInfo", typ: "PageInfo!"},
	}},
	{name: "LabelConnection", fields: []fieldDef{
		{name: "nodes", typ: "[Label]"}, {name: "totalCount", typ: "Int!"}, {name: "pageInfo", typ: "PageInfo!"},
	}},
	{name: "PullRequestChangedFileConnection", fields: []fieldDef{
		{name: "nodes", typ: "[PullRequestChangedFile]"}, {name: "totalCount", typ: "Int!"},
		{name: "pageInfo", typ: "PageInfo!"},
	}},
	{name: "SearchResultItemConnection", fields: []fieldDef{
		{name: "nodes", typ: "[SearchResultItem]"}, {name: "issueCount", typ: "Int!"},
		{name: "pageInfo", typ: "PageInfo!"},
	}},
	{name: "SearchResultItem", fields: []fieldDef{{name: "id", typ: "ID!"}}},
	{name: "CreateRepositoryPayload", fields: []fieldDef{{name: "repository", typ: "Repository"}}},
	{name: "CreateIssuePayload", fields: []fieldDef{{name: "issue", typ: "Issue"}}},
	{name: "CloseIssuePayload", fields: []fieldDef{{name: "issue", typ: "Issue"}}},
	{name: "AddCommentPayload", fields: []fieldDef{{name: "issueComment", typ: "IssueComment"}}},
	{name: "CreatePullRequestPayload", fields: []fieldDef{{name: "pullRequest", typ: "PullRequest"}}},
	{name: "MergePullRequestPayload", fields: []fieldDef{{name: "pullRequest", typ: "PullRequest"}}},
	{name: "IssueComment", fields: []fieldDef{{name: "id", typ: "ID!"}, {name: "body", typ: "String!"}}},
}

// objectOf answers one object type's definition.
func objectOf(name string) *objectDef {
	for i := range gqlObjects {
		if gqlObjects[i].name == name {
			return &gqlObjects[i]
		}
	}
	return nil
}

// enumOf answers one enum's values.
func enumOf(name string) []string {
	for _, pair := range gqlEnums {
		if pair[0].(string) == name {
			return pair[1].([]string)
		}
	}
	return nil
}

// interfaceOf answers one interface's definition.
func interfaceOf(name string) *objectDef {
	for i := range gqlInterfaces {
		if gqlInterfaces[i].name == name {
			return &gqlInterfaces[i]
		}
	}
	return nil
}

// inputOf answers one input object's fields.
func inputOf(name string) [][2]string {
	for _, pair := range gqlInputs {
		if pair[0].(string) == name {
			return pair[1].([][2]string)
		}
	}
	return nil
}

// isScalar answers whether a name is one of the scalar types.
func isScalar(name string) bool {
	for _, scalar := range gqlScalars {
		if scalar == name {
			return true
		}
	}
	return false
}

// typeRef answers the introspection shape of a type written as SDL-ish text.
func typeRef(text string) map[string]any {
	text = trimSpace(text)
	if hasSuffix(text, "!") {
		return map[string]any{"kind": "NON_NULL", "name": nil, "ofType": typeRef(dropLast(text))}
	}
	if hasPrefix(text, "[") && hasSuffix(text, "]") {
		return map[string]any{"kind": "LIST", "name": nil, "ofType": typeRef(text[1 : len(text)-1])}
	}
	kind := "OBJECT"
	switch {
	case isScalar(text):
		kind = "SCALAR"
	case enumOf(text) != nil:
		kind = "ENUM"
	case interfaceOf(text) != nil:
		kind = "INTERFACE"
	}
	return map[string]any{"kind": kind, "name": text, "ofType": nil}
}

// trimSpace, hasSuffix, hasPrefix and dropLast keep the type text helpers readable.
func trimSpace(text string) string {
	for len(text) > 0 && (text[0] == ' ' || text[0] == '\t') {
		text = text[1:]
	}
	for len(text) > 0 && (text[len(text)-1] == ' ' || text[len(text)-1] == '\t') {
		text = text[:len(text)-1]
	}
	return text
}

func hasPrefix(text, prefix string) bool {
	return len(text) >= len(prefix) && text[:len(prefix)] == prefix
}

func hasSuffix(text, suffix string) bool {
	return len(text) >= len(suffix) && text[len(text)-len(suffix):] == suffix
}

func dropLast(text string) string {
	if text == "" {
		return text
	}
	return text[:len(text)-1]
}

// introspectType builds one introspection type object for a named type, or nil when it is unknown.
func introspectType(name string) map[string]any {
	if def := objectOf(name); def != nil {
		fields := make([]any, 0, len(def.fields))
		for _, field := range def.fields {
			args := make([]any, 0, len(field.args))
			for _, arg := range field.args {
				args = append(args, map[string]any{
					"name": arg[0], "description": nil, "type": typeRef(arg[1]), "defaultValue": nil,
				})
			}
			fields = append(fields, map[string]any{
				"name": field.name, "description": nil, "args": args,
				"type": typeRef(field.typ), "isDeprecated": false, "deprecationReason": nil,
			})
		}
		return map[string]any{
			"kind": "OBJECT", "name": name, "description": nil, "fields": fields,
			"inputFields": nil, "interfaces": []any{}, "enumValues": nil, "possibleTypes": nil,
		}
	}

	if values := enumOf(name); values != nil {
		entries := make([]any, 0, len(values))
		for _, value := range values {
			entries = append(entries, map[string]any{
				"name": value, "description": nil, "isDeprecated": false, "deprecationReason": nil,
			})
		}
		return map[string]any{
			"kind": "ENUM", "name": name, "description": nil, "fields": nil, "inputFields": nil,
			"interfaces": nil, "enumValues": entries, "possibleTypes": nil,
		}
	}

	if input := inputOf(name); input != nil {
		entries := make([]any, 0, len(input))
		for _, field := range input {
			entries = append(entries, map[string]any{
				"name": field[0], "description": nil, "type": typeRef(field[1]), "defaultValue": nil,
			})
		}
		return map[string]any{
			"kind": "INPUT_OBJECT", "name": name, "description": nil, "fields": nil,
			"inputFields": entries, "interfaces": nil, "enumValues": nil, "possibleTypes": nil,
		}
	}

	if def := interfaceOf(name); def != nil {
		fields := make([]any, 0, len(def.fields))
		for _, field := range def.fields {
			fields = append(fields, map[string]any{
				"name": field.name, "description": nil, "args": []any{},
				"type": typeRef(field.typ), "isDeprecated": false, "deprecationReason": nil,
			})
		}
		return map[string]any{
			"kind": "INTERFACE", "name": name, "description": nil, "fields": fields,
			"inputFields": nil, "interfaces": []any{}, "enumValues": nil,
			"possibleTypes": []any{map[string]any{"kind": "OBJECT", "name": "Repository", "ofType": nil}},
		}
	}

	if isScalar(name) {
		return map[string]any{
			"kind": "SCALAR", "name": name, "description": nil, "fields": nil, "inputFields": nil,
			"interfaces": nil, "enumValues": nil, "possibleTypes": nil,
		}
	}

	return nil
}

// allTypeNames answers every type name the schema knows.
func allTypeNames() []string {
	out := make([]string, 0, len(gqlObjects)+len(gqlEnums)+len(gqlInputs)+len(gqlInterfaces)+len(gqlScalars))
	for _, def := range gqlObjects {
		out = append(out, def.name)
	}
	for _, pair := range gqlEnums {
		out = append(out, pair[0].(string))
	}
	for _, pair := range gqlInputs {
		out = append(out, pair[0].(string))
	}
	for _, def := range gqlInterfaces {
		out = append(out, def.name)
	}
	out = append(out, gqlScalars...)
	sort.Strings(out)
	return out
}
