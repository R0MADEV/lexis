// Tests for session tracker — captures activity during an MCP session and
// persists it as an auto-tagged note when the server shuts down.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  trackToolCall,
  saveSessionLog,
  resetSessionForTests,
  getSessionStateForTests,
} from "../mcp/session-tracker";
import { searchNotes } from "../adapters/storage/notes-file";
import { cleanupTmpProject } from "./test-utils";

let tmpDir: string;

function initFeatureBranchRepo(branch: string = "feature/x") {
  const child = require("child_process");
  child.spawnSync("git", ["init", "-q", "-b", branch, tmpDir]);
  child.spawnSync("git", ["-C", tmpDir, "config", "user.email", "t@t.com"]);
  child.spawnSync("git", ["-C", tmpDir, "config", "user.name", "t"]);
  fs.writeFileSync(path.join(tmpDir, "x"), "x");
  child.spawnSync("git", ["-C", tmpDir, "add", "."]);
  child.spawnSync("git", ["-C", tmpDir, "commit", "-q", "-m", "init"]);
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lexis-tracker-"));
  resetSessionForTests();
});

afterEach(() => {
  cleanupTmpProject(tmpDir);
});

describe("trackToolCall — captures search/symbol/file activity", () => {
  test("counts every tool call", () => {
    trackToolCall("search_code", { query: "x" });
    trackToolCall("get_symbol", { name: "Y" });
    trackToolCall("read_file", { path: "src/a.ts" });
    expect(getSessionStateForTests().toolCalls).toBe(3);
  });

  test("captures search queries from search_code and pattern_search", () => {
    trackToolCall("search_code", { query: "AuthService" });
    trackToolCall("pattern_search", { pattern: "console\\.log" });
    const state = getSessionStateForTests();
    expect(state.searchQueries).toContain("AuthService");
    expect(state.searchQueries).toContain("console\\.log");
  });

  test("captures symbols inspected from get_symbol/find_references/etc.", () => {
    trackToolCall("get_symbol", { name: "PaymentProcessor" });
    trackToolCall("find_references", { symbol: "AuthService" });
    trackToolCall("call_chain", { name: "login" });
    const state = getSessionStateForTests();
    expect(state.symbolsInspected).toContain("PaymentProcessor");
    expect(state.symbolsInspected).toContain("AuthService");
    expect(state.symbolsInspected).toContain("login");
  });

  test("captures files read", () => {
    trackToolCall("read_file", { path: "src/a.ts" });
    trackToolCall("read_file", { path: "src/b.ts" });
    expect(getSessionStateForTests().filesRead).toEqual(
      expect.arrayContaining(["src/a.ts", "src/b.ts"]),
    );
  });

  test("counts manual notes", () => {
    trackToolCall("note", { content: "first" });
    trackToolCall("note", { content: "second" });
    expect(getSessionStateForTests().manualNotes).toBe(2);
  });

  test("ignores irrelevant tools", () => {
    trackToolCall("reindex", {});
    const state = getSessionStateForTests();
    expect(state.toolCalls).toBe(1);
    expect(state.searchQueries).toEqual([]);
    expect(state.symbolsInspected).toEqual([]);
  });
});

describe("saveSessionLog", () => {
  test("does NOT save on main/master branches", () => {
    const child = require("child_process");
    child.spawnSync("git", ["init", "-q", "-b", "main", tmpDir]);
    child.spawnSync("git", ["-C", tmpDir, "config", "user.email", "t@t.com"]);
    child.spawnSync("git", ["-C", tmpDir, "config", "user.name", "t"]);
    fs.writeFileSync(path.join(tmpDir, "x"), "x");
    child.spawnSync("git", ["-C", tmpDir, "add", "."]);
    child.spawnSync("git", ["-C", tmpDir, "commit", "-q", "-m", "init"]);

    // Generate enough activity (>= 3 tool calls) so it's not "trivial"
    trackToolCall("search_code", { query: "a" });
    trackToolCall("search_code", { query: "b" });
    trackToolCall("search_code", { query: "c" });

    saveSessionLog(tmpDir);

    const notes = searchNotes(tmpDir, "auto-session");
    expect(notes).toHaveLength(0);
  });

  test("does NOT save when fewer than 3 tool calls", () => {
    initFeatureBranchRepo("feature/test");
    trackToolCall("search_code", { query: "a" });
    trackToolCall("search_code", { query: "b" });
    saveSessionLog(tmpDir);
    const notes = searchNotes(tmpDir, "auto-session");
    expect(notes).toHaveLength(0);
  });

  test("saves an auto-session note on a feature branch with enough activity", () => {
    initFeatureBranchRepo("feature/payment-flow");
    trackToolCall("search_code", { query: "AuthService" });
    trackToolCall("get_symbol", { name: "PaymentProcessor" });
    trackToolCall("read_file", { path: "src/payment.ts" });
    trackToolCall("read_file", { path: "src/auth.ts" });

    saveSessionLog(tmpDir);

    const notes = searchNotes(tmpDir, "auto-session");
    expect(notes.length).toBeGreaterThan(0);
    const log = notes[0]!.content;
    expect(log).toContain("feature/payment-flow");
    expect(log).toMatch(/4 tool calls/);
    expect(log).toContain("AuthService");
    expect(log).toContain("PaymentProcessor");
    expect(log).toContain("src/payment.ts");
  });

  test("is idempotent — multiple calls don't duplicate the note", () => {
    initFeatureBranchRepo("feature/test");
    trackToolCall("search_code", { query: "a" });
    trackToolCall("search_code", { query: "b" });
    trackToolCall("search_code", { query: "c" });

    saveSessionLog(tmpDir);
    saveSessionLog(tmpDir);
    saveSessionLog(tmpDir);

    const notes = searchNotes(tmpDir, "auto-session");
    expect(notes).toHaveLength(1);
  });
});
