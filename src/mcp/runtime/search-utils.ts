// Pure helpers for search and read_file output: signature detection, ranking,
// truncation, identifier tokenization, glob conversion. No fs / no side effects.

import { SearchResult } from "../../core/searcher";
import { baseFileName } from "./path-utils";

// Tokenize an identifier-style string. UserController → ["user", "controller"];
// user-controller → ["user", "controller"]; my_var → ["my", "var"]
export function identTokens(s: string): string[] {
  return s
    .replace(/[-_.\s]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

// Convert a simple glob to a RegExp. Supports * (any chars except /), ** (any),
// ? (single char), and literal segments. Insensitive on case.
export function globToRegex(glob: string): RegExp {
  const re = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")  // escape regex specials except * and ?
    .replace(/\*\*/g, "::DOUBLESTAR::")
    .replace(/\*/g, "[^/\\\\]*")
    .replace(/\?/g, ".")
    .replace(/::DOUBLESTAR::/g, ".*");
  return new RegExp(re + "$", "i");
}

// Find the enclosing class/function/method signature for a given line offset.
// Walks backwards looking at indent levels to identify nesting.
export function findEnclosingSignatures(lines: string[], offset: number): string[] {
  const SIG_RE = /^(\s*)(export\s+|public\s+|private\s+|protected\s+|static\s+|async\s+|abstract\s+|default\s+|pub\s+|suspend\s+|override\s+|readonly\s+|final\s+)*(class\s+\w|interface\s+\w|trait\s+\w|struct\s+\w|enum\s+\w|function\s+\w|fn\s+\w|func\s+\w|def\s+\w|sub\s+\w|defmodule\s+\w|module\s+\w|defp\s+\w|defmacro\s+\w|\w+\s*\([^)]*\)\s*[:{])/;

  const found: Array<{ line: string; indent: number; lineNum: number }> = [];
  for (let i = Math.min(offset - 1, lines.length - 1); i >= 0; i--) {
    const l = lines[i] ?? "";
    const m = l.match(SIG_RE);
    if (!m) continue;
    const indent = (m[1] ?? "").length;
    if (found.length === 0 || indent < found[found.length - 1]!.indent) {
      const sigLines: string[] = [l.trimEnd()];
      let j = i;
      while (j < lines.length - 1) {
        const t = (sigLines[sigLines.length - 1] ?? "").trim();
        if (t.endsWith("{") || t.endsWith(":") || /[=]>\s*\{?\s*$/.test(t)) break;
        if (!t.endsWith(",") && !t.endsWith("(")) break;
        j++;
        sigLines.push((lines[j] ?? "").trimEnd());
        if (sigLines.length >= 4) break;
      }
      found.push({ line: sigLines.join(" ").replace(/\s+/g, " ").trim().slice(0, 200), indent, lineNum: i + 1 });
      if (indent === 0) break;
    }
  }

  return found.reverse().map((f) => f.line);
}

// If a single read_file response exceeds the budget, cut it in the middle
// and tell the caller exactly how to resume.
const READ_FILE_MAX_CHARS = 24_000;
export function truncateIfExcessive(text: string, requestedOffset: number, lastReadLine: number): string {
  if (text.length <= READ_FILE_MAX_CHARS) return text;
  const cutoff = Math.floor(READ_FILE_MAX_CHARS * 0.9);
  const truncated = text.slice(0, cutoff);
  const lastNl = truncated.lastIndexOf("\n");
  const safe = lastNl > cutoff * 0.7 ? truncated.slice(0, lastNl) : truncated;
  const linesShown = (safe.match(/\n/g) || []).length;
  const approxLastLine = requestedOffset + linesShown;
  return `${safe}\n\n[... output truncated to fit token budget. Read more with offset=${approxLastLine}. Original range went up to line ${lastReadLine}.]`;
}

// Rank a list of files by relevance to a search pattern (filename match,
// camelCase ↔ kebab-case equivalence, src/ vs tests/ etc).
export function rankFiles(rawPattern: string, files: string[]): Array<{ file: string; score: number }> {
  const isGlob = /[*?]/.test(rawPattern);
  const globRe = isGlob ? globToRegex(rawPattern) : null;

  const lowerPattern = rawPattern.toLowerCase();
  const tokens = identTokens(rawPattern);
  const tokenJoined = tokens.join("");

  const scored: Array<{ file: string; score: number }> = [];

  for (const file of files) {
    const lowerFile = file.toLowerCase();
    const basename = baseFileName(file).toLowerCase();
    const baseStem = basename.replace(/\.[^.]+$/, "");
    const baseStemNorm = baseStem.replace(/[-_.]/g, "");

    let score = 0;

    if (globRe) {
      if (!globRe.test(file)) continue;
      score = 1000;
    } else if (basename === lowerPattern || baseStem === lowerPattern) {
      score = 1000;
    } else if (tokenJoined && baseStemNorm === tokenJoined) {
      score = 900;
    } else if (basename.includes(lowerPattern)) {
      score = 700 - basename.indexOf(lowerPattern);
    } else if (tokenJoined && baseStemNorm.includes(tokenJoined)) {
      score = 600;
    } else if (lowerFile.includes(lowerPattern)) {
      score = 300 - lowerFile.indexOf(lowerPattern) / 10;
    } else {
      continue;
    }

    if (/[\/\\](src|lib|app|core|cmd|pkg|internal|api)[\/\\]/i.test(file)) score += 30;
    if (/[\/\\](tests?|spec|fixtures?|docs?|examples?|node_modules|vendor)[\/\\]/i.test(file)) score -= 40;

    score += Math.max(0, 20 - Math.floor(file.length / 10));

    scored.push({ file, score });
  }

  scored.sort((a, b) => b.score - a.score || a.file.length - b.file.length);
  return scored;
}

// Re-rank search() results by relevance to the user's query.
export function rerankSearchResults<T extends SearchResult>(query: string, results: T[]): T[] {
  if (results.length <= 1) return results;

  const lowerQuery = query.toLowerCase();
  const queryTokens = identTokens(query).join("");

  const scored = results.map((r) => {
    let boost = 0;

    const symLower = r.symbol.name.toLowerCase();
    const symTokens = identTokens(r.symbol.name).join("");

    if (symLower === lowerQuery) boost += 500;
    else if (queryTokens && symTokens === queryTokens) boost += 400;
    else if (symLower.includes(lowerQuery)) boost += 200;
    else if (queryTokens && symTokens.includes(queryTokens)) boost += 150;

    const base = baseFileName(r.symbol.file).toLowerCase();
    const baseStem = base.replace(/\.[^.]+$/, "");
    if (baseStem === lowerQuery || baseStem.replace(/[-_.]/g, "") === queryTokens) {
      boost += 150;
    } else if (base.includes(lowerQuery)) {
      boost += 60;
    }

    if (/[\/\\](src|lib|app|core|cmd|pkg|internal|api)[\/\\]/i.test(r.symbol.file)) boost += 30;
    if (/[\/\\](tests?|spec|fixtures?|docs?|examples?|node_modules|vendor)[\/\\]/i.test(r.symbol.file)) boost -= 40;

    return { result: r, score: r.score + boost };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.result);
}
