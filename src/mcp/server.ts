import * as readline from "readline";
import * as fs from "fs";
import * as path from "path";
import { loadIndex, saveIndex } from "../adapters/storage/index-file";
import { trackToolCall, saveSessionLog } from "./session-tracker";
import { Index, indexProject } from "../core/indexer";
import { cacheGet, cacheSet, clearToolCacheForTests } from "./runtime/cache";
import { JsonRpcRequest, send, ok, err, log } from "./runtime/jsonrpc";
import { recordToolCall } from "./runtime/telemetry";

// Re-export test helpers for the existing test files.
export { cacheGet, cacheSet, clearToolCacheForTests };

// Tools whose results are deterministic given the same args+index — safe to cache.
// Excluded: read_file (cheap, mtime-sensitive), list_symbols & find_file (already index-only).
const CACHEABLE = new Set(["search_code", "get_symbol", "find_references", "get_context", "find_writes", "git_context", "recent_changes", "call_chain", "list_entrypoints", "explain", "event_handlers", "impact_analysis", "config_lookup", "interface_implementations", "pattern_search", "tests_for", "hot_files", "dead_code", "investigate", "list_todos", "resolve_import", "outline"]);

import { LEXIS_INSTRUCTIONS, buildSessionInstructions } from "./instructions";

import { TOOLS } from "./tools-registry";

// Search/output utilities live in runtime/search-utils + runtime/path-utils.
// Re-exported for existing tests.
import { findEnclosingSignatures, truncateIfExcessive, rankFiles, identTokens, globToRegex } from "./runtime/search-utils";
import { baseFileName, compressPaths, formatPathList } from "./runtime/path-utils";
export { findEnclosingSignatures, truncateIfExcessive, rankFiles, identTokens, globToRegex };
export { baseFileName, compressPaths, formatPathList };

// Token-saving mode controlled by LEXIS_COMPRESSION env var.
//   default | compact: regular output (current behavior)
//   ultra:             aggressive — no decoratives, telegraphic, 1-line tool descs
//
// Tool filtering, linter detection and ultra-compact descriptions live in their
// own module. Re-exported here so existing tests keep their import paths.
import { isUltraMode, filterToolsForProject, detectLinter } from "./tool-filtering";
export { isUltraMode, filterToolsForProject, detectLinter };
export type { LinterSpec } from "./tool-filtering";

// Tool handlers, one family per file under src/mcp/tools/. The dispatcher
// below is the only consumer; nothing else should import these directly.
import { execSearchCode } from "./tools/search-code";
import { execReadFile, resetSessionState, readRangeKey } from "./tools/read-file";
import { execListSymbols, execFindFile, execGetSymbol } from "./tools/symbols";
import { execFindReferences, execGetContext, execFindWrites } from "./tools/references";
import { execGitContext, execHotFiles, execRecentChanges } from "./tools/git";
import { execCallChain, execListEntrypoints } from "./tools/flow";
import { execPatternSearch, execTestsFor } from "./tools/patterns";
import {
  execDeadCode, execConfigLookup, execInterfaceImplementations,
  execEventHandlers, execImpactAnalysis,
} from "./tools/structure";
import { execExplain } from "./tools/explain";
import { execInvestigate } from "./tools/investigate";
import { execNote, execNotes, execForget } from "./tools/notes";
import { execLint, execResolveImport, execOutline, execListTodos } from "./tools/meta";

// Re-export session-state helpers used by tests.
export { resetSessionState, readRangeKey };

