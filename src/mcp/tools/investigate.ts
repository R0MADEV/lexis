// investigate — all-in-one symbol look-up that combines definition,
// references (deduped), and tests in a single call. Saves 2-3 round-trips
// vs chaining get_symbol + find_references + tests_for.

import * as path from "path";
import { getSymbol, findReferences } from "../../core/searcher";
import { Index } from "../../core/indexer";
import { isUltraMode } from "../tool-filtering";
import { runRg } from "../runtime/ripgrep";
import { formatPathList } from "../runtime/path-utils";

export function execInvestigate(
  args: Record<string, unknown>,
  index: Index,
  projectPath: string
): string {
  const name = args["name"] as string;
  const fileFilter = args["path_filter"] as string | undefined;
  if (!name) return "Error: 'name' is required.";

  const sections: string[] = [];

  // 1. DEFINITION
  const defResult = getSymbol(name, fileFilter, index);
  const ultra = isUltraMode();
  const sectionHeader = (label: string) => ultra ? `[${label}]` : `═══ ${label} ═══`;

  if (defResult) {
    const projectRoot = path.resolve(projectPath);
    const relPath = path.relative(projectRoot, defResult.symbol.file);
    const lineCount = defResult.body.split("\n").length;
    sections.push(
      `${sectionHeader("DEFINITION")}\n${relPath}:${defResult.symbol.lineStart}-${defResult.symbol.lineStart + lineCount - 1} [${defResult.symbol.type}]\n\n\`\`\`\n${defResult.body}\n\`\`\``
    );
  } else {
    return `Symbol "${name}" not found.`;
  }

  // 2. REFERENCES — limit to first 8, dedup by file (the user only needs to know "who calls me")
  const refs = findReferences(name, projectPath, index);
  if (refs.length > 0) {
    const projectRoot = path.resolve(projectPath);
    const seen = new Set<string>();
    const refLines: string[] = [];
    for (const r of refs) {
      const key = `${r.file}:${r.line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // Skip the definition file itself in references
      if (r.file === defResult.symbol.file && Math.abs(r.line - defResult.symbol.lineStart) < 5) continue;
      const rel = path.relative(projectRoot, r.file);
      refLines.push(`${rel}:${r.line}  [${r.kind}]`);
      if (refLines.length >= 8) break;
    }
    if (refLines.length > 0) {
      sections.push(`${sectionHeader(`REFERENCES (${refs.length} total, showing top ${refLines.length})`)}\n${formatPathList(refLines)}`);
    }
  }

  // 3. TESTS — find test files that mention the symbol
  const escName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const testRgArgs = [
    "--files-with-matches", "--no-heading",
    "-e", `\\b${escName}\\b`,
    "--glob", "**/{test,tests,spec,__tests__}/**",
    "--glob", "**/*.{test,spec}.*",
    "--glob", "!node_modules/**", "--glob", "!vendor/**",
    projectPath,
  ];
  const testStdout = runRg(testRgArgs).stdout.trim();
  if (testStdout) {
    const projectRoot = path.resolve(projectPath);
    const allTests = [...new Set(testStdout.split("\n"))].map((f) => path.relative(projectRoot, f));
    const testFiles = allTests.slice(0, 5);
    // The references section above reports what it held back; this one used to
    // drop the rest without a word.
    const header = allTests.length > testFiles.length
      ? sectionHeader(`TESTS (${allTests.length} total, showing top ${testFiles.length})`)
      : sectionHeader("TESTS");
    sections.push(`${header}\n${testFiles.join("\n")}`);
  }

  return sections.join("\n\n");
}
