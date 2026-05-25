// Git-backed tools: git_context (branches+commits by keyword),
// recent_changes (branch vs base diff with symbol mapping),
// hot_files (commit frequency since a date).

import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";
import { Index } from "../../core/indexer";
import { log } from "../runtime/jsonrpc";

export function execGitContext(
  args: Record<string, unknown>,
  projectPath: string
): string {
  const keyword = args["keyword"] as string;
  if (!keyword || keyword.length < 2) return "Error: 'keyword' must be at least 2 chars.";

  log(`[git_context] keyword="${keyword}"`);

  const gitDir = path.join(projectPath, ".git");
  if (!fs.existsSync(gitDir)) return "Not a git repository.";

  const run = (args: string[]): string => {
    const r = spawnSync("git", ["-C", projectPath, ...args], { encoding: "utf-8" });
    return (r.stdout ?? "").trim();
  };

  const branchesRaw = run(["branch", "-a", "--list", `*${keyword}*`]);
  const branches = branchesRaw
    .split("\n")
    .map((b) => b.replace(/^[* ]+/, "").trim())
    .filter((b) => b.length > 0)
    .slice(0, 15);

  const commitsRaw = run([
    "log", "--all",
    "--grep", keyword, "-i",
    "--pretty=format:%h|%ad|%an|%s",
    "--date=short",
    "-n", "10",
  ]);
  const commits = commitsRaw.split("\n").filter((l) => l.includes("|"));

  const sections: string[] = [];

  if (branches.length > 0) {
    sections.push(`BRANCHES matching "${keyword}":\n${branches.map((b) => `  ${b}`).join("\n")}`);
  } else {
    sections.push(`BRANCHES matching "${keyword}": none`);
  }

  if (commits.length > 0) {
    const commitLines = commits.map((c) => {
      const [hash, date, author, ...rest] = c.split("|");
      return `  ${hash}  ${date}  ${author?.padEnd(20)}  ${rest.join("|")}`;
    });
    sections.push(`COMMITS matching "${keyword}":\n${commitLines.join("\n")}`);
  } else {
    sections.push(`COMMITS matching "${keyword}": none`);
  }

  return sections.join("\n\n");
}

export function execHotFiles(
  args: Record<string, unknown>,
  projectPath: string
): string {
  const limit = typeof args["limit"] === "number" ? Math.min(args["limit"], 50) : 15;
  const since = (args["since"] as string) ?? "6 months ago";

  log(`[hot_files] limit=${limit} since=${since}`);

  if (!fs.existsSync(path.join(projectPath, ".git"))) return "Not a git repository.";

  // git log --since=X --name-only --pretty=format: → list of changed files
  const r = spawnSync(
    "git", ["-C", projectPath, "log", `--since=${since}`, "--name-only", "--pretty=format:"],
    { encoding: "utf-8", maxBuffer: 50 * 1024 * 1024 }
  );
  if (r.status !== 0) return `git error: ${(r.stderr ?? "").slice(0, 200)}`;

  const counts = new Map<string, number>();
  for (const line of (r.stdout ?? "").split("\n")) {
    const f = line.trim();
    if (!f) continue;
    if (/\.(lock|min\.[jt]s|map|snap)$/.test(f)) continue;
    if (/^(node_modules|vendor|dist|build|\.git)\//.test(f)) continue;
    counts.set(f, (counts.get(f) ?? 0) + 1);
  }

  // Last commit date per file (for recency boost)
  const sorted = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);

  if (sorted.length === 0) return `No file activity in the last ${since}.`;

  const lines = sorted.map(([file, count]) => {
    // Get most recent author for this file
    const last = spawnSync(
      "git", ["-C", projectPath, "log", "-n", "1", "--pretty=format:%ad|%an", "--date=short", "--", file],
      { encoding: "utf-8" }
    );
    const [date, author] = (last.stdout ?? "").split("|");
    const meta = date ? `  ${date} by ${(author ?? "").slice(0, 18)}` : "";
    return `  ${count.toString().padStart(3)} commits  ${file}${meta}`;
  });

  return `Hot files since ${since} (${counts.size} changed total, top ${sorted.length}):\n\n${lines.join("\n")}`;
}

