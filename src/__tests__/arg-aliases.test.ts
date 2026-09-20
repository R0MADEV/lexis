import { normalizeArgs } from "../mcp/runtime/arg-aliases";

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
