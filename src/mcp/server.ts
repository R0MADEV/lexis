import * as readline from "readline";
import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";
import { search, getSymbol, findReferences, getContext, suggestSimilar, SearchResult, Suggestion } from "../core/searcher";
import { QueryIntent, extractTechnicalTerms } from "../core/query-analyzer";
import { loadIndex, saveIndex } from "../adapters/storage/index-file";
import { addNote, removeNote, searchNotes } from "../adapters/storage/notes-file";
import { Index, Symbol as IndexedSymbol, indexProject } from "../core/indexer";

// All diagnostic output goes to stderr so it doesn't corrupt the stdio MCP protocol
const log = (...args: unknown[]) => process.stderr.write(args.join(" ") + "\n");

// ── In-memory LRU cache for tool results ─────────────────────────────────────
// Saves repeated ripgrep / git invocations when Claude chains queries on the
// same symbol. TTL bounds staleness when files change mid-session.
const CACHE_MAX = 100;
const CACHE_TTL_MS = 5 * 60 * 1000;
const toolCache = new Map<string, { value: string; expires: number }>();

function cacheGet(key: string): string | null {
  const hit = toolCache.get(key);
  if (!hit) return null;
  if (hit.expires < Date.now()) { toolCache.delete(key); return null; }
  // refresh LRU position
  toolCache.delete(key);
  toolCache.set(key, hit);
  return hit.value;
}

function cacheSet(key: string, value: string): void {
  if (toolCache.size >= CACHE_MAX) {
    const oldest = toolCache.keys().next().value;
    if (oldest !== undefined) toolCache.delete(oldest);
  }
  toolCache.set(key, { value, expires: Date.now() + CACHE_TTL_MS });
}

// ── Ripgrep resolution ────────────────────────────────────────────────────────
// @vscode/ripgrep bundles the rg binary — always available after npm install.
// Falls back to system rg if for some reason the bundled one is missing.
let _rgPath: string | null | undefined = undefined;

function resolveRg(): string | null {
  if (_rgPath !== undefined) return _rgPath;
  try {
    const { rgPath } = require("@vscode/ripgrep") as { rgPath: string };
    if (rgPath && fs.existsSync(rgPath)) { _rgPath = rgPath; return rgPath; }
  } catch { /* not bundled */ }
  const lookup = process.platform === "win32" ? "where" : "which";
  const r = spawnSync(lookup, ["rg"], { encoding: "utf-8" });
  const found = r.stdout?.split(/\r?\n/)[0]?.trim();
  if (found && fs.existsSync(found)) { _rgPath = found; return found; }
  _rgPath = null;
  log("[warn] ripgrep not found — search tools will return empty results");
  return null;
}

function runRg(args: string[]): { stdout: string; stderr: string } {
  const rg = resolveRg();
  if (!rg) return { stdout: "", stderr: "ripgrep not available" };
  const r = spawnSync(rg, args, { encoding: "utf-8" });
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

// Tools whose results are deterministic given the same args+index — safe to cache.
// Excluded: read_file (cheap, mtime-sensitive), list_symbols & find_file (already index-only).
const CACHEABLE = new Set(["search_code", "get_symbol", "find_references", "get_context", "find_writes", "git_context", "recent_changes", "call_chain", "list_entrypoints", "explain", "event_handlers", "impact_analysis", "config_lookup", "interface_implementations", "pattern_search", "tests_for", "hot_files", "dead_code"]);

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string | null;
  method: string;
  params?: unknown;
}

type JsonRpcResponse =
  | { jsonrpc: "2.0"; id: number | string | null; result: unknown }
  | { jsonrpc: "2.0"; id: number | string | null; error: { code: number; message: string } };

function send(msg: JsonRpcResponse): void {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function ok(id: number | string | null, result: unknown): void {
  send({ jsonrpc: "2.0", id, result });
}

function err(id: number | string | null, code: number, message: string): void {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

const LEXIS_INSTRUCTIONS = `Lexis — lexical + structural code search.

Use Lexis tools as your PRIMARY way to navigate this codebase. Do NOT read entire files when you can search.

WORKFLOW (follow on first query):
1. notes — recall context from previous sessions
2. list_entrypoints — understand structure (routes, handlers, CLI commands)
3. search_code — find symbols/code by keyword (compact output, ~50 tokens/result)
4. get_symbol — get a function/class implementation by exact name
5. read_file with offset/limit — only when you need a specific range

RULES:
- Default to output='compact'. Use 'content' only when you need 2+ full implementations.
- For bugs: use search_code with context='bug' (auto depth=2, prioritizes callers + error handlers)
- For features: use search_code with context='feature' (prioritizes types + patterns)
- To follow a flow: use call_chain (upstream/downstream)
- To assess change risk: use impact_analysis before refactoring
- Save findings with note(content, tags, files) so future sessions don't re-discover them
- If results seem stale or a recent file is missing, call reindex

TOKEN BUDGET:
- snippet (~15 tok) → orient
- compact (default, ~50 tok) → standard
- content (~500 tok) → full implementation, use sparingly
- files / count → when you only need paths or a number`;

const TOOLS = [
  {
    name: "search_code",
    description: "Search code chunks. output: 'snippet'(~15tok/result — match line ±1 with line numbers, best for exploration), 'compact'(default,~50tok/result — signature+first body line), 'content'(~500tok/result), 'files', 'count', 'trace'(call topology,~10tok/symbol), 'signatures'(one-line sigs,~5tok/result), 'arch'(one result per layer: route→controller→service→repository→model). depth: 1(default,exact), 2(concept). top_k: default 3. context: 'bug'(prioritizes callers+error handlers, auto depth=2), 'feature'(prioritizes types+patterns).",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search terms or identifier name" },
        output: { type: "string", enum: ["snippet", "content", "compact", "files", "count", "trace", "signatures", "arch"] },
        top_k: { type: "number" },
        depth: { type: "number" },
        context: { type: "string", enum: ["bug", "feature", "general"] },
      },
      required: ["query"],
    },
  },
  {
    name: "read_file",
    description: "Read file with line range. offset=start line, limit=max lines (default 80). Use 20-50 line windows.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        offset: { type: "number" },
        limit: { type: "number" },
      },
      required: ["path"],
    },
  },
  {
    name: "list_symbols",
    description: "List indexed functions/classes. Filter by file_filter or name_filter substrings.",
    inputSchema: {
      type: "object",
      properties: {
        file_filter: { type: "string" },
        name_filter: { type: "string" },
      },
    },
  },
  {
    name: "find_file",
    description: "Find files whose path contains pattern.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string" },
      },
      required: ["pattern"],
    },
  },
  {
    name: "get_symbol",
    description: "Get the full implementation of a named symbol (function/class). One call instead of list_symbols + read_file.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Symbol name (exact or partial)" },
        file_filter: { type: "string", description: "Optional: filter by file path substring" },
      },
      required: ["name"],
    },
  },
  {
    name: "find_references",
    description: "Find all usages of a symbol: calls, imports, type refs, definition. depth=2 traces callers-of-callers for full propagation chain (essential for deep bug analysis).",
    inputSchema: {
      type: "object",
      properties: {
        symbol: { type: "string", description: "Exact symbol name to find references for" },
        depth: { type: "number", description: "1=direct callers only (default), 2=callers of callers" },
      },
      required: ["symbol"],
    },
  },
  {
    name: "get_context",
    description: "Given a file + line number (from a stack trace or error), return the enclosing function, its callers, types it uses, and related tests. Best first tool for debugging.",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string", description: "File path (relative or absolute)" },
        line: { type: "number", description: "Line number from the stack trace or error" },
      },
      required: ["file", "line"],
    },
  },
  {
    name: "find_writes",
    description: "Find code that writes to a given file path or filename. Detects file_put_contents, fopen('w'), fs.writeFile, open(...,'w'), shell redirects (>, tee), and similar across PHP/JS/TS/Python/Ruby/Bash/Perl. Use when investigating bugs like 'config file not updating'.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Filename or path fragment to find writers for (e.g. 'listeners.cfg', '/etc/kamailio/')" },
      },
      required: ["target"],
    },
  },
  {
    name: "git_context",
    description: "Get git context for a keyword: matching branch names (local + remote) and recent commits. Surfaces in-progress work or fixes related to the topic before duplicating effort.",
    inputSchema: {
      type: "object",
      properties: {
        keyword: { type: "string", description: "Substring to match against branch names and commit messages" },
      },
      required: ["keyword"],
    },
  },
  {
    name: "recent_changes",
    description: "Snapshot of in-progress work: commits + files + symbols changed (vs base) plus uncommitted edits. Use as the FIRST query when joining a feature mid-flight or resuming work, or to inspect any branch's changes without checkout.",
    inputSchema: {
      type: "object",
      properties: {
        base: { type: "string", description: "Base ref to diff against (default: auto-detect main/master/develop)" },
        head: { type: "string", description: "Head ref to diff (default: HEAD). Use to inspect any branch without checkout." },
        since: { type: "string", description: "Optional time filter for commits, e.g. '1 day', '2 weeks', '2025-04-01'" },
      },
    },
  },
  {
    name: "call_chain",
    description: "Find the call path from one symbol to another (BFS over the call graph). Answers 'how does X reach Y?'. One call replaces 3-4 chained find_references. Returns the shortest chain or 'no path found'.",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "Starting symbol name (entry point — e.g. controller method)" },
        to:   { type: "string", description: "Target symbol name (e.g. repository or model method)" },
        max_depth: { type: "number", description: "Max hops to explore (default 5, cap 8)" },
      },
      required: ["from", "to"],
    },
  },
  {
    name: "list_entrypoints",
    description: "Map of how the project is invoked: HTTP routes, CLI commands, server entry files, event handlers, scheduled jobs. Best FIRST tool when joining an unfamiliar codebase — gives the architecture in ~200 tokens.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", description: "Optional filter: 'route', 'cli', 'server', 'event', 'job'" },
      },
    },
  },
  {
    name: "explain",
    description: "Dense summary of a file or symbol (~200 tokens): exposed API, dependencies, call graph, tests, layer. Use INSTEAD of read_file when you only need to understand what something does — saves ~80% tokens vs reading the full file.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "File path (relative or absolute) OR symbol name" },
      },
      required: ["target"],
    },
  },
  {
    name: "event_handlers",
    description: "Find dispatchers AND handlers of a named event/signal across event-driven frameworks (Symfony, Laravel, NestJS, Spring, Doctrine, EventEmitter, Rails callbacks, Django signals). CRITICAL for systems where call_chain hits 'no path' because flow goes through dispatchers.",
    inputSchema: {
      type: "object",
      properties: {
        event: { type: "string", description: "Event name (e.g. 'user.created', 'post_persist', 'OrderPlaced')" },
      },
      required: ["event"],
    },
  },
  {
    name: "impact_analysis",
    description: "Reverse impact: what breaks if you change SYMBOL? Lists direct callers + transitive callers (depth 2) + tests covering them + cross-layer references. Use BEFORE refactoring to estimate blast radius.",
    inputSchema: {
      type: "object",
      properties: {
        symbol: { type: "string", description: "Symbol name to analyze" },
      },
      required: ["symbol"],
    },
  },
  {
    name: "config_lookup",
    description: "Find where a config key/env-var is DEFINED (yaml/json/env/toml/ini) and CONSUMED (env(), getenv, config(), process.env, etc.) across the project. Resolves 'this config is not applied' bugs.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Config key or env var name (e.g. 'DATABASE_URL', 'app.timeout', 'redis.host')" },
      },
      required: ["key"],
    },
  },
  {
    name: "interface_implementations",
    description: "Find all classes/types that implement an interface (PHP, Java, C#, TS, Python ABCs, Rust impl). Critical when DI container resolves an interface to multiple impls — you need to know which.",
    inputSchema: {
      type: "object",
      properties: {
        interface: { type: "string", description: "Interface / abstract class / trait name" },
      },
      required: ["interface"],
    },
  },
  {
    name: "pattern_search",
    description: "Regex search across the codebase for code-quality patterns: 'console.log', 'TODO|FIXME|HACK', 'catch.*\\{\\s*\\}', empty error handlers, large switch statements, etc. Output is grouped by file with hit counts. Use for audits / cleanup.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "PCRE regex (use \\\\ for backslashes in JSON). E.g. 'console\\\\.log' or '@deprecated'" },
        glob:    { type: "string", description: "Optional glob filter (e.g. '*.ts', 'src/**')" },
        max:     { type: "number", description: "Max files to return (default 20)" },
      },
      required: ["pattern"],
    },
  },
  {
    name: "tests_for",
    description: "Find tests that cover a given symbol or file. Heuristic: co-located test files (X.test.ts, X_test.go, XTest.php) + test files mentioning the symbol name. Use BEFORE refactoring to know which tests will fail or need updating.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Symbol name OR file path" },
      },
      required: ["target"],
    },
  },
  {
    name: "hot_files",
    description: "Files with the highest git churn (most commits + recent activity). The 'hot' files are usually where bugs live and features cluster. Use as 'where should I look first?' for unfamiliar projects.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Top N files to return (default 15)" },
        since: { type: "string", description: "Time window (e.g. '3 months', '2025-01-01'). Default: 6 months." },
      },
    },
  },
  {
    name: "dead_code",
    description: "Symbols defined but never referenced anywhere (excluding their own definition). Lists candidates for removal. Heuristic, not perfect — does not detect dynamic dispatch / DI / event handlers, so verify before deleting.",
    inputSchema: {
      type: "object",
      properties: {
        scope:  { type: "string", description: "Optional path filter (e.g. 'src/legacy/')" },
        limit:  { type: "number", description: "Max symbols to return (default 30)" },
      },
    },
  },
  {
    name: "note",
    description: "Save a finding to .lexis-notes.md (markdown, persists across sessions). Use to record non-obvious context: bug root causes, architectural decisions, gotchas. Newest notes appear on top — Claude reads them first.",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", description: "The finding (markdown supported, 1-3 paragraphs ideal)" },
        tags:    { type: "array", items: { type: "string" }, description: "Topic tags (e.g. ['kamailio', 'bug', 'PROVIDER-2419'])" },
        files:   { type: "array", items: { type: "string" }, description: "Related files (e.g. ['src/auth/login.ts:42'])" },
      },
      required: ["content"],
    },
  },
  {
    name: "notes",
    description: "Recall persistent notes from previous sessions. Use this FIRST when starting work on a known area — saves re-discovering what you already learned. Match by content/tag/file substring, or pass no query to get the latest 10.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Optional substring filter against content/tags/files" },
        limit: { type: "number", description: "Max notes to return (default 10)" },
      },
    },
  },
  {
    name: "forget",
    description: "Delete a saved note by id. Use when a note is wrong or outdated.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Note id (shown in `notes` output)" },
      },
      required: ["id"],
    },
  },
  {
    name: "reindex",
    description: "Re-scan the project to pick up new or changed files since the last index. Call this if search results seem stale or a recently added file is not found.",
    inputSchema: { type: "object", properties: {} },
  },
];

