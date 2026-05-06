// Meta tools — those that operate on project-wide patterns or run external
// processes (linters), rather than searching code:
//   • lint            — run typechecker/linter, return parsed errors
//   • resolve_import  — given a file + symbol, find where the import came from
//   • outline         — list all signatures in a file (no bodies)
//   • list_todos      — list TODO/FIXME/XXX/HACK markers across the project

import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";
import { Index } from "../../core/indexer";
import { getSymbol } from "../../core/searcher";
import { detectLinter } from "../tool-filtering";
import { runRg } from "../runtime/ripgrep";
import { formatPathList } from "../runtime/path-utils";

export function execLint(
  args: Record<string, unknown>,
  projectPath: string,
): string {
  const pathFilter = (args["path_filter"] as string | undefined)?.toLowerCase();

  const detected = detectLinter(projectPath);
  if (!detected) {
    return "No linter detected. Lexis looked for: tsconfig.json, go.mod, Cargo.toml, pyproject.toml, composer.json, Gemfile.";
  }

  const r = spawnSync(detected.cmd, detected.args, {
    cwd: projectPath,
    encoding: "utf-8",
    timeout: 60_000,
  });

  const output = ((r.stdout ?? "") + (r.stderr ?? "")).trim();

  if (r.error && (r.error as NodeJS.ErrnoException).code === "ENOENT") {
    return `${detected.label} project detected, but the linter "${detected.cmd}" is not installed.\nInstall it to run \`lint\` automatically. Marker: ${detected.marker}`;
  }

  if (!output) {
    return `${detected.label}: no errors.`;
  }

  const projectRoot = path.resolve(projectPath);
  const diagnosticRe = /^(.+?\.\w+):(\d+)(?::(\d+))?\s*[-:]?\s*(error|warning|note|info)?\s*[:.]?\s*(.+)$/i;
  const seen = new Set<string>();
  const out: string[] = [];

  for (const line of output.split("\n")) {
    const m = line.match(diagnosticRe);
    if (!m) continue;
    const [, file, lineNum, col, kind, msg] = m;
    const fileStr = file ?? "";
    if (pathFilter && !fileStr.toLowerCase().includes(pathFilter)) continue;

    const rel = path.isAbsolute(fileStr) ? path.relative(projectRoot, fileStr) : fileStr;
    const key = `${rel}:${lineNum}:${col ?? "0"}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const k = kind ?? "error";
    out.push(`${rel}:${lineNum}${col ? `:${col}` : ""}  [${k.toLowerCase()}] ${(msg ?? "").trim().slice(0, 200)}`);
  }

  if (out.length === 0) {
    return `${detected.label}: no errors.`;
  }

  return `${detected.label} — ${out.length} issue(s):\n\n${out.slice(0, 100).join("\n")}${out.length > 100 ? `\n\n[${out.length - 100} more — use path_filter to narrow]` : ""}`;
}

// Given a file and an imported symbol, return the symbol's definition.
// Generic across TS/JS/Python/PHP/Rust/Java/Ruby import syntax.
export function execResolveImport(
  args: Record<string, unknown>,
  index: Index,
  projectPath: string,
): string {
  const file = args["file"] as string;
  const symbol = args["symbol"] as string;
  if (!file || !symbol) return "Error: 'file' and 'symbol' are required.";

  const projectRoot = path.resolve(projectPath);
  const resolvedFile = path.isAbsolute(file) ? file : path.resolve(projectRoot, file);

  let content: string;
  try { content = fs.readFileSync(resolvedFile, "utf-8"); }
  catch { return `Could not read file: ${file}`; }

  const escSym = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const importPatterns = [
    new RegExp(`^\\s*import\\b.*\\b${escSym}\\b`, "m"),
    new RegExp(`^\\s*from\\s+\\S+\\s+import\\b.*\\b${escSym}\\b`, "m"),
    new RegExp(`^\\s*use\\s+[\\w\\\\:.]*${escSym}\\b`, "m"),
    new RegExp(`^\\s*(require|include|require_relative)\\b.*${escSym}`, "m"),
  ];

  const isImported = importPatterns.some((re) => re.test(content));
  if (!isImported) {
    return `Symbol "${symbol}" is not imported in ${path.relative(projectRoot, resolvedFile)}.`;
  }

  const def = getSymbol(symbol, undefined, index);
  if (!def) {
    return `Symbol "${symbol}" is imported but its definition was not found in the indexed code. May be from an external dependency (node_modules, vendor).`;
  }

  const relDef = path.relative(projectRoot, def.symbol.file);
  const lineCount = def.body.split("\n").length;
  return `IMPORTED IN: ${path.relative(projectRoot, resolvedFile)}\nDEFINED IN: ${relDef}:${def.symbol.lineStart}-${def.symbol.lineStart + lineCount - 1} [${def.symbol.type}]\n\n\`\`\`\n${def.body}\n\`\`\``;
}

// File outline — print signatures only, no bodies. ~10x cheaper than read_file
// when you just want to know what a file exposes. Universal signature detector
// covers most languages.
export function execOutline(
  args: Record<string, unknown>,
  _index: Index,
  projectPath: string,
): string {
  const file = args["file"] as string;
  if (!file) return "Error: 'file' is required.";

  const projectRoot = path.resolve(projectPath);
  const resolved = path.isAbsolute(file) ? file : path.resolve(projectRoot, file);

  let lines: string[];
  try { lines = fs.readFileSync(resolved, "utf-8").split("\n"); }
  catch { return `File not found or unreadable: ${file}`; }

  const SIGNATURE_PATTERNS: Array<{ re: RegExp; kind: string }> = [
    { re: /^\s*(export\s+)?(default\s+)?(abstract\s+|async\s+)*class\s+\w+/, kind: "class" },
    { re: /^\s*(export\s+)?interface\s+\w+/, kind: "interface" },
    { re: /^\s*(export\s+)?(type|enum)\s+\w+/, kind: "type" },
    { re: /^\s*(export\s+)?(default\s+)?(async\s+)?function\s+\w+/, kind: "function" },
    { re: /^\s*(public|private|protected|static|async|readonly|abstract|override)?\s*(public|private|protected|static|async|readonly|abstract|override)?\s*\w+\s*\([^)]*\)\s*[:{]/, kind: "method" },
    { re: /^\s*(pub\s+(\(\w+\)\s+)?)?(async\s+)?fn\s+\w+/, kind: "function" },
    { re: /^\s*(pub\s+(\(\w+\)\s+)?)?(struct|enum|trait|impl)\s+\w+/, kind: "type" },
    { re: /^\s*func\s+(\(\s*\w+\s+[^)]+\)\s+)?\w+\s*\(/, kind: "function" },
    { re: /^\s*type\s+\w+\s+(struct|interface)/, kind: "type" },
    { re: /^\s*(async\s+)?def\s+\w+\s*\(/, kind: "function" },
    { re: /^\s*class\s+\w+/, kind: "class" },
    { re: /^\s*defmodule\s+[\w.]+/, kind: "module" },
    { re: /^\s*(def|defp|defmacro)\s+\w+/, kind: "function" },
    { re: /^\s*sub\s+\w+/, kind: "function" },
    { re: /^\s*module\s+\w+/, kind: "module" },
  ];

  const out: string[] = [];
  const SKIP = /^\s*(if|else|for|while|switch|catch|try|return|new|throw|do)\b/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.length === 0 || line.length > 300) continue;
    if (SKIP.test(line)) continue;

    for (const { re, kind } of SIGNATURE_PATTERNS) {
      if (!re.test(line)) continue;
      const sigLines: string[] = [line.trimEnd()];
      let j = i;
      while (j < lines.length - 1) {
        const t = (sigLines[sigLines.length - 1] ?? "").trim();
        if (t.endsWith("{") || t.endsWith(":") || /[=]>\s*\{?\s*$/.test(t)) break;
        if (!t.endsWith(",") && !t.endsWith("(")) break;
        j++;
        sigLines.push((lines[j] ?? "").trimEnd());
        if (sigLines.length >= 4) break;
      }
      const sig = sigLines.join("\n").trimStart().slice(0, 240);
      out.push(`  ${(i + 1).toString().padStart(4)}  [${kind}] ${sig}`);
      break;
    }
  }

  if (out.length === 0) {
    return `No signatures detected in ${path.relative(projectRoot, resolved)} (${lines.length} lines). File may have unsupported syntax.`;
  }

  const header = `FILE: ${path.relative(projectRoot, resolved)} (${lines.length} lines, ${out.length} signatures)\n`;
  return header + out.join("\n");
}

// List TODO/FIXME/XXX/HACK markers via ripgrep.
export function execListTodos(
  args: Record<string, unknown>,
  projectPath: string,
): string {
  const pathFilter = (args["path_filter"] as string | undefined)?.toLowerCase();
  const limit = typeof args["limit"] === "number" ? args["limit"] : 50;

  const rgArgs = [
    "--line-number", "--no-heading", "--max-filesize", "200K",
    "-e", "\\b(TODO|FIXME|XXX|HACK)\\b",
    "--glob", "!node_modules/**", "--glob", "!vendor/**",
    "--glob", "!.git/**", "--glob", "!dist/**", "--glob", "!build/**",
    "--glob", "!**/*.lock", "--glob", "!**/*.min.*",
    projectPath,
  ];
  const stdout = runRg(rgArgs).stdout;
  if (!stdout.trim()) return "No TODOs/FIXMEs found.";

  const projectRoot = path.resolve(projectPath);
  const lines = stdout.trim().split("\n");
  const filtered: string[] = [];

  for (const line of lines) {
    const m = line.match(/^(.+?):(\d+):(.*)$/);
    if (!m) continue;
    const [, file, lineNum, content] = m;
    if (pathFilter && !(file ?? "").toLowerCase().includes(pathFilter)) continue;

    const rel = path.relative(projectRoot, file ?? "");
    const trimmed = (content ?? "").trim().slice(0, 120);
    filtered.push(`${rel}:${lineNum}  ${trimmed}`);
    if (filtered.length >= limit) break;
  }

  if (filtered.length === 0) return "No TODOs/FIXMEs found matching the filter.";

  const overflow = lines.length - filtered.length;
  const body = formatPathList(filtered);
  return overflow > 0 ? `${body}\n\n[${overflow} more — refine path_filter]` : body;
}
