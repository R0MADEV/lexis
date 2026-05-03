# Lexis — Technical Architecture

## Overview

Lexis is a CLI tool that does lexical code retrieval for LLMs. The core idea: instead of vectorizing a codebase or sending everything to an AI, Lexis finds the exact code chunks relevant to a question using grep-based search and dependency graph traversal, then sends only those chunks to the LLM.

No vector databases. No embedding models. No semantic search. Just fast, exact lexical search.

---

## Project Structure

```
lexis/
├── src/
│   ├── core/                        # Pure business logic, no external dependencies
│   │   ├── indexer.ts               # Walks project files, extracts symbols
│   │   ├── searcher.ts              # Search engine + graph traversal
│   │   ├── chunker.ts               # Prompt builder, response parser, token estimator
│   │   ├── language-detector.ts     # Detects language and framework from file headers
│   │   └── git-context.ts           # Git branch, recent commits, recent changes
│   ├── adapters/
│   │   ├── llm/
│   │   │   ├── claude.ts            # Anthropic SDK — ask() + askWithTools()
│   │   │   └── openai.ts            # OpenAI SDK — ask() + askWithTools()
│   │   └── storage/
│   │       └── index-file.ts        # Save/load symbol index to disk
│   └── cli/
│       ├── main.ts                  # Entry point, loads .env.local
│       └── commands/
│           ├── index.ts             # `lexis index <path>`
│           └── ask.ts               # `lexis ask "<question>"`
├── .env                             # Template (committed)
├── .env.local                       # Real keys (gitignored)
├── package.json
└── tsconfig.json
```

---

## Architecture

Clean/Hexagonal architecture with three layers:

**Core** — pure logic. No imports from adapters or CLI. Can be tested in isolation.

**Adapters** — implement interfaces defined by core. Swap Claude for GPT or disk storage for S3 without touching core logic.

**CLI** — thin shell. Parses args, wires dependencies, calls core through adapters.

---

## How a Question Gets Answered

### Mode 1: Native Tool Calling (default)

```
lexis ask "question"
        │
        ├── loadIndex(projectPath)
        ├── getGitContext(projectPath)       ← branch, last commits, recent diffs
        │
        └── toolCallingMode()
              │
              ├── define tools:
              │     search_code(query)       ← calls search() internally
              │     read_file(path)          ← reads up to 300 lines
              │
              ├── estimateTokens(systemPrompt + question)
              │
              └── askClaudeWithTools() / askOpenAIWithTools()
                    │
                    ├── LLM calls search_code("term1")  → results returned
                    ├── LLM calls search_code("term2")  → results returned
                    ├── LLM calls read_file("/path")    → file content returned
                    └── LLM stops calling tools → final answer
```

The LLM controls the retrieval loop. It decides what to search, when it has enough context, and when to stop.

### Mode 2: JSON Protocol (LEXIS_TOOL_CALLING=false)

```
lexis ask "question"
        │
        └── reasoningLoop()
              │
              for each iteration (up to LEXIS_MAX_ITERATIONS):
              │
              ├── check searchCache — skip if already searched
              ├── search(query, index, projectPath, topK=5)
              ├── build prompt with chunks + git context
              ├── estimateTokens(prompt) → log
              ├── llm(prompt)
              │
              └── parse JSON response:
                    {
                      needs_more_context: true/false,
                      search_terms: ["term1", "term2"],
                      partial_analysis: "...",
                      answer: "...",
                      read_file: "/path/to/file.ts"  ← optional
                    }
                    │
                    ├── if read_file → read and add as chunk, continue
                    ├── if needs_more_context → set currentQuery = search_terms, continue
                    └── if answer → print and exit
```

---

## Core Modules

### indexer.ts

Walks all project files recursively (skips `node_modules`, `.git`, `dist`, `build`, `.next`) and extracts symbols by regex:

- `function functionName`
- `const name = () =>`
- `class ClassName`
- `fn name(` (Rust)
- `def name(` (Python)
- `func name(` (Go)

Saves to `.lexis-index.json` at the project root.

