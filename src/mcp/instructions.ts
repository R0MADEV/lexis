// MCP `instructions` field — sent to the client at `initialize`. Claude reads
// this once per session as system context. Compact by design: every byte here
// is paid in tokens on every connect.
//
// On feature/bug branches, prior notes are appended so Claude inherits context
// without asking for it.

import { detectBranch, isMainBranch, loadNotesForCurrentBranch } from "../adapters/storage/notes-file";

export const LEXIS_INSTRUCTIONS = `Lexis — code search. Use these tools INSTEAD of reading files.

WORKFLOW: notes → list_entrypoints → search_code → get_symbol → read_file(offset,limit).

DEFAULTS: output='compact', depth=1, top_k=3. Use context='bug'|'feature' to auto-tune.
Use call_chain for flows, impact_analysis before refactor, reindex if results stale.

CRITICAL — note() to persist findings (the MCP can't see the chat):
- ALWAYS save when: root cause found, design decision made, hypothesis ruled out, task completed.
- GOOD: "Bug X from Y. The W clue is misleading — actually unrelated." with tags+files.
- BAD: "started investigating", "found ClassX" (already in index), process commentary.

OUTPUT MODES (tokens/result): snippet ~15, compact ~50, content ~500, files/count tiny.`;

export function buildSessionInstructions(projectPath: string): string {
  const branch = detectBranch(projectPath);

  if (!branch || isMainBranch(branch)) {
    return LEXIS_INSTRUCTIONS;
  }

  const notes = loadNotesForCurrentBranch(projectPath);
  if (notes.length === 0) return LEXIS_INSTRUCTIONS;

  // Curated findings (manual notes) carry far more context than auto-session
  // tracking. Show up to 5 manuals first; fall back to auto-session only if
  // there are no manuals yet on this branch.
  const isAuto = (tags: string[]) => tags.includes("auto-session");
  const manuals = notes.filter((n) => !isAuto(n.tags)).slice(-5).reverse();
  const autoLogs = notes.filter((n) => isAuto(n.tags)).slice(-2).reverse();

  const fmt = (n: { createdAt: string; id: string; content: string }) => {
    const date = n.createdAt.slice(0, 10);
    const summary = n.content.split("\n")[0]?.slice(0, 200) ?? "";
    return `- ${date} (${n.id}): ${summary}`;
  };

  const sections: string[] = [];
  if (manuals.length > 0) {
    sections.push(`### Curated findings (most recent first)\n${manuals.map(fmt).join("\n")}`);
  }
  if (autoLogs.length > 0) {
    sections.push(`### Recent activity logs\n${autoLogs.map(fmt).join("\n")}`);
  }

  return `${LEXIS_INSTRUCTIONS}

## Current branch: ${branch}

You are CONTINUING previous work on this branch. The notes below are your
own findings from prior sessions — treat them as established facts unless
you find evidence to update them. Read full content with \`notes\` tool.

${sections.join("\n\n")}

Before ending this session: if you discovered the cause, made a decision,
or ruled out a hypothesis, save it with \`note()\` — see the RULES section
on when note() is REQUIRED. Do NOT rely on Claude Code's chat history;
the MCP server cannot read it.`;
}
