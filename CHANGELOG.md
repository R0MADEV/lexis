# Changelog

Notable changes and architectural decisions in Lexis MCP. Most recent first.

## v0.12.0 — modularization + test coverage

**Internal refactor of `src/mcp/server.ts` (3,550 → 2,504 lines, -29%).**

### Modules extracted

| New module | Responsibility |
|---|---|
| `src/mcp/runtime/cache.ts` | LRU cache for tool results (5-min TTL) |
| `src/mcp/runtime/jsonrpc.ts` | JSON-RPC 2.0 helpers (`send`, `ok`, `err`) |
| `src/mcp/runtime/ripgrep.ts` | `resolveRg`, `runRg`, bundled-vs-system fallback |
| `src/mcp/runtime/path-utils.ts` | `baseFileName`, `compressPaths`, `formatPathList` |
| `src/mcp/runtime/search-utils.ts` | `rankFiles`, `identTokens`, `globToRegex`, `findEnclosingSignatures`, `truncateIfExcessive`, `rerankSearchResults` |
| `src/mcp/tool-filtering.ts` | Project-aware tool list filtering, linter detection, ULTRA_DESCRIPTIONS |
| `src/mcp/tools-registry.ts` | The 30-tool MCP registry (name + description + inputSchema) |
| `src/mcp/instructions.ts` | `LEXIS_INSTRUCTIONS` + `buildSessionInstructions` |
| `src/mcp/tools/notes.ts` | `note`, `notes`, `forget` handlers |
| `src/mcp/tools/meta.ts` | `lint`, `resolve_import`, `outline`, `list_todos` handlers |

### Test coverage

**Tests: 102 → 183.** New suites:

- `src/__tests__/helpers.test.ts` (47 tests) — pure helpers: `identTokens`, `globToRegex`,
  `baseFileName`, `compressPaths`, `formatPathList`, `rankFiles`, `truncateIfExcessive`,
  `findEnclosingSignatures`, `isMainBranch`, `categoryForBranch`, LRU cache, `readRangeKey`,
  `isUltraMode`, `detectLinter`, `detectBranch`.
- `src/__tests__/session-tracker.test.ts` (10 tests) — `trackToolCall`, `saveSessionLog`,
  branch-aware skip, idempotency.
- Smoke tests for 17 previously uncovered MCP tools (find_references, call_chain,
  pattern_search, find_writes, git_context, recent_changes, hot_files, tests_for,
  config_lookup, explain, event_handlers, impact_analysis, interface_implementations,
  dead_code, list_entrypoints, get_context, investigate). All with real assertions
  (`toContain` / `toMatch` / `not.toContain`), no `typeof string` placeholders.

### Cleanup

- Anonymized all internal project references (ivoz/deitu/PROVIDER tickets) in code,
  tests, and docs. Generic examples only.
- README now states client-validation status honestly: only Claude Code is tested
  in real workflows. Other MCP clients listed as "untested — should work".
- Added a real session walkthrough example to README (sanitized version of a
  PROVIDER-style bug investigation).

### Known limitation discovered

Lexis declines to save notes (manual or auto-session) when the current branch is
`main`/`master`/`develop`. This is intentional for users (no active work in main
yet) but **counterproductive when developing Lexis itself**, where everything
happens on main. Workarounds for this codebase: this CHANGELOG, or temporary
feature branches.

---

## v0.11.0 — `LEXIS_COMPRESSION=ultra` mode

Aggressive token-saving mode (opt-in via env var). Saves ~1,610 tokens of fixed
cost on tool descriptions plus ~30% per response. Trade-off: less context for
Claude → may pick wrong tools more often. Worth measuring in real use.

## v0.10.0 — token-saving features

- `outline(file)` tool: signatures only, no bodies (~10x cheaper than `read_file`)
- In-session `read_file` deduplication: same range twice returns marker not content
- `read_file` shows full enclosing class/method signatures, not just names

## v0.9.0 — three new tools

- `lint` — auto-detects TS/Go/Rust/Python/PHP/Ruby and parses output
- `resolve_import` — find where a symbol came from (TS/JS/Py/PHP/Rust/Java/Ruby)
- `list_todos` — TODO/FIXME/XXX/HACK across the project

Plus context-aware tool filtering: `lint` only exposed if a linter marker exists,
`git_context`/`recent_changes`/`hot_files` only if `.git` exists, etc.

## v0.8.0 — output optimizations

- Path compression: common prefix shown once at top of result lists
- `investigate(symbol)` tool: definition + references + tests in one call
- Auto-truncate huge `read_file` outputs with resume marker

## v0.7.0 — auto-session logging

- Mechanical session log written on shutdown (close, SIGINT, SIGTERM, crash)
- Manual notes prioritized over auto-session in MCP `instructions`
- Strong "when to call note()" rules added to instructions

## v0.6.0 — branch-aware notes

- Notes auto-categorized by current git branch:
  `bugs/`, `features/`, `others/` folders under `~/.lexis/projects/<slug>/`.
- Auto-load notes for the current branch into MCP `instructions` at session start.
- Migration: legacy flat `notes.md` → `others/legacy-notes.md`.

## v0.5.0 — smarter ranking

- `find_file`: ranking by exact filename, camelCase ↔ kebab-case ↔ snake_case
  equivalence, glob patterns (`*Controller.ts`), src/ over tests/ preference.
- `search_code`: rerank results by exact-name match + src/tests heuristics.

## v0.4.0 — language fallbacks + DSLs

- Modular parsers (`src/core/parsers/<lang>.ts`).
- Built-in support for Kamailio (`route[NAME]`), Asterisk dialplan (`[context]`),
  CGRates JSON profiles (scoped to CGRates files only).
- Ripgrep fallback for `get_symbol`/`list_symbols` on unsupported languages.

## v0.3.0 — `--global` setup + auto-install

- `lexis setup --global --auto`: registers MCP at user scope (Claude Code).
- Postinstall script auto-registers Claude Code on `npm install -g lexis-mcp`
  and writes usage hints to `~/.claude/CLAUDE.md`.
- `LEXIS_NO_AUTOSETUP=1` to opt out.

## v0.2.0 — initial public release

First version distributed via npm: `npm install -g lexis-mcp`.
