// search_code — the primary code-search tool. Multiple output modes
// (compact, snippet, content, files, count, trace, signatures, arch).

import * as path from "path";
import { search, suggestSimilar, SearchResult } from "../../core/searcher";
import { QueryIntent, extractTechnicalTerms } from "../../core/query-analyzer";
import { Index } from "../../core/indexer";
import { pathFilterMatches } from "../../core/path-match";
import { log } from "../runtime/jsonrpc";
import { rerankSearchResults } from "../runtime/search-utils";
import { formatPathList } from "../runtime/path-utils";
import { isUltraMode } from "../tool-filtering";
import { buildTrace, formatSuggestions, detectLayer } from "../runtime/format";
import { intSetting } from "../../core/settings";

function scopeIndex(index: Index, pathFilter: string): Index {
  const matches = (file: string): boolean => pathFilterMatches(file, pathFilter);
  return { ...index, symbols: index.symbols.filter((s) => matches(s.file)), files: index.files.filter(matches) };
}

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
  const pathFilter = args["path_filter"] as string | undefined;

  log(`[search_code] query="${query}" output=${output} topK=${topK} depth=${depth} context=${context ?? "auto"} path_filter=${pathFilter ?? "none"}`);

  // Scoping narrows the index itself rather than only the result list, so
  // excluded files stop competing for the top_k slots and ranking improves.
  const scoped = pathFilter ? scopeIndex(index, pathFilter) : index;
  if (pathFilter && scoped.symbols.length === 0) {
    return `No indexed files match path_filter "${pathFilter}".`;
  }

  // search() also runs a ripgrep pass over the project, which can surface files
  // the scoped index excluded — so the scope is enforced on the results too.
  const found = search(query, scoped, projectPath, topK, depth, intentOverride);
  const rawResults = pathFilter ? found.filter((r) => pathFilterMatches(r.symbol.file, pathFilter)) : found;

  // search() deliberately casts a wider net than top_k so ranking has something
  // to choose between; the caller still gets what it asked for. The env var is
  // a ceiling on that, not a replacement for it — reading it alone made top_k
  // decorative, which is why a top_k of 2, 3 or 10 all returned the same seven.
  const displayLimit = Math.min(topK, intSetting(process.env["LEXIS_TOOL_RESULT_LIMIT"], 20, "LEXIS_TOOL_RESULT_LIMIT"));
  if (rawResults.length === 0) {
    if (pathFilter) return `No results for "${query}" under path_filter "${pathFilter}".`;
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
    const limit = displayLimit;
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
    const limit = displayLimit;
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

        // The end line is what makes the result actionable: without it the reader
        // knows where a symbol starts but not how far it runs, so it follows up
        // with an exploratory read_file. Three tokens here save that round trip.
        // Search results carry the extent extractFunction measured, not the
        // lineStart + 20 the index stores.
        const span = r.symbol.lineEnd > r.symbol.lineStart
          ? `${r.symbol.lineStart}-${r.symbol.lineEnd}`
          : `${r.symbol.lineStart}`;

        // Ultra mode: 1 line per result (sig only, no preview body, no blank between)
        if (isUltraMode()) {
          return `${relPath}:${span} ${r.symbol.name} ${displaySig}`;
        }

        const preview = body1 && body1 !== displaySig
          ? `  ${displaySig}\n  ${body1}`
          : `  ${displaySig}`;
        return `${relPath}:${span}  [${r.symbol.type}] ${r.symbol.name}\n${preview}`;
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
  const limit = displayLimit;
  const limited = results.slice(0, limit);
  const overflow = results.length - limited.length;
  const projectRoot = path.resolve(projectPath);

  // Token budget: emit full bodies until the budget is spent, then demote the
  // rest to compact previews. Stops a broad query from dumping 5k+ tokens of
  // code at once. ~4 chars/token. The per-call `content_budget` arg overrides
  // the LEXIS_CONTENT_BUDGET env default — the caller raises it when it knows
  // it needs depth, lowers it when just orienting.
  const budget = typeof args["content_budget"] === "number"
    ? (args["content_budget"] as number)
    : intSetting(process.env["LEXIS_CONTENT_BUDGET"], 2500, "LEXIS_CONTENT_BUDGET");
  const fullBlocks: string[] = [];
  const compactLines: string[] = [];
  let used = 0;

  // First meaningful body line of a result, so a demoted entry still shows
  // enough for the caller to judge whether to fetch it full (vs a blind pointer).
  const previewOf = (code: string): string => {
    const line = code.split("\n").map((l) => l.trim()).find((l) => l.length > 2 && !l.startsWith("//"));
    return line ? `\n  ${line.slice(0, 100)}` : "";
  };

  for (const r of limited) {
    const block = `FILE: ${r.symbol.file} (lines ${r.symbol.lineStart}-${r.symbol.lineEnd})\nSYMBOL: ${r.symbol.name}\nCODE:\n\`\`\`\n${r.code}\n\`\`\``;
    const blockTokens = Math.ceil(block.length / 4);
    // Always emit at least the first result full, even if it alone exceeds the
    // budget — content mode must never come back empty.
    if (fullBlocks.length === 0 || used + blockTokens <= budget) {
      fullBlocks.push(block);
      used += blockTokens;
    } else {
      const rel = path.relative(projectRoot, r.symbol.file);
      compactLines.push(`${rel}:${r.symbol.lineStart}  [${r.symbol.type}] ${r.symbol.name}${previewOf(r.code)}`);
    }
  }

  let body = fullBlocks.join("\n\n---\n\n");
  if (compactLines.length > 0) {
    body += `\n\n[${compactLines.length} more shown compact — content budget reached, narrow the query for full code]\n${compactLines.join("\n")}`;
  }
  if (overflow > 0) {
    body += `\n\n[${overflow} additional results omitted — refine query or use output='files'/'count']`;
  }
  return body;
}
