// Project-aware tool filtering and linter detection. Hides tools that don't
// apply to the current project (e.g. `lint` on a docs-only repo) and applies
// ultra-compact descriptions when LEXIS_COMPRESSION=ultra.

import * as fs from "fs";
import * as path from "path";

// Token-saving mode controlled by LEXIS_COMPRESSION env var.
//   default | compact: regular output (current behavior)
//   ultra:             aggressive — no decoratives, telegraphic, 1-line tool descs
export function isUltraMode(): boolean {
  return process.env["LEXIS_COMPRESSION"] === "ultra";
}

// One-line ultra descriptions for the most common tools.
const ULTRA_DESCRIPTIONS: Record<string, string> = {
  search_code:    "Search code (compact|content|files, ctx bug|feature).",
  get_symbol:     "Get fn/class def by name.",
  read_file:      "Read file (path, offset, limit).",
  find_references: "Find usages of symbol.",
  find_file:      "Find files by pattern (glob).",
  list_symbols:   "List symbols in file.",
  list_entrypoints: "Routes/CLI/handlers/crons.",
  call_chain:     "Trace callers up/down.",
  get_context:    "fn+callers+tests for file:line.",
  pattern_search: "Multi-pattern grep AND/OR.",
  find_writes:    "Find code writing to a file.",
  git_context:    "Branches+commits by keyword.",
  recent_changes: "Files changed in N days.",
  hot_files:      "Files with most commits.",
  tests_for:      "Find tests for source file.",
  config_lookup:  "Find config keys.",
  explain:        "Summarize file or symbol.",
  event_handlers: "Dispatchers+handlers of event.",
  impact_analysis: "What breaks if symbol changes.",
  interface_implementations: "Impls of interface.",
  dead_code:      "Exports with no refs.",
  note:           "Save finding for future sessions.",
  notes:          "Recall notes (content/tag/file).",
  forget:         "Delete note by id.",
  reindex:        "Re-scan if results stale.",
  investigate:    "Def+refs+tests in one call.",
  list_todos:     "List TODO/FIXME/XXX/HACK.",
  resolve_import: "Where does an import come from.",
  lint:           "Run typechecker, parsed errors.",
  outline:        "File signatures only.",
};

// Linter registry: marker file → command. Order matters (more-specific first).
export interface LinterSpec { marker: string; label: string; cmd: string; args: string[]; }

export const LINTERS: LinterSpec[] = [
  { marker: "tsconfig.json", label: "TypeScript", cmd: "npx", args: ["--no-install", "tsc", "--noEmit", "--pretty", "false"] },
  { marker: "go.mod",        label: "Go",         cmd: "go",  args: ["vet", "./..."] },
  { marker: "Cargo.toml",    label: "Rust",       cmd: "cargo", args: ["check", "--message-format=short"] },
  { marker: "pyproject.toml",label: "Python",     cmd: "ruff", args: ["check", "."] },
  { marker: "composer.json", label: "PHP",        cmd: "vendor/bin/phpstan", args: ["analyse", "--no-progress", "--error-format=raw"] },
  { marker: "Gemfile",       label: "Ruby",       cmd: "bundle", args: ["exec", "rubocop", "--format", "simple"] },
];

export function detectLinter(projectPath: string): LinterSpec | null {
  for (const l of LINTERS) {
    if (fs.existsSync(path.join(projectPath, l.marker))) return l;
  }
  return null;
}

// Hides tools that don't apply to the current project. Detection is cheap
// (fs.existsSync on a few markers) and runs once per `tools/list` request.
export function filterToolsForProject<T extends { name: string; description?: string }>(
  tools: T[],
  projectPath: string,
): T[] {
  const hasLinter = detectLinter(projectPath) !== null;
  const hasGit = fs.existsSync(path.join(projectPath, ".git"));
  const hasTests = ["tests", "test", "spec", "__tests__", "cypress", "e2e"].some((d) =>
    fs.existsSync(path.join(projectPath, d))
  );
  const hasConfigs = ["config", ".env", "settings.py", "config.yaml", "config.yml"].some((p) =>
    fs.existsSync(path.join(projectPath, p))
  );

  const ultra = isUltraMode();

  return tools
    .filter((t) => {
      if (t.name === "lint" && !hasLinter) return false;
      if ((t.name === "git_context" || t.name === "recent_changes" || t.name === "hot_files") && !hasGit) return false;
      if (t.name === "tests_for" && !hasTests) return false;
      if (t.name === "config_lookup" && !hasConfigs) return false;
      return true;
    })
    .map((t) => {
      if (!ultra) return t;
      const ultraDesc = ULTRA_DESCRIPTIONS[t.name];
      return ultraDesc ? { ...t, description: ultraDesc } : t;
    });
}
