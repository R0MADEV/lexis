import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { indexProject } from "../core/indexer";
import { dispatchTool, clearToolCacheForTests } from "../mcp/server";
import { recordToolCall, _resetTelemetryDirCacheForTests } from "../mcp/runtime/telemetry";
import { cleanupTmpProject } from "./test-utils";

let tmpDir: string;
let telemetryDir: string;

const originalEnv = {
  LEXIS_TELEMETRY: process.env["LEXIS_TELEMETRY"],
  LEXIS_TELEMETRY_DIR: process.env["LEXIS_TELEMETRY_DIR"],
};

function readToday(): Array<Record<string, unknown>> {
  const d = new Date();
  const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const file = path.join(telemetryDir, `${stamp}.jsonl`);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf-8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lexis-telemetry-test-"));
  telemetryDir = fs.mkdtempSync(path.join(os.tmpdir(), "lexis-telemetry-out-"));
  process.env["LEXIS_TELEMETRY"] = "1";          // opt back in inside jest
  process.env["LEXIS_TELEMETRY_DIR"] = telemetryDir;
  _resetTelemetryDirCacheForTests();
  clearToolCacheForTests();
});

afterEach(() => {
  cleanupTmpProject(tmpDir);
  fs.rmSync(telemetryDir, { recursive: true, force: true });
  if (originalEnv.LEXIS_TELEMETRY === undefined) delete process.env["LEXIS_TELEMETRY"];
  else process.env["LEXIS_TELEMETRY"] = originalEnv.LEXIS_TELEMETRY;
  if (originalEnv.LEXIS_TELEMETRY_DIR === undefined) delete process.env["LEXIS_TELEMETRY_DIR"];
  else process.env["LEXIS_TELEMETRY_DIR"] = originalEnv.LEXIS_TELEMETRY_DIR;
  _resetTelemetryDirCacheForTests();
});

describe("recordToolCall — unit", () => {
  test("writes a JSONL line with all expected fields", () => {
    recordToolCall({
      tool: "search_code",
      args: { query: "foo" },
      result: "x".repeat(40),  // 40 bytes → 10 tokens
      ms: 12,
      cached: false,
      projectPath: "/Users/test/myproject",
    });

    const lines = readToday();
    expect(lines).toHaveLength(1);
    const r = lines[0]!;
    expect(r["tool"]).toBe("search_code");
    expect(r["project"]).toBe("myproject");
    expect(r["tokens_out"]).toBe(10);
    expect(r["bytes_out"]).toBe(40);
    expect(r["ms"]).toBe(12);
    expect(r["cached"]).toBe(false);
    expect(typeof r["args_hash"]).toBe("string");
    expect((r["args_hash"] as string).length).toBe(8);
    expect(typeof r["ts"]).toBe("string");
    expect(() => new Date(r["ts"] as string)).not.toThrow();
  });

  test("args_hash is deterministic and order-independent", () => {
    recordToolCall({ tool: "x", args: { a: 1, b: 2 }, result: "", ms: 0, cached: false, projectPath: "/p" });
    recordToolCall({ tool: "x", args: { b: 2, a: 1 }, result: "", ms: 0, cached: false, projectPath: "/p" });
    recordToolCall({ tool: "x", args: { a: 1, b: 3 }, result: "", ms: 0, cached: false, projectPath: "/p" });

    const lines = readToday();
    expect(lines).toHaveLength(3);
    expect(lines[0]!["args_hash"]).toBe(lines[1]!["args_hash"]);  // same args, different order
    expect(lines[0]!["args_hash"]).not.toBe(lines[2]!["args_hash"]);  // different args
  });

  test("appends multiple calls to the same file", () => {
    for (let i = 0; i < 5; i++) {
      recordToolCall({ tool: `t${i}`, args: {}, result: "", ms: 0, cached: false, projectPath: "/p" });
    }
    expect(readToday()).toHaveLength(5);
  });

  test("tokens_out uses ceil(bytes/4)", () => {
    recordToolCall({ tool: "t", args: {}, result: "abc", ms: 0, cached: false, projectPath: "/p" });   // 3 → 1
    recordToolCall({ tool: "t", args: {}, result: "abcd", ms: 0, cached: false, projectPath: "/p" });  // 4 → 1
    recordToolCall({ tool: "t", args: {}, result: "abcde", ms: 0, cached: false, projectPath: "/p" }); // 5 → 2
    const lines = readToday();
    expect(lines.map((l) => l["tokens_out"])).toEqual([1, 1, 2]);
  });

  test("does not write when LEXIS_TELEMETRY=0 (explicit opt-out)", () => {
    process.env["LEXIS_TELEMETRY"] = "0";
    recordToolCall({ tool: "t", args: {}, result: "x", ms: 0, cached: false, projectPath: "/p" });
    expect(readToday()).toHaveLength(0);
  });

  test("does not write when JEST_WORKER_ID is set and LEXIS_TELEMETRY is unset", () => {
    delete process.env["LEXIS_TELEMETRY"];
    // JEST_WORKER_ID is already set by Jest itself, so this exercises the real guard.
    expect(process.env["JEST_WORKER_ID"]).toBeDefined();
    recordToolCall({ tool: "t", args: {}, result: "x", ms: 0, cached: false, projectPath: "/p" });
    expect(readToday()).toHaveLength(0);
  });

  test("survives disk failure without throwing", () => {
    // Point telemetry at an unwritable location. mkdirSync on a path under a
    // non-existent device-like prefix will fail; recordToolCall must swallow it.
    process.env["LEXIS_TELEMETRY_DIR"] = "/dev/null/does/not/exist";
    _resetTelemetryDirCacheForTests();
    expect(() => recordToolCall({
      tool: "t", args: {}, result: "x", ms: 0, cached: false, projectPath: "/p",
    })).not.toThrow();
  });
});

describe("dispatchTool — telemetry integration", () => {
  test("records one line per non-cached call", () => {
    const file = path.join(tmpDir, "src/a.ts");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "export class Foo {}");
    const idx = indexProject(tmpDir, null);

    dispatchTool("get_symbol", { name: "Foo" }, idx, tmpDir);

    const lines = readToday();
    expect(lines).toHaveLength(1);
    expect(lines[0]!["tool"]).toBe("get_symbol");
    expect(lines[0]!["cached"]).toBe(false);
    expect(lines[0]!["project"]).toBe(path.basename(tmpDir));
  });

  test("records cache hit with cached=true on repeated identical call", () => {
    const file = path.join(tmpDir, "src/a.ts");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "export class Foo {}");
    const idx = indexProject(tmpDir, null);

    dispatchTool("get_symbol", { name: "Foo" }, idx, tmpDir);
    dispatchTool("get_symbol", { name: "Foo" }, idx, tmpDir);

    const lines = readToday();
    expect(lines).toHaveLength(2);
    expect(lines[0]!["cached"]).toBe(false);
    expect(lines[1]!["cached"]).toBe(true);
    // Same args → same hash on both lines
    expect(lines[0]!["args_hash"]).toBe(lines[1]!["args_hash"]);
  });
});
