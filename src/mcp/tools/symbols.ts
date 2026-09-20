// Symbol-lookup tools: list_symbols, find_file, get_symbol.
// Each ships with a ripgrep fallback for languages the indexer doesn't cover.

import * as fs from "fs";
import * as path from "path";
import { getSymbol, suggestSimilar } from "../../core/searcher";
import { Index } from "../../core/indexer";
import { pathFilterMatches } from "../../core/path-match";
import { log } from "../runtime/jsonrpc";
import { runRg } from "../runtime/ripgrep";
import { rankFiles } from "../runtime/search-utils";
import { formatSuggestions } from "../runtime/format";

export function execListSymbols(
  args: Record<string, unknown>,
  index: Index
): string {
  const fileFilter = args["path_filter"] as string | undefined;
  const nameFilter = (args["name_filter"] as string | undefined)?.toLowerCase();

  let symbols = index.symbols;
  if (fileFilter) symbols = symbols.filter((s) => pathFilterMatches(s.file, fileFilter));
  if (nameFilter) symbols = symbols.filter((s) => s.name.toLowerCase().includes(nameFilter));

  log(`[list_symbols] ${symbols.length} results`);

  if (symbols.length > 0) {
    const lines = symbols.slice(0, 60).map((s) => `${s.file}:${s.lineStart} [${s.type}] ${s.name}`);
    const suffix = symbols.length > 60 ? `\n... (${symbols.length - 60} more)` : "";
    return lines.join("\n") + suffix;
  }

  // Fallback: scan files matching fileFilter for definition lines via ripgrep.
  // Helps when the file is in an unsupported language (Lua, Elixir, Kamailio, etc.).
  if (fileFilter) {
    const fallback = ripgrepListSymbolsFallback(fileFilter, index.projectPath);
    if (fallback) return fallback;
  }
  return "No symbols found.";
}

function ripgrepListSymbolsFallback(fileFilter: string, projectPath: string): string | null {
  // Same patterns as get_symbol, capturing the name with a group for output formatting.
  const patterns = [
    `(class|interface|trait|struct|type|enum|object|module|record)\\s+([A-Za-z_][\\w]*)`,
    `(def|defn|defmodule|defmacro|defprotocol|defp|fn|func|function|sub|method|proc|procedure)\\s+([A-Za-z_][\\w:]*)`,
    `route\\[([A-Za-z_][\\w]*)\\]`,
    `^\\[([A-Za-z_][\\w-]*)\\]\\s*$`,
  ];

  const rgArgs = [
    "--line-number", "--no-heading", "--max-filesize", "200K",
    "-e", patterns.join("|"),
    "--glob", `*${fileFilter}*`,
    "--glob", "!node_modules/**", "--glob", "!vendor/**", "--glob", "!.git/**",
    "--glob", "!dist/**", "--glob", "!build/**",
    projectPath,
  ];

  const stdout = runRg(rgArgs).stdout;
  if (!stdout.trim()) return null;

  const projectRoot = path.resolve(projectPath);
  const out: string[] = [];
  for (const line of stdout.trim().split("\n").slice(0, 60)) {
    const m = line.match(/^(.+?):(\d+):(.*)$/);
    if (!m) continue;
    const [, file, lineNum, content] = m;
    const rel = path.relative(projectRoot, file ?? "");
    out.push(`${rel}:${lineNum}  ${(content ?? "").trim().slice(0, 120)}`);
  }
  if (out.length === 0) return null;

  return `[fallback search — file may be in an unsupported language]\n${out.join("\n")}`;
}

export function execFindFile(
  args: Record<string, unknown>,
  index: Index
): string {
  const rawPattern = args["pattern"] as string;
  if (!rawPattern) return "Error: 'pattern' is required.";

  const ranked = rankFiles(rawPattern, index.files);
  log(`[find_file] "${rawPattern}" → ${ranked.length} results`);

  if (ranked.length === 0) {
    return `No files match "${rawPattern}".`;
  }
  const top = ranked.slice(0, 30).map((r) => r.file);
  const suffix = ranked.length > 30 ? `\n... (${ranked.length - 30} more)` : "";
  return top.join("\n") + suffix;
}

// Rank files by relevance to the search pattern.
// Strategies tried in order (higher score wins):
//   1. Glob match (e.g. *.controller.ts, **/auth/*)
//   2. Exact filename match (case-insensitive)
//   3. Identifier-tokenized filename match (UserController == user-controller == user_controller)
//   4. Substring filename match
//   5. Substring path match
//
// Tie-breakers (added to score, smaller adjustments):
//   + bonus for shorter paths (likely more "primary" files)
//   + bonus for src/lib/app/core dirs
//   - penalty for tests/, vendor/, fixtures/, docs/
// (helpers moved to runtime/search-utils.ts and runtime/path-utils.ts)