export function execRecentChanges(
  args: Record<string, unknown>,
  index: Index,
  projectPath: string
): string {
  const since = args["since"] as string | undefined;
  const userBase = args["base"] as string | undefined;
  const head = (args["head"] as string | undefined) ?? "HEAD";

  log(`[recent_changes] base=${userBase ?? "auto"} head=${head} since=${since ?? "n/a"}`);

  const gitDir = path.join(projectPath, ".git");
  if (!fs.existsSync(gitDir)) return "Not a git repository.";

  const run = (gitArgs: string[]): string => {
    const r = spawnSync("git", ["-C", projectPath, ...gitArgs], { encoding: "utf-8" });
    return (r.stdout ?? "").trim();
  };

  const currentBranch = run(["rev-parse", "--abbrev-ref", head]) || head;

  // Auto-detect base: try origin/HEAD, then main, master, develop
  let base = userBase ?? "";
  if (!base) {
    const originHead = run(["symbolic-ref", "refs/remotes/origin/HEAD"]).replace("refs/remotes/", "");
    if (originHead) base = originHead;
    else for (const cand of ["main", "master", "develop"]) {
      if (run(["rev-parse", "--verify", "--quiet", cand])) { base = cand; break; }
    }
  }
  if (!base) base = "HEAD~10";  // last-resort fallback

  // ── Commits in branch ──────────────────────────────────────────────────────
  const logArgs = ["log", `${base}..${head}`, "--pretty=format:%h|%ad|%an|%s", "--date=short"];
  if (since) logArgs.push(`--since=${since}`);
  logArgs.push("-n", "20");
  const commitsRaw = run(logArgs);
  const commits = commitsRaw.split("\n").filter((l) => l.includes("|"));

  // ── Files changed (committed, vs base) ─────────────────────────────────────
  const filesCommitted = run(["diff", "--numstat", `${base}...${head}`])
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => {
      const parts = l.split(/\s+/);
      const added = parseInt(parts[0] ?? "0", 10) || 0;
      const removed = parseInt(parts[1] ?? "0", 10) || 0;
      const file = parts.slice(2).join(" ");
      return { file, added, removed, status: "committed" as const };
    })
    .filter((c) => c.file);

  // ── Uncommitted (working dir + staged) — only meaningful when inspecting HEAD
  const inspectingHead = head === "HEAD";
  const filesUncommitted = inspectingHead
    ? run(["diff", "--numstat", "HEAD"])
        .split("\n")
        .filter((l) => l.trim().length > 0)
        .map((l) => {
          const parts = l.split(/\s+/);
          const added = parseInt(parts[0] ?? "0", 10) || 0;
          const removed = parseInt(parts[1] ?? "0", 10) || 0;
          const file = parts.slice(2).join(" ");
          return { file, added, removed, status: "uncommitted" as const };
        })
        .filter((c) => c.file)
    : [];

  // ── Map line ranges → symbols using the index ──────────────────────────────
  const projectRoot = path.resolve(projectPath);
  const indexByFile = new Map<string, typeof index.symbols>();
  for (const s of index.symbols) {
    const rel = path.relative(projectRoot, s.file);
    if (!indexByFile.has(rel)) indexByFile.set(rel, []);
    indexByFile.get(rel)!.push(s);
  }

  const symbolsForFile = (relFile: string, status: "committed" | "uncommitted"): string[] => {
    const fileSymbols = indexByFile.get(relFile);
    if (!fileSymbols || fileSymbols.length === 0) return [];

    const diffArgs = status === "committed"
      ? ["diff", "--unified=0", `${base}...${head}`, "--", relFile]
      : ["diff", "--unified=0", "HEAD", "--", relFile];
    const diff = run(diffArgs);
    const hunkRe = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm;
    const touchedLines: number[] = [];
    let m: RegExpExecArray | null;
    while ((m = hunkRe.exec(diff)) !== null) {
      const start = parseInt(m[1] ?? "0", 10);
      const span  = parseInt(m[2] ?? "1", 10) || 1;
      for (let i = 0; i < span; i++) touchedLines.push(start + i);
    }

    const touchedSymbols = new Set<string>();
    for (const line of touchedLines) {
      const sym = fileSymbols
        .filter((s) => s.lineStart <= line && s.lineEnd >= line)
        .sort((a, b) => b.lineStart - a.lineStart)[0];
      if (sym && sym.name.length > 1) touchedSymbols.add(sym.name);
    }
    return [...touchedSymbols].slice(0, 5);
  };

  // ── Format output ──────────────────────────────────────────────────────────
  const sections: string[] = [];
  sections.push(`Branch: ${currentBranch}  (vs ${base})`);

  if (commits.length > 0) {
    const lines = commits.slice(0, 10).map((c) => {
      const [hash, date, author, ...rest] = c.split("|");
      return `  ${hash}  ${date}  ${(author ?? "").padEnd(18)}  ${rest.join("|").slice(0, 80)}`;
    });
    const more = commits.length > 10 ? ` (+${commits.length - 10} more)` : "";
    sections.push(`COMMITS (${commits.length}${more}):\n${lines.join("\n")}`);
  } else {
    sections.push(`COMMITS: none`);
  }

  type ChangedFile = { file: string; added: number; removed: number; status: "committed" | "uncommitted" };
  const formatFiles = (files: ChangedFile[], label: string): string => {
    if (files.length === 0) return `${label}: none`;
    const top = files.slice(0, 15);
    const lines = top.map((c) => {
      const sigil = `+${c.added} -${c.removed}`.padEnd(10);
      const syms = symbolsForFile(c.file, c.status);
      const symPart = syms.length > 0 ? `  → ${syms.join(", ")}` : "";
      return `  ${c.file}  ${sigil}${symPart}`;
    });
    const more = files.length > top.length ? `\n  ... (+${files.length - top.length} more)` : "";
    return `${label} (${files.length}):\n${lines.join("\n")}${more}`;
  };

  sections.push(formatFiles(filesCommitted, "FILES (committed)"));
  if (filesUncommitted.length > 0) {
    sections.push(formatFiles(filesUncommitted, "UNCOMMITTED"));
  }

  return sections.join("\n\n");
}
