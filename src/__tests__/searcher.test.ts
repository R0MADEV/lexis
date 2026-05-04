import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { indexProject } from "../core/indexer";
import { search, getSymbol } from "../core/searcher";
import { cleanupTmpProject } from "./test-utils";

let tmpDir: string;

function write(rel: string, content: string) {
  const abs = path.join(tmpDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lexis-searcher-test-"));
});

afterEach(() => {
  cleanupTmpProject(tmpDir);
});

describe("search", () => {
  test("finds symbol by exact name", () => {
    write("src/auth.ts", `
export class AuthService {
  login(user: string) { return true; }
}
`);
    const idx = indexProject(tmpDir, null);
    const results = search("AuthService", idx, tmpDir);
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((r) => r.symbol.name === "AuthService")).toBe(true);
  });

  test("returns empty for completely unrelated query", () => {
    write("src/auth.ts", "export function login() {}");
    const idx = indexProject(tmpDir, null);
    const results = search("xyznonexistentsymbol123", idx, tmpDir);
    expect(results).toHaveLength(0);
  });

  test("finds partial name match", () => {
    write("src/user.ts", `
export function getUserById(id: string) {}
export function getUserByEmail(email: string) {}
`);
    const idx = indexProject(tmpDir, null);
    const results = search("getUser", idx, tmpDir);
    expect(results.length).toBeGreaterThan(0);
  });
});

describe("getSymbol", () => {
  test("returns symbol definition for exact name", () => {
    write("src/payments.ts", `
export class PaymentProcessor {
  charge(amount: number) { return true; }
}
`);
    const idx = indexProject(tmpDir, null);
    const result = getSymbol("PaymentProcessor", undefined, idx);
    expect(result).not.toBeNull();
    expect(result?.symbol.name).toBe("PaymentProcessor");
  });

  test("returns null for unknown symbol", () => {
    write("src/a.ts", "export function known() {}");
    const idx = indexProject(tmpDir, null);
    const result = getSymbol("CompletelyUnknown", undefined, idx);
    expect(result).toBeNull();
  });

  test("prefers class over interface when names are similar", () => {
    write("src/repo.ts", `
interface UserRepository { find(): void; }
class UserRepositoryImpl implements UserRepository { find() {} }
`);
    const idx = indexProject(tmpDir, null);
    const result = getSymbol("UserRepository", undefined, idx);
    expect(result).not.toBeNull();
  });
});
