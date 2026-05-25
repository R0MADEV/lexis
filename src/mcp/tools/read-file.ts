// read_file — return a numbered slice of a file with enclosing
// class/function signatures. In-session dedup prevents re-sending
// the same exact range twice.

import * as fs from "fs";
import * as path from "path";
import { Index } from "../../core/indexer";
import { log } from "../runtime/jsonrpc";
import { findEnclosingSignatures, truncateIfExcessive } from "../runtime/search-utils";

// In-session "already shown" tracking. When Claude calls read_file twice for
// the same exact range, the second call returns a tiny marker instead of the
// full content again — saves ~2-5k tokens on iterative debugging sessions.
//
// State lives at module level (one MCP server = one session); cleared by
// resetSessionState() (used by tests; production sessions never call it).
const shownReadRanges = new Set<string>();

export function resetSessionState(): void {
  shownReadRanges.clear();
}

export function readRangeKey(path: string, offset: number, limit: number): string {
  return `${path}:${offset}:${limit}`;
}

export function execReadFile(
  args: Record<string, unknown>,
  projectPath: string,
  index: Index
): string {
  const filePath = args["path"] as string;
  const offset = Math.max(1, typeof args["offset"] === "number" ? args["offset"] : 1);
  const limit = Math.max(1, typeof args["limit"] === "number" ? args["limit"] : 80);

  const resolved = path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(projectPath, filePath);

  const projectResolved = path.resolve(projectPath);
  if (!resolved.startsWith(projectResolved + path.sep) && resolved !== projectResolved) {
    return "Access denied: path is outside the project directory.";
  }

  log(`[read_file] "${resolved}" lines ${offset}-${offset + limit - 1}`);

  // In-session dedup: if Claude already pulled this exact range, return a
  // tiny marker instead of the full content.
  const dedupKey = readRangeKey(resolved, offset, limit);
  if (shownReadRanges.has(dedupKey)) {
    const rel = path.relative(projectResolved, resolved);
    return `[already shown earlier this session] ${rel} lines ${offset}-${offset + limit - 1}. ` +
           `Re-read with a different offset if you need fresh content.`;
  }
  shownReadRanges.add(dedupKey);

  try {
    const content = fs.readFileSync(resolved, "utf-8");
    const allLines = content.split("\n");
    const totalLines = allLines.length;
    const startIdx = offset - 1;
    const endIdx = Math.min(startIdx + limit, totalLines);
    const slice = allLines.slice(startIdx, endIdx);

    const numbered = slice
      .map((line, i) => `${(startIdx + i + 1).toString().padStart(6, " ")}\t${line}`)
      .join("\n");

    // Find enclosing class + method by walking backwards from `offset` looking
    // for signature lines. Capture the FULL signature (multi-line if needed)
    // so Claude knows the params/return types without a separate get_symbol call.
    const enclosingSigs = findEnclosingSignatures(allLines, offset);

    const relPath = path.relative(projectResolved, resolved);
    let contextLine = "";
    if (enclosingSigs.length > 0) {
      const sigText = enclosingSigs.map((s) => `  ${s}`).join("\n");
      contextLine = `INSIDE:\n${sigText}\n\n`;
    }

    const header = `FILE: ${relPath} (showing lines ${offset}-${endIdx} of ${totalLines})\n${contextLine}`;
    const footer =
      endIdx < totalLines
        ? `\n\n[... ${totalLines - endIdx} more lines. Call read_file with offset=${endIdx + 1} to continue.]`
        : "";
    return truncateIfExcessive(header + numbered + footer, offset, endIdx);
  } catch {
    return `Could not read file: ${resolved}`;
  }
}

// Walk backwards from `offset` looking for class/function/method signature
// lines that visually enclose the cursor. Returns the OUTER signature first,
// inner-most last (e.g. ["class Foo {", "  async bar(): Promise<X> {"]).
//
// Approach: look at indentation levels. A signature at indent level N encloses
// everything at indent > N below it. Stop at the file top or when we find an
// outer-level (indent 0) class/function whose body the cursor falls in.
// (helper lives in runtime/search-utils.ts)
