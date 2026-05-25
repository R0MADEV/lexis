// Telemetry — append one JSON line per tool call to a daily file under
// ~/.lexis/telemetry/YYYY-MM-DD.jsonl. Used to measure baseline token cost
// and which tools are expensive, before designing token-saving features.
//
// On by default. Disable by exporting LEXIS_TELEMETRY=0.
//
// Output schema (one per call):
//   {
//     ts:         ISO-8601 timestamp,
//     tool:       string,        // tool name
//     project:    string,        // basename of project root
//     args_hash:  string,        // sha1(args) first 8 chars — groups identical calls
//     tokens_out: number,        // ceil(result.length / 4)
//     bytes_out:  number,        // result.length
//     ms:         number,        // duration in ms
//     cached:     boolean        // true if served from cache
//   }

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";

const DEFAULT_TELEMETRY_DIR = path.join(os.homedir(), ".lexis", "telemetry");
// Tests / sandboxed environments can redirect output by setting LEXIS_TELEMETRY_DIR.
function telemetryDir(): string {
  return process.env["LEXIS_TELEMETRY_DIR"] ?? DEFAULT_TELEMETRY_DIR;
}

const ensuredDirs = new Set<string>();
function ensureDir(dir: string): boolean {
  if (ensuredDirs.has(dir)) return true;
  try {
    fs.mkdirSync(dir, { recursive: true });
    ensuredDirs.add(dir);
    return true;
  } catch {
    return false;
  }
}

function todayFile(dir: string): string {
  const d = new Date();
  const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return path.join(dir, `${stamp}.jsonl`);
}

function hashArgs(args: Record<string, unknown>): string {
  const keys = Object.keys(args).sort();
  const canonical: Record<string, unknown> = {};
  for (const k of keys) canonical[k] = args[k];
  return crypto.createHash("sha1").update(JSON.stringify(canonical)).digest("hex").slice(0, 8);
}

export interface ToolCallRecord {
  tool: string;
  args: Record<string, unknown>;
  result: string;
  ms: number;
  cached: boolean;
  projectPath: string;
}

export function recordToolCall(record: ToolCallRecord): void {
  if (process.env["LEXIS_TELEMETRY"] === "0") return;
  // Jest sets JEST_WORKER_ID on every test worker — suppress to keep
  // real-usage stats clean. Tests can opt back in with LEXIS_TELEMETRY=1.
  if (process.env["JEST_WORKER_ID"] && process.env["LEXIS_TELEMETRY"] !== "1") return;

  const dir = telemetryDir();
  if (!ensureDir(dir)) return;

  const line: Record<string, unknown> = {
    ts: new Date().toISOString(),
    tool: record.tool,
    project: path.basename(record.projectPath),
    args_hash: hashArgs(record.args),
    tokens_out: Math.ceil(record.result.length / 4),
    bytes_out: record.result.length,
    ms: record.ms,
    cached: record.cached,
  };

  try {
    fs.appendFileSync(todayFile(dir), JSON.stringify(line) + "\n");
  } catch {
    // Never let telemetry crash a tool call.
  }
}

// Exposed for tests: invalidate the memoized "I've already made this dir" set.
export function _resetTelemetryDirCacheForTests(): void {
  ensuredDirs.clear();
}