export function dispatchTool(
  name: string,
  args: Record<string, unknown>,
  index: Index,
  projectPath: string
): string {
  // Include projectPath so multiple MCP instances or tests against different
  // projects don't share results. Also include compression mode — same args
  // produce different output in ultra vs normal.
  const compMode = process.env["LEXIS_COMPRESSION"] ?? "normal";
  const cacheKey = CACHEABLE.has(name) ? `${projectPath}:${compMode}:${name}:${stableStringify(args)}` : null;
  const tStart = Date.now();
  if (cacheKey) {
    const cached = cacheGet(cacheKey);
    if (cached !== null) {
      log(`[cache hit] ${name}`);
      recordToolCall({ tool: name, args, result: cached, ms: Date.now() - tStart, cached: true, projectPath });
      return cached;
    }
  }

  let result: string;
  const t0 = Date.now();
  switch (name) {
    case "search_code":      result = execSearchCode(args, index, projectPath); break;
    case "read_file":        result = execReadFile(args, projectPath, index); break;
    case "list_symbols":     result = execListSymbols(args, index); break;
    case "find_file":        result = execFindFile(args, index); break;
    case "get_symbol":       result = execGetSymbol(args, index, projectPath); break;
    case "find_references":  result = execFindReferences(args, index, projectPath); break;
    case "get_context":      result = execGetContext(args, index, projectPath); break;
    case "find_writes":      result = execFindWrites(args, projectPath); break;
    case "git_context":      result = execGitContext(args, projectPath); break;
    case "recent_changes":   result = execRecentChanges(args, index, projectPath); break;
    case "call_chain":       result = execCallChain(args, index, projectPath); break;
    case "list_entrypoints": result = execListEntrypoints(args, index, projectPath); break;
    case "explain":          result = execExplain(args, index, projectPath); break;
    case "event_handlers":   result = execEventHandlers(args, projectPath); break;
    case "impact_analysis":  result = execImpactAnalysis(args, index, projectPath); break;
    case "config_lookup":    result = execConfigLookup(args, projectPath); break;
    case "interface_implementations": result = execInterfaceImplementations(args, index, projectPath); break;
    case "pattern_search":   result = execPatternSearch(args, projectPath); break;
    case "tests_for":        result = execTestsFor(args, index, projectPath); break;
    case "hot_files":        result = execHotFiles(args, projectPath); break;
    case "dead_code":        result = execDeadCode(args, index, projectPath); break;
    case "note":             result = execNote(args, projectPath); break;
    case "notes":            result = execNotes(args, projectPath); break;
    case "forget":           result = execForget(args, projectPath); break;
    case "investigate":      result = execInvestigate(args, index, projectPath); break;
    case "list_todos":       result = execListTodos(args, projectPath); break;
    case "outline":          result = execOutline(args, index, projectPath); break;
    case "resolve_import":   result = execResolveImport(args, index, projectPath); break;
    case "lint":             result = execLint(args, projectPath); break;
    default:                 return `Unknown tool: ${name}`;
  }

  // Optional token-budget footer for diagnosing tool weight. Off by default
  // so we don't burn ~50 tokens per large response. Enable with LEXIS_DEBUG_FOOTER=1.
  if (process.env["LEXIS_DEBUG_FOOTER"] === "1") {
    const approxTokens = Math.round(result.length / 4);
    if (approxTokens >= 500) {
      const ms = Date.now() - t0;
      result = `${result}\n\n[~${approxTokens} tokens, ${ms}ms]`;
    }
  }

  if (cacheKey) cacheSet(cacheKey, result);
  recordToolCall({ tool: name, args, result, ms: Date.now() - tStart, cached: false, projectPath });
  return result;
}

// Sort keys so {"a":1,"b":2} and {"b":2,"a":1} hash to the same cache key.
function stableStringify(obj: Record<string, unknown>): string {
  const keys = Object.keys(obj).sort();
  const sorted: Record<string, unknown> = {};
  for (const k of keys) sorted[k] = obj[k];
  return JSON.stringify(sorted);
}

function buildIndex(resolvedPath: string, previous: Index | null, reason: string): Index {
  const t0 = Date.now();
  log(`[lexis mcp] ${reason} — indexing ${resolvedPath}...`);
  const idx = indexProject(resolvedPath, previous);
  saveIndex(idx, resolvedPath);
  log(`[lexis mcp] indexed ${idx.files.length} files, ${idx.symbols.length} symbols in ${Date.now() - t0}ms`);
  return idx;
}

// ── Auto-staleness detection ──────────────────────────────────────────────────
// Every 30s, scan mtimes of indexed files. If any changed → incremental re-index.
// Cost: ~1ms for mtime reads on typical projects. Keeps index fresh automatically.
const STALENESS_CHECK_MS = 30_000;
let lastStalenessCheck = 0;

function refreshIfStale(current: Index, resolvedPath: string): Index {
  const now = Date.now();
  if (now - lastStalenessCheck < STALENESS_CHECK_MS) return current;
  lastStalenessCheck = now;

  const indexTime = new Date(current.createdAt).getTime();

  // 1. Check existing indexed files for modifications
  const hasStaleFile = current.files.some((f) => {
    try { return fs.statSync(f).mtimeMs > indexTime; } catch { return true; }
  });

  // 2. Check all top-level directories for new files — creating a file updates the dir mtime.
  // Scanning first-level dirs covers any language/framework structure without a hardcoded list.
  const IGNORE_TOP = new Set([".git", "node_modules", "vendor", "dist", "build", ".next", "__pycache__"]);
  const topDirs: string[] = [resolvedPath]; // always check project root itself
  try {
    for (const entry of fs.readdirSync(resolvedPath, { withFileTypes: true })) {
      if (entry.isDirectory() && !IGNORE_TOP.has(entry.name)) {
        topDirs.push(path.join(resolvedPath, entry.name));
      }
    }
  } catch { /* ignore read errors */ }

  const hasNewFile = topDirs.some((dir) => {
    try { return fs.statSync(dir).mtimeMs > indexTime; } catch { return false; }
  });

  if (!hasStaleFile && !hasNewFile) return current;

  const reason = hasNewFile && !hasStaleFile ? "new file detected" : "file change detected";
  const updated = buildIndex(resolvedPath, current, `${reason} — auto re-index`);
  clearToolCacheForTests();
  return updated;
}