```typescript
interface Symbol {
  name: string;
  file: string;      // absolute path
  lineStart: number;
  lineEnd: number;   // lineStart + 20 (approximate)
  type: "function" | "class" | "variable";
}

interface Index {
  symbols: Symbol[];
  projectPath: string;
  createdAt: string;
}
```

---

### searcher.ts

The main search pipeline. Entry point is `search()`.

#### Step 1 — Extract technical terms

```typescript
extractTechnicalTerms("how does useContactMatchOrder work")
// → ["useContactMatchOrder", "does", "useContactMatchOrder", "work"]
// camelCase terms extracted first, then words > 4 chars
```

#### Step 2 — ripgrep search

Searches for `\bterm1\b|\bterm2\b` across the project. Falls back to Node.js `fs` walk if `rg` is not installed.

`findRipgrep()` checks: `rg`, `/opt/homebrew/bin/rg`, `/usr/local/bin/rg`, `~/.cargo/bin/rg`

#### Step 3 — Extract function context

For each match, `extractFunction()` walks backwards from the matched line to find the enclosing top-level function (regex requires no leading whitespace), then walks forward counting `{` and `}` to find the end. Capped at 60 lines.

#### Step 4 — Filter by dominant layer

`filterByDominantLayer()` — in fullstack projects, finds whether the results are mostly frontend or backend and filters out the minority layer unless they score ≥ 2 matches.

```typescript
const LAYER_BY_EXT = {
  ".ts": "frontend", ".tsx": "frontend", ".js": "frontend",
  ".go": "backend", ".py": "backend", ".rb": "backend", ...
}
```

Cross-layer results are only kept if the origin file has explicit API/WebSocket calls (`fetch()`, `axios.*`, `socket.emit`, `/api/` strings, etc.).

#### Step 5 — Graph traversal

`traverseGraph()` expands the initial results by following references:

- Imports: `import { X, Y } from 'z'` → extracts `X`, `Y`
- Function calls: `functionName(` → extracts `functionName`
- camelCase identifiers: `useContactMatchOrder` → extracted

For each reference, runs a new ripgrep search. Results from different layers are filtered by `isConnected()` which reads the origin file and checks for cross-layer patterns.

Traversal results are re-scored against the **original query terms** (not the traversal term) — if score is 0, the result is discarded. This prevents unrelated code from polluting results.

Depth is configurable (default: 2). Each depth level expands up to 5 new files.

#### Step 6 — Sort and deduplicate

- `dedup()` — removes overlapping results (same file, overlapping line ranges)
- `sortByRelevanceAndRecency()` — sorts by match count, then by file modification time (most recently modified first)

---

### language-detector.ts

Detects language (from file extension) and framework (from import patterns in the first 20 lines of the file header).

```typescript
interface LanguageContext {
  language: string;
  framework: string | null;
  genericKeywords: Set<string>;
}
```

The `genericKeywords` set is used by `extractReferences()` to filter out framework noise (e.g. `useState`, `useEffect`, `render`, `computed`) so the traversal doesn't follow React/Vue internals.

**Languages**: TypeScript, JavaScript, Python, Rust, Go, PHP, Java, Ruby, Swift, Kotlin

