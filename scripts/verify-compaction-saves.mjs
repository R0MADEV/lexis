#!/usr/bin/env node
// Empirical check: does the agent checkpoint findings BEFORE a compaction
// erases the conversation? Cross-references two independent logs:
//
//   1. Lexis telemetry   ~/.lexis/telemetry/*.jsonl   → note() calls (ts, project)
//   2. Claude Code JSONL  ~/.claude/projects/*/*.jsonl → compact_boundary (ts, cwd)
//
// For each compaction, it asks: in the work segment leading up to it (since the
// previous compaction in that session, capped at a lookback window), did the
// agent call note() in the same project? The % of compactions WITH a preceding
// save is the behavioral signal for "strengthened save instructions are working".
//
// This is the only honest way to verify a prompt-level change: measure behavior
// over real sessions, don't assert it. Run it after a week of normal use.
//
// Usage:  node scripts/verify-compaction-saves.mjs [--window-min 60]

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const args = process.argv.slice(2);
const windowMin = (() => {
  const i = args.indexOf("--window-min");
  return i >= 0 && args[i + 1] ? parseInt(args[i + 1], 10) : 60;
})();
const WINDOW_MS = windowMin * 60_000;

const TELEMETRY_DIR = path.join(os.homedir(), ".lexis", "telemetry");
const PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");

function readJsonl(file) {
  const out = [];
  let text;
  try { text = fs.readFileSync(file, "utf-8"); } catch { return out; }
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch { /* skip malformed */ }
  }
  return out;
}

function listJsonl(dir) {
  const files = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return files; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) files.push(...listJsonl(p));
    else if (e.name.endsWith(".jsonl")) files.push(p);
  }
  return files;
}

// 1. note() calls from Lexis telemetry → { ts(ms), project }
const noteCalls = [];
for (const f of listJsonl(TELEMETRY_DIR)) {
  for (const r of readJsonl(f)) {
    if (r.tool !== "note") continue;
    const ts = Date.parse(r.ts);
    if (!Number.isNaN(ts)) noteCalls.push({ ts, project: r.project ?? "" });
  }
}

// 2. compaction events from Claude Code JSONL → { ts(ms), cwd, session, branch, pre, post }
const compactions = [];
for (const f of listJsonl(PROJECTS_DIR)) {
  for (const r of readJsonl(f)) {
    if (r.subtype !== "compact_boundary") continue;
    const ts = Date.parse(r.timestamp);
    if (Number.isNaN(ts)) continue;
    compactions.push({
      ts,
      cwd: r.cwd ?? "",
      session: r.sessionId ?? "",
      branch: r.gitBranch ?? "",
      pre: r.compactMetadata?.preTokens ?? 0,
      post: r.compactMetadata?.postTokens ?? 0,
      trigger: r.compactMetadata?.trigger ?? "?",
    });
  }
}

compactions.sort((a, b) => a.ts - b.ts);

// A note belongs to a compaction if its project string appears in the compaction's
// cwd path (robust to Lexis indexing a root while Claude Code runs in a subdir).
function projectMatches(noteProject, cwd) {
  if (!noteProject) return false;
  return cwd.split(path.sep).includes(noteProject) || cwd.includes(noteProject);
}

// Segment for a compaction = (previous compaction in same session, or T-window) .. T
function segmentStart(comp, idx) {
  let prevTs = comp.ts - WINDOW_MS;
  for (let j = idx - 1; j >= 0; j--) {
    if (compactions[j].session === comp.session) { prevTs = Math.max(prevTs, compactions[j].ts); break; }
  }
  return prevTs;
}

let withSave = 0;
const rows = [];
compactions.forEach((comp, idx) => {
  const start = segmentStart(comp, idx);
  const saved = noteCalls.some(
    (n) => n.ts > start && n.ts <= comp.ts && projectMatches(n.project, comp.cwd),
  );
  if (saved) withSave++;
  rows.push({ comp, saved, start });
});

// ── Report ──────────────────────────────────────────────────────────────────
const line = (s = "") => process.stdout.write(s + "\n");

