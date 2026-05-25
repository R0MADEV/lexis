// Pattern-search tools that use ripgrep directly:
//   • pattern_search — regex search across the project
//   • tests_for      — co-located + mentioning tests for a file/symbol

import * as fs from "fs";
import * as path from "path";
import { getSymbol, suggestSimilar } from "../../core/searcher";
import { Index } from "../../core/indexer";
import { log } from "../runtime/jsonrpc";
import { runRg } from "../runtime/ripgrep";
import { formatSuggestions } from "../runtime/format";

export function execPatternSearch(
  args: Record<string, unknown>,
  projectPath: string
): string {
  const pattern = args["pattern"] as string;
  const glob = args["glob"] as string | undefined;
  const max = typeof args["max"] === "number" ? Math.min(args["max"], 100) : 20;

  if (!pattern || pattern.length < 2) return "Error: 'pattern' must be at least 2 chars.";

  log(`[pattern_search] pattern="${pattern}" glob=${glob ?? "none"}`);

  const rgArgs = [
    "--line-number", "--no-heading", "--max-filesize", "200K",
    "-e", pattern,
    "--glob", "!node_modules/**", "--glob", "!vendor/**",
    "--glob", "!.git/**", "--glob", "!dist/**", "--glob", "!build/**",
    "--glob", "!**/*.lock", "--glob", "!**/*.min.*", "--glob", "!**/*.map",
  ];
  if (glob) rgArgs.push("--glob", glob);
  rgArgs.push(projectPath);

  let { stdout, stderr } = runRg(rgArgs);

  if (!stdout.trim()) {
    return stderr.includes("regex parse error")
      ? `Invalid regex: ${pattern}\n${stderr.split("\n").slice(0, 3).join("\n")}`
      : `No matches for pattern: ${pattern}`;
  }

  // Aggregate by file: count hits, keep first-line sample
  const projectRoot = path.resolve(projectPath);
  const byFile = new Map<string, { count: number; sample: string; sampleLine: number }>();
  let totalHits = 0;

  for (const line of stdout.split("\n")) {
    const m = line.match(/^(.+?):(\d+):(.*)$/);
    if (!m) continue;
    const [, file, lineStr, content] = m;
    if (!file) continue;
    totalHits++;
    if (!byFile.has(file)) {
      byFile.set(file, {
        count: 1,
        sample: (content ?? "").trim().slice(0, 110),
        sampleLine: parseInt(lineStr ?? "0", 10),
      });
    } else {
      byFile.get(file)!.count++;
    }
  }

  const sorted = [...byFile.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, max);
  const lines = sorted.map(([file, info]) => {
    const rel = path.relative(projectRoot, file);
    return `  ${rel}:${info.sampleLine}  (×${info.count})  ${info.sample}`;
  });

  const more = byFile.size > sorted.length ? ` (top ${sorted.length} of ${byFile.size} files)` : "";
  return `Pattern "${pattern}" — ${totalHits} hits across ${byFile.size} file(s)${more}:\n\n${lines.join("\n")}`;
}

export function execTestsFor(
  args: Record<string, unknown>,
  index: Index,
  projectPath: string
): string {
  const target = args["target"] as string;
  if (!target) return "Error: 'target' is required.";

  log(`[tests_for] target="${target}"`);

  const projectRoot = path.resolve(projectPath);
  const looksLikeFile = target.includes("/") || /\.[a-z0-9]{1,5}$/i.test(target);

  let symbolName: string;
  let sourceFile: string | null = null;

  if (looksLikeFile) {
    sourceFile = path.isAbsolute(target) ? path.resolve(target) : path.resolve(projectPath, target);
    if (!fs.existsSync(sourceFile)) return `File not found: ${target}`;
    symbolName = path.basename(sourceFile, path.extname(sourceFile));
  } else {
    const symInfo = getSymbol(target, undefined, index);
    if (!symInfo) {
      const sug = suggestSimilar(target, index, 5);
      return `Symbol "${target}" not found.${formatSuggestions(sug, projectRoot)}`;
    }
    symbolName = symInfo.symbol.name;
    sourceFile = symInfo.symbol.file;
  }

  // 1. Co-located test files (same dir, common naming conventions)
  const colocated: string[] = [];
  if (sourceFile) {
    const dir = path.dirname(sourceFile);
    const base = path.basename(sourceFile, path.extname(sourceFile));
    const ext = path.extname(sourceFile);
    const cap = base.charAt(0).toUpperCase() + base.slice(1);

    const candidates = [
      path.join(dir, `${base}.test${ext}`),
      path.join(dir, `${base}.spec${ext}`),
      path.join(dir, "__tests__", `${base}${ext}`),
      path.join(dir, "__tests__", `${base}.test${ext}`),
      path.join(dir, `${base}_test.go`),
      path.join(dir, `test_${base}.py`),
      path.join(path.dirname(dir), "tests", `test_${base}.py`),
      path.join(dir, `${cap}Test.php`),
      path.join(dir, `${cap}Test.java`),
      path.join(dir, `${cap}Test.kt`),
      path.join(dir, `${base}_spec.rb`),
      path.join(dir, `${base}_test.rb`),
    ];
    for (const c of candidates) {
      try { fs.accessSync(c); colocated.push(c); } catch { /* skip */ }
    }
  }

  // 2. Mentioning tests — ripgrep symbol name in test files
  const rgArgs = [
    "--line-number", "--no-heading", "--max-filesize", "200K",
    "-e", `\\b${symbolName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
    "--glob", "**/*{.test,.spec,_test,_spec,Test,Spec}.{ts,tsx,js,jsx,go,py,php,java,kt,rb}",
    "--glob", "**/__tests__/**",
    "--glob", "**/tests/**",
    "--glob", "**/spec/**",
    "--glob", "**/cypress/**",
    "--glob", "!node_modules/**", "--glob", "!vendor/**",
    projectPath,
  ];
  let stdout = runRg(rgArgs).stdout;

  const mentioning = new Map<string, number>();
  for (const line of stdout.split("\n")) {
    const m = line.match(/^(.+?):(\d+):/);
    if (!m) continue;
    const file = m[1] ?? "";
    if (colocated.includes(file)) continue;  // already counted
    if (file === sourceFile) continue;
    mentioning.set(file, (mentioning.get(file) ?? 0) + 1);
  }

  const sections: string[] = [`Tests covering "${target}":`];

  if (colocated.length > 0) {
    sections.push(`CO-LOCATED (${colocated.length}):\n${colocated.map((f) => `  ${path.relative(projectRoot, f)}`).join("\n")}`);
  }

  if (mentioning.size > 0) {
    const top = [...mentioning.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .map(([file, count]) => `  ${path.relative(projectRoot, file)}  (${count} ref${count === 1 ? "" : "s"})`);
    sections.push(`MENTIONING (${mentioning.size}):\n${top.join("\n")}`);
  }

  if (colocated.length === 0 && mentioning.size === 0) {
    return `No tests found for "${target}". ⚠️  Refactoring this is risky — write tests first.`;
  }

  return sections.join("\n\n");
}
