#!/usr/bin/env node
import dotenv from "dotenv";
const quiet = process.argv.includes("mcp");
dotenv.config({ path: ".env.local", quiet } as Parameters<typeof dotenv.config>[0]);
dotenv.config({ quiet } as Parameters<typeof dotenv.config>[0]);
import { Command } from "commander";
import { indexCommand } from "./commands/index";
import { askCommand } from "./commands/ask";
import { setupCommand, listClientsCommand } from "./commands/setup";
import { initCommand } from "./commands/init";
import { startMcpServer } from "../mcp/server";

const program = new Command();

program
  .name("lexis")
  .description("Lexical + structural code retrieval for LLMs. MCP server for Claude Code.")
  .version("0.8.0");

program
  .command("setup [path]")
  .description("Set up Lexis MCP. Use --global for user-level setup (works in any project), or pass a path for project-specific setup with upfront indexing.")
  .option("-n, --name <name>", "Override the MCP server name (default: 'lexis' for global, folder name for project)")
  .option("-c, --client <id>", "Target client: claude-code, cursor, continue, cline, roo, goose, zed, opencode, gemini-cli, windsurf")
  .option("--all", "Print install instructions for ALL supported clients")
  .option("--auto", "Auto-register (only supported for claude-code via the `claude` CLI)")
  .option("--global", "Register at user scope — works in any project automatically (recommended)")
  .action(async (projectPath: string | undefined, opts: { name?: string; client?: string; auto?: boolean; all?: boolean; global?: boolean }) => {
    await setupCommand(projectPath, opts);
  });

program
  .command("clients")
  .description("List supported MCP clients")
  .action(() => listClientsCommand());

program
  .command("init [path]")
  .description("Optional: create CLAUDE.local.md with Lexis usage hints (gitignored)")
  .action((projectPath?: string) => initCommand(projectPath ?? process.cwd()));

program
  .command("index <path>")
  .description("Index a project for search (incremental by default — only re-scans modified files)")
  .option("--full", "Force full re-index instead of incremental")
  .action(async (projectPath: string, opts: { full?: boolean }) => {
    await indexCommand(projectPath, opts);
  });

program
  .command("ask <question>")
  .description("Ask a question about your project")
  .option("-p, --path <path>", "Project path", process.cwd())
  .option("-l, --lang <lang>", "Response language code: en, es, fr, de, pt, it, ja, zh...", process.env["LEXIS_LANG"] ?? "en")
  .option("-d, --depth <number>", "Graph traversal depth", "2")
  .option("-k, --topk <number>", "Max results per search", "5")
  .action(async (question: string, options: { path: string; lang: string; depth: string; topk: string }) => {
    await askCommand(question, options.path, options.lang, {
      depth: parseInt(options.depth),
      topK: parseInt(options.topk),
    });
  });

program
  .command("mcp")
  .description("Start Lexis as an MCP server (stdio transport) for use with Claude Code")
  .option("-p, --path <path>", "Project path to serve", process.cwd())
  .action((options: { path: string }) => {
    startMcpServer(options.path);
  });

program.parse(process.argv);
