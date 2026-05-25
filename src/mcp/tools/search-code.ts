// search_code — the primary code-search tool. Multiple output modes
// (compact, snippet, content, files, count, trace, signatures, arch).

import * as path from "path";
import { search, suggestSimilar, SearchResult } from "../../core/searcher";
import { QueryIntent, extractTechnicalTerms } from "../../core/query-analyzer";
import { Index } from "../../core/indexer";
import { log } from "../runtime/jsonrpc";
import { rerankSearchResults } from "../runtime/search-utils";
import { formatPathList } from "../runtime/path-utils";
import { isUltraMode } from "../tool-filtering";
import { buildTrace, formatSuggestions, detectLayer } from "../runtime/format";

export function execSearchCode(
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

  const rawResults = search(query, index, projectPath, topK, depth, intentOverride);
  if (rawResults.length === 0) {
    const suggestions = suggestSimilar(query, index, 5);
    return `No results found for "${query}".${formatSuggestions(suggestions, path.resolve(projectPath))}`;
  }
  const results = rerankSearchResults(query, rawResults);

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
    const projectRoot = path.resolve(projectPath);
    const rel = [...new Set(results.map((r) => path.relative(projectRoot, r.symbol.file)))];
    return formatPathList(rel);
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

        // Ultra mode: 1 line per result (sig only, no preview body, no blank between)
        if (isUltraMode()) {
          return `${relPath}:${r.symbol.lineStart} ${r.symbol.name} ${displaySig}`;
        }

        const preview = body1 && body1 !== displaySig
          ? `  ${displaySig}\n  ${body1}`
          : `  ${displaySig}`;
        return `${relPath}:${r.symbol.lineStart}  [${r.symbol.type}] ${r.symbol.name}\n${preview}`;
      })
      .join(isUltraMode() ? "\n" : "\n\n");

    return overflow > 0
      ? `${body}${isUltraMode() ? `\n[+${overflow}]` : `\n\n[${overflow} additional results omitted — use output='content' for full code]`}`
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
