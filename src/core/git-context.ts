import { spawnSync } from "child_process";

export interface GitContext {
  recentCommits: string;
  recentChanges: string;
  branch: string;
}

function git(args: string[], cwd: string): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0 || result.error) throw new Error("git command failed");
  return (result.stdout as string).trim();
}

export function getGitContext(projectPath: string): GitContext | null {
  try {
    const branch = git(["rev-parse", "--abbrev-ref", "HEAD"], projectPath);
    const recentCommits = git(["log", "--oneline", "-10"], projectPath);
    const recentChanges = git(["diff", "HEAD~1", "--stat"], projectPath);
    return { branch, recentCommits, recentChanges };
  } catch {
    return null;
  }
}

export function formatGitContext(ctx: GitContext, _lang: string): string {
  return `GIT CONTEXT:\nBranch: ${ctx.branch}\nRecent commits:\n${ctx.recentCommits}\nRecent changes:\n${ctx.recentChanges}`;
}