function buildTrace(results: SearchResult[], projectRoot: string): string {
  const n = results.length;
  const calls: Set<number>[]    = Array.from({ length: n }, () => new Set<number>());
  const calledBy: Set<number>[] = Array.from({ length: n }, () => new Set<number>());

  for (let i = 0; i < n; i++) {
    const codeI = results[i]!.code;
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const nameJ = results[j]!.symbol.name;
      if (nameJ.length < 4) continue;
      const escaped = nameJ.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (new RegExp(`\\b${escaped}\\b`).test(codeI)) {
        calls[i]!.add(j);
        calledBy[j]!.add(i);
      }
    }
  }

  const lines = results.map((r, i) => {
    const rel = path.relative(projectRoot, r.symbol.file);
    const header = `${rel}:${r.symbol.lineStart}  [${r.symbol.type}]  ${r.symbol.name}`;

    const callerLines = [...calledBy[i]!].map((j) => {
      const c = results[j]!;
      return `  ← ${c.symbol.name.padEnd(26)} ${path.relative(projectRoot, c.symbol.file)}:${c.symbol.lineStart}`;
    });
    const calleeLines = [...calls[i]!].map((j) => {
      const c = results[j]!;
      return `  → ${c.symbol.name.padEnd(26)} ${path.relative(projectRoot, c.symbol.file)}:${c.symbol.lineStart}`;
    });

    const rels = [...callerLines, ...calleeLines];
    return rels.length > 0 ? `${header}\n${rels.join("\n")}` : header;
  });

  // entry points first (no callers in this result set)
  lines.sort((a, b) => {
    const aIsEntry = !a.includes("  ←");
    const bIsEntry = !b.includes("  ←");
    if (aIsEntry !== bIsEntry) return aIsEntry ? -1 : 1;
    return 0;
  });

  return `Call topology (${n} symbols):\n\n${lines.join("\n\n")}`;
}

function formatSuggestions(suggestions: Suggestion[], projectRoot: string): string {
  if (suggestions.length === 0) return "";
  const groups: Record<string, Suggestion[]> = {};
  for (const s of suggestions) {
    (groups[s.reason] ??= []).push(s);
  }
  const labels: Record<string, string> = {
    "case-variant": "Case mismatch",
    "exact-substring": "Substring match",
    "edit-distance": "Closest by typo",
    "token-overlap": "Same words, different order",
  };
  const parts = Object.entries(groups).map(([reason, items]) => {
    const lines = items.map((s) => {
      const rel = path.relative(projectRoot, s.file);
      return `  ${s.name}  [${s.type}]  ${rel}:${s.lineStart}`;
    });
    return `${labels[reason] ?? reason}:\n${lines.join("\n")}`;
  });
  return `\n\nDid you mean:\n${parts.join("\n\n")}`;
}

