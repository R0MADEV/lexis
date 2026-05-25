// explain — describe a file or symbol in compact form:
// public API, dependencies, callers count, co-located tests.

import * as fs from "fs";
import * as path from "path";
import { getSymbol, suggestSimilar } from "../../core/searcher";
import { Index, Symbol as IndexedSymbol } from "../../core/indexer";
import { log } from "../runtime/jsonrpc";
import { detectLayer, extractCallNames, formatSuggestions } from "../runtime/format";

export function execExplain(
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
