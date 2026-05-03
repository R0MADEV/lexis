# lexis-mcp

Lexical + structural code retrieval for LLMs. An MCP server that gives Claude Code, Cursor, and other AI assistants a set of precise code-search tools — so they find the right code fast instead of reading entire files.

**Result: ~80% fewer tokens per complex task.** A typical bug investigation drops from ~15,000 tokens to ~3,000.

No vectors. No embeddings. No external servers. Just ripgrep + AST symbol extraction.

---

## Install

```bash
npm install -g lexis-mcp
```

Or run without installing:

```bash
npx lexis-mcp setup /path/to/your/project
```

## Quick start

```bash
# Index your project and get MCP setup instructions for Claude Code
lexis setup /path/to/your/project

# Auto-register with Claude Code (requires claude CLI)
lexis setup /path/to/your/project --auto

# For Cursor, Windsurf, Continue, or any other client
lexis setup /path/to/your/project --client cursor
lexis setup /path/to/your/project --client windsurf
lexis setup /path/to/your/project --all   # print instructions for all clients
```

That's it. The MCP server starts on demand — no background process needed.

---

## Supported clients

| Client | ID |
|---|---|
| Claude Code | `claude-code` |
| Cursor | `cursor` |
| Continue.dev | `continue` |
| Cline / Claude Dev | `cline` |
| Roo Code | `roo` |
| Goose (Block) | `goose` |
| Zed | `zed` |
| OpenCode | `opencode` |
| Gemini CLI | `gemini-cli` |
| Windsurf | `windsurf` |

```bash
lexis clients   # list all
```

---

## What the AI gets

28 tools across 8 output modes. The AI calls these autonomously — no manual search needed.

### Search & navigation
| Tool | What it does |
|---|---|
| `search_code` | Regex/literal search with ripgrep. Returns compact snippets by default. |
| `get_symbol` | Get a function/class/variable definition by name. |
| `find_references` | Find all usages of a symbol. |
| `find_file` | Locate files matching a name pattern. |
| `read_file` | Read a file slice (offset + limit lines). Shows which function/class you're inside. |
| `list_symbols` | List all symbols in a file. |
| `pattern_search` | Multi-pattern grep (AND/OR logic). |
| `find_writes` | Find where a variable or field is mutated. |

### Architecture & flow
| Tool | What it does |
|---|---|
| `call_chain` | Trace who calls what — upstream or downstream. |
| `list_entrypoints` | Find routes, CLI commands, event listeners, crons. |
| `event_handlers` | Find event/hook/subscriber registrations. |
| `interface_implementations` | Find classes that implement an interface or extend a base. |
| `impact_analysis` | Show what would break if a symbol changed. |
| `dead_code` | Find exported symbols with no references. |

### Context & history
| Tool | What it does |
|---|---|
| `git_context` | Recent commits + diff for a file. |
| `recent_changes` | Files changed in the last N days. |
| `hot_files` | Files with the most commits (churn). |
| `tests_for` | Find test files related to a source file. |
| `config_lookup` | Find config keys/env vars by name. |
| `explain` | Summarize what a file or symbol does (reads its code). |

### Output modes
| Mode | Tokens/result | Use when |
|---|---|---|
| `snippet` | ~15 | Orient yourself — just the matching line ± context |
| `compact` | ~50 | Default — line + surrounding block |
| `signatures` | ~20 | Browse an API without reading bodies |
| `files` | ~5 | Just file paths |
| `count` | ~3 | How many matches exist |
| `content` | ~500 | Need the full implementation |
| `trace` | ~80 | Follow a call chain |
| `arch` | ~30 | Architecture-level view |

### Persistent notes (across sessions)
```
note: "ProxyTrunk reload fix — must call kamailio.reload() after DB commit, not before"
notes: query="kamailio"
forget: id="abc123"
```

Notes live in `~/.lexis/projects/<slug>/notes.md` — readable by humans and AI alike.

---

## Storage

Everything lives in `~/.lexis/` — never inside your project repo.

```
~/.lexis/
  projects/
    Users-you-myproject/
      index.json      ← symbol index
      notes.md        ← persistent notes
```

The index auto-migrates if you had a `.lexis-index.json` in your project root.

---

## Indexed languages

TypeScript, JavaScript, Python, Go, Rust, Ruby, Java, Kotlin, PHP, C/C++, C#, Swift, Perl, Bash/Shell

Frameworks detected automatically: React, Vue, Angular, Laravel, Symfony, Django, Flask, Spring, Express, Next.js, Nuxt

---

## CLI reference

```bash
lexis setup <path>                  # index + print Claude Code MCP command
lexis setup <path> --auto           # auto-register with Claude Code
lexis setup <path> --client cursor  # Cursor instructions
lexis setup <path> --all            # all clients
lexis setup <path> --name myapp     # override MCP server name

lexis index <path>                  # incremental re-index
lexis index <path> --full           # full re-index

lexis clients                       # list supported MCP clients

lexis ask "question" -p <path>      # ask a question via CLI (requires API key)
```

---

## How it works

1. `lexis index` scans your project with ripgrep, extracts symbols (functions, classes, constants), and stores a compact JSON index in `~/.lexis/`.
2. When Claude Code (or any MCP client) calls a tool like `search_code`, the MCP server searches the index and returns precise snippets — not whole files.
3. The AI uses multiple tools iteratively until it has enough context. Token usage is 5–10× lower than reading files directly.

**Incremental indexing**: re-index only touches files modified since the last run. A 50k-file project re-indexes in under a second.

---

## Requirements

- Node.js 18+
- [ripgrep](https://github.com/BurntSushi/ripgrep) — optional but strongly recommended (`brew install ripgrep`)

No API key needed for MCP mode — the AI client provides the model.

---

## License

MIT
