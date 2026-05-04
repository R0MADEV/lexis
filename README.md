# lexis-mcp

A code-search MCP server that gives Claude Code, Cursor, Windsurf and other AI assistants 28 specialized tools to navigate large codebases — without burning tokens.

**Result: ~80% fewer tokens per complex task.** A typical bug investigation drops from ~15,000 tokens to ~3,000.

No vectors. No embeddings. No external services. Just ripgrep + AST symbol extraction + smart ranking.

---

## Install

```bash
npm install -g lexis-mcp
```

That's it. The postinstall:
- Registers Lexis with Claude Code automatically (user scope, works in any project)
- Writes usage hints to `~/.claude/CLAUDE.md` so Claude prefers Lexis over `Read`/`Grep`
- Bundles ripgrep — no extra dependencies

For other clients (Cursor, Windsurf, OpenCode, etc.):
```bash
lexis setup --global --client cursor      # prints the JSON to paste into your client config
lexis setup --global --all                # prints config for all 10 supported clients
```

---

## Why it exists

LLMs are smart but not omniscient. When you ask Claude Code about a bug in a 100k-line codebase, it has two options:
1. **Read whole files blindly** — burns tokens, often misses the cause
2. **Use search tools** — fast and precise, but only if those tools exist

`lexis-mcp` provides those tools. Claude Code calls them autonomously through MCP, gets exactly what it needs, and answers with a fraction of the context.

---

## Supported clients

10 MCP-compatible clients:

| Client | Auto-register on install |
|---|---|
| Claude Code | ✅ |
| Cursor | Manual (one config paste) |
| Continue.dev | Manual |
| Cline / Claude Dev | Manual |
| Roo Code | Manual |
| Goose (Block) | Manual |
| Zed | Manual |
| OpenCode | Manual |
| Gemini CLI | Manual |
| Windsurf (Codeium) | Manual |

```bash
lexis clients              # list all
lexis setup --global --client <id>
```

---

## What the AI gets

28 tools across 8 output modes. Every tool is designed to return only what's relevant — never whole files unless asked.

### Search & navigation

| Tool | What it does |
|---|---|
| `search_code` | Smart search with ranking: exact-name matches first, src/ before tests/ |
| `get_symbol` | Get a function/class/variable definition by name. Falls back to ripgrep for unsupported languages |
| `find_references` | Find all usages of a symbol |
| `find_file` | Locate files. Supports camelCase ↔ kebab-case ↔ snake_case equivalence and globs (`*.controller.ts`) |
| `read_file` | Read a file slice (offset + limit). Shows the enclosing function/class as header |
| `list_symbols` | List symbols in a file. Falls back to ripgrep for non-supported languages |
| `pattern_search` | Multi-pattern grep with AND/OR logic |
| `find_writes` | Find where a variable, field, or file path is mutated |

### Architecture & flow

| Tool | What it does |
|---|---|
| `call_chain` | Trace upstream/downstream callers |
| `list_entrypoints` | Discover routes, CLI commands, event listeners, crons |
| `event_handlers` | Find event/hook/subscriber registrations |
| `interface_implementations` | Find classes that implement an interface or extend a base |
| `impact_analysis` | Show what would break if a symbol changed |
| `dead_code` | Find exported symbols with no references |

### Context & history

| Tool | What it does |
|---|---|
| `git_context` | Recent commits + diff for a file |
| `recent_changes` | Files changed in the last N days |
| `hot_files` | Files with the most commits (churn signal) |
| `tests_for` | Find test files related to a source file |
| `config_lookup` | Find config keys / env vars by name |
| `explain` | Summarize what a file or symbol does |

### Persistence

| Tool | What it does |
|---|---|
| `note` | Save a finding so future sessions inherit it |
| `notes` | Recall past findings, filter by tag/file/content |
| `forget` | Delete a note |
| `reindex` | Force a re-index — Claude can call this if results seem stale |

### Output modes

| Mode | Tokens/result | Use when |
|---|---|---|
| `snippet` | ~15 | Orient yourself — match line ± 1 |
| `compact` | ~50 | Default — signature + first body line |
| `signatures` | ~20 | Browse an API without reading bodies |
| `files` | ~5 | Just file paths |
| `count` | ~3 | How many matches exist |
| `content` | ~500 | Full implementation, when really needed |
| `trace` | ~80 | Follow a call chain |
| `arch` | ~30 | Architecture-level overview |

---

## Indexed languages and DSLs

**General-purpose languages** (full AST symbol extraction):
TypeScript, JavaScript, Python, Go, Rust, Ruby, Java, Kotlin, C#, PHP, C/C++, Swift, Dart, Scala, Elixir, Perl, Bash/Shell.

**Telecom DSLs** (built-in parsers — useful for VoIP/billing backends):
- **Kamailio** (`.cfg`) — `route[NAME]`, `failure_route[NAME]`, `event_route[NAME]`, etc.
- **Asterisk dialplan** (`.conf`) — `[context]` blocks
- **CGRates** (scoped JSON) — Profile IDs (`ATTR_*`, `FLTR_*`, `THD_*`, `RTE_*`...)

