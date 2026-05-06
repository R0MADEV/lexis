// Ripgrep resolver. @vscode/ripgrep bundles the rg binary — always available
// after npm install. Falls back to system rg via which/where if needed.

import * as fs from "fs";
import { spawnSync } from "child_process";

const log = (...args: unknown[]) => process.stderr.write(args.join(" ") + "\n");

let _rgPath: string | null | undefined = undefined;

export function resolveRg(): string | null {
  if (_rgPath !== undefined) return _rgPath;
  try {
    const { rgPath } = require("@vscode/ripgrep") as { rgPath: string };
    if (rgPath && fs.existsSync(rgPath)) { _rgPath = rgPath; return rgPath; }
  } catch { /* not bundled */ }
  const lookup = process.platform === "win32" ? "where" : "which";
  const r = spawnSync(lookup, ["rg"], { encoding: "utf-8" });
  const found = r.stdout?.split(/\r?\n/)[0]?.trim();
  if (found && fs.existsSync(found)) { _rgPath = found; return found; }
  _rgPath = null;
  log("[warn] ripgrep not found — search tools will return empty results");
  return null;
}

export function runRg(args: string[]): { stdout: string; stderr: string } {
  const rg = resolveRg();
  if (!rg) return { stdout: "", stderr: "ripgrep not available" };
  const r = spawnSync(rg, args, { encoding: "utf-8" });
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

// Standard ignore globs used across most ripgrep calls in the codebase.
export const STANDARD_IGNORE_GLOBS: string[] = [
  "--glob", "!node_modules/**",
  "--glob", "!vendor/**",
  "--glob", "!.git/**",
  "--glob", "!dist/**",
  "--glob", "!build/**",
];