**Frameworks detected by imports**:
- React: `from 'react'`
- Vue: `from 'vue'`
- Angular: `@angular/`
- Laravel: `use Illuminate\`
- Symfony: `use Symfony\`
- Django: `from django`
- Flask: `from flask`
- Spring: `org.springframework`
- Express: `require('express')`
- Testing: `describe(`, `it(`, `test(`, `expect(`

---

### chunker.ts

Builds prompts and parses LLM responses.

**`buildPrompt()`** — first iteration, builds both a simple and an iterative prompt.

**`buildIterativePrompt()`** — subsequent iterations. Includes all accumulated chunks plus partial analysis from previous iterations. Accepts optional `gitContext` string injected into the system prompt.

**`parseLLMResponse()`** — extracts JSON from LLM response. Handles both ` ```json ``` ` blocks and raw `{...}` objects.

**`estimateTokens(text)`** — `Math.ceil(text.length / 4)`. Rough estimate, useful for monitoring cost before each LLM call.

**`LLMResponse` interface**:
```typescript
interface LLMResponse {
  needs_more_context: boolean;
  search_terms: string[];
  partial_analysis: string | null;
  answer: string | null;
  read_file?: string | null;   // LLM can request a full file
}
```

**`LexisTool` interface** — shared between claude.ts and openai.ts:
```typescript
interface LexisTool {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
  execute: (args: Record<string, unknown>) => Promise<string>;
}
```

---

### git-context.ts

Runs three git commands via `execSync` (silences stderr, catches all errors):

```bash
git rev-parse --abbrev-ref HEAD      # current branch
git log --oneline -10                # last 10 commits
git diff HEAD~1 --stat               # files changed in last commit
```

Returns `null` if not a git repo or git is not installed. Safe to call anywhere.

---

## LLM Adapters

### claude.ts

- `ask(prompt)` — simple single-turn call to `claude-sonnet-4-6`, max 4096 tokens
- `askWithTools(systemPrompt, userMessage, tools)` — runs a tool use loop up to 15 turns. On each turn: if `stop_reason === "tool_use"`, executes all requested tools and feeds results back. If `stop_reason === "end_turn"`, returns the text response.

### openai.ts

- `ask(prompt)` — single-turn call to `gpt-4o`, max 4096 tokens
- `askWithTools(systemPrompt, userMessage, tools)` — same loop logic using OpenAI function calling. Handles `ChatCompletionMessageFunctionToolCall` type narrowing (`toolCall.type === "function"` guard).

---

## CLI Commands

### `lexis index <path>`

Calls `buildIndex(projectPath)` from `indexer.ts`. Walks all files, extracts symbols, saves to `<projectPath>/.lexis-index.json`. Prints symbol count when done.

### `lexis ask "<question>" [--lang en|es]`

1. Loads index from `.lexis-index.json`
2. Resolves LLM (checks `ANTHROPIC_API_KEY` first, then `OPENAI_API_KEY`)
3. If `LEXIS_TOOL_CALLING !== "false"` → runs `toolCallingMode()`
4. Otherwise → runs `reasoningLoop()`

Both modes share:
- Search cache (`Set<string>`) — skips duplicate queries
- Git context — injected once into the system prompt
- Token estimation — logged before every LLM call

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Enables Claude. Takes priority over OpenAI. |
| `OPENAI_API_KEY` | — | Enables GPT-4o. Used if no Anthropic key. |
| `LEXIS_LANG` | `en` | Response language. `en` or `es`. |
| `LEXIS_MAX_ITERATIONS` | `3` | Max loop iterations in JSON protocol mode. |
| `LEXIS_TOOL_CALLING` | `true` | Set to `false` to use JSON protocol instead of native tool calling. |
| `LEXIS_DEBUG` | `false` | Set to `true` to print traversal debug logs. |

`.env` is the committed template. `.env.local` holds real secrets and overrides `.env` (loaded by `dotenv` in `main.ts`).

---

## Key Design Decisions

**Why lexical and not semantic search?**
Semantic search requires an embedding model and a vector store. Lexical search works immediately on any project, costs nothing to index, and is exact — function names, variable names, and call sites are exact strings, not approximate concepts.

**Why graph traversal?**
A single grep for "useContactMatchOrder" finds the function definition but not the state it reads, the hooks it calls, or the API it hits. Graph traversal follows the dependency chain to surface the full context the LLM needs.

**Why dominant layer filtering?**
In fullstack projects, searching for "session" returns both the React session hook and the Go session middleware. The LLM question is usually about one layer. Filtering to the dominant layer (by total match score) reduces noise and avoids confusing the LLM with unrelated code.

**Why native tool calling over JSON protocol?**
JSON protocol requires the LLM to format its response as valid JSON every time. Tool calling is a first-class API feature — the LLM calls tools without needing to produce formatted JSON, and the search loop is driven by the model rather than by our code. More robust, fewer format failures, better results.

**Why re-score traversal results against the original query?**
Without re-scoring, traversal can surface files that match a traversal term (e.g. `useState`) but have nothing to do with the original question. Re-scoring against the original query terms and discarding 0-score results keeps the context window clean.
