#!/usr/bin/env node
// Runs once after `npm install -g lexis-mcp`.
// Best-effort auto-register with Claude Code at user scope. Silent fallback to
// printed instructions for any other client.

const { spawnSync } = require("child_process");

// Skip in CI, dev installs, or when explicitly disabled.
if (process.env.CI || process.env.LEXIS_NO_AUTOSETUP) process.exit(0);

// Only run on global installs — local installs don't need MCP registration.
if (process.env.npm_config_global !== "true") process.exit(0);

function tryClaudeCode() {
  // Check if claude CLI is installed
  const which = process.platform === "win32" ? "where" : "which";
  const found = spawnSync(which, ["claude"], { encoding: "utf-8" });
  if (found.status !== 0) return false;

  const r = spawnSync(
    "claude",
    ["mcp", "add", "--scope", "user", "lexis", "--", "lexis", "mcp"],
    { encoding: "utf-8" }
  );

  // status 0 = added; non-zero often means "already exists" — also fine
  const stderr = (r.stderr || "") + (r.stdout || "");
  if (r.status === 0) {
    console.log("✅ Lexis registered with Claude Code (user scope).");
    return true;
  }
  if (stderr.includes("already exists")) {
    console.log("✅ Lexis already registered with Claude Code.");
    return true;
  }
  return false;
}

console.log("");
console.log("🔍 Lexis MCP installed.");
console.log("");

const claudeOk = tryClaudeCode();

if (!claudeOk) {
  console.log("To activate Lexis in your AI client, run:");
  console.log("  lexis setup --global --auto         # Claude Code");
  console.log("  lexis setup --global --client cursor   # Cursor");
  console.log("  lexis setup --global --all          # all supported clients");
}
console.log("");
console.log("Then open any project — Lexis works automatically.");
console.log("Disable autosetup: LEXIS_NO_AUTOSETUP=1 npm install -g lexis-mcp");
console.log("");
