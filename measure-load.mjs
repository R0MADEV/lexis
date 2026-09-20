// Measures what Lexis costs a client just by being installed: the `tools/list`
// payload plus the `instructions` field, in default and ultra mode.
// Numbers in the README's "Load cost" table come from here.
//
// Usage: npm run build && node measure-load.mjs

import { createRequire } from "module";
const require = createRequire(import.meta.url);

const { TOOLS } = require("./dist/mcp/tools-registry.js");
const { LEXIS_INSTRUCTIONS } = require("./dist/mcp/instructions.js");
const { filterToolsForProject } = require("./dist/mcp/tool-filtering.js");

const approxTokens = (s) => Math.round(s.length / 3.5);
const bytes = (s) => Buffer.byteLength(s, "utf8");

// Measure what a client actually receives: project-filtered tools, both modes.
// Filtering runs in both so the only variable between rows is compression.
const listFor = (mode) => {
  process.env["LEXIS_COMPRESSION"] = mode;
  return filterToolsForProject(TOOLS, process.cwd());
};

const report = (label, tools) => {
  const payload = JSON.stringify(tools);
  console.log(`\n═══ ${label} ═══`);
  console.log(`Tools listed:         ${tools.length}`);
  console.log(`Tools JSON bytes:     ${bytes(payload).toLocaleString()}`);
  console.log(`Tools JSON ~tokens:   ${approxTokens(payload).toLocaleString()}`);
  console.log(`TOTAL + instructions: ${approxTokens(payload + LEXIS_INSTRUCTIONS).toLocaleString()} ~tokens`);
};

console.log(`Project: ${process.cwd()}`);
console.log(`Tools defined in registry: ${TOOLS.length}`);
console.log(`Instructions: ${bytes(LEXIS_INSTRUCTIONS).toLocaleString()} bytes / ${approxTokens(LEXIS_INSTRUCTIONS).toLocaleString()} ~tokens`);

report("DEFAULT MODE", listFor("default"));
report("ULTRA MODE (LEXIS_COMPRESSION=ultra)", listFor("ultra"));

process.env["LEXIS_COMPRESSION"] = "default";
console.log("\n═══ Top 5 heaviest tools (default) ═══");
[...TOOLS]
  .map((t) => ({ name: t.name, bytes: bytes(JSON.stringify(t)) }))
  .sort((a, b) => b.bytes - a.bytes)
  .slice(0, 5)
  .forEach((t) => console.log(`  ${t.name.padEnd(28)} ${t.bytes.toLocaleString().padStart(6)} bytes`));
