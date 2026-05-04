import * as fs from "fs";
import * as path from "path";

const CLAUDE_LOCAL_MD = `# Lexis instructions (local — not committed)

Use Lexis MCP tools as the primary way to navigate this codebase.

## Flow
1. \`notes\` — recall context from previous sessions
2. \`list_entrypoints\` — understand project structure
3. \`search_code(query)\` — find code by keyword (compact output by default)
4. \`get_symbol(name)\` — get a function/class implementation
5. \`read_file(path, offset, limit)\` — only when you need a specific range

## Rules
- Do NOT read entire files when you can search. Use offset/limit on read_file.
- Use \`call_chain\` to trace upstream/downstream callers.
- Use \`impact_analysis\` before refactoring.
- Save findings with \`note\` so future sessions inherit them.
- If results seem stale, call \`reindex\`.
`;

const GITIGNORE_BLOCK = `
# Lexis (per-developer local config)
CLAUDE.local.md
`;

export function initCommand(projectPath: string): void {
  const abs = path.resolve(projectPath);
  if (!fs.existsSync(abs)) {
    console.error(`Path does not exist: ${abs}`);
    process.exit(1);
  }

  const claudeLocal = path.join(abs, "CLAUDE.local.md");
  const gitignore = path.join(abs, ".gitignore");

  if (fs.existsSync(claudeLocal)) {
    console.log(`✓ CLAUDE.local.md already exists — leaving untouched.`);
  } else {
    fs.writeFileSync(claudeLocal, CLAUDE_LOCAL_MD);
    console.log(`✓ Created CLAUDE.local.md (Lexis usage hints for Claude Code).`);
  }

  if (fs.existsSync(gitignore)) {
    const current = fs.readFileSync(gitignore, "utf-8");
    if (!current.includes("CLAUDE.local.md")) {
      fs.appendFileSync(gitignore, GITIGNORE_BLOCK);
      console.log(`✓ Added CLAUDE.local.md to .gitignore.`);
    } else {
      console.log(`✓ CLAUDE.local.md already in .gitignore.`);
    }
  } else {
    fs.writeFileSync(gitignore, GITIGNORE_BLOCK.trimStart());
    console.log(`✓ Created .gitignore with CLAUDE.local.md entry.`);
  }

  console.log(`\nDone. Lexis instructions live in CLAUDE.local.md (gitignored).`);
}
