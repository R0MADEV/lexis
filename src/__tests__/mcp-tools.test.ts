import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { indexProject } from "../core/indexer";
import { dispatchTool } from "../mcp/server";

let tmpDir: string;

function write(rel: string, content: string) {
  const abs = path.join(tmpDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lexis-mcp-tools-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("dispatchTool — search_code", () => {
  test("finds a symbol by name", () => {
    write("src/auth.ts", `
export class AuthService {
  login(user: string) { return true; }
}
`);
    const idx = indexProject(tmpDir, null);
    const result = dispatchTool("search_code", { query: "AuthService" }, idx, tmpDir);
    expect(result).toContain("AuthService");
  });

  test("returns no-results message for unknown query", () => {
    write("src/a.ts", "export const known = 1;");
    const idx = indexProject(tmpDir, null);
    const result = dispatchTool("search_code", { query: "xyzNonExistent12345" }, idx, tmpDir);
    expect(result.toLowerCase()).toMatch(/no.*results|no matches|no se encontraron/i);
  });

  test("respects output='files' mode", () => {
    write("src/payments.ts", `export class PaymentProcessor { charge() {} }`);
    const idx = indexProject(tmpDir, null);
    const result = dispatchTool("search_code", { query: "PaymentProcessor", output: "files" }, idx, tmpDir);
    expect(result).toContain("payments.ts");
    expect(result).not.toContain("class PaymentProcessor");
  });

  test("respects output='count' mode", () => {
    write("src/a.ts", "export function foo() {}\nexport function bar() {}\nexport function baz() {}");
    const idx = indexProject(tmpDir, null);
    const result = dispatchTool("search_code", { query: "function", output: "count" }, idx, tmpDir);
    expect(result).toMatch(/\d+/);
  });
});

describe("dispatchTool — get_symbol", () => {
  test("returns implementation of an exact symbol", () => {
    write("src/a.ts", `
export class Foo {
  bar() {
    return 42;
  }
}
`);
    const idx = indexProject(tmpDir, null);
    const result = dispatchTool("get_symbol", { name: "Foo" }, idx, tmpDir);
    expect(result).toContain("class Foo");
    expect(result).toContain("bar");
  });

  test("handles unknown symbol gracefully", () => {
    write("src/a.ts", "export const x = 1;");
    const idx = indexProject(tmpDir, null);
    const result = dispatchTool("get_symbol", { name: "TotallyUnknown" }, idx, tmpDir);
    expect(result.toLowerCase()).toMatch(/not found|no.*found|sin.*encontrar/i);
  });
});

describe("dispatchTool — read_file", () => {
  test("reads a slice of a file", () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n");
    write("src/big.ts", lines);
    const idx = indexProject(tmpDir, null);
    const result = dispatchTool(
      "read_file",
      { path: "src/big.ts", offset: 10, limit: 5 },
      idx,
      tmpDir,
    );
    expect(result).toContain("line 10");
    expect(result).toContain("line 14");
    expect(result).not.toContain("line 30");
  });

  test("handles non-existent file gracefully", () => {
    const idx = indexProject(tmpDir, null);
    const result = dispatchTool(
      "read_file",
      { path: "src/does-not-exist.ts", offset: 1, limit: 5 },
      idx,
      tmpDir,
    );
    expect(result.toLowerCase()).toMatch(/could not|not.*found|error|cannot/i);
  });
});

describe("dispatchTool — list_symbols", () => {
  test("lists all symbols in the project", () => {
    write("src/a.ts", "export function alpha() {}\nexport function beta() {}");
    const idx = indexProject(tmpDir, null);
    const result = dispatchTool("list_symbols", {}, idx, tmpDir);
    expect(result).toContain("alpha");
    expect(result).toContain("beta");
  });

  test("filters by file_filter", () => {
    write("src/a.ts", "export function inA() {}");
    write("src/b.ts", "export function inB() {}");
    const idx = indexProject(tmpDir, null);
    const result = dispatchTool("list_symbols", { file_filter: "a.ts" }, idx, tmpDir);
    expect(result).toContain("inA");
    expect(result).not.toContain("inB");
  });
});

describe("dispatchTool — find_file", () => {
  test("finds files by name pattern", () => {
    write("src/auth/login.ts", "export const x = 1;");
    write("src/auth/logout.ts", "export const y = 2;");
    write("src/payments.ts", "export const z = 3;");
    const idx = indexProject(tmpDir, null);
    const result = dispatchTool("find_file", { pattern: "auth" }, idx, tmpDir);
    expect(result).toContain("login.ts");
    expect(result).toContain("logout.ts");
    expect(result).not.toContain("payments.ts");
  });

  test("ranks exact filename matches first", () => {
    write("src/lib/AuthService.ts", "export class AuthService {}");
    write("src/utils/helper-with-AuthService-mention.ts", "// references AuthService");
    write("src/components/AuthService.spec.ts", "// test");
    const idx = indexProject(tmpDir, null);
    const result = dispatchTool("find_file", { pattern: "AuthService" }, idx, tmpDir);
    const lines = result.split("\n");
    // Exact filename match should rank first
    expect(lines[0]).toContain("AuthService.ts");
    expect(lines[0]).not.toContain("helper-with");
  });

  test("matches across camelCase / kebab-case / snake_case", () => {
    write("src/lib/UserController.ts", "export class UserController {}");
    write("src/handlers/user-controller.go", "package handlers");
    write("src/services/user_controller.py", "class UserController: pass");
    const idx = indexProject(tmpDir, null);
    const result = dispatchTool("find_file", { pattern: "UserController" }, idx, tmpDir);
    expect(result).toContain("UserController.ts");
    expect(result).toContain("user-controller.go");
    expect(result).toContain("user_controller.py");
  });

  test("prefers src/ over tests/ folders", () => {
    write("src/auth.ts", "export const a = 1;");
    write("tests/auth.test.ts", "// test");
    const idx = indexProject(tmpDir, null);
    const result = dispatchTool("find_file", { pattern: "auth" }, idx, tmpDir);
    const lines = result.split("\n");
    const srcIdx = lines.findIndex((l) => l.includes("src") && !l.includes("tests"));
    const testIdx = lines.findIndex((l) => l.includes("tests"));
    expect(srcIdx).toBeGreaterThanOrEqual(0);
    if (testIdx !== -1) expect(srcIdx).toBeLessThan(testIdx);
  });

  test("supports glob pattern: *.controller.ts", () => {
    write("src/UserController.ts", "x");
    write("src/AuthController.ts", "x");
    write("src/UserService.ts", "x");
    const idx = indexProject(tmpDir, null);
    const result = dispatchTool("find_file", { pattern: "*Controller.ts" }, idx, tmpDir);
    expect(result).toContain("UserController.ts");
    expect(result).toContain("AuthController.ts");
    expect(result).not.toContain("UserService.ts");
  });
});

describe("dispatchTool — notes / forget", () => {
  test("note tool adds and notes tool retrieves", () => {
    const idx = indexProject(tmpDir, null);
    const addResult = dispatchTool(
      "note",
      { content: "Found a tricky bug in the auth flow today", tags: ["bug", "auth"] },
      idx,
      tmpDir,
    );
    expect(addResult.toLowerCase()).toMatch(/saved|note|recorded/i);

    const recallResult = dispatchTool("notes", { query: "tricky" }, idx, tmpDir);
    expect(recallResult).toContain("tricky bug in the auth flow");
  });

  test("forget removes a note", () => {
    const idx = indexProject(tmpDir, null);
    dispatchTool(
      "note",
      { content: "Marked for deletion in this test scenario", tags: [] },
      idx,
      tmpDir,
    );
    const list = dispatchTool("notes", { query: "deletion" }, idx, tmpDir);
    const idMatch = list.match(/\b([a-z0-9]{6})\b/);
    if (!idMatch) throw new Error("Note id not found in: " + list);
    const id = idMatch[1]!;
    const forgetResult = dispatchTool("forget", { id }, idx, tmpDir);
    expect(forgetResult.toLowerCase()).toMatch(/deleted|removed|forg/i);
  });
});

describe("dispatchTool — fallback for unsupported languages", () => {
  test("get_symbol finds Lua function via fallback", () => {
    write("scripts/util.lua", `
local function processData(input)
  return input * 2
end

function MyModule.compute(x)
  return x + 1
end
`);
    const idx = indexProject(tmpDir, null);
    const result = dispatchTool("get_symbol", { name: "processData" }, idx, tmpDir);
    expect(result).toContain("processData");
    expect(result.toLowerCase()).toMatch(/fallback|file:|util\.lua/);
  });

  test("get_symbol finds Elixir defmodule via fallback", () => {
    write("lib/auth.ex", `
defmodule MyApp.Auth do
  def login(user) do
    :ok
  end
end
`);
    const idx = indexProject(tmpDir, null);
    const result = dispatchTool("get_symbol", { name: "Auth" }, idx, tmpDir);
    expect(result).toContain("Auth");
    expect(result).toContain("defmodule");
  });

  test("get_symbol finds Kamailio route via fallback", () => {
    write("kamailio/users/config/kamailio.cfg", `
route[GET_DDI_PREFIX] {
  if (search("@.*\\\\*")) {
    xlog("found prefix");
  }
}
`);
    const idx = indexProject(tmpDir, null);
    const result = dispatchTool("get_symbol", { name: "GET_DDI_PREFIX" }, idx, tmpDir);
    expect(result).toContain("GET_DDI_PREFIX");
    expect(result).toContain("route[");
  });

  test("get_symbol returns 'not found' when no fallback match either", () => {
    write("a.txt", "just plain text");
    const idx = indexProject(tmpDir, null);
    const result = dispatchTool("get_symbol", { name: "DefinitelyNotHere" }, idx, tmpDir);
    expect(result).toContain("not found");
  });

  test("list_symbols falls back to ripgrep for unsupported file types", () => {
    write("config/extensions.conf", `
[from-internal]
exten => _X.,1,Goto(globals,s,1)

[outbound-routes]
exten => _X.,1,NoOp()
`);
    const idx = indexProject(tmpDir, null);
    const result = dispatchTool("list_symbols", { file_filter: "extensions.conf" }, idx, tmpDir);
    expect(result).toContain("from-internal");
    expect(result).toContain("outbound-routes");
  });
});

describe("dispatchTool — unknown tool", () => {
  test("returns an error message for unknown tool", () => {
    const idx = indexProject(tmpDir, null);
    const result = dispatchTool("nonexistent_tool", {}, idx, tmpDir);
    expect(result.toLowerCase()).toMatch(/unknown|not.*found/i);
  });
});