line("=".repeat(72));
line("COMPACTION-SAVE VERIFICATION");
line("=".repeat(72));
line(`note() calls in telemetry:     ${noteCalls.length}`);
line(`compaction events found:       ${compactions.length}`);
line(`lookback window per segment:   ${windowMin} min (capped at prev compaction)`);
line("");

if (compactions.length === 0) {
  line("No compactions recorded yet. Use Claude Code in long sessions, then re-run.");
  process.exit(0);
}
if (noteCalls.length === 0) {
  line("No note() calls in telemetry yet. Either the MCP build lacks telemetry");
  line("(restart Claude Code) or no notes were saved. Can't measure saving rate.");
  process.exit(0);
}

const pct = Math.round((withSave / compactions.length) * 100);
line(`Compactions WITH a preceding save:  ${withSave}/${compactions.length} (${pct}%)`);
line(`Compactions WITHOUT:                ${compactions.length - withSave}`);
line("");

const totalLost = compactions.reduce((a, c) => a + Math.max(0, c.pre - c.post), 0);
const avgPre = Math.round(compactions.reduce((a, c) => a + c.pre, 0) / compactions.length);
const avgPost = Math.round(compactions.reduce((a, c) => a + c.post, 0) / compactions.length);
line(`Context summarized away: avg ${avgPre.toLocaleString()} → ${avgPost.toLocaleString()} tok/compaction`);
line(`Total context compacted across all events: ${totalLost.toLocaleString()} tok`);
line("");

// ── Cost of running the compactions themselves ────────────────────────────────
// A compaction is one LLM call: it reads the pre-context (input) and writes the
// summary (output, ~5x input price). Whether the input is cache-read (×0.1) or
// fresh (×1) isn't observable here, so we report both bounds in billing-equivalent
// tokens (output counted at ×5).
const OUTPUT_MULT = 5, CACHE_MULT = 0.1, FRESH_MULT = 1;
const costCached = compactions.reduce((a, c) => a + c.pre * CACHE_MULT + c.post * OUTPUT_MULT, 0);
const costFresh = compactions.reduce((a, c) => a + c.pre * FRESH_MULT + c.post * OUTPUT_MULT, 0);
const spanDays = Math.max(1, (compactions.at(-1).ts - compactions[0].ts) / 86_400_000);
const round = (n) => Math.round(n).toLocaleString();

line("COST OF THE COMPACTIONS THEMSELVES (billing-equivalent tokens):");
line(`  per compaction:  ~${round(costCached / compactions.length)} (cached input)  to  ~${round(costFresh / compactions.length)} (fresh input)`);
line(`  all ${compactions.length} events:  ~${round(costCached)}  to  ~${round(costFresh)}`);
line(`  observed span:   ${spanDays.toFixed(0)} days  →  ~${round(costCached / spanDays * 30)} to ~${round(costFresh / spanDays * 30)} / month (this machine)`);
line(`  × 20 devs (rough): ~${round(costCached / spanDays * 30 * 20)} to ~${round(costFresh / spanDays * 30 * 20)} / month`);
line("  (output billed ×5; cached input ×0.1, fresh ×1 — true value sits between)");
line("");

line("Per compaction (newest last):");
for (const { comp, saved } of rows.slice(-15)) {
  const when = new Date(comp.ts).toISOString().replace("T", " ").slice(0, 16);
  const proj = path.basename(comp.cwd) || "?";
  const flag = saved ? "✓ saved before" : "✗ no save";
  line(`  ${when}  ${proj.padEnd(20)} ${comp.branch.padEnd(14)} ${String(comp.pre).padStart(7)}→${String(comp.post).padEnd(6)} ${flag}`);
}
line("");
line(`VERDICT: in ${pct}% of compactions, the agent had checkpointed beforehand.`);
line(pct >= 70 ? "  → strengthened save guidance appears to be working."
   : pct >= 30 ? "  → partial. Saving happens but not reliably before compaction."
   :             "  → low. The agent rarely saves before losing context — guidance needs work.");