**Framework awareness**: Symfony Routes (PHP attributes), React/Vue, Next.js, Laravel, Spring, Django/Flask, Express, Nuxt.

**Anything else**: tools that depend on the symbol graph fall back to ripgrep with universal definition patterns (`def`, `fn`, `class`, `module`, etc.) so they still return useful results in unsupported languages.

---

## How it compares to other MCPs

Honest comparison — not every MCP is trying to do the same thing.

| MCP | Approach | Best for | Limit |
|---|---|---|---|
| **lexis-mcp** | Lexical + structural via ripgrep + AST. Pre-builds a symbol index. 28 specialized tools. | Searching, navigating, and understanding existing code. Bug investigation, feature planning. | No semantic search — won't find conceptually related code that uses different words |
| **filesystem MCP** (official) | Generic read/write of files | Reading/writing files where the AI already knows the path | No search, no symbol extraction, no ranking |
| **Serena** | Uses LSP (Language Server Protocol) per language | Maximum precision (real type info, real refs) | Requires LSPs installed and running per language; heavier setup |
| **Repomix** | Bundles the entire repo into one big file for the LLM | Small repos that fit in context | Opposite of token-efficient on large repos |
| **Context7** | Remote SSE server for library documentation | Looking up API docs of public packages | Doesn't index your project code |

**When to use Lexis:**
- Large codebases where reading whole files is wasteful
- Multi-language / multi-stack projects (e.g., PHP + Asterisk + Kamailio)
- You want zero per-project setup once installed globally
- You don't want native dependencies or embedding databases

**When NOT to use Lexis:**
- Tiny codebases — Repomix or just `Read` is fine
- You need real type-checked references — Serena (LSP) is more precise
- You only need to look up library docs — use Context7

---

## How it works

1. **Index** — `lexis` scans the project, extracts symbols using language-specific parsers, stores a compact JSON in `~/.lexis/projects/<slug>/index.json`.
2. **Auto-refresh** — every 30 seconds the MCP server checks file mtimes; if anything changed it re-indexes incrementally (sub-second on most projects).
3. **Search** — when a tool is called, results are ranked: exact-name matches first, `src/`/`lib/`/`app/` over `tests/`/`vendor/`/`docs/`, shorter paths over longer ones.
4. **Cache** — recent results are LRU-cached for 5 min to avoid re-running expensive searches across iterative calls. Cache is wiped automatically on re-index.

**Modular parsers**: each language lives in `src/core/parsers/<lang>.ts`. Adding a new DSL is 3 lines: a regex file, an import, an extension. See `src/core/parsers/kamailio.ts` for the simplest example.

---

## Storage

Everything lives in `~/.lexis/` — **never** inside your project repo:

```
~/.lexis/
  projects/
    Users-you-myproject/
      index.json      ← symbol index (~300 KB for 1500 symbols)
      notes.md        ← persistent notes, human-readable markdown
```

The index migrates automatically if a legacy `.lexis-index.json` is found inside the project.

---

## CLI reference

```bash
# Setup (one-time)
lexis setup --global              # user-scope MCP, works in every project
lexis setup --global --auto       # also auto-register with Claude Code
lexis setup <path>                # per-project setup (alternative)
lexis setup <path> --client cursor

# Indexing (mostly automatic)
lexis index <path>                # incremental re-index
lexis index <path> --full         # full re-scan

# Inspection
lexis clients                     # list supported MCP clients

# Optional
lexis init <path>                 # write CLAUDE.local.md (gitignored) with hints
lexis ask "<question>" -p <path>  # ask via CLI (requires API key)
```

---

## Configuration

Lexis works with zero configuration. Optional environment variables:

| Var | Purpose |
|---|---|
| `LEXIS_NO_AUTOSETUP=1` | Skip postinstall auto-registration |
| `LEXIS_TOOL_RESULT_LIMIT` | Max results per tool (default: 20) |
| `LEXIS_DEBUG=true` | Verbose logging on stderr |

---

## Requirements

- Node.js 18+
- ripgrep (bundled — no extra install needed)
- An MCP-compatible AI client (Claude Code, Cursor, Windsurf, etc.)

No API key is required for MCP mode — the AI client provides the model.

---

## Quality

- 68 tests covering parsers, indexer, MCP tools, ranking
- CI on Linux, macOS, and Windows × Node 18 / 20 / 22
- TypeScript strict mode
- Zero runtime dependencies beyond bundled ripgrep + the official Anthropic / OpenAI / commander / dotenv packages

---

## Contributing

Adding a new language or DSL:
1. Create `src/core/parsers/<name>.ts` exporting a `ParserPattern[]`
2. Import + spread it in `src/core/parsers/index.ts`
3. Add the file extension to `SUPPORTED_EXTENSIONS` in `src/core/indexer.ts`
4. Add a test in `src/__tests__/indexer.test.ts`

See `kamailio.ts` (10 lines) for a minimal example.

---

## License

MIT