function detectLayer(filePath: string): string {
  const f = filePath.replace(/\\/g, "/");
  const base = path.basename(f);
  const isFrontend = /\.(tsx|jsx|vue|svelte)$/.test(base);
  const isBackendExt = /\.(php|go|py|rb|java|kt|cs|rs|swift|scala|ex|pl)$/i.test(base);
  const isMigration  = /\/(migrations?|DoctrineMigrations?|Seeds?|Fixtures?)\//i.test(f);

  // Tests — most specific, check first
  if (/\.(test|spec)\.[^.]+$/i.test(base) || /[/_](tests?|__tests__|specs?|e2e|cypress|spec)\//i.test(f)) return "test";

  // Routes / URL maps
  if (/\/(routes?|router|routing|urls?)[/.]?/i.test(f) || /\b(routes?|urls?)\.[a-z]+$/i.test(base)) return "route";

  // Controllers / HTTP handlers / API actions
  if (/\/(controllers?|handlers?|actions?|resolvers?|mutations?)\//i.test(f)) return "controller";
  if (/(controller|handler|action|resolver)\.[a-z]+$/i.test(base)) return "controller";

  // Services / use-cases / interactors / commands / queries (CQRS) / sagas
  if (/\/(services?|use[-_]?cases?|interactors?|application|usecases?|commands?|queries|sagas?|workflows?|operations?)\//i.test(f)) return "service";
  if (/(service|usecase|interactor|command|handler|saga)\.[a-z]+$/i.test(base)) return "service";

  // Repositories / data access / persistence (hexagonal: adapters/persistence)
  if (/\/(repositor|dao|data[-_]?access|persistence|gateways?)\//i.test(f)) return "repository";
  if (/(repository|gateway|store|persistence)\.[a-z]+$/i.test(base)) return "repository";

  // Domain model (DDD): entities, aggregates, value objects, domain services
  if (!isMigration && isBackendExt) {
    if (/\/(models?|entities?|aggregates?|domain|dto|dtos?|value[-_]?objects?|specifications?)\//i.test(f)) return "model";
    if (/(model|entity|aggregate|valueobject|specification)\.[a-z]+$/i.test(base)) return "model";
  }

  // Cross-cutting: middleware, guards, interceptors, pipes, filters, decorators
  if (/\/(middleware|middlewares?|guards?|interceptors?|pipes?|filters?|decorators?)\//i.test(f)) return "middleware";

  // Ports / adapters (hexagonal architecture)
  if (/\/(ports?|adapters?|infrastructure)\//i.test(f)) {
    // ports = interfaces (model-ish), adapters = impl. Both belong to "model" conceptually
    if (/\/ports?\//i.test(f)) return "model";
    return "repository";
  }

  // State management (Redux / Pinia / Zustand / NgRx / Vuex / Recoil)
  if (/\/(slices?|stores?|reducers?|mutations?|getters?|selectors?|effects?|atoms?)\//i.test(f)) return "service";

  // Frontend layer
  if (/\/(hooks?|composables?|contexts?|providers?|signals?)\//i.test(f)) return "hook";
  if (/\/(components?|views?|pages?|screens?|layouts?|ui|widgets?|fragments?)\//i.test(f)) return "ui";
  if (isFrontend && /\/entities\//i.test(f)) return "ui";  // frontend "entities" = UI components

  // Events / messaging (event-driven architectures)
  if (/\/(events?|messages?|listeners?|subscribers?|publishers?)\//i.test(f)) return "service";

  return "other";
}

function execSearchCode(
  args: Record<string, unknown>,
  index: Index,
  projectPath: string
): string {
  const query = args["query"] as string;
  const output = (args["output"] as string | undefined) ?? "compact";
  const context = args["context"] as string | undefined;

  const intentOverride: QueryIntent | undefined =
    context === "bug" ? "bug" : context === "feature" ? "flow" : undefined;
  const defaultDepth = context === "bug" ? 2 : 1;

  const topK = typeof args["top_k"] === "number" ? args["top_k"] : 3;
  const depth = typeof args["depth"] === "number" ? args["depth"] : defaultDepth;

  log(`[search_code] query="${query}" output=${output} topK=${topK} depth=${depth} context=${context ?? "auto"}`);

  const results = search(query, index, projectPath, topK, depth, intentOverride);
  if (results.length === 0) {
    const suggestions = suggestSimilar(query, index, 5);
    return `No results found for "${query}".${formatSuggestions(suggestions, path.resolve(projectPath))}`;
  }

  if (output === "trace") {
    const projectRoot = path.resolve(projectPath);
    return buildTrace(results, projectRoot);
  }

  if (output === "count") {
    const uniqueFiles = new Set(results.map((r) => r.symbol.file));
    return `${results.length} matches across ${uniqueFiles.size} files.`;
  }

  if (output === "signatures") {
    const projectRoot = path.resolve(projectPath);
    const SKIP = /^\s*(@\w|\/\/|\/\*|\*(?!\/)|import\s|from\s|#include|export\s*\{)/;
    const sigLines = results.map((r) => {
      const relPath = path.relative(projectRoot, r.symbol.file);
      const sig = r.code.split("\n").find((l) => {
        const t = l.trim();
        return t.length > 0 && !SKIP.test(t) && !t.includes("// ←") && !t.includes("// ...");
      }) ?? r.symbol.name;
      const trimmed = sig.trimStart();
      // multi-line signature: first line ends with ( or , — append ellipsis
      const display = /[,(]\s*$/.test(trimmed) ? trimmed.slice(0, 100) + "…" : trimmed.slice(0, 120);
      return `${relPath}:${r.symbol.lineStart}  ${display}`;
    });
    return sigLines.join("\n");
  }

  if (output === "files") {
    const uniqueFiles = [...new Set(results.map((r) => r.symbol.file))];
    return uniqueFiles.join("\n");
  }

  if (output === "snippet") {
    const limit = parseInt(process.env["LEXIS_TOOL_RESULT_LIMIT"] ?? "20");
    const limited = results.slice(0, limit);
    const overflow = results.length - limited.length;
    const projectRoot = path.resolve(projectPath);

    // Lower-case query terms for matching
    const terms = extractTechnicalTerms(query)
      .map((t) => t.toLowerCase())
      .filter((t) => t.length >= 2);

    // A line is "trivial" if it's just a brace, paren, or whitespace — no signal
    const TRIVIAL = /^\s*[{}\][()\s]*;?\s*$/;

    const lines = limited.map((r) => {
      const relPath = path.relative(projectRoot, r.symbol.file);
      const codeLines = r.code.split("\n");

      // Find the line with most term hits; ties go to the first
      let bestIdx = 0;
      let bestScore = -1;
      for (let i = 0; i < codeLines.length; i++) {
        const lower = (codeLines[i] ?? "").toLowerCase();
        const score = terms.reduce((acc, t) => acc + (lower.includes(t) ? 1 : 0), 0);
        if (score > bestScore) { bestScore = score; bestIdx = i; }
      }

      const matchLine = r.symbol.lineStart + bestIdx;
      const match = (codeLines[bestIdx] ?? "").trimEnd().slice(0, 130);

      // Only add a context line if the match itself is short on signal (e.g. control flow continues)
      const after = (codeLines[bestIdx + 1] ?? "").trimEnd();
      const wantsContext = match.length < 50 && after.length > 0 && !TRIVIAL.test(after);

      const head = `${relPath}:${matchLine}  ${r.symbol.name}`;
      return wantsContext
        ? `${head}\n  ${match}\n  ${after.slice(0, 110)}`
        : `${head}\n  ${match}`;
    });

    const body = lines.join("\n\n");
    return overflow > 0
      ? `${body}\n\n[${overflow} more — use top_k or 'compact' for sigs]`
      : body;
  }

  if (output === "compact") {
    const limit = parseInt(process.env["LEXIS_TOOL_RESULT_LIMIT"] ?? "20");
    const limited = results.slice(0, limit);
    const overflow = results.length - limited.length;
    const projectRoot = path.resolve(projectPath);

    // Patterns for boilerplate lines to skip
    const SKIP_LINE = /^\s*(?:\/\/|\/\*|\*(?!\/)|@\w|import\s|from\s|#include\s|use\s[\w\\]+[;\\]|using\s[\w.]+;|export\s*\{|<\?php|package\s+\w|namespace\s+\w|declare\s*\()/;
    const BARE_BRACE = /^\s*[{}\][()\s]*;?\s*$/;
    // Import member lines: just an identifier (possibly with `as Alias`) and optional comma
    const IMPORT_MEMBER = /^\s*\w+(\s+as\s+\w+)?,?\s*$/;
    const DECL_KW = /\b(function|class|interface|type|enum|def|func|fn|const|let|var|fun|struct|trait|impl)\b|^\s*(public|private|protected|async|export|abstract|static|override|suspend)\s/;

    const body = limited
      .map((r) => {
        const relPath = path.relative(projectRoot, r.symbol.file);
        const lines = r.code.split("\n");
        const nameEsc = r.symbol.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const nameRe  = new RegExp(`\\b${nameEsc}\\b`);

        // 1. Try to find the declaration line (contains symbol name + declaration keyword)
        const declIdx = lines.findIndex((l) => {
          const t = l.trim();
          return nameRe.test(t) && DECL_KW.test(t) && !t.includes("// ←");
        });

        let sig = "";
        let body1 = "";

        if (declIdx !== -1) {
          sig = lines[declIdx]!.trimStart().slice(0, 120);
          // find first meaningful body line after declaration
          body1 = lines.slice(declIdx + 1).find((l) => {
            const t = l.trim();
            return t.length > 2 && !BARE_BRACE.test(t) && !t.includes("// ←") && !t.includes("// ...") && !SKIP_LINE.test(l) && !IMPORT_MEMBER.test(t);
          })?.trimStart().slice(0, 100) ?? "";
        } else {
          // fallback: first non-boilerplate line
          const meaningful = lines.filter((l) => {
            const t = l.trim();
            return t.length > 2 && !BARE_BRACE.test(t) && !t.includes("// ←") && !t.includes("// ...") && !SKIP_LINE.test(l) && !IMPORT_MEMBER.test(t);
          });
          sig   = (meaningful[0] ?? "").trimStart().slice(0, 120);
          body1 = (meaningful[1] ?? "").trimStart().slice(0, 100);
        }

        // If signature ends with ( or , it's multi-line — add ellipsis
        const displaySig = /[,(]\s*$/.test(sig) ? sig.slice(0, 108) + "…" : sig;
        const preview = body1 && body1 !== displaySig
          ? `  ${displaySig}\n  ${body1}`
          : `  ${displaySig}`;

        return `${relPath}:${r.symbol.lineStart}  [${r.symbol.type}] ${r.symbol.name}\n${preview}`;
      })
      .join("\n\n");

    return overflow > 0
      ? `${body}\n\n[${overflow} additional results omitted — use output='content' for full code]`
      : body;
  }

  if (output === "arch") {
    const projectRoot = path.resolve(projectPath);
    const LAYER_ORDER = ["route", "controller", "service", "repository", "model", "middleware", "hook", "ui", "test", "other"];
    const layerMap = new Map<string, SearchResult>();
    for (const r of results) {
      const layer = detectLayer(r.symbol.file);
      if (!layerMap.has(layer)) layerMap.set(layer, r);
    }
    if (layerMap.size === 0) return "No results found.";

    const SKIP_A = /^\s*(?:\/\/|\/\*|\*(?!\/)|@\w|import\s|from\s|#include\s|use\s[\w\\]+[;\\]|export\s*\{|<\?php|package\s+\w|namespace\s+\w)/;
    const BARE_A = /^\s*[{}\][()\s]*;?\s*$/;
    const IM_A   = /^\s*\w+(\s+as\s+\w+)?,?\s*$/;

    const lines: string[] = [];
    for (const layer of LAYER_ORDER) {
      const r = layerMap.get(layer);
      if (!r) continue;
      const relPath = path.relative(projectRoot, r.symbol.file);
      const sig = r.code.split("\n").find((l) => {
        const t = l.trim();
        return t.length > 2 && !BARE_A.test(t) && !t.includes("// ←") && !SKIP_A.test(l) && !IM_A.test(t);
      }) ?? r.symbol.name;
      const display = sig.trimStart().slice(0, 110);
      lines.push(`[${layer.toUpperCase().padEnd(12)}] ${relPath}:${r.symbol.lineStart}  ${r.symbol.name}\n  ${display}`);
    }
    return `Architecture for "${query}" (${lines.length} layers):\n\n${lines.join("\n\n")}`;
  }

  // content (default)
  const limit = parseInt(process.env["LEXIS_TOOL_RESULT_LIMIT"] ?? "20");
  const limited = results.slice(0, limit);
  const overflow = results.length - limited.length;

  const body = limited
    .map(
      (r) =>
        `FILE: ${r.symbol.file} (lines ${r.symbol.lineStart}-${r.symbol.lineEnd})\nSYMBOL: ${r.symbol.name}\nCODE:\n\`\`\`\n${r.code}\n\`\`\``
    )
    .join("\n\n---\n\n");

  return overflow > 0
    ? `${body}\n\n[${overflow} additional results omitted — refine query or use output='files'/'count']`
    : body;
}

function execReadFile(
  args: Record<string, unknown>,
  projectPath: string,
  index: Index
): string {
  const filePath = args["path"] as string;
  const offset = Math.max(1, typeof args["offset"] === "number" ? args["offset"] : 1);
  const limit = Math.max(1, typeof args["limit"] === "number" ? args["limit"] : 80);

  const resolved = path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(projectPath, filePath);

  const projectResolved = path.resolve(projectPath);
  if (!resolved.startsWith(projectResolved + path.sep) && resolved !== projectResolved) {
    return "Access denied: path is outside the project directory.";
  }

  log(`[read_file] "${resolved}" lines ${offset}-${offset + limit - 1}`);

  try {
    const content = fs.readFileSync(resolved, "utf-8");
    const allLines = content.split("\n");
    const totalLines = allLines.length;
    const startIdx = offset - 1;
    const endIdx = Math.min(startIdx + limit, totalLines);
    const slice = allLines.slice(startIdx, endIdx);

    const numbered = slice
      .map((line, i) => `${(startIdx + i + 1).toString().padStart(6, " ")}\t${line}`)
      .join("\n");

    // Find enclosing symbol chain. lineEnd in the index is approximate (lineStart+20),
    // so anchor on lineStart and pick the symbol whose start is closest to (but ≤) offset.
    const fileSymbols = index.symbols.filter((s) => s.file === resolved);
    const containingClass = fileSymbols
      .filter((s) => s.type === "class" && s.lineStart <= offset)
      .sort((a, b) => b.lineStart - a.lineStart)[0];
    const containingFn = fileSymbols
      .filter((s) => (s.type === "function" || s.type === "method") && s.lineStart <= offset)
      .sort((a, b) => b.lineStart - a.lineStart)[0];

    const relPath = path.relative(projectResolved, resolved);
    let contextLine = "";
    const chain: string[] = [];
    if (containingClass) chain.push(`${containingClass.name} [class]`);
    if (containingFn && (!containingClass || containingFn.lineStart > containingClass.lineStart)) {
      chain.push(`${containingFn.name} [${containingFn.type}]`);
    }
    if (chain.length > 0) contextLine = `INSIDE: ${chain.join(" › ")}\n`;

    const header = `FILE: ${relPath} (showing lines ${offset}-${endIdx} of ${totalLines})\n${contextLine}`;
    const footer =
      endIdx < totalLines
        ? `\n\n[... ${totalLines - endIdx} more lines. Call read_file with offset=${endIdx + 1} to continue.]`
        : "";
    return header + numbered + footer;
  } catch {
    return `Could not read file: ${resolved}`;
  }
}

function execListSymbols(
  args: Record<string, unknown>,
  index: Index
): string {
  const fileFilter = (args["file_filter"] as string | undefined)?.toLowerCase();
  const nameFilter = (args["name_filter"] as string | undefined)?.toLowerCase();

  let symbols = index.symbols;
  if (fileFilter) symbols = symbols.filter((s) => s.file.toLowerCase().includes(fileFilter));
  if (nameFilter) symbols = symbols.filter((s) => s.name.toLowerCase().includes(nameFilter));

  log(`[list_symbols] ${symbols.length} results`);

  if (symbols.length === 0) return "No symbols found.";
  const lines = symbols.slice(0, 60).map((s) => `${s.file}:${s.lineStart} [${s.type}] ${s.name}`);
  const suffix = symbols.length > 60 ? `\n... (${symbols.length - 60} more)` : "";
  return lines.join("\n") + suffix;
}

function execFindFile(
  args: Record<string, unknown>,
  index: Index
): string {
  const pattern = (args["pattern"] as string).toLowerCase();
  const matched = index.files.filter((f) => f.toLowerCase().includes(pattern));

  log(`[find_file] "${pattern}" → ${matched.length} results`);

  if (matched.length === 0) return "No files found.";
  const suffix = matched.length > 30 ? `\n... (${matched.length - 30} more)` : "";
  return matched.slice(0, 30).join("\n") + suffix;
}

function execGetSymbol(
  args: Record<string, unknown>,
  index: Index,
  projectPath: string
): string {
  const name = args["name"] as string;
  const fileFilter = args["file_filter"] as string | undefined;

  log(`[get_symbol] name="${name}" file_filter=${fileFilter ?? "none"}`);

  const result = getSymbol(name, fileFilter, index);
  if (!result) {
    const suggestions = suggestSimilar(name, index, 5);
    return `Symbol "${name}" not found.${formatSuggestions(suggestions, path.resolve(projectPath))}`;
  }

  const { symbol: sym, body } = result;
  const relPath = path.relative(path.resolve(projectPath), sym.file);
  const lineCount = body.split("\n").length;

  return `SYMBOL: ${sym.name} [${sym.type}]\nFILE: ${relPath} (lines ${sym.lineStart}-${sym.lineStart + lineCount - 1})\n\n\`\`\`\n${body}\n\`\`\``;
}

function execFindReferences(
  args: Record<string, unknown>,
  index: Index,
  projectPath: string
): string {
  const symbol = args["symbol"] as string;
  const depth = typeof args["depth"] === "number" ? Math.min(Math.max(1, args["depth"]), 2) : 1;

  log(`[find_references] symbol="${symbol}" depth=${depth}`);

  const refs = findReferences(symbol, projectPath, index);
  if (refs.length === 0) {
    const suggestions = suggestSimilar(symbol, index, 5);
    return `No references found for "${symbol}".${formatSuggestions(suggestions, path.resolve(projectPath))}`;
  }

  const projectRoot = path.resolve(projectPath);
  const fileCache = new Map<string, string[]>();
  const getLines = (file: string): string[] => {
    if (!fileCache.has(file)) {
      try { fileCache.set(file, fs.readFileSync(file, "utf-8").split("\n")); }
      catch { fileCache.set(file, []); }
    }
    return fileCache.get(file)!;
  };

  const formatRef = (r: { file: string; line: number; kind: string; content: string }, label?: string): string => {
    const relFile = path.relative(projectRoot, r.file);
    const header = `${label ?? ""}${relFile}:${r.line}  [${r.kind}]`;
    if (r.kind === "import") return `${header}  ${r.content}`;
    const lines = getLines(r.file);
    if (lines.length === 0) return `${header}  ${r.content.slice(0, 80)}`;
    const start = Math.max(0, r.line - 1 - 2);
    const end   = Math.min(lines.length, r.line - 1 + 3);
    const ctx: string[] = [];
    for (let i = start; i < end; i++) {
      ctx.push(`  ${i + 1 === r.line ? "→" : " "} ${i + 1}: ${lines[i]}`);
    }
    return `${header}\n${ctx.join("\n")}`;
  };

  // definitions first, then calls, types, other, imports last
  const KIND_ORDER: Record<string, number> = { definition: 0, call: 1, type: 2, other: 3, import: 4 };
  const sorted = [...refs].sort((a, b) => (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9));
  const MAX = 25;
  const shown = sorted.slice(0, MAX);
  const overflow = refs.length - shown.length;

  const parts = shown.map((r) => formatRef(r));
  let body = `${refs.length} references to "${symbol}":\n\n${parts.join("\n\n")}`;
  if (overflow > 0) body += `\n\n[${overflow} more references omitted]`;

  // depth=2: trace callers of each direct caller using the index
  if (depth >= 2) {
    const GENERIC_FN = new Set([
      "__construct", "constructor", "init", "__init__", "setUp", "tearDown",
      "create", "build", "make", "get", "set", "run", "execute", "handle", "process",
      "render", "main", "test", "factory", "instance", "default",
    ]);
    const callerNames = new Set<string>();
    // include 'other' to catch DI / property declarations (typed constructor args in PHP, fields in Java/C#)
    for (const ref of refs.filter((r) => r.kind === "call" || r.kind === "type" || r.kind === "other")) {
      // find the innermost indexed symbol that contains this reference line
      const enc = index.symbols
        .filter((s) => s.file === ref.file && s.lineStart <= ref.line)
        .sort((a, b) => b.lineStart - a.lineStart)[0];
      if (!enc || enc.name.length < 4 || enc.name === symbol) continue;
      // walk up the file's symbols to find a non-generic enclosing context
      let chosen = enc;
      if (GENERIC_FN.has(enc.name)) {
        const parent = index.symbols
          .filter((s) => s.file === ref.file && s.lineStart < enc.lineStart && s.type === "class")
          .sort((a, b) => b.lineStart - a.lineStart)[0];
        if (parent) chosen = parent;
      }
      if (!GENERIC_FN.has(chosen.name)) callerNames.add(chosen.name);
    }

    const depth2Refs: Array<typeof refs[number] & { via: string }> = [];
    const knownFiles = new Set(refs.map((r) => r.file));

    for (const callerName of [...callerNames].slice(0, 4)) {
      const callerRefs = findReferences(callerName, projectPath, index);
      for (const r of callerRefs) {
        if (knownFiles.has(r.file)) continue;
        if (r.kind === "definition") continue;  // skip self-defs
        depth2Refs.push({ ...r, via: callerName });
        knownFiles.add(r.file);
        if (depth2Refs.length >= 10) break;
      }
      if (depth2Refs.length >= 10) break;
    }

    if (depth2Refs.length > 0) {
      const d2Parts = depth2Refs.map((r) => formatRef(r, `(via ${r.via}) `));
      body += `\n\nCALLERS OF CALLERS (depth 2):\n\n${d2Parts.join("\n\n")}`;
    }
  }

  return body;
}

function execGetContext(
  args: Record<string, unknown>,
  index: Index,
  projectPath: string
): string {
  const file = args["file"] as string;
  const line = typeof args["line"] === "number" ? args["line"] : parseInt(args["line"] as string, 10);

  log(`[get_context] file="${file}" line=${line}`);

  const ctx = getContext(file, line, projectPath, index);
  const projectRoot = path.resolve(projectPath);

  const relFile = path.isAbsolute(file)
    ? path.relative(projectRoot, file)
    : file;

  const fnLabel = ctx.fnName ?? "(anonymous)";
  const parts: string[] = [];

  parts.push(`FUNCTION: ${fnLabel} (${relFile}:${ctx.fnLineStart}-${ctx.fnLineEnd})\n\n\`\`\`\n${ctx.fnCode}\n\`\`\``);

  if (ctx.callers.length > 0) {
    const fileCache = new Map<string, string[]>();
    const getLines = (f: string): string[] => {
      if (!fileCache.has(f)) {
        try { fileCache.set(f, fs.readFileSync(f, "utf-8").split("\n")); }
        catch { fileCache.set(f, []); }
      }
      return fileCache.get(f)!;
    };

    const callerParts = ctx.callers.slice(0, 5).map((r) => {
      const rel = path.relative(projectRoot, r.symbol.file);
      const fileLines = getLines(r.symbol.file);
      if (fileLines.length === 0) return `  ${rel}:${r.symbol.lineStart}  ${r.code.split("\n")[0]}`;

      // find the line within the caller chunk that actually calls our function
      const searchName = ctx.fnName ?? "";
      let callLine = r.symbol.lineStart;
      for (let i = r.symbol.lineStart - 1; i < Math.min(r.symbol.lineEnd, fileLines.length); i++) {
        if (searchName && (fileLines[i] ?? "").includes(searchName)) { callLine = i + 1; break; }
      }

      const start = Math.max(0, callLine - 1 - 2);
      const end   = Math.min(fileLines.length, callLine - 1 + 3);
      const ctx2 = [];
      for (let i = start; i < end; i++) {
        const n = i + 1;
        ctx2.push(`  ${n === callLine ? "→" : " "} ${n}: ${fileLines[i]}`);
      }
      return `  ${rel}:${callLine}\n${ctx2.join("\n")}`;
    });

    parts.push(`CALLED BY (${ctx.callers.length}):\n${callerParts.join("\n\n")}`);
  } else {
    parts.push(`CALLED BY: none found (may be an entry point or exported API)`);
  }

  if (ctx.types.length > 0) {
    const typeLines = ctx.types.slice(0, 6).map((r) => {
      const rel = path.relative(projectRoot, r.symbol.file);
      return `  ${rel}:${r.symbol.lineStart}  [${r.symbol.type}]  ${r.symbol.name}`;
    });
    parts.push(`TYPES (${ctx.types.length}):\n${typeLines.join("\n")}`);
  }

  if (ctx.tests.length > 0) {
    const testLines = ctx.tests.slice(0, 3).map((r) => {
      const rel = path.relative(projectRoot, r.symbol.file);
      const lineCount = r.symbol.lineEnd - r.symbol.lineStart + 1;
      return `  ${rel}  (${lineCount} lines)`;
    });
    parts.push(`TESTS:\n${testLines.join("\n")}`);
  }

  return parts.join("\n\n");
}

function execFindWrites(
  args: Record<string, unknown>,
  projectPath: string
): string {
  const target = args["target"] as string;
  if (!target || target.length < 2) return "Error: 'target' must be at least 2 chars.";

  log(`[find_writes] target="${target}"`);

  // Match the basename and any path that ends with the target — handles both
  // 'listeners.cfg' and '/etc/kamailio/proxytrunks/listeners.cfg' callers.
  const targetEsc = target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // Patterns that indicate a write to `target` (cross-language)
  const patterns = [
    // PHP
    `file_put_contents\\s*\\([^)]*${targetEsc}`,
    `fopen\\s*\\([^)]*${targetEsc}[^)]*['"][wa]`,
    `fwrite\\s*\\([^)]*${targetEsc}`,
    // JS / TS / Node
    `fs\\.(writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream)\\s*\\([^)]*${targetEsc}`,
    `writeFile(Sync)?\\s*\\([^)]*${targetEsc}`,
    // Python
    `open\\s*\\([^)]*${targetEsc}[^)]*['"][wax]`,
    `\\.write\\s*\\([^)]*\\).*${targetEsc}`,
    // Ruby
    `File\\.(open|write)\\s*\\([^)]*${targetEsc}`,
    // Bash / shell redirects
    `>\\s*[^|;&\\n]*${targetEsc}`,
    `tee\\s+[^|;&\\n]*${targetEsc}`,
    // Perl
    `open\\s*\\([^,)]*,\\s*['"]>+[^'"]*${targetEsc}`,
    `print\\s+\\$?\\w+\\s+[^;]*${targetEsc}`,
    // Generic: variable assignment with the target nearby
    `\\$?\\w+\\s*=\\s*['"][^'"]*${targetEsc}`,
  ];

  const rgArgs = [
    "--line-number", "--no-heading", "--max-filesize", "200K",
    "-e", patterns.join("|"),
    "--glob", "!node_modules/**", "--glob", "!vendor/**", "--glob", "!.git/**",
    "--glob", "!dist/**", "--glob", "!build/**",
    projectPath,
  ];

  let stdout = runRg(rgArgs).stdout;

  if (!stdout.trim()) return `No code found that writes to "${target}".`;

  const projectRoot = path.resolve(projectPath);
  const lines = stdout.trim().split("\n").slice(0, 30);
  const formatted = lines.map((l) => {
    const m = l.match(/^(.+?):(\d+):(.*)$/);
    if (!m) return l;
    const [, file, lineNum, content] = m;
    const rel = path.relative(projectRoot, file ?? "");
    return `${rel}:${lineNum}  ${(content ?? "").trim().slice(0, 140)}`;
  });

  const overflow = stdout.trim().split("\n").length - lines.length;
  const body = `${lines.length} writer(s) for "${target}":\n\n${formatted.join("\n")}`;
  return overflow > 0 ? `${body}\n\n[${overflow} more omitted]` : body;
}

function execGitContext(
  args: Record<string, unknown>,
  projectPath: string
): string {
  const keyword = args["keyword"] as string;
  if (!keyword || keyword.length < 2) return "Error: 'keyword' must be at least 2 chars.";

  log(`[git_context] keyword="${keyword}"`);

  const gitDir = path.join(projectPath, ".git");
  if (!fs.existsSync(gitDir)) return "Not a git repository.";

  const run = (args: string[]): string => {
    const r = spawnSync("git", ["-C", projectPath, ...args], { encoding: "utf-8" });
    return (r.stdout ?? "").trim();
  };

  const branchesRaw = run(["branch", "-a", "--list", `*${keyword}*`]);
  const branches = branchesRaw
    .split("\n")
    .map((b) => b.replace(/^[* ]+/, "").trim())
    .filter((b) => b.length > 0)
    .slice(0, 15);

  const commitsRaw = run([
    "log", "--all",
    "--grep", keyword, "-i",
    "--pretty=format:%h|%ad|%an|%s",
    "--date=short",
    "-n", "10",
  ]);
  const commits = commitsRaw.split("\n").filter((l) => l.includes("|"));

  const sections: string[] = [];

  if (branches.length > 0) {
    sections.push(`BRANCHES matching "${keyword}":\n${branches.map((b) => `  ${b}`).join("\n")}`);
  } else {
    sections.push(`BRANCHES matching "${keyword}": none`);
  }

  if (commits.length > 0) {
    const commitLines = commits.map((c) => {
      const [hash, date, author, ...rest] = c.split("|");
      return `  ${hash}  ${date}  ${author?.padEnd(20)}  ${rest.join("|")}`;
    });
    sections.push(`COMMITS matching "${keyword}":\n${commitLines.join("\n")}`);
  } else {
    sections.push(`COMMITS matching "${keyword}": none`);
  }

  return sections.join("\n\n");
}

// Extract identifiers that look like function/method calls from a code body.
// Cross-language: matches camelCase, snake_case, PascalCase followed by `(`.
function extractCallNames(code: string): Set<string> {
  const calls = new Set<string>();
  // foo(  /  Foo(  /  foo_bar(  /  $this->foo(  /  this.foo(  /  obj::foo(
  const re = /(?:^|[^a-zA-Z0-9_$])([a-zA-Z_][a-zA-Z0-9_]{2,})\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    const name = m[1]!;
    // skip language keywords
    if (KEYWORDS_BLOCKLIST.has(name)) continue;
    calls.add(name);
  }
  return calls;
}

const KEYWORDS_BLOCKLIST = new Set([
  "if", "for", "while", "switch", "catch", "return", "new", "throw", "typeof",
  "function", "class", "const", "let", "var", "void", "async", "await", "yield",
  "isset", "empty", "is_null", "array", "echo", "print", "list",
  "print_r", "var_dump", "die", "exit", "sizeof", "count",
  "len", "range", "list", "tuple", "dict", "set", "str", "int", "float", "bool",
  "make", "len", "cap", "append", "panic", "recover", "go", "defer",
  "println", "printf", "fmt", "Println", "Printf", "Errorf",
  "require", "include", "use",
]);

function execCallChain(
  args: Record<string, unknown>,
  index: Index,
  projectPath: string
): string {
  const from = args["from"] as string;
  const to   = args["to"]   as string;
  const maxDepth = Math.min(typeof args["max_depth"] === "number" ? args["max_depth"] : 5, 8);

  log(`[call_chain] ${from} → ${to} (max_depth=${maxDepth})`);

  if (!from || !to) return "Error: 'from' and 'to' are required.";

  // Verify both endpoints exist in the index
  const fromSym = getSymbol(from, undefined, index);
  if (!fromSym) {
    const sug = suggestSimilar(from, index, 3);
    return `Source symbol "${from}" not found.${formatSuggestions(sug, path.resolve(projectPath))}`;
  }
  const toExists = index.symbols.some((s) => s.name === to);
  if (!toExists) {
    const sug = suggestSimilar(to, index, 3);
    return `Target symbol "${to}" not found.${formatSuggestions(sug, path.resolve(projectPath))}`;
  }

  // BFS on the call graph. Path = list of symbol names.
  type Step = { name: string; path: string[] };
  const visited = new Set<string>([from]);
  const queue: Step[] = [{ name: from, path: [from] }];

  while (queue.length > 0) {
    const step = queue.shift()!;
    if (step.path.length > maxDepth) continue;

    // Resolve current symbol's body (use cache via index lookup + read)
    const sym = getSymbol(step.name, undefined, index);
    if (!sym) continue;

    const callNames = extractCallNames(sym.body);

    if (callNames.has(to)) {
      const fullPath = [...step.path, to];
      return formatChain(fullPath, index, projectPath);
    }

    for (const callee of callNames) {
      if (visited.has(callee)) continue;
      // Only traverse names we know about (must be indexed)
      if (!index.symbols.some((s) => s.name === callee)) continue;
      visited.add(callee);
      queue.push({ name: callee, path: [...step.path, callee] });
    }
  }

  return `No call path found from "${from}" to "${to}" within ${maxDepth} hops.\nExplored ${visited.size} symbol(s). Try a higher max_depth or check that callers reach the target via dynamic dispatch (events, DI, reflection).`;
}

function formatChain(chain: string[], index: Index, projectPath: string): string {
  const projectRoot = path.resolve(projectPath);
  const lines: string[] = [];
  for (let i = 0; i < chain.length; i++) {
    const name = chain[i]!;
    const sym = index.symbols.find((s) => s.name === name);
    const arrow = i === 0 ? "  " : "→ ";
    if (sym) {
      const rel = path.relative(projectRoot, sym.file);
      lines.push(`${arrow}${name}  [${sym.type}]  ${rel}:${sym.lineStart}`);
    } else {
      lines.push(`${arrow}${name}`);
    }
  }
  return `Call chain (${chain.length - 1} hop${chain.length - 1 === 1 ? "" : "s"}):\n\n${lines.join("\n")}`;
}

type EntryKind = "route" | "cli" | "server" | "event" | "job";

function classifyEntry(filePath: string): EntryKind | null {
  const f = filePath.replace(/\\/g, "/");
  const base = path.basename(f);

  // Skip frontend routing conventions that look like server entries but aren't.
  // Any TS/JS file inside pages/, views/, routes/, screens/ — covers Next.js, Nuxt,
  // SvelteKit, Remix, React Router, Vue Router, Expo, etc.
  const isFrontendRoute = /\/(pages?|views?|routes?|screens?)\/.+\.(t|j)sx?$/i.test(f);
  if (isFrontendRoute) return null;

  // Server entry files (long-running daemons / web servers)
  // Restricted to Go/Python/Rust/Ruby/PHP/Java/Kotlin where `index.X` actually means entry
  if (/^(main|server|app|wsgi|asgi|application)\.(go|py|rs|rb|php|java|kt)$/i.test(base)) return "server";
  if (/^index\.(go|py|rs|php)$/i.test(base)) return "server";
  // TS/JS server entry: only when the file lives at project root or under src/cli/cmd/bin
  if (/^(main|server|app|index)\.(ts|js)$/i.test(base)) {
    const dir = path.dirname(f);
    const isShallow = /(?:^|\/)(src|cli|cmd|bin|server)\/[^/]+$/i.test(dir) || /^[^/]+$/i.test(dir);
    if (isShallow) return "server";
  }
  if (/\/(cmd|bin|server)\/[^/]+\/main\.(go|py|rs)$/i.test(f)) return "server";
  if (/^manage\.py$/i.test(base)) return "server";  // Django

  // CLI tools — nested bin/scripts/cli, console artisan, makefile-driven
  if (/\/(cli|bin|scripts?|tools?)\//i.test(f) && !/(node_modules|vendor)/.test(f)) return "cli";
  if (/^(console|artisan|gradlew|mvnw)$/i.test(base)) return "cli";
  if (/cli\.(go|py|rs|ts|js|rb)$/i.test(base)) return "cli";

  // HTTP routes / URL maps
  if (/\b(routes?|router|routing|urls?)\.(go|py|rs|ts|js|rb|php)$/i.test(base)) return "route";
  if (/\/(routes?|router|routing)\//i.test(f)) return "route";
  if (/urls\.py$/i.test(base)) return "route";  // Django

  // Controllers & API actions
  if (/\/(controllers?|handlers?|actions?|resolvers?)\//i.test(f)) return "route";
  if (/(controller|handler|action|resolver)\.[a-z]+$/i.test(base)) return "route";

  // Event handlers / subscribers / listeners
  if (/\/(listeners?|subscribers?|consumers?|observers?)\//i.test(f)) return "event";
  if (/(listener|subscriber|consumer|observer)\.[a-z]+$/i.test(base)) return "event";

  // Scheduled jobs / cron / workers
  if (/\/(jobs?|tasks?|workers?|schedules?|crons?)\//i.test(f)) return "job";
  if (/(job|task|worker|cron|scheduler)\.[a-z]+$/i.test(base)) return "job";

  return null;
}

function execListEntrypoints(
  args: Record<string, unknown>,
  index: Index,
  projectPath: string
): string {
  const filterKind = args["kind"] as EntryKind | undefined;

  log(`[list_entrypoints] kind=${filterKind ?? "all"}`);

  const projectRoot = path.resolve(projectPath);
  const buckets: Record<EntryKind, Map<string, IndexedSymbol[]>> = {
    route: new Map(), cli: new Map(), server: new Map(), event: new Map(), job: new Map(),
  };

  // 1. Classify every indexed file
  const fileKind = new Map<string, EntryKind>();
  for (const file of index.files) {
    const k = classifyEntry(file);
    if (k && (!filterKind || k === filterKind)) {
      fileKind.set(file, k);
      buckets[k].set(file, []);
    }
  }

  // 2. Attach symbols to their files
  for (const sym of index.symbols) {
    const k = fileKind.get(sym.file);
    if (!k) continue;
    buckets[k].get(sym.file)!.push(sym);
  }

  // 3. Format
  const labels: Record<EntryKind, string> = {
    server: "SERVERS / DAEMONS", cli: "CLI COMMANDS",
    route: "HTTP ROUTES / CONTROLLERS", event: "EVENT HANDLERS", job: "SCHEDULED JOBS",
  };
  const order: EntryKind[] = ["server", "route", "event", "job", "cli"];

  const sections: string[] = [];
  let totalFiles = 0;

  for (const k of order) {
    if (filterKind && k !== filterKind) continue;
    const bucket = buckets[k];
    if (bucket.size === 0) continue;

    // Sort files: most symbols first, then path
    const sorted = [...bucket.entries()]
      .map(([file, syms]) => ({ file, syms, count: syms.length }))
      .sort((a, b) => b.count - a.count || a.file.localeCompare(b.file))
      .slice(0, 12);

    const lines = sorted.map(({ file, syms, count }) => {
      const rel = path.relative(projectRoot, file);
      const top = syms.slice(0, 3).map((s) => s.name).join(", ");
      const more = count > 3 ? ` +${count - 3}` : "";
      const summary = count > 0 ? `  → ${top}${more}` : "";
      return `  ${rel}${summary}`;
    });
    const overflow = bucket.size - sorted.length;
    const head = `${labels[k]} (${bucket.size}${overflow > 0 ? `, top ${sorted.length}` : ""}):`;
    sections.push(`${head}\n${lines.join("\n")}`);
    totalFiles += bucket.size;
  }

  if (sections.length === 0) {
    return filterKind
      ? `No entrypoints of kind "${filterKind}" detected.`
      : "No entrypoints detected. This may not be a service/app project, or files use uncommon naming.";
  }

  return `Entry points overview (${totalFiles} files):\n\n${sections.join("\n\n")}`;
}

function execNote(
  args: Record<string, unknown>,
  projectPath: string
): string {
  const content = args["content"] as string;
  if (!content || content.trim().length < 10) {
    return "Error: 'content' must be at least 10 chars (substantial finding only).";
  }
  const tags = Array.isArray(args["tags"]) ? (args["tags"] as string[]) : [];
  const files = Array.isArray(args["files"]) ? (args["files"] as string[]) : [];

  log(`[note] tags=${tags.join(",")} files=${files.length}`);

  const note = addNote(projectPath, content, tags, files);
  return `Saved note ${note.id}.\n  Tags: ${note.tags.join(", ") || "(none)"}\n  Files: ${note.files.join(", ") || "(none)"}\n  ${note.content.split("\n")[0]?.slice(0, 100)}…`;
}

function execNotes(
  args: Record<string, unknown>,
  projectPath: string
): string {
  const query = args["query"] as string | undefined;
  const limit = typeof args["limit"] === "number" ? Math.min(args["limit"], 50) : 10;

  log(`[notes] query=${query ?? "(latest)"} limit=${limit}`);

  const notes = searchNotes(projectPath, query).slice(0, limit);
  if (notes.length === 0) {
    return query
      ? `No notes match "${query}".`
      : `No notes saved yet. Use 'note' to record findings worth keeping across sessions.`;
  }

  const blocks = notes.map((n) => {
    const date = n.createdAt.replace("T", " ").slice(0, 16);
    const head = `## ${date} · ${n.id}`;
    const meta: string[] = [];
    if (n.tags.length > 0)  meta.push(`Tags: ${n.tags.join(", ")}`);
    if (n.files.length > 0) meta.push(`Files: ${n.files.join(", ")}`);
    const metaLine = meta.length > 0 ? `\n${meta.join(" | ")}` : "";
    return `${head}${metaLine}\n${n.content}`;
  });

  return `Notes (${notes.length}${query ? ` matching "${query}"` : ", newest first"}):\n\n${blocks.join("\n\n---\n\n")}`;
}

function execForget(
  args: Record<string, unknown>,
  projectPath: string
): string {
  const id = args["id"] as string;
  if (!id) return "Error: 'id' is required.";
  log(`[forget] id=${id}`);
  return removeNote(projectPath, id) ? `Forgot note ${id}.` : `Note ${id} not found.`;
}

function execPatternSearch(
  args: Record<string, unknown>,
  projectPath: string
): string {
  const pattern = args["pattern"] as string;
  const glob = args["glob"] as string | undefined;
  const max = typeof args["max"] === "number" ? Math.min(args["max"], 100) : 20;

  if (!pattern || pattern.length < 2) return "Error: 'pattern' must be at least 2 chars.";

  log(`[pattern_search] pattern="${pattern}" glob=${glob ?? "none"}`);

  const rgArgs = [
    "--line-number", "--no-heading", "--max-filesize", "200K",
    "-e", pattern,
    "--glob", "!node_modules/**", "--glob", "!vendor/**",
    "--glob", "!.git/**", "--glob", "!dist/**", "--glob", "!build/**",
    "--glob", "!**/*.lock", "--glob", "!**/*.min.*", "--glob", "!**/*.map",
  ];
  if (glob) rgArgs.push("--glob", glob);
  rgArgs.push(projectPath);

  let { stdout, stderr } = runRg(rgArgs);

  if (!stdout.trim()) {
    return stderr.includes("regex parse error")
      ? `Invalid regex: ${pattern}\n${stderr.split("\n").slice(0, 3).join("\n")}`
      : `No matches for pattern: ${pattern}`;
  }

  // Aggregate by file: count hits, keep first-line sample
  const projectRoot = path.resolve(projectPath);
  const byFile = new Map<string, { count: number; sample: string; sampleLine: number }>();
  let totalHits = 0;

  for (const line of stdout.split("\n")) {
    const m = line.match(/^(.+?):(\d+):(.*)$/);
    if (!m) continue;
    const [, file, lineStr, content] = m;
    if (!file) continue;
    totalHits++;
    if (!byFile.has(file)) {
      byFile.set(file, {
        count: 1,
        sample: (content ?? "").trim().slice(0, 110),
        sampleLine: parseInt(lineStr ?? "0", 10),
      });
    } else {
      byFile.get(file)!.count++;
    }
  }

  const sorted = [...byFile.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, max);
  const lines = sorted.map(([file, info]) => {
    const rel = path.relative(projectRoot, file);
    return `  ${rel}:${info.sampleLine}  (×${info.count})  ${info.sample}`;
  });

  const more = byFile.size > sorted.length ? ` (top ${sorted.length} of ${byFile.size} files)` : "";
  return `Pattern "${pattern}" — ${totalHits} hits across ${byFile.size} file(s)${more}:\n\n${lines.join("\n")}`;
}

function execTestsFor(
  args: Record<string, unknown>,
  index: Index,
  projectPath: string
): string {
  const target = args["target"] as string;
  if (!target) return "Error: 'target' is required.";

  log(`[tests_for] target="${target}"`);

  const projectRoot = path.resolve(projectPath);
  const looksLikeFile = target.includes("/") || /\.[a-z0-9]{1,5}$/i.test(target);

  let symbolName: string;
  let sourceFile: string | null = null;

  if (looksLikeFile) {
    sourceFile = path.isAbsolute(target) ? path.resolve(target) : path.resolve(projectPath, target);
    if (!fs.existsSync(sourceFile)) return `File not found: ${target}`;
    symbolName = path.basename(sourceFile, path.extname(sourceFile));
  } else {
    const symInfo = getSymbol(target, undefined, index);
    if (!symInfo) {
      const sug = suggestSimilar(target, index, 5);
      return `Symbol "${target}" not found.${formatSuggestions(sug, projectRoot)}`;
    }
    symbolName = symInfo.symbol.name;
    sourceFile = symInfo.symbol.file;
  }

  // 1. Co-located test files (same dir, common naming conventions)
  const colocated: string[] = [];
  if (sourceFile) {
    const dir = path.dirname(sourceFile);
    const base = path.basename(sourceFile, path.extname(sourceFile));
    const ext = path.extname(sourceFile);
    const cap = base.charAt(0).toUpperCase() + base.slice(1);

    const candidates = [
      path.join(dir, `${base}.test${ext}`),
      path.join(dir, `${base}.spec${ext}`),
      path.join(dir, "__tests__", `${base}${ext}`),
      path.join(dir, "__tests__", `${base}.test${ext}`),
      path.join(dir, `${base}_test.go`),
      path.join(dir, `test_${base}.py`),
      path.join(path.dirname(dir), "tests", `test_${base}.py`),
      path.join(dir, `${cap}Test.php`),
      path.join(dir, `${cap}Test.java`),
      path.join(dir, `${cap}Test.kt`),
      path.join(dir, `${base}_spec.rb`),
      path.join(dir, `${base}_test.rb`),
    ];
    for (const c of candidates) {
      try { fs.accessSync(c); colocated.push(c); } catch { /* skip */ }
    }
  }

  // 2. Mentioning tests — ripgrep symbol name in test files
  const rgArgs = [
    "--line-number", "--no-heading", "--max-filesize", "200K",
    "-e", `\\b${symbolName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
    "--glob", "**/*{.test,.spec,_test,_spec,Test,Spec}.{ts,tsx,js,jsx,go,py,php,java,kt,rb}",
    "--glob", "**/__tests__/**",
    "--glob", "**/tests/**",
    "--glob", "**/spec/**",
    "--glob", "**/cypress/**",
    "--glob", "!node_modules/**", "--glob", "!vendor/**",
    projectPath,
  ];
  let stdout = runRg(rgArgs).stdout;

  const mentioning = new Map<string, number>();
  for (const line of stdout.split("\n")) {
    const m = line.match(/^(.+?):(\d+):/);
    if (!m) continue;
    const file = m[1] ?? "";
    if (colocated.includes(file)) continue;  // already counted
    if (file === sourceFile) continue;
    mentioning.set(file, (mentioning.get(file) ?? 0) + 1);
  }

  const sections: string[] = [`Tests covering "${target}":`];

  if (colocated.length > 0) {
    sections.push(`CO-LOCATED (${colocated.length}):\n${colocated.map((f) => `  ${path.relative(projectRoot, f)}`).join("\n")}`);
  }

  if (mentioning.size > 0) {
    const top = [...mentioning.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .map(([file, count]) => `  ${path.relative(projectRoot, file)}  (${count} ref${count === 1 ? "" : "s"})`);
    sections.push(`MENTIONING (${mentioning.size}):\n${top.join("\n")}`);
  }

  if (colocated.length === 0 && mentioning.size === 0) {
    return `No tests found for "${target}". ⚠️  Refactoring this is risky — write tests first.`;
  }

  return sections.join("\n\n");
}

function execHotFiles(
  args: Record<string, unknown>,
  projectPath: string
): string {
  const limit = typeof args["limit"] === "number" ? Math.min(args["limit"], 50) : 15;
  const since = (args["since"] as string) ?? "6 months ago";

  log(`[hot_files] limit=${limit} since=${since}`);

  if (!fs.existsSync(path.join(projectPath, ".git"))) return "Not a git repository.";

  // git log --since=X --name-only --pretty=format: → list of changed files
  const r = spawnSync(
    "git", ["-C", projectPath, "log", `--since=${since}`, "--name-only", "--pretty=format:"],
    { encoding: "utf-8", maxBuffer: 50 * 1024 * 1024 }
  );
  if (r.status !== 0) return `git error: ${(r.stderr ?? "").slice(0, 200)}`;

  const counts = new Map<string, number>();
  for (const line of (r.stdout ?? "").split("\n")) {
    const f = line.trim();
    if (!f) continue;
    if (/\.(lock|min\.[jt]s|map|snap)$/.test(f)) continue;
    if (/^(node_modules|vendor|dist|build|\.git)\//.test(f)) continue;
    counts.set(f, (counts.get(f) ?? 0) + 1);
  }

  // Last commit date per file (for recency boost)
  const sorted = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);

  if (sorted.length === 0) return `No file activity in the last ${since}.`;

  const lines = sorted.map(([file, count]) => {
    // Get most recent author for this file
    const last = spawnSync(
      "git", ["-C", projectPath, "log", "-n", "1", "--pretty=format:%ad|%an", "--date=short", "--", file],
      { encoding: "utf-8" }
    );
    const [date, author] = (last.stdout ?? "").split("|");
    const meta = date ? `  ${date} by ${(author ?? "").slice(0, 18)}` : "";
    return `  ${count.toString().padStart(3)} commits  ${file}${meta}`;
  });

  return `Hot files since ${since} (${counts.size} changed total, top ${sorted.length}):\n\n${lines.join("\n")}`;
}

function execDeadCode(
  args: Record<string, unknown>,
  index: Index,
  projectPath: string
): string {
  const scope = args["scope"] as string | undefined;
  const limit = typeof args["limit"] === "number" ? Math.min(args["limit"], 100) : 30;

  log(`[dead_code] scope=${scope ?? "all"} limit=${limit}`);

  // Filter symbols by scope and skip noise (constructors, anonymous, very short names, magic methods)
  const SKIP_NAMES = new Set([
    "__construct", "constructor", "__init__", "main", "init", "render",
    "toString", "__toString", "equals", "hashCode", "compareTo", "Clone",
    "default", "index", "store", "show", "create", "update", "destroy",  // RESTful conventions
    "execute", "handle", "run", "process",  // common command/job entry points
    "new", "build", "make", "of", "from", "with",  // factories
    "get", "set", "is", "has",
  ]);

  let candidates = index.symbols.filter((s) => {
    if (s.name.length < 5) return false;
    if (SKIP_NAMES.has(s.name)) return false;
    if (s.name.startsWith("_")) return false;          // private convention in many langs
    if (s.name.startsWith("test")) return false;       // test functions are entry points
    if (s.type === "variable" || s.type === "unknown") return false;
    if (/[/_](test|spec)/i.test(s.file)) return false;  // test files don't count
    if (scope && !s.file.includes(scope)) return false;
    return true;
  });

  // Build name→count of definitions (skip names with multiple defs — interfaces/abstract)
  const defCount = new Map<string, number>();
  for (const s of index.symbols) defCount.set(s.name, (defCount.get(s.name) ?? 0) + 1);

  log(`[dead_code] checking ${candidates.length} candidates with ripgrep...`);

  // For each candidate, ripgrep its name across the project. If hits === 1, it's only its definition → dead.
  const dead: Array<{ s: IndexedSymbol; defs: number }> = [];
  const projectRoot = path.resolve(projectPath);

  // Cap how many we check (ripgrep per symbol is expensive)
  const checkCap = Math.min(candidates.length, 500);
  candidates = candidates.slice(0, checkCap);

  for (const s of candidates) {
    if (dead.length >= limit) break;

    const escName = s.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const rgArgs = [
      "--count-matches", "--no-heading",
      "-e", `\\b${escName}\\b`,
      "--glob", "!node_modules/**", "--glob", "!vendor/**",
      "--glob", "!.git/**", "--glob", "!dist/**", "--glob", "!build/**",
      projectPath,
    ];
    let stdout = runRg(rgArgs).stdout;

    let totalHits = 0;
    for (const line of stdout.split("\n")) {
      const m = line.match(/:(\d+)$/);
      if (m) totalHits += parseInt(m[1] ?? "0", 10);
    }

    // Heuristic: dead if total occurrences ≤ defCount (only its own definition(s))
    const numDefs = defCount.get(s.name) ?? 1;
    if (totalHits <= numDefs) {
      dead.push({ s, defs: numDefs });
    }
  }

  if (dead.length === 0) {
    return `No dead code candidates found${scope ? ` in "${scope}"` : ""} (checked ${checkCap} symbols).`;
  }

  const lines = dead.map(({ s }) => {
    return `  ${path.relative(projectRoot, s.file)}:${s.lineStart}  [${s.type}] ${s.name}`;
  });

  const note = checkCap < candidates.length
    ? `\n[Checked ${checkCap}/${candidates.length} candidates — increase scope filter to narrow]`
    : "";

  return `Dead code candidates (${dead.length})${scope ? ` in "${scope}"` : ""}:\n\n${lines.join("\n")}\n\n⚠️  Heuristic only — these symbols may still be used via DI, events, reflection, or external callers.${note}`;
}

function execConfigLookup(
  args: Record<string, unknown>,
  projectPath: string
): string {
  const key = args["key"] as string;
  if (!key || key.length < 2) return "Error: 'key' must be at least 2 chars.";

  log(`[config_lookup] key="${key}"`);

  const keyEsc = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // For nested keys like 'app.timeout', also try the last segment alone (timeout)
  const lastSeg = key.split(/[.\/]/).pop() ?? key;
  const lastSegEsc = lastSeg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // ── Definition patterns: where the key is SET ──
  const defPatterns = [
    // YAML / JSON / TOML — `key:` or `"key":` or `key =`
    `^\\s*['"]?${keyEsc}['"]?\\s*[:=]`,
    // .env style: KEY=value or KEY="value"
    `^\\s*${keyEsc}\\s*=`,
    // Last segment for nested keys (yaml indentation)
    `^\\s*${lastSegEsc}\\s*:`,
  ];
  // Restrict definitions to config file types
  const defGlobs = [
    "--glob", "*.{yaml,yml,json,toml,ini,env,conf,cfg,properties}",
    "--glob", ".env*",
    "--glob", "**/config/**",
    "--glob", "**/.env*",
  ];

  // ── Consumer patterns: where the key is READ ──
  const consumePatterns = [
    // PHP: env('KEY'), config('app.timeout'), getenv('KEY'), $_ENV['KEY']
    `env\\s*\\(\\s*['"\`]${keyEsc}['"\`]`,
    `getenv\\s*\\(\\s*['"\`]${keyEsc}['"\`]`,
    `config\\s*\\(\\s*['"\`]${keyEsc}['"\`]`,
    `\\$_ENV\\s*\\[\\s*['"\`]${keyEsc}['"\`]\\s*\\]`,
    // Symfony parameters: %key%
    `%${keyEsc}%`,
    // Python / Django: os.environ['X'], settings.X
    `os\\.environ(?:\\.get)?\\s*[\\(\\[]\\s*['"\`]${keyEsc}['"\`]`,
    `os\\.getenv\\s*\\(\\s*['"\`]${keyEsc}['"\`]`,
    // Node / TS: process.env.X, process.env['X']
    `process\\.env\\.${keyEsc}\\b`,
    `process\\.env\\s*\\[\\s*['"\`]${keyEsc}['"\`]\\s*\\]`,
    // Spring: @Value("${app.timeout}")
    `@Value\\s*\\(\\s*['"\`]\\$\\{${keyEsc}`,
    // Go: os.Getenv("X"), viper.Get*("X")
    `Getenv\\s*\\(\\s*['"\`]${keyEsc}['"\`]`,
    `viper\\.Get\\w*\\s*\\(\\s*['"\`]${keyEsc}['"\`]`,
    // Ruby: ENV['X'], Rails.application.credentials.X
    `ENV\\s*\\[\\s*['"\`]${keyEsc}['"\`]\\s*\\]`,
    `ENV\\.fetch\\s*\\(\\s*['"\`]${keyEsc}['"\`]`,
    // Go env struct tags (caarlos0/env, envconfig): \`env:"KEY"\` or \`envconfig:"KEY"\`
    `\\benv(?:config)?:"${keyEsc}(?:,[^"]*)?"`,
    // Pydantic BaseSettings: KEY: str = Field(env="KEY")
    `Field\\s*\\(\\s*[^)]*env\\s*=\\s*['"\`]${keyEsc}['"\`]`,
    // Zod env schema: KEY: z.string()  (when paired with declared key)
    `^\\s*${keyEsc}\\s*:\\s*z\\.`,
    // Generic: just the key as a string in code (broad fallback)
    `['"\`]${keyEsc}['"\`]`,
  ];
  const consumeGlobs = [
    "--glob", "!*.{yaml,yml,json,toml,ini,env,conf,cfg,properties,md,lock}",
    "--glob", "!node_modules/**", "--glob", "!vendor/**",
    "--glob", "!.git/**", "--glob", "!dist/**", "--glob", "!build/**",
  ];

  const searchPatterns = (patterns: string[], extraGlobs: string[]): string => {
    const args = [
      "--line-number", "--no-heading", "--max-filesize", "200K",
      "-e", patterns.join("|"),
      ...extraGlobs,
      projectPath,
    ];
    return runRg(args).stdout;
  };

  const definitions = searchPatterns(defPatterns, defGlobs);
  const consumers = searchPatterns(consumePatterns, consumeGlobs);

  const projectRoot = path.resolve(projectPath);
  const formatHits = (raw: string, max: number): { lines: string[]; total: number } => {
    const seen = new Set<string>();
    const out: string[] = [];
    let total = 0;
    for (const line of raw.split("\n")) {
      const m = line.match(/^(.+?):(\d+):(.*)$/);
      if (!m) continue;
      const [, file, lineStr, content] = m;
      const k = `${file}:${lineStr}`;
      if (seen.has(k)) continue;
      seen.add(k);
      total++;
      if (out.length < max) {
        out.push(`  ${path.relative(projectRoot, file ?? "")}:${lineStr}  ${(content ?? "").trim().slice(0, 130)}`);
      }
    }
    return { lines: out, total };
  };

  const defs = formatHits(definitions, 12);
  const cons = formatHits(consumers, 15);

  const sections: string[] = [`Config "${key}":`];

  if (defs.total > 0) {
    const more = defs.total > defs.lines.length ? ` (+${defs.total - defs.lines.length})` : "";
    sections.push(`DEFINED IN (${defs.total}${more}):\n${defs.lines.join("\n")}`);
  } else {
    sections.push(`DEFINED IN: not found in config files (may be set externally — env, k8s secret, CI variable)`);
  }

  if (cons.total > 0) {
    const more = cons.total > cons.lines.length ? ` (+${cons.total - cons.lines.length})` : "";
    sections.push(`CONSUMED BY (${cons.total}${more}):\n${cons.lines.join("\n")}`);
  } else {
    sections.push(`CONSUMED BY: no code reads this key — possibly dead config or read via dynamic key`);
  }

  return sections.join("\n\n");
}

function execInterfaceImplementations(
  args: Record<string, unknown>,
  index: Index,
  projectPath: string
): string {
  const ifaceName = args["interface"] as string;
  if (!ifaceName) return "Error: 'interface' is required.";

  log(`[interface_implementations] iface="${ifaceName}"`);

  const ifaceEsc = ifaceName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // Cross-language patterns for "X implements/extends/inherits Iface"
  const patterns = [
    // PHP / Java / TS: implements Iface (handles multi-implements lists)
    `implements\\s+[\\w,\\s]*\\b${ifaceEsc}\\b`,
    // TS / Java / C#: extends AbstractClass
    `extends\\s+${ifaceEsc}\\b`,
    // Python: class X(Iface): or class X(A, Iface):
    `class\\s+\\w+\\s*\\([^)]*\\b${ifaceEsc}\\b[^)]*\\)\\s*:`,
    // Rust: impl Iface for X
    `impl\\s+${ifaceEsc}\\s+for\\s+\\w+`,
    // Go: doesn't have explicit "implements" — match struct with iface methods (skip, too noisy)
    // Kotlin: class X : Iface
    `class\\s+\\w+\\s*[:,]\\s*[^{]*\\b${ifaceEsc}\\b`,
    // C#: class X : Iface
    `:\\s*[^{,]*\\b${ifaceEsc}\\b`,
  ];

  const rgArgs = [
    "--line-number", "--no-heading", "--max-filesize", "200K",
    "-e", patterns.join("|"),
    "--glob", "!node_modules/**", "--glob", "!vendor/**",
    "--glob", "!.git/**", "--glob", "!dist/**", "--glob", "!build/**",
    "--glob", "!**/*.d.ts",
    projectPath,
  ];

  let stdout = runRg(rgArgs).stdout;

  if (!stdout.trim()) {
    return `No implementations found for "${ifaceName}". May not be an interface, or implementations live outside indexed paths.`;
  }

  const projectRoot = path.resolve(projectPath);
  const seen = new Set<string>();
  const impls: Array<{ file: string; line: number; className: string; layer: string }> = [];

  for (const line of stdout.split("\n")) {
    const m = line.match(/^(.+?):(\d+):(.*)$/);
    if (!m) continue;
    const [, file, lineStr, content] = m;
    const k = `${file}:${lineStr}`;
    if (seen.has(k)) continue;
    seen.add(k);

    // Extract the implementing class/struct name from the matched line
    const classMatch = (content ?? "").match(/(?:class|struct|impl)\s+(\w+)/);
    const className = classMatch?.[1] ?? "(unknown)";
    // Skip self-references (the interface declaring itself)
    if (className === ifaceName) continue;

    impls.push({
      file: file ?? "",
      line: parseInt(lineStr ?? "0", 10),
      className,
      layer: detectLayer(file ?? ""),
    });
  }

  if (impls.length === 0) {
    return `No implementations found for "${ifaceName}" (matched lines were self-references only).`;
  }

  // Group by layer for a quick architectural view
  const byLayer = new Map<string, typeof impls>();
  for (const i of impls) {
    if (!byLayer.has(i.layer)) byLayer.set(i.layer, []);
    byLayer.get(i.layer)!.push(i);
  }

  const sections: string[] = [`Interface "${ifaceName}" — ${impls.length} implementation(s):`];
  for (const [layer, list] of [...byLayer.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const top = list.slice(0, 8).map((i) => `  ${i.className.padEnd(40)} ${path.relative(projectRoot, i.file)}:${i.line}`);
    const more = list.length > top.length ? `\n  ... (+${list.length - top.length} more)` : "";
    sections.push(`[${layer.toUpperCase()}] (${list.length}):\n${top.join("\n")}${more}`);
  }

  return sections.join("\n\n");
}

function execEventHandlers(
  args: Record<string, unknown>,
  projectPath: string
): string {
  const event = args["event"] as string;
  if (!event || event.length < 2) return "Error: 'event' must be at least 2 chars.";

  log(`[event_handlers] event="${event}"`);

  const eventEsc = event.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // Patterns split into 'dispatch' (publishers) and 'handle' (subscribers/listeners)
  // Cross-framework: Symfony, Laravel, NestJS, Spring, Doctrine, EventEmitter, Rails, Django, RxJS
  const dispatchPatterns = [
    // Symfony / generic dispatch
    `->dispatch\\s*\\([^)]*['"\`]${eventEsc}`,
    // Laravel events
    `Event::dispatch\\s*\\([^)]*['"\`]${eventEsc}`,
    `event\\s*\\(\\s*new\\s+\\w*${eventEsc}`,
    // NestJS / EventEmitter
    `eventEmitter\\.emit\\s*\\([^)]*['"\`]${eventEsc}`,
    `\\.emit\\s*\\(\\s*['"\`]${eventEsc}`,
    `\\.publish\\s*\\(\\s*['"\`]${eventEsc}`,
    // Spring publishEvent
    `publishEvent\\s*\\([^)]*${eventEsc}`,
    // Django signals
    `${eventEsc}\\.send\\s*\\(`,
    `${eventEsc}\\.send_robust\\s*\\(`,
    // Rails ActiveSupport notifications
    `ActiveSupport::Notifications\\.instrument\\s*\\(\\s*['"\`]${eventEsc}`,
  ];

  const handlerPatterns = [
    // Symfony attributes
    `#\\[AsEventListener\\s*\\(\\s*['"\`]?${eventEsc}`,
    `#\\[AsMessageHandler`,  // generic message handler — match by symbol below
    // Symfony getSubscribedEvents
    `['"\`]${eventEsc}['"\`]\\s*=>`,
    // NestJS
    `@OnEvent\\s*\\(\\s*['"\`]${eventEsc}`,
    `@EventPattern\\s*\\(\\s*['"\`]${eventEsc}`,
    `@MessagePattern\\s*\\(\\s*['"\`]${eventEsc}`,
    // EventEmitter / EE3
    `\\.on\\s*\\(\\s*['"\`]${eventEsc}`,
    `\\.addListener\\s*\\(\\s*['"\`]${eventEsc}`,
    `\\.subscribe\\s*\\(\\s*['"\`]?${eventEsc}`,
    // Spring @EventListener
    `@EventListener\\s*\\(\\s*classes\\s*=\\s*${eventEsc}`,
    // Doctrine lifecycle
    `@PostPersist|@PrePersist|@PostUpdate|@PreUpdate|@PostRemove|@PreRemove`,
    // Django @receiver
    `@receiver\\s*\\(\\s*${eventEsc}`,
    // Rails callbacks
    `(after|before|around)_(save|create|update|destroy|commit|validation)\\s+:?\\w*${eventEsc}`,
  ];

  const allPatterns = [...dispatchPatterns, ...handlerPatterns];

  const rgArgs = [
    "--line-number", "--no-heading", "--max-filesize", "200K",
    "-e", allPatterns.join("|"),
    "--glob", "!node_modules/**", "--glob", "!vendor/**",
    "--glob", "!.git/**", "--glob", "!dist/**", "--glob", "!build/**",
    projectPath,
  ];

  let stdout = runRg(rgArgs).stdout;

  if (!stdout.trim()) return `No dispatchers or handlers found for event "${event}".`;

  // Classify each hit as dispatch vs handle
  const dispatchers: string[] = [];
  const handlers: string[] = [];
  const projectRoot = path.resolve(projectPath);
  const dispatchRe = new RegExp(dispatchPatterns.join("|"));

  const seen = new Set<string>();
  for (const line of stdout.split("\n").slice(0, 200)) {
    const m = line.match(/^(.+?):(\d+):(.*)$/);
    if (!m) continue;
    const [, file, lineStr, content] = m;
    const key = `${file}:${lineStr}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const rel = path.relative(projectRoot, file ?? "");
    const trimmed = (content ?? "").trim().slice(0, 130);
    const formatted = `  ${rel}:${lineStr}  ${trimmed}`;

    if (dispatchRe.test(content ?? "")) dispatchers.push(formatted);
    else handlers.push(formatted);
  }

  const sections: string[] = [`Event "${event}":`];
  if (dispatchers.length > 0) {
    const top = dispatchers.slice(0, 10);
    const more = dispatchers.length > top.length ? ` (+${dispatchers.length - top.length} more)` : "";
    sections.push(`DISPATCHED FROM (${dispatchers.length}${more}):\n${top.join("\n")}`);
  } else {
    sections.push(`DISPATCHED FROM: none found`);
  }
  if (handlers.length > 0) {
    const top = handlers.slice(0, 15);
    const more = handlers.length > top.length ? ` (+${handlers.length - top.length} more)` : "";
    sections.push(`HANDLED BY (${handlers.length}${more}):\n${top.join("\n")}`);
  } else {
    sections.push(`HANDLED BY: none found`);
  }

  return sections.join("\n\n");
}

function execImpactAnalysis(
  args: Record<string, unknown>,
  index: Index,
  projectPath: string
): string {
  const symbolName = args["symbol"] as string;
  if (!symbolName) return "Error: 'symbol' is required.";

  log(`[impact_analysis] symbol="${symbolName}"`);

  const symInfo = getSymbol(symbolName, undefined, index);
  if (!symInfo) {
    const sug = suggestSimilar(symbolName, index, 5);
    return `Symbol "${symbolName}" not found.${formatSuggestions(sug, path.resolve(projectPath))}`;
  }

  // Direct refs (depth=1)
  const refs = findReferences(symbolName, projectPath, index);
  const projectRoot = path.resolve(projectPath);

  const calls = refs.filter((r) => r.kind === "call");
  const types = refs.filter((r) => r.kind === "type" || r.kind === "other");
  const imports = refs.filter((r) => r.kind === "import");

  // Group callers by file + bucket by layer
  const callerFiles = new Map<string, number>();
  for (const r of calls) {
    callerFiles.set(r.file, (callerFiles.get(r.file) ?? 0) + 1);
  }

  // Layer breakdown
  const byLayer = new Map<string, Set<string>>();
  for (const r of [...calls, ...types]) {
    const layer = detectLayer(r.file);
    if (!byLayer.has(layer)) byLayer.set(layer, new Set());
    byLayer.get(layer)!.add(r.file);
  }

  // Test coverage proxy: how many caller files are tests?
  const testFiles = [...callerFiles.keys()].filter((f) => /\b(test|spec|cypress|__tests__)\b/i.test(f));

  // Risk heuristic
  const riskScore = calls.length + types.length * 0.5 + (callerFiles.size > 10 ? 5 : 0);
  const riskLevel =
    riskScore < 5  ? "LOW"    :
    riskScore < 20 ? "MEDIUM" :
    riskScore < 50 ? "HIGH"   : "CRITICAL";

  const sections: string[] = [];
  sections.push(
    `IMPACT ANALYSIS: ${symbolName} [${symInfo.symbol.type}]`,
    `  ${path.relative(projectRoot, symInfo.symbol.file)}:${symInfo.symbol.lineStart}`,
    `  Risk: ${riskLevel} (${calls.length} direct calls, ${types.length} type/DI refs, ${imports.length} imports across ${callerFiles.size} files)`,
  );

  if (byLayer.size > 0) {
    const layerLines = [...byLayer.entries()]
      .sort((a, b) => b[1].size - a[1].size)
      .map(([layer, files]) => `  ${layer.padEnd(12)} ${files.size} file${files.size === 1 ? "" : "s"}`);
    sections.push(`AFFECTED LAYERS:\n${layerLines.join("\n")}`);
  }

  if (testFiles.length > 0) {
    const top = testFiles.slice(0, 5).map((f) => `  ${path.relative(projectRoot, f)}`);
    sections.push(`TEST COVERAGE: ${testFiles.length} test file(s) reference this symbol\n${top.join("\n")}`);
  } else {
    sections.push(`TEST COVERAGE: ⚠️  no tests reference this symbol — refactor at your own risk`);
  }

  // Top callers (most refs to this symbol)
  if (callerFiles.size > 0) {
    const topCallers = [...callerFiles.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([file, count]) => `  ${path.relative(projectRoot, file)}  (${count} ref${count === 1 ? "" : "s"})`);
    sections.push(`TOP CALLERS:\n${topCallers.join("\n")}`);
  }

  return sections.join("\n\n");
}

function execExplain(
  args: Record<string, unknown>,
  index: Index,
  projectPath: string
): string {
  const target = args["target"] as string;
  if (!target) return "Error: 'target' is required.";

  log(`[explain] target="${target}"`);

  const projectRoot = path.resolve(projectPath);

  // Decide if target is a file path (contains slash or known extension) or a symbol name
  const looksLikeFile = target.includes("/") || /\.[a-z0-9]{1,5}$/i.test(target);

  if (looksLikeFile) {
    const resolved = path.isAbsolute(target) ? path.resolve(target) : path.resolve(projectPath, target);
    if (!fs.existsSync(resolved)) {
      return `File not found: ${target}`;
    }
    return explainFile(resolved, index, projectRoot);
  }

  // Symbol path
  const symInfo = getSymbol(target, undefined, index);
  if (!symInfo) {
    const sug = suggestSimilar(target, index, 5);
    return `Symbol "${target}" not found.${formatSuggestions(sug, projectRoot)}`;
  }
  return explainSymbol(symInfo.symbol, symInfo.body, index, projectRoot);
}

function explainFile(file: string, index: Index, projectRoot: string): string {
  const relPath = path.relative(projectRoot, file);
  const layer = detectLayer(file);

  const fileSymbols = index.symbols.filter((s) => s.file === file);
  const totalLines = (() => {
    try { return fs.readFileSync(file, "utf-8").split("\n").length; } catch { return 0; }
  })();

  // Public API: top-level classes + functions (heuristic: not nested by indentation)
  const classes = fileSymbols.filter((s) => s.type === "class").map((s) => s.name);
  const fns     = fileSymbols.filter((s) => s.type === "function" || s.type === "method").map((s) => s.name);

  // Imports / dependencies — read first 60 lines and extract imports/use/require
  let imports: string[] = [];
  try {
    const head = fs.readFileSync(file, "utf-8").split("\n").slice(0, 60).join("\n");
    imports = extractImports(head);
  } catch { /* skip */ }

  const sections: string[] = [];
  sections.push(`FILE: ${relPath}  (${totalLines} lines, layer=${layer})`);

  if (classes.length > 0) {
    sections.push(`EXPORTS classes: ${classes.slice(0, 8).join(", ")}${classes.length > 8 ? ` (+${classes.length - 8})` : ""}`);
  }
  if (fns.length > 0) {
    sections.push(`EXPORTS functions: ${fns.slice(0, 12).join(", ")}${fns.length > 12 ? ` (+${fns.length - 12})` : ""}`);
  }
  if (imports.length > 0) {
    sections.push(`DEPENDS ON: ${imports.slice(0, 10).join(", ")}${imports.length > 10 ? ` (+${imports.length - 10})` : ""}`);
  }

  // Co-located tests
  const base = path.basename(file, path.extname(file));
  const cap  = base.charAt(0).toUpperCase() + base.slice(1);
  const testFiles = index.files.filter((f) => {
    const b = path.basename(f);
    return b === `${base}.test${path.extname(file)}` ||
           b === `${base}.spec${path.extname(file)}` ||
           b === `${base}_test.go` ||
           b === `test_${base}.py` ||
           b === `${cap}Test.php` ||
           b === `${cap}Test.java`;
  });
  if (testFiles.length > 0) {
    sections.push(`TESTED BY: ${testFiles.map((t) => path.relative(projectRoot, t)).join(", ")}`);
  }

  return sections.join("\n");
}

function explainSymbol(sym: IndexedSymbol, body: string, index: Index, projectRoot: string): string {
  const relPath = path.relative(projectRoot, sym.file);
  const layer = detectLayer(sym.file);
  const lines = body.split("\n");
  const sigLine = lines[0]?.trim().slice(0, 140) ?? "";
  const lineCount = lines.length;

  // Outgoing calls inside this symbol — only ones that match other indexed symbols
  const callNames = extractCallNames(body);
  const knownNames = new Set(index.symbols.map((s) => s.name));
  const knownCalls = [...callNames].filter((n) => knownNames.has(n) && n !== sym.name);

  // Quick caller count via index proximity (cheap proxy: how often this name appears in other files)
  let callerFiles = 0;
  for (const other of index.symbols) {
    if (other.file === sym.file) continue;
    // Could grep, but cheap: count distinct files that reference the same name in any indexed symbol
    if (other.name === sym.name) callerFiles++;
  }

  const sections: string[] = [];
  sections.push(`SYMBOL: ${sym.name}  [${sym.type}]  (${relPath}:${sym.lineStart}-${sym.lineStart + lineCount - 1}, layer=${layer})`);
  sections.push(`SIG: ${sigLine}`);
  sections.push(`SIZE: ${lineCount} lines`);

  if (knownCalls.length > 0) {
    sections.push(`CALLS: ${knownCalls.slice(0, 12).join(", ")}${knownCalls.length > 12 ? ` (+${knownCalls.length - 12})` : ""}`);
  } else {
    sections.push(`CALLS: (none indexed)`);
  }

  if (callerFiles > 0) {
    sections.push(`NAME also defined in ${callerFiles} other file(s) — use find_references for callers`);
  }

  return sections.join("\n");
}

function extractImports(headCode: string): string[] {
  const out = new Set<string>();
  // ES imports
  for (const m of headCode.matchAll(/import\s+(?:[^'"\n]+\s+from\s+)?['"]([^'"]+)['"]/g)) {
    if (m[1]) out.add(m[1]);
  }
  // PHP use
  for (const m of headCode.matchAll(/^use\s+([\w\\]+)/gm)) {
    if (m[1]) out.add(m[1].split("\\").pop() ?? m[1]);
  }
  // Python from X import / import X
  for (const m of headCode.matchAll(/^from\s+([\w.]+)\s+import/gm)) {
    if (m[1]) out.add(m[1]);
  }
  for (const m of headCode.matchAll(/^import\s+([\w.]+)/gm)) {
    if (m[1] && !m[1].includes("'")) out.add(m[1]);
  }
  // Go imports (single-line and grouped)
  for (const m of headCode.matchAll(/import\s+["']([^"']+)["']/g)) {
    if (m[1]) out.add(m[1].split("/").pop() ?? m[1]);
  }
  // Rust use
  for (const m of headCode.matchAll(/^use\s+([\w:]+)/gm)) {
    if (m[1]) out.add(m[1].split("::").pop() ?? m[1]);
  }
  return [...out];
}

function execRecentChanges(
  args: Record<string, unknown>,
  index: Index,
  projectPath: string
): string {
  const since = args["since"] as string | undefined;
  const userBase = args["base"] as string | undefined;
  const head = (args["head"] as string | undefined) ?? "HEAD";

  log(`[recent_changes] base=${userBase ?? "auto"} head=${head} since=${since ?? "n/a"}`);

  const gitDir = path.join(projectPath, ".git");
  if (!fs.existsSync(gitDir)) return "Not a git repository.";

  const run = (gitArgs: string[]): string => {
    const r = spawnSync("git", ["-C", projectPath, ...gitArgs], { encoding: "utf-8" });
    return (r.stdout ?? "").trim();
  };

  const currentBranch = run(["rev-parse", "--abbrev-ref", head]) || head;

  // Auto-detect base: try origin/HEAD, then main, master, develop
  let base = userBase ?? "";
  if (!base) {
    const originHead = run(["symbolic-ref", "refs/remotes/origin/HEAD"]).replace("refs/remotes/", "");
    if (originHead) base = originHead;
    else for (const cand of ["main", "master", "develop"]) {
      if (run(["rev-parse", "--verify", "--quiet", cand])) { base = cand; break; }
    }
  }
  if (!base) base = "HEAD~10";  // last-resort fallback

  // ── Commits in branch ──────────────────────────────────────────────────────
  const logArgs = ["log", `${base}..${head}`, "--pretty=format:%h|%ad|%an|%s", "--date=short"];
  if (since) logArgs.push(`--since=${since}`);
  logArgs.push("-n", "20");
  const commitsRaw = run(logArgs);
  const commits = commitsRaw.split("\n").filter((l) => l.includes("|"));

  // ── Files changed (committed, vs base) ─────────────────────────────────────
  const filesCommitted = run(["diff", "--numstat", `${base}...${head}`])
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => {
      const parts = l.split(/\s+/);
      const added = parseInt(parts[0] ?? "0", 10) || 0;
      const removed = parseInt(parts[1] ?? "0", 10) || 0;
      const file = parts.slice(2).join(" ");
      return { file, added, removed, status: "committed" as const };
    })
    .filter((c) => c.file);

  // ── Uncommitted (working dir + staged) — only meaningful when inspecting HEAD
  const inspectingHead = head === "HEAD";
  const filesUncommitted = inspectingHead
    ? run(["diff", "--numstat", "HEAD"])
        .split("\n")
        .filter((l) => l.trim().length > 0)
        .map((l) => {
          const parts = l.split(/\s+/);
          const added = parseInt(parts[0] ?? "0", 10) || 0;
          const removed = parseInt(parts[1] ?? "0", 10) || 0;
          const file = parts.slice(2).join(" ");
          return { file, added, removed, status: "uncommitted" as const };
        })
        .filter((c) => c.file)
    : [];

  // ── Map line ranges → symbols using the index ──────────────────────────────
  const projectRoot = path.resolve(projectPath);
  const indexByFile = new Map<string, typeof index.symbols>();
  for (const s of index.symbols) {
    const rel = path.relative(projectRoot, s.file);
    if (!indexByFile.has(rel)) indexByFile.set(rel, []);
    indexByFile.get(rel)!.push(s);
  }

  const symbolsForFile = (relFile: string, status: "committed" | "uncommitted"): string[] => {
    const fileSymbols = indexByFile.get(relFile);
    if (!fileSymbols || fileSymbols.length === 0) return [];

    const diffArgs = status === "committed"
      ? ["diff", "--unified=0", `${base}...${head}`, "--", relFile]
      : ["diff", "--unified=0", "HEAD", "--", relFile];
    const diff = run(diffArgs);
    const hunkRe = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm;
    const touchedLines: number[] = [];
    let m: RegExpExecArray | null;
    while ((m = hunkRe.exec(diff)) !== null) {
      const start = parseInt(m[1] ?? "0", 10);
      const span  = parseInt(m[2] ?? "1", 10) || 1;
      for (let i = 0; i < span; i++) touchedLines.push(start + i);
    }

    const touchedSymbols = new Set<string>();
    for (const line of touchedLines) {
      const sym = fileSymbols
        .filter((s) => s.lineStart <= line && s.lineEnd >= line)
        .sort((a, b) => b.lineStart - a.lineStart)[0];
      if (sym && sym.name.length > 1) touchedSymbols.add(sym.name);
    }
    return [...touchedSymbols].slice(0, 5);
  };

  // ── Format output ──────────────────────────────────────────────────────────
  const sections: string[] = [];
  sections.push(`Branch: ${currentBranch}  (vs ${base})`);

  if (commits.length > 0) {
    const lines = commits.slice(0, 10).map((c) => {
      const [hash, date, author, ...rest] = c.split("|");
      return `  ${hash}  ${date}  ${(author ?? "").padEnd(18)}  ${rest.join("|").slice(0, 80)}`;
    });
    const more = commits.length > 10 ? ` (+${commits.length - 10} more)` : "";
    sections.push(`COMMITS (${commits.length}${more}):\n${lines.join("\n")}`);
  } else {
    sections.push(`COMMITS: none`);
  }

  type ChangedFile = { file: string; added: number; removed: number; status: "committed" | "uncommitted" };
  const formatFiles = (files: ChangedFile[], label: string): string => {
    if (files.length === 0) return `${label}: none`;
    const top = files.slice(0, 15);
    const lines = top.map((c) => {
      const sigil = `+${c.added} -${c.removed}`.padEnd(10);
      const syms = symbolsForFile(c.file, c.status);
      const symPart = syms.length > 0 ? `  → ${syms.join(", ")}` : "";
      return `  ${c.file}  ${sigil}${symPart}`;
    });
    const more = files.length > top.length ? `\n  ... (+${files.length - top.length} more)` : "";
    return `${label} (${files.length}):\n${lines.join("\n")}${more}`;
  };

  sections.push(formatFiles(filesCommitted, "FILES (committed)"));
  if (filesUncommitted.length > 0) {
    sections.push(formatFiles(filesUncommitted, "UNCOMMITTED"));
  }

  return sections.join("\n\n");
}

function dispatchTool(
  name: string,
  args: Record<string, unknown>,
  index: Index,
  projectPath: string
): string {
  const cacheKey = CACHEABLE.has(name) ? `${name}:${stableStringify(args)}` : null;
  if (cacheKey) {
    const cached = cacheGet(cacheKey);
    if (cached !== null) {
      log(`[cache hit] ${name}`);
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
    default:                 return `Unknown tool: ${name}`;
  }

  // Add token budget footer for large responses (>=500 tokens) so callers can self-regulate.
  // ~4 chars per token is the standard heuristic for English/code mixes.
  const approxTokens = Math.round(result.length / 4);
  if (approxTokens >= 500) {
    const ms = Date.now() - t0;
    result = `${result}\n\n[~${approxTokens} tokens, ${ms}ms]`;
  }

  if (cacheKey) cacheSet(cacheKey, result);
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
  toolCache.clear();
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
          serverInfo: { name: "lexis", version: "0.2.0" },
          instructions: LEXIS_INSTRUCTIONS,
        });
        break;

      case "notifications/initialized":
        // No response for notifications
        break;

      case "tools/list":
        ok(id, { tools: TOOLS });
        break;

      case "tools/call": {
        const p = params as { name: string; arguments?: Record<string, unknown> };
        if (!p?.name) { err(id, -32602, "Missing tool name"); break; }

        const toolArgs = p.arguments ?? {};
        try {
          index = refreshIfStale(index, resolvedPath);
          let result: string;
          if (p.name === "reindex") {
            index = buildIndex(resolvedPath, index, "reindex requested");
            toolCache.clear();
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
    log("[lexis mcp] stdin closed, exiting.");
    process.exit(0);
  });
}
