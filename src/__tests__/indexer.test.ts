import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { indexProject } from "../core/indexer";

let tmpDir: string;

function write(rel: string, content: string) {
  const abs = path.join(tmpDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lexis-indexer-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("indexProject — full index", () => {
  test("indexes TypeScript functions and classes", () => {
    write("src/auth.ts", `
export class AuthService {
  login(user: string) { return true; }
  logout() {}
}
export function hashPassword(pw: string): string { return pw; }
`);
    const idx = indexProject(tmpDir, null);
    const names = idx.symbols.map((s) => s.name);
    expect(names).toContain("AuthService");
    expect(names).toContain("hashPassword");
    expect(idx.files).toContain(path.join(tmpDir, "src/auth.ts"));
  });

  test("ignores node_modules and dist", () => {
    write("src/index.ts", "export const a = 1;");
    write("node_modules/lib/index.ts", "export const b = 2;");
    write("dist/index.js", "exports.c = 3;");

    const idx = indexProject(tmpDir, null);
    const files = idx.files;
    expect(files.some((f) => f.includes("node_modules"))).toBe(false);
    expect(files.some((f) => f.includes("dist"))).toBe(false);
    expect(files.some((f) => f.includes("src/index.ts"))).toBe(true);
  });

  test("indexes Python functions", () => {
    write("app/utils.py", `
def parse_date(value):
    pass

class DateParser:
    def run(self): pass
`);
    const idx = indexProject(tmpDir, null);
    const names = idx.symbols.map((s) => s.name);
    expect(names).toContain("parse_date");
    expect(names).toContain("DateParser");
  });

  test("indexes Go functions", () => {
    write("main.go", `
package main

func main() {}
func handleRequest(w http.ResponseWriter, r *http.Request) {}
type Server struct{}
`);
    const idx = indexProject(tmpDir, null);
    const names = idx.symbols.map((s) => s.name);
    expect(names).toContain("main");
    expect(names).toContain("handleRequest");
    expect(names).toContain("Server");
  });

  test("createdAt is set", () => {
    write("a.ts", "const x = 1;");
    const idx = indexProject(tmpDir, null);
    expect(idx.createdAt).toBeTruthy();
    expect(new Date(idx.createdAt).getTime()).toBeLessThanOrEqual(Date.now());
  });
});

describe("indexProject — any language/framework structure", () => {
  test("indexes files in non-standard dirs: components/, handlers/, models/", () => {
    write("components/Button.tsx", "export function Button() {}");
    write("handlers/userHandler.go", "func GetUser(w http.ResponseWriter, r *http.Request) {}");
    write("models/user.py", "class User:\n    pass");
    const idx = indexProject(tmpDir, null);
    const names = idx.symbols.map((s) => s.name);
    expect(names).toContain("Button");
    expect(names).toContain("GetUser");
    expect(names).toContain("User");
  });

  test("indexes files in deeply nested dirs", () => {
    write("src/domain/user/repository/UserRepository.ts",
      "export class UserRepository { find() {} }");
    const idx = indexProject(tmpDir, null);
    expect(idx.symbols.map((s) => s.name)).toContain("UserRepository");
  });

  test("ignores node_modules, dist, build, .git in any structure", () => {
    write("src/real.ts", "export function realCode() {}");
    write("node_modules/lib/index.ts", "export function shouldIgnore() {}");
    write("dist/bundle.js", "function alsoIgnore() {}");
    write("build/output.ts", "function ignoreThis() {}");
    const idx = indexProject(tmpDir, null);
    const names = idx.symbols.map((s) => s.name);
    expect(names).toContain("realCode");
    expect(names).not.toContain("shouldIgnore");
    expect(names).not.toContain("alsoIgnore");
    expect(names).not.toContain("ignoreThis");
  });
});

describe("indexProject — incremental", () => {
  test("reuses symbols from unchanged files", () => {
    write("src/a.ts", "export function foo() {}");
    write("src/b.ts", "export function bar() {}");

    const full = indexProject(tmpDir, null);
    expect(full.symbols.map((s) => s.name)).toContain("foo");
    expect(full.symbols.map((s) => s.name)).toContain("bar");

    // Simulate incremental: nothing changed — all symbols should be kept
    const incremental = indexProject(tmpDir, full);
    expect(incremental.symbols.map((s) => s.name)).toContain("foo");
    expect(incremental.symbols.map((s) => s.name)).toContain("bar");
  });

  test("picks up new file added after full index", (done) => {
    write("src/a.ts", "export function foo() {}");
    const full = indexProject(tmpDir, null);

    // Wait 10ms so new file has a newer mtime than index.createdAt
    setTimeout(() => {
      write("src/b.ts", "export function newFunc() {}");
      const incremental = indexProject(tmpDir, full);
      expect(incremental.symbols.map((s) => s.name)).toContain("newFunc");
      done();
    }, 20);
  });

  test("picks up new file in non-standard dir (components/, handlers/)", (done) => {
    write("src/a.ts", "export function existing() {}");
    const full = indexProject(tmpDir, null);

    setTimeout(() => {
      write("components/NewComponent.tsx", "export function NewComponent() {}");
      write("handlers/newHandler.go", "func NewHandler() {}");
      const incremental = indexProject(tmpDir, full);
      const names = incremental.symbols.map((s) => s.name);
      expect(names).toContain("NewComponent");
      expect(names).toContain("NewHandler");
      done();
    }, 20);
  });

  test("drops symbols from deleted files", () => {
    write("src/a.ts", "export function toDelete() {}");
    write("src/b.ts", "export function toKeep() {}");
    const full = indexProject(tmpDir, null);

    fs.unlinkSync(path.join(tmpDir, "src/a.ts"));
    const incremental = indexProject(tmpDir, full);
    const names = incremental.symbols.map((s) => s.name);
    expect(names).not.toContain("toDelete");
    expect(names).toContain("toKeep");
  });
});
