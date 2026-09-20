#!/usr/bin/env node
// What the agent actually does, from the telemetry lexis already writes.
//
// A prompt-level change cannot be asserted in a test: whether an agent picks
// investigate over a five-call chain is a property of a model's choices, not of
// this code. The only honest verification is to measure the same window before
// and after, over real sessions.
//
// Windows are explicit rather than stored, so a comparison never drifts:
//
//   node scripts/agent-behavior.mjs --until 2026-09-20   # before the change
//   node scripts/agent-behavior.mjs --since 2026-09-21   # after, a week later
//
// The numbers that matter, and why:
//   reads per search   how often a search hands back a file instead of an answer
//   chain vs one-call  whether the workflow change took
//   tokens per session what any of it is worth

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const since = flag("--since");
const until = flag("--until");
const SESSION_GAP_MS = 30 * 60 * 1000;

const dir = path.join(os.homedir(), ".lexis", "telemetry");
if (!fs.existsSync(dir)) {
  console.error(`No telemetry at ${dir}. It is on by default; LEXIS_TELEMETRY=0 disables it.`);
  process.exit(1);
}

const calls = [];
for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"))) {
  for (const line of fs.readFileSync(path.join(dir, file), "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { calls.push(JSON.parse(line)); } catch { /* skip malformed */ }
  }
}

// Jest writes to tmpdirs under its own project names; those are not real use.
const isFixture = (p) => /test-|tmp|^lexis-mcp-tools/.test(p ?? "");
const inWindow = (ts) => (!since || ts >= since) && (!until || ts <= until + "T23:59:59Z");
const real = calls
  .filter((c) => !isFixture(c.project) && inWindow(c.ts))
  .sort((a, b) => a.ts.localeCompare(b.ts));

if (real.length === 0) {
  console.error("No calls in that window.");
  process.exit(1);
}

// A session is a run of calls on one project with no gap longer than SESSION_GAP_MS.
const sessions = [];
let current = null;
for (const call of real) {
  const at = new Date(call.ts).getTime();
  const isNewSession = !current || current.project !== call.project || at - current.last > SESSION_GAP_MS;
  if (isNewSession) {
    current = { project: call.project, last: at, calls: [] };
    sessions.push(current);
  }
  current.last = at;
  current.calls.push(call);
}

const tokensOf = (session) => session.calls.reduce((sum, c) => sum + (c.tokens_out ?? 0), 0);
const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p / 100))];
const count = (tool) => real.filter((c) => c.tool === tool).length;
const ratio = (a, b) => (b === 0 ? "n/a" : (a / b).toFixed(2));

const perSession = sessions.map(tokensOf).sort((a, b) => a - b);
const callsPerSession = sessions.map((s) => s.calls.length).sort((a, b) => a - b);

const chainCalls = count("get_symbol") + count("find_references") + count("tests_for");
const oneCall = count("investigate");

const window = [since ? `from ${since}` : null, until ? `to ${until}` : null]
  .filter(Boolean).join(" ") || "all time";

const row = (label, value) => console.log(`  ${label.padEnd(34)} ${String(value).padStart(10)}`);

console.log(`\nAgent behaviour — ${window}`);
console.log(`  ${real.length.toLocaleString()} calls across ${sessions.length.toLocaleString()} sessions\n`);

console.log("Cost");
row("tokens per session (median)", percentile(perSession, 50).toLocaleString());
row("tokens per session (p90)", percentile(perSession, 90).toLocaleString());
row("calls per session (median)", percentile(callsPerSession, 50));

console.log("\nDoes search finish the job?");
row("read_file per search_code", ratio(count("read_file"), count("search_code")));
row("read_file calls", count("read_file").toLocaleString());

console.log("\nOne call or a chain?");
row("investigate", oneCall.toLocaleString());
row("get_symbol + find_references + tests_for", chainCalls.toLocaleString());
row("one-call share", chainCalls + oneCall === 0 ? "n/a" : `${(100 * oneCall / (oneCall + chainCalls)).toFixed(1)}%`);

console.log("\nHeaviest tools by tokens returned");
const byTool = new Map();
for (const c of real) byTool.set(c.tool, (byTool.get(c.tool) ?? 0) + (c.tokens_out ?? 0));
const total = [...byTool.values()].reduce((a, b) => a + b, 0);
for (const [tool, tokens] of [...byTool.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)) {
  row(tool, `${(100 * tokens / total).toFixed(1)}%`);
}
console.log();