export function startMcpServer(projectPath: string): void {
  const resolvedPath = path.resolve(projectPath);
  log(`[lexis mcp] starting — project: ${resolvedPath}`);

  const existing = loadIndex(resolvedPath);
  let index: Index;

  if (!existing) {
    index = buildIndex(resolvedPath, null, "no index found");
  } else {
    const ageMin = (Date.now() - new Date(existing.createdAt).getTime()) / 60_000;
    if (ageMin > 60) {
      index = buildIndex(resolvedPath, existing, `index is ${Math.floor(ageMin)}min old — incremental refresh`);
    } else {
      index = existing;
      log(`[lexis mcp] index loaded — ${index.files.length} files, ${index.symbols.length} symbols`);
    }
  }

  // Pre-warm cache with queries Claude almost always issues at session start.
  // Runs async after this tick so MCP handshake (initialize) is not blocked.
  // Each tool result is cached identically to a real call — first user query is instant.
  setImmediate(() => {
    const t0 = Date.now();
    const warmTools: Array<{ name: string; args: Record<string, unknown> }> = [
      { name: "list_entrypoints", args: {} },
      { name: "recent_changes",   args: {} },
    ];
    for (const { name, args } of warmTools) {
      try {
        dispatchTool(name, args, index, resolvedPath);
      } catch (e) {
        log(`[lexis mcp] pre-warm ${name} failed: ${(e as Error).message}`);
      }
    }
    log(`[lexis mcp] cache pre-warmed (${warmTools.length} tools) in ${Date.now() - t0}ms`);
  });

  const rl = readline.createInterface({ input: process.stdin, terminal: false });

  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let request: JsonRpcRequest;
    try {
      request = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      // Notifications or malformed input — ignore
      return;
    }

    const { id, method, params } = request;

    switch (method) {
      case "initialize":
        ok(id, {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "lexis", version: "0.5.1" },
          instructions: buildSessionInstructions(resolvedPath),
        });
        break;

      case "notifications/initialized":
        // No response for notifications
        break;

      case "tools/list":
        ok(id, { tools: filterToolsForProject(TOOLS, resolvedPath) });
        break;

      case "tools/call": {
        const p = params as { name: string; arguments?: Record<string, unknown> };
        if (!p?.name) { err(id, -32602, "Missing tool name"); break; }

        const toolArgs = p.arguments ?? {};
        try {
          trackToolCall(p.name, toolArgs);
          index = refreshIfStale(index, resolvedPath);
          let result: string;
          if (p.name === "reindex") {
            index = buildIndex(resolvedPath, index, "reindex requested");
            clearToolCacheForTests();
            result = `Re-indexed: ${index.files.length} files, ${index.symbols.length} symbols. Cache cleared.`;
          } else {
            result = dispatchTool(p.name, toolArgs, index, resolvedPath);
          }
          ok(id, { content: [{ type: "text", text: result }] });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          ok(id, { content: [{ type: "text", text: `Error: ${msg}` }], isError: true });
        }
        break;
      }

      default:
        if (id !== null && id !== undefined) {
          err(id, -32601, `Method not found: ${method}`);
        }
    }
  });

  rl.on("close", () => {
    log("[lexis mcp] stdin closed, saving session log...");
    saveSessionLog(resolvedPath);
    process.exit(0);
  });

  // Defensive: also save on uncaught exceptions and signals so abrupt terminal
  // kills (Ctrl+C in the parent shell, OS shutdown, etc.) don't lose context.
  // Note: SIGKILL can't be intercepted — that's why we also persist every 2 min.
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as NodeJS.Signals[]) {
    process.on(sig, () => {
      try { saveSessionLog(resolvedPath); } catch { /* ignore */ }
      process.exit(0);
    });
  }
  process.on("uncaughtException", (e) => {
    log(`[lexis mcp] uncaught: ${(e as Error).message}`);
    try { saveSessionLog(resolvedPath); } catch { /* ignore */ }
    process.exit(1);
  });
}

// `send` and `LEXIS_INSTRUCTIONS` re-exported for test convenience.
export { send, LEXIS_INSTRUCTIONS };