export function execGetSymbol(
  args: Record<string, unknown>,
  index: Index,
  projectPath: string
): string {
  const name = args["name"] as string;
  const fileFilter = args["path_filter"] as string | undefined;

  log(`[get_symbol] name="${name}" file_filter=${fileFilter ?? "none"}`);

  const result = getSymbol(name, fileFilter, index);
  if (result) {
    const { symbol: sym, body } = result;
    const relPath = path.relative(path.resolve(projectPath), sym.file);
    const lineCount = body.split("\n").length;
    return `SYMBOL: ${sym.name} [${sym.type}]\nFILE: ${relPath} (lines ${sym.lineStart}-${sym.lineStart + lineCount - 1})\n\n\`\`\`\n${body}\n\`\`\``;
  }

  // Fallback for unsupported languages / DSLs: search definition patterns with ripgrep.
  // Covers Elixir, Lua, Scala, Dart, Erlang, Clojure, R, Julia, plus any DSL with
  // common definition syntax (def, fn, function, sub, defmodule, defn, etc.).
  const fallback = ripgrepDefinitionFallback(name, projectPath, fileFilter);
  if (fallback) return fallback;

  const suggestions = suggestSimilar(name, index, 5);
  return `Symbol "${name}" not found.${formatSuggestions(suggestions, path.resolve(projectPath))}`;
}

// Look up a symbol definition with ripgrep when the indexer didn't catch it.
// Useful for languages without an AST extractor and for DSLs (kamailio.cfg, dialplan).
function ripgrepDefinitionFallback(name: string, projectPath: string, fileFilter?: string): string | null {
  const escName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Universal definition patterns across languages and DSLs:
  //   class Foo / interface Foo / trait Foo / struct Foo / type Foo
  //   def Foo / defn Foo / defmodule Foo / defmacro Foo (Elixir/Clojure)
  //   function Foo / fn Foo / func Foo / sub Foo (JS/Rust/Go/Perl)
  //   route[Foo] / context[Foo]      (Kamailio/Asterisk dialplan)
  //   [Foo]                          (Asterisk extensions context header)
  //   Foo = function / Foo: function (Lua/object literal styles)
  const patterns = [
    `(class|interface|trait|struct|type|enum|object|module|record)\\s+${escName}\\b`,
    `(def|defn|defmodule|defmacro|defprotocol|defp|fn|func|function|sub|method|proc|procedure)\\s+${escName}\\b`,
    `\\b${escName}\\s*[=:]\\s*(function|fn|\\(|async\\s*\\()`,  // Foo = function() / Foo: () =>
    `route\\[${escName}\\]`,                                     // Kamailio route[X]
    `^\\[${escName}\\]\\s*$`,                                    // Asterisk [context], INI [section]
  ];

  const rgArgs = [
    "--line-number", "--no-heading", "--max-filesize", "200K",
    "-e", patterns.join("|"),
    "--glob", "!node_modules/**", "--glob", "!vendor/**", "--glob", "!.git/**",
    "--glob", "!dist/**", "--glob", "!build/**",
  ];
  if (fileFilter) rgArgs.push("--glob", `*${fileFilter}*`);
  rgArgs.push(projectPath);

  const stdout = runRg(rgArgs).stdout;
  if (!stdout.trim()) return null;

  const projectRoot = path.resolve(projectPath);
  const lines = stdout.trim().split("\n").slice(0, 5);
  const blocks: string[] = [];

  for (const line of lines) {
    const m = line.match(/^(.+?):(\d+):(.*)$/);
    if (!m) continue;
    const [, file, lineNumStr, content] = m;
    const lineNum = parseInt(lineNumStr ?? "0", 10);
    const relPath = path.relative(projectRoot, file ?? "");

    // Show the definition line plus 5 surrounding lines for context.
    let snippet = (content ?? "").trim();
    try {
      const allLines = fs.readFileSync(file ?? "", "utf-8").split("\n");
      const start = Math.max(0, lineNum - 1);
      const end = Math.min(allLines.length, lineNum + 5);
      snippet = allLines.slice(start, end).join("\n");
    } catch { /* keep single-line snippet */ }

    blocks.push(`FILE: ${relPath}:${lineNum}\n\`\`\`\n${snippet}\n\`\`\``);
  }

  if (blocks.length === 0) return null;

  const header = `Symbol "${name}" found via fallback search (no indexed AST for this language).\nShowing top ${blocks.length} definition match(es):\n\n`;
  return header + blocks.join("\n\n");
}
