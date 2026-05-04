// Track activity during a single MCP session and persist a summary at close.
// Goal: when you reopen a feature/bug branch weeks later, you can recall
// exactly what you searched, read, and inspected without depending on the
// AI remembering to call `note` manually.

import { addNote, detectBranch, isMainBranch } from "../adapters/storage/notes-file";

interface SessionTracker {
  startedAt: number;
  toolCalls: number;
  searchQueries: Set<string>;
  symbolsInspected: Set<string>;
  filesRead: Set<string>;        // file path → first read offset (deduplicated)
  manualNotes: number;
}

const session: SessionTracker = {
  startedAt: Date.now(),
  toolCalls: 0,
  searchQueries: new Set(),
  symbolsInspected: new Set(),
  filesRead: new Set(),
  manualNotes: 0,
};

// Kept as a no-op for source compatibility with server.ts callers — periodic
// persistence was removed in favor of save-once-on-close. Trade-off: SIGKILL
// or sudden power loss can lose the session log; every other shutdown is
// caught by signal handlers and saves cleanly.
export function persistIfDue(_projectPath: string): void {
  // intentionally empty
}

export function trackToolCall(name: string, args: Record<string, unknown>): void {
  session.toolCalls++;
  switch (name) {
    case "search_code":
    case "pattern_search": {
      const q = args["query"] ?? args["pattern"];
      if (typeof q === "string" && q.trim()) session.searchQueries.add(q);
      break;
    }
    case "get_symbol":
    case "find_references":
    case "call_chain":
    case "impact_analysis":
    case "interface_implementations": {
      const n = args["name"] ?? args["symbol"];
      if (typeof n === "string" && n.trim()) session.symbolsInspected.add(n);
      break;
    }
    case "read_file": {
      const p = args["path"];
      if (typeof p === "string" && p.trim()) session.filesRead.add(p);
      break;
    }
    case "note":
      session.manualNotes++;
      break;
  }
}

// Build a markdown summary; null if the session is too trivial to log.
function buildSummary(branch: string): string | null {
  if (session.toolCalls < 3) return null;

  const durationMin = Math.max(1, Math.round((Date.now() - session.startedAt) / 60000));
  const lines: string[] = [];

  lines.push(`Auto-session log on branch \`${branch}\``);
  lines.push("");
  lines.push(`Duration: ${durationMin} min · ${session.toolCalls} tool calls`);

  if (session.searchQueries.size > 0) {
    const top = [...session.searchQueries].slice(0, 12);
    lines.push("");
    lines.push(`**Searched:** ${top.map((q) => `\`${q}\``).join(", ")}`);
  }
  if (session.symbolsInspected.size > 0) {
    const top = [...session.symbolsInspected].slice(0, 12);
    lines.push("");
    lines.push(`**Symbols inspected:** ${top.join(", ")}`);
  }
  if (session.filesRead.size > 0) {
    const top = [...session.filesRead].slice(0, 15);
    lines.push("");
    lines.push("**Files read:**");
    for (const f of top) lines.push(`- ${f}`);
  }
  if (session.manualNotes > 0) {
    lines.push("");
    lines.push(`**Manual notes saved during session:** ${session.manualNotes}`);
  }

  return lines.join("\n");
}

// Save the session as an auto-tagged note. Only runs on feature/bug branches —
// main/master sessions are skipped to avoid polluting historical context.
//
// Idempotent: this function is wired to multiple shutdown paths (close, SIGINT,
// SIGTERM, SIGHUP, uncaughtException). The flag below ensures we don't double-write
// if more than one fires.
let alreadySaved = false;

export function saveSessionLog(projectPath: string): void {
  if (alreadySaved) return;
  alreadySaved = true;

  try {
    const branch = detectBranch(projectPath);
    if (!branch || isMainBranch(branch)) return;

    const summary = buildSummary(branch);
    if (!summary) return;

    addNote(
      projectPath,
      summary,
      ["auto-session"],
      [...session.filesRead].slice(0, 20),
    );
  } catch {
    // Never let a logging error crash the shutdown.
  }
}
