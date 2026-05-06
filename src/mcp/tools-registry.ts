// Registry of all MCP tool definitions (name + description + inputSchema).
// Each entry follows the MCP `tools/list` shape. Handlers live elsewhere
// (server.ts dispatches by name).

export const TOOLS = [
  {
    name: "search_code",
    description: "Search code. output: snippet|compact|content|files|count|trace|signatures|arch (default compact). depth 1-2 (default 1). top_k default 3. context: bug|feature (auto-tunes depth and ranking).",
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
    description: "Find code that writes to a file/filename across PHP/JS/Python/Ruby/Bash. Detects writeFile, fopen('w'), shell redirects, etc. Use when investigating 'config not updating' bugs.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Filename or path fragment to find writers for (e.g. 'config.json', '/etc/myapp/')" },
      },
      required: ["target"],
    },
  },
  {
    name: "git_context",
    description: "Get git context for a keyword: matching branches + recent commits. Surfaces in-progress work before duplicating effort.",
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
    description: "Find dispatchers + handlers of an event/signal (Symfony, Laravel, NestJS, Spring, Doctrine, EventEmitter, Rails, Django signals). Use when call_chain hits 'no path' due to event indirection.",
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
        tags:    { type: "array", items: { type: "string" }, description: "Topic tags (e.g. ['auth', 'bug', 'JIRA-1234'])" },
        files:   { type: "array", items: { type: "string" }, description: "Related files (e.g. ['src/auth/login.ts:42'])" },
      },
      required: ["content"],
    },
  },
  {
    name: "notes",
    description: "Recall persistent notes from previous sessions. Call FIRST on a known area. Match by content/tag/file substring, or no query for latest 10.",
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
  {
    name: "lint",
    description: "Run project typechecker/linter, return only parsed errors+warnings. Auto-detects TS/Go/Rust/Python/PHP/Ruby by marker file. Saves reading raw compiler output.",
    inputSchema: {
      type: "object",
      properties: {
        path_filter: { type: "string", description: "Optional: only show errors in files containing this substring" },
      },
    },
  },
  {
    name: "resolve_import",
    description: "Given a file and an imported symbol, return the symbol's definition without you having to read the importing file. Saves a Read+grep round-trip. Supports TS/JS, Python, PHP, Rust, Java import syntax.",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string", description: "The file that imports the symbol (relative or absolute path)" },
        symbol: { type: "string", description: "The imported symbol/identifier name" },
      },
      required: ["file", "symbol"],
    },
  },
  {
    name: "outline",
    description: "Show only signatures (class/function/method headers) of a file without bodies. Lets you understand the API of a file in ~10x less tokens than read_file. Use this when you need to know WHAT a file exposes, not HOW it implements it.",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string", description: "File path (relative or absolute)" },
      },
      required: ["file"],
    },
  },
  {
    name: "list_todos",
    description: "List all TODO, FIXME, XXX, HACK markers in the project. Use to triage technical debt or check pending items in a specific area. Optional path_filter to narrow scope.",
    inputSchema: {
      type: "object",
      properties: {
        path_filter: { type: "string", description: "Optional: only show TODOs in files whose path contains this" },
        limit: { type: "number", description: "Max results (default 50)" },
      },
    },
  },
  {
    name: "investigate",
    description: "All-in-one symbol exploration: returns the definition + who references it + related tests in a single call. Saves 2-3 round-trips compared to chaining get_symbol+find_references+tests_for. Use when you need to understand a class/function holistically.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Symbol name (exact or partial)" },
        file_filter: { type: "string", description: "Optional: filter by file path substring" },
      },
      required: ["name"],
    },
  },
];
