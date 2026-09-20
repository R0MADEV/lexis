import { normalizeArgs, validateArgs } from "../mcp/runtime/args";

describe("normalizeArgs", () => {
  test("maps the primary file input onto path", () => {
    expect(normalizeArgs("outline", { file: "src/a.ts" })).toEqual({ path: "src/a.ts" });
    expect(normalizeArgs("get_context", { file: "src/a.ts", line: 3 })).toEqual({ path: "src/a.ts", line: 3 });
    expect(normalizeArgs("resolve_import", { file: "src/a.ts", symbol: "x" })).toEqual({ path: "src/a.ts", symbol: "x" });
  });

  test("maps every result-narrowing name onto path_filter", () => {
    expect(normalizeArgs("get_symbol", { name: "X", file_filter: "src" })).toEqual({ name: "X", path_filter: "src" });
    expect(normalizeArgs("list_symbols", { file_filter: "src" })).toEqual({ path_filter: "src" });
    expect(normalizeArgs("investigate", { name: "X", file_filter: "src" })).toEqual({ name: "X", path_filter: "src" });
    expect(normalizeArgs("dead_code", { scope: "src/legacy" })).toEqual({ path_filter: "src/legacy" });
  });

  test("the canonical name wins when both are passed", () => {
    expect(normalizeArgs("outline", { path: "canonical.ts", file: "alias.ts" })).toEqual({ path: "canonical.ts" });
  });

  test("leaves target alone — it takes a symbol OR a file, it is not a path scope", () => {
    expect(normalizeArgs("explain", { target: "AuthService" })).toEqual({ target: "AuthService" });
    expect(normalizeArgs("tests_for", { target: "src/a.ts" })).toEqual({ target: "src/a.ts" });
  });

  test("leaves defined_in alone — it selects a definition, not where results live", () => {
    expect(normalizeArgs("find_references", { symbol: "x", defined_in: "src/admin" }))
      .toEqual({ symbol: "x", defined_in: "src/admin" });
  });

  test("passes through tools that already use the canonical names", () => {
    expect(normalizeArgs("read_file", { path: "a.ts", offset: 1 })).toEqual({ path: "a.ts", offset: 1 });
    expect(normalizeArgs("list_todos", { path_filter: "src" })).toEqual({ path_filter: "src" });
    expect(normalizeArgs("search_code", { query: "x" })).toEqual({ query: "x" });
  });
});

describe("validateArgs", () => {
  test("rejects a parameter the tool does not declare", () => {
    const error = validateArgs("find_references", { symbol: "handleClick", path: "src/" });
    expect(error).toContain("find_references");
    expect(error).toContain("path");
  });

  test("lists what the tool does accept, so the retry succeeds first try", () => {
    const error = validateArgs("pattern_search", { pattern: "TODO", path: "src/" });
    expect(error).toContain("pattern");
    expect(error).toContain("path_filter");
    expect(error).toContain("glob");
  });

  test("names every unknown parameter, not just the first", () => {
    const error = validateArgs("find_file", { pattern: "auth", scope: "src", limit: 5 });
    expect(error).toContain("scope");
    expect(error).toContain("limit");
  });

  test("accepts a call that only uses declared parameters", () => {
    expect(validateArgs("search_code", { query: "x", output: "files", path_filter: "src" })).toBeNull();
    expect(validateArgs("read_file", { path: "a.ts", offset: 1, limit: 40 })).toBeNull();
  });

  test("a tool with no parameters accepts none", () => {
    expect(validateArgs("reindex", {})).toBeNull();
    expect(validateArgs("reindex", { path: "src/" })).toContain("path");
  });

  test("says nothing about a tool it does not know — the dispatcher reports that", () => {
    expect(validateArgs("no_such_tool", { anything: 1 })).toBeNull();
  });

  test("legacy names pass once normalized", () => {
    expect(validateArgs("outline", normalizeArgs("outline", { file: "a.ts" }))).toBeNull();
    expect(validateArgs("dead_code", normalizeArgs("dead_code", { scope: "src" }))).toBeNull();
  });
});

describe("validateArgs — did you mean", () => {
  test("points at the parameter the name was a near-miss for", () => {
    const error = validateArgs("search_code", { query: "x", path: "src/" });
    expect(error).toContain("Did you mean 'path_filter'");
  });

  test("catches the same near-miss on pattern_search", () => {
    expect(validateArgs("pattern_search", { pattern: "TODO", path: "src" }))
      .toContain("Did you mean 'path_filter'");
  });

  test("catches a typo", () => {
    expect(validateArgs("read_file", { path: "a.ts", offest: 3 }))
      .toContain("Did you mean 'offset'");
  });

  test("stays quiet when nothing is close, rather than inventing a guess", () => {
    const error = validateArgs("find_references", { symbol: "x", wobble: 1 });
    expect(error).not.toContain("Did you mean");
    expect(error).toContain("defined_in");
  });

  test("a one or two letter name is not treated as a prefix of everything", () => {
    expect(validateArgs("find_references", { symbol: "x", s: 1 })).not.toContain("Did you mean");
  });

  test("still lists the accepted parameters alongside the suggestion", () => {
    const error = validateArgs("search_code", { query: "x", path: "src/" });
    expect(error).toContain("Accepted:");
    expect(error).toContain("top_k");
  });
});
