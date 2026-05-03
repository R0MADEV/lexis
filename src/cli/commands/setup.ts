import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { spawnSync } from "child_process";
import { indexProject } from "../../core/indexer";
import { loadIndex, saveIndex } from "../../adapters/storage/index-file";
import { projectStorageDir } from "../../adapters/storage/paths";

type ClientId =
  | "claude-code" | "cursor" | "continue" | "cline" | "roo"
  | "goose" | "zed" | "opencode" | "gemini-cli" | "windsurf";

interface ClientSpec {
  id: ClientId;
  label: string;
  install: (mcpName: string, cmd: string, args: string[]) => string;  // human instructions
  autoInstall?: (mcpName: string, cmd: string, args: string[]) => { ok: boolean; msg: string };
}

const CLIENTS: ClientSpec[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    install: (name, cmd, args) => `claude mcp add ${name} -- ${cmd} ${args.join(" ")}`,
    autoInstall: (name, cmd, args) => {
      const r = spawnSync("claude", ["mcp", "add", name, "--", cmd, ...args], { stdio: "inherit" });
      return r.status === 0
        ? { ok: true,  msg: "Registered with Claude Code." }
        : { ok: false, msg: "claude CLI not found or failed." };
    },
  },
  {
    id: "cursor",
    label: "Cursor",
    install: (name, cmd, args) => {
      const cfgPath = `~/.cursor/mcp.json (or .cursor/mcp.json in your project)`;
      const json = JSON.stringify({ mcpServers: { [name]: { command: cmd, args } } }, null, 2);
      return `Add to ${cfgPath}:\n${json}`;
    },
  },
  {
    id: "continue",
    label: "Continue.dev",
    install: (name, cmd, args) => {
      const yaml = `mcpServers:\n  - name: ${name}\n    command: ${cmd}\n    args:\n${args.map((a) => `      - "${a}"`).join("\n")}`;
      return `Add to ~/.continue/config.yaml under mcpServers:\n${yaml}`;
    },
  },
  {
    id: "cline",
    label: "Cline (Claude Dev / Roo Code)",
    install: (name, cmd, args) => {
      const cfgPath = "~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json";
      const json = JSON.stringify({ mcpServers: { [name]: { command: cmd, args } } }, null, 2);
      return `Add to ${cfgPath} (or VS Code settings JSON):\n${json}`;
    },
  },
  {
    id: "roo",
    label: "Roo Code",
    install: (name, cmd, args) => {
      const json = JSON.stringify({ mcpServers: { [name]: { command: cmd, args } } }, null, 2);
      return `Add to Roo's MCP settings JSON:\n${json}`;
    },
  },
  {
    id: "goose",
    label: "Goose (Block)",
    install: (name, cmd, args) =>
      `goose configure → Add Extension → command: ${cmd} ${args.join(" ")}`,
  },
  {
    id: "zed",
    label: "Zed",
    install: (name, cmd, args) => {
      const json = JSON.stringify({ context_servers: { [name]: { command: { path: cmd, args } } } }, null, 2);
      return `Add to ~/.config/zed/settings.json:\n${json}`;
    },
  },
  {
    id: "opencode",
    label: "OpenCode",
    install: (name, cmd, args) => {
      const json = JSON.stringify({ mcp: { [name]: { type: "local", command: [cmd, ...args] } } }, null, 2);
      return `Add to ~/.config/opencode/opencode.json:\n${json}`;
    },
  },
  {
    id: "gemini-cli",
    label: "Gemini CLI",
    install: (name, cmd, args) => {
      const json = JSON.stringify({ mcpServers: { [name]: { command: cmd, args } } }, null, 2);
      return `Add to ~/.gemini/settings.json:\n${json}`;
    },
  },
  {
    id: "windsurf",
    label: "Windsurf (Codeium)",
    install: (name, cmd, args) => {
      const json = JSON.stringify({ mcpServers: { [name]: { command: cmd, args } } }, null, 2);
      return `Add to ~/.codeium/windsurf/mcp_config.json:\n${json}`;
    },
  },
];

function findClient(id: string): ClientSpec | undefined {
  const normalized = id.toLowerCase();
  return CLIENTS.find((c) => c.id === normalized);
}

export async function setupCommand(
  projectPath: string,
  opts: { name?: string; client?: string; auto?: boolean; all?: boolean }
): Promise<void> {
  const abs = path.resolve(projectPath);
  if (!fs.existsSync(abs)) {
    console.error(`Path does not exist: ${abs}`);
    process.exit(1);
  }

  // 1. Index (incremental)
  console.log(`\n📦 Indexing ${abs} ...`);
  const previous = loadIndex(abs);
  const index = indexProject(abs, previous);
  saveIndex(index, abs);
  console.log(`   ${index.symbols.length} symbols across ${index.files.length} files`);
  console.log(`   stored in ${projectStorageDir(abs)}`);

  // 2. Resolve the binary command. If installed globally, "lexis" is on $PATH.
  // If running from a clone (this dist), use the absolute path so configs are portable.
  const isGlobalBin = process.argv[1]?.includes(`${path.sep}node_modules${path.sep}`);
  const cmd = isGlobalBin ? "lexis" : process.argv[1] ?? "lexis";
  const args = ["mcp", "--path", abs];

  const projectName = opts.name ?? path.basename(abs);
  const mcpName = `lexis-${projectName.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`;

  // 3. Decide which clients to print/install
  const targets: ClientSpec[] =
    opts.all       ? CLIENTS :
    opts.client    ? (findClient(opts.client) ? [findClient(opts.client)!] : []) :
                     [CLIENTS[0]!];   // default: Claude Code instructions

  if (opts.client && targets.length === 0) {
    console.log(`\n❌ Unknown client "${opts.client}". Available:`);
    console.log(CLIENTS.map((c) => `   ${c.id.padEnd(12)} — ${c.label}`).join("\n"));
    process.exit(1);
  }

  // 4. Auto-install only when --auto AND a single client AND that client supports it
  if (opts.auto && targets.length === 1 && targets[0]!.autoInstall) {
    const t = targets[0]!;
    console.log(`\n🔌 Auto-registering with ${t.label}...`);
    const r = t.autoInstall!(mcpName, cmd, args);
    console.log(r.ok ? `✅ ${r.msg}` : `⚠️  ${r.msg}`);
    if (!r.ok) {
      console.log(`\nManual:\n   ${t.install(mcpName, cmd, args)}\n`);
    }
    return;
  }

  // 5. Print instructions
  console.log(`\n✅ Index ready. To enable in your AI client:\n`);
  for (const t of targets) {
    console.log(`── ${t.label} ────────────────────────────────────`);
    console.log(t.install(mcpName, cmd, args));
    console.log("");
  }

  if (!opts.client && !opts.all) {
    console.log(`Other supported clients: ${CLIENTS.slice(1).map((c) => c.id).join(", ")}`);
    console.log(`Use --client <id> for specific instructions, or --all to print all.`);
  }

  console.log(`\n── Test it ──────────────────────────────────────`);
  console.log(`Once registered, paste this into your AI client:\n`);
  console.log(`  Use lexis tools to explore the ${projectName} project.`);
  console.log(`  Start with list_entrypoints to understand the structure,`);
  console.log(`  then search_code for anything specific.\n`);
}

export function listClientsCommand(): void {
  console.log("Supported MCP clients:\n");
  for (const c of CLIENTS) console.log(`  ${c.id.padEnd(14)} — ${c.label}`);
  console.log(`\nUse: lexis setup <path> --client <id>`);
}
