import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { indexProject } from "../core/indexer";
import { dispatchTool } from "../mcp/server";
import { cleanupTmpProject } from "./test-utils";

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
  cleanupTmpProject(tmpDir);
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

  test("ranks exact symbol name match above partial matches", () => {
    write("src/lib/AuthService.ts", "export class AuthService {\n  login() {}\n}");
    write("src/utils/AuthServiceHelper.ts", "export class AuthServiceHelper {}");
    write("src/handlers/AuthServiceFactory.ts", "export class AuthServiceFactory {}");
    const idx = indexProject(tmpDir, null);
    const result = dispatchTool(
      "search_code",
      { query: "AuthService", output: "files", top_k: 10 },
      idx,
      tmpDir,
    );
    const lines = result.split("\n");
    expect(lines[0]).toContain("AuthService.ts");
    expect(lines[0]).not.toContain("Helper");
    expect(lines[0]).not.toContain("Factory");
  });

  test("ranks src/ over tests/", () => {
    write("src/PaymentProcessor.ts", "export class PaymentProcessor { charge() {} }");
    write("tests/PaymentProcessor.test.ts", "// PaymentProcessor tests");
    const idx = indexProject(tmpDir, null);
    const result = dispatchTool(
      "search_code",
      { query: "PaymentProcessor", output: "files", top_k: 10 },
      idx,
      tmpDir,
    );
    const lines = result.split("\n").filter((l) => l.length > 0);
    const srcIdx = lines.findIndex((l) => l.includes("src") && !l.includes("tests"));
    const testIdx = lines.findIndex((l) => l.includes("tests"));
    expect(srcIdx).toBeGreaterThanOrEqual(0);
    if (testIdx !== -1) expect(srcIdx).toBeLessThan(testIdx);
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

describe("dispatchTool — path compression in output", () => {
  test("search_code with output='files' compresses common path prefix when 3+ results share it", () => {
    write("library/Ivoz/Provider/Domain/Service/ProxyTrunkUpdate.php",
      "<?php class ProxyTrunkUpdate {}");
    write("library/Ivoz/Provider/Domain/Service/ProxyTrunkSync.php",
      "<?php class ProxyTrunkSync {}");
    write("library/Ivoz/Provider/Domain/Service/ProxyTrunkReload.php",
      "<?php class ProxyTrunkReload {}");
    const idx = indexProject(tmpDir, null);
    const result = dispatchTool(
      "search_code",
      { query: "ProxyTrunk", output: "files", top_k: 10 },
      idx,
      tmpDir,
    );
    // Should have a "BASE:" header and short relative paths
    expect(result).toMatch(/BASE:.+/);
    expect(result).toContain("ProxyTrunkUpdate.php");
    // The long Provider/Domain/Service prefix should appear only once (in BASE)
    const longPathCount = (result.match(/library\/Ivoz\/Provider\/Domain\/Service/g) || []).length;
    expect(longPathCount).toBeLessThanOrEqual(1);
  });

  test("search_code does NOT compress when results don't share enough prefix", () => {
    write("src/auth/AuthService.ts", "export class AuthService {}");
    write("config/settings.ts", "export const SETTINGS_AuthService = 1;");
    const idx = indexProject(tmpDir, null);
    const result = dispatchTool(
      "search_code",
      { query: "AuthService", output: "files", top_k: 10 },
      idx,
      tmpDir,
    );
    // No BASE header when results don't share a meaningful prefix
    expect(result).not.toMatch(/^BASE:/m);
  });

  test("search_code does NOT compress when fewer than 3 results", () => {
    write("src/lib/Single.ts", "export class Single {}");
    const idx = indexProject(tmpDir, null);
    const result = dispatchTool(
      "search_code",
      { query: "Single", output: "files", top_k: 10 },
      idx,
      tmpDir,
    );
    expect(result).not.toMatch(/^BASE:/m);
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

describe("tool visibility — context-aware tool list", () => {
  test("lint tool is HIDDEN when project has no linter marker", () => {
    write("README.md", "# just docs, no project");
    write("notes.txt", "stuff");
    const idx = indexProject(tmpDir, null);
    // We test through the public API: a project without linter shouldn't expose it.
    // dispatchTool would still work (defensive), but the tool list filtering
    // is what matters for `tools/list`. Validate the underlying detector.
    const { detectLinter } = require("../mcp/server");
    expect(detectLinter(tmpDir)).toBeNull();
  });

  test("lint tool is VISIBLE when tsconfig.json exists", () => {
    write("tsconfig.json", `{"compilerOptions": {}}`);
    const { detectLinter } = require("../mcp/server");
    const linter = detectLinter(tmpDir);
    expect(linter).not.toBeNull();
    expect(linter?.label).toBe("TypeScript");
  });

  test("lint tool is VISIBLE when go.mod exists", () => {
    write("go.mod", "module foo");
    const { detectLinter } = require("../mcp/server");
    const linter = detectLinter(tmpDir);
    expect(linter?.label).toBe("Go");
  });
});

describe("dispatchTool — lint (multi-language detection)", () => {
  test("detects TypeScript project from tsconfig.json", () => {
    write("tsconfig.json", `{"compilerOptions": {"strict": true, "noEmit": true}}`);
    write("src/a.ts", "export const x: number = 1;");
    const idx = indexProject(tmpDir, null);
    const result = dispatchTool("lint", {}, idx, tmpDir);
    // Should at least identify the project type, even if tsc isn't installed locally
    expect(result.toLowerCase()).toMatch(/typescript|tsc|no errors|not installed|cannot/);
  });

  test("returns 'no linter detected' for empty project", () => {
    write("README.md", "# empty");
    const idx = indexProject(tmpDir, null);
    const result = dispatchTool("lint", {}, idx, tmpDir);
    expect(result.toLowerCase()).toMatch(/no linter|not detected|unknown project/);
  });

  test("detects Go project from go.mod", () => {
    write("go.mod", "module example.com/foo\ngo 1.21");
    write("main.go", "package main\nfunc main() {}");
    const idx = indexProject(tmpDir, null);
    const result = dispatchTool("lint", {}, idx, tmpDir);
    expect(result.toLowerCase()).toMatch(/go|vet|no errors|not installed/);
  });
});

describe("dispatchTool — resolve_import (multi-language)", () => {
  test("TypeScript/JS: resolves named import", () => {
    write("src/lib/AuthService.ts", "export class AuthService { login() {} }");
    write("src/handlers/userHandler.ts", `import { AuthService } from "../lib/AuthService";\nclass UserHandler {}`);
    const idx = indexProject(tmpDir, null);
    const result = dispatchTool(
      "resolve_import",
      { file: "src/handlers/userHandler.ts", symbol: "AuthService" },
      idx, tmpDir,
    );
    expect(result).toContain("AuthService.ts");
    expect(result).toContain("class AuthService");
  });

  test("Python: resolves 'from x import Y'", () => {
    write("app/services/auth.py", "class AuthService:\n    def login(self): pass");
    write("app/handlers/user.py", "from app.services.auth import AuthService\nclass UserHandler: pass");
    const idx = indexProject(tmpDir, null);
    const result = dispatchTool(
      "resolve_import",
      { file: "app/handlers/user.py", symbol: "AuthService" },
      idx, tmpDir,
    );
    expect(result).toContain("auth.py");
    expect(result).toContain("class AuthService");
  });

  test("PHP: resolves 'use App\\Foo'", () => {
    write("src/Auth/AuthService.php", "<?php\nnamespace App\\Auth;\nclass AuthService {}");
    write("src/Handler/UserHandler.php", "<?php\nuse App\\Auth\\AuthService;\nclass UserHandler {}");
    const idx = indexProject(tmpDir, null);
    const result = dispatchTool(
      "resolve_import",
      { file: "src/Handler/UserHandler.php", symbol: "AuthService" },
      idx, tmpDir,
    );
    expect(result).toContain("AuthService.php");
  });

  test("returns 'not imported' when symbol is not in the file's imports", () => {
    write("src/a.ts", "export const a = 1;");
    write("src/b.ts", "import { a } from './a';");
    const idx = indexProject(tmpDir, null);
    const result = dispatchTool(
      "resolve_import",
      { file: "src/b.ts", symbol: "NeverImported" },
      idx, tmpDir,
    );
    expect(result.toLowerCase()).toMatch(/not imported|not found/);
  });
});

describe("dispatchTool — list_todos", () => {
  test("finds TODO, FIXME, XXX, HACK markers across the project", () => {
    write("src/a.ts", "// TODO: implement caching\nexport function x() {}");
    write("src/b.ts", "/* FIXME: race condition */ export function y() {}");
    write("src/c.ts", "// XXX: this is hacky\n// HACK: workaround for bug 123");
    write("src/clean.ts", "// nothing to see here\nexport const z = 1;");
    const idx = indexProject(tmpDir, null);
    const result = dispatchTool("list_todos", {}, idx, tmpDir);
    expect(result).toMatch(/TODO/);
    expect(result).toMatch(/FIXME/);
    expect(result).toMatch(/XXX/);
    expect(result).toMatch(/HACK/);
    expect(result).toContain("implement caching");
    expect(result).toContain("race condition");
  });

  test("filters by path substring", () => {
    write("src/auth/login.ts", "// TODO: add 2FA");
    write("src/payments/charge.ts", "// TODO: handle refunds");
    const idx = indexProject(tmpDir, null);
    const result = dispatchTool("list_todos", { path_filter: "auth" }, idx, tmpDir);
    expect(result).toContain("2FA");
    expect(result).not.toContain("refunds");
  });

  test("returns empty-list message when no TODOs", () => {
    write("src/clean.ts", "export const ok = 1;");
    const idx = indexProject(tmpDir, null);
    const result = dispatchTool("list_todos", {}, idx, tmpDir);
    expect(result.toLowerCase()).toMatch(/no todos|nothing|empty/);
  });
});

describe("dispatchTool — auto-truncate huge results", () => {
  test("read_file truncates extremely long single results with marker", () => {
    // Generate a 500-line file
    const longBody = Array.from({ length: 500 }, (_, i) => `  // line ${i + 1}: ${"x".repeat(80)}`).join("\n");
    write("src/big.ts", `export function huge() {\n${longBody}\n}\n`);
    const idx = indexProject(tmpDir, null);
    // Read 500 lines but expect truncation since output exceeds budget
    const result = dispatchTool(
      "read_file",
      { path: "src/big.ts", offset: 1, limit: 500 },
      idx,
      tmpDir,
    );
    // Either it returns all (if under budget) or it truncates with a clear marker
    if (result.length > 30000) {
      // Not truncated — fail explicitly so we notice
      throw new Error("read_file returned " + result.length + " chars, should have been truncated");
    }
    // If truncated, the marker should be present
    expect(result.length).toBeLessThan(30000);
  });
});

describe("dispatchTool — investigate (combined tool)", () => {
  test("returns definition + references + tests in one call", () => {
    write("src/lib/AuthService.ts", `
export class AuthService {
  login(user: string) { return true; }
}
`);
    write("src/services/UserController.ts", `
import { AuthService } from "../lib/AuthService";
export class UserController {
  constructor(private auth: AuthService) {}
}
`);
    write("tests/AuthService.test.ts", `
import { AuthService } from "../src/lib/AuthService";
test("login", () => { new AuthService().login("x"); });
`);
    const idx = indexProject(tmpDir, null);
    const result = dispatchTool("investigate", { name: "AuthService" }, idx, tmpDir);
    // Definition section
    expect(result).toMatch(/DEFINITION/i);
    expect(result).toContain("class AuthService");
    // References section
    expect(result).toMatch(/REFERENCES|USED BY|CALLERS/i);
    expect(result).toContain("UserController");
    // Tests section
    expect(result).toMatch(/TESTS/i);
    expect(result).toContain("AuthService.test.ts");
  });

  test("handles unknown symbol gracefully", () => {
    write("src/a.ts", "export const x = 1;");
    const idx = indexProject(tmpDir, null);
    const result = dispatchTool("investigate", { name: "TotallyUnknown" }, idx, tmpDir);
    expect(result.toLowerCase()).toMatch(/not found|no.*found/);
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
