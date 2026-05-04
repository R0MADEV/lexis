import * as fs from "fs";
import * as path from "path";
import { ALL_PATTERNS } from "./parsers";

export interface Symbol {
  name: string;
  file: string;
  lineStart: number;
  lineEnd: number;
  type: "function" | "class" | "method" | "variable" | "unknown";
}

export interface Index {
  projectPath: string;
  symbols: Symbol[];
  files: string[];
  createdAt: string;
}

const SUPPORTED_EXTENSIONS = new Set([
  // JS / TS
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  // Python
  ".py",
  // Rust
  ".rs",
  // Go
  ".go",
  // Java / Kotlin
  ".java", ".kt", ".kts",
  // C / C++ / C#
  ".c", ".cpp", ".cc", ".cxx", ".h", ".hpp", ".cs",
  // Ruby
  ".rb",
  // PHP
  ".php",
  // Swift
  ".swift",
  // Dart / Flutter
  ".dart",
  // Vue / Svelte
  ".vue", ".svelte",
  // Scala
  ".scala",
  // Elixir
  ".ex", ".exs",
  // Shell / scripting (DevOps glue, common in backend infra)
  ".sh", ".bash", ".zsh",
  // Perl
  ".pl", ".pm",
  // Telecom DSLs — common in voip/telephony backends (ivozprovider, asterisk, kamailio)
  ".cfg",   // Kamailio main config (route[], failure_route[], etc.)
  ".conf",  // Asterisk dialplan ([context], exten => ...)
]);

// Files without extension are still indexed if first line is a shebang
const SHEBANG_RE = /^#!.*\b(perl|bash|sh|zsh|python\d?|ruby|node|env\s+\w+)\b/;

const IGNORE_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", ".nuxt",
  "coverage", ".cache", "tmp", "vendor", "target",
  "__pycache__", ".tox", "venv", ".venv", ".bundle",
  ".svelte-kit", ".parcel-cache", "out", ".turbo",
  "migrations", "seeds", "fixtures",           // DB migrations are generated, not business logic
  "generated", "gen", "proto",                  // protobuf / code generation output
  "storybook-static", ".storybook",
  "cache", "logs",                              // generic cache/log dirs
]);

// path patterns to ignore (matches against full path, not just dir name)
const IGNORE_PATH_PATTERNS = [
  /\/var\/cache\//,             // Symfony cache
  /\/var\/log\//,                // Symfony logs
  /\/var\/sessions\//,           // Symfony sessions
  /\/storage\/(framework|logs|debugbar)\//,  // Laravel storage
  /\/_compiled_\//,              // generic compiled output
];

const IGNORE_FILE_PATTERNS = [
  /\.min\.[jt]s$/,           // minified JS/TS
  /\.min\.css$/,              // minified CSS
  /\.map$/,                   // source maps
  /\.d\.ts$/,                 // TypeScript declarations
  /\.lock$/,                  // lock files (yarn, Gemfile, etc.)
  /package-lock\.json$/,
  /[-_](pb|generated)\./,    // protobuf generated: foo_pb.go, foo.generated.ts
  /\.pb\.go$/, /\.pb\.py$/,
  /schema\.prisma$/,          // Prisma schema (static, not code)
  /\.snap$/,                  // Jest/Vitest snapshots
  /^__CG__/,                  // Doctrine ORM proxies
  /\.cache\.php$/,             // Symfony bootstrap cache
];

// Read only the first ~80 bytes to check for a shebang — cheap and avoids loading binaries.
function hasShebang(filePath: string): boolean {
  try {
    const fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(80);
    const n = fs.readSync(fd, buf, 0, 80, 0);
    fs.closeSync(fd);
    if (n < 2) return false;
    const first = buf.toString("utf-8", 0, n).split("\n")[0] ?? "";
    return SHEBANG_RE.test(first);
  } catch {
    return false;
  }
}

export function indexProject(projectPath: string, previousIndex?: Index | null): Index {
  const files = getFiles(projectPath);

  // Full index path: no previous data → scan everything.
  if (!previousIndex) {
    const symbols = extractSymbols(files);
    return { projectPath, symbols, files, createdAt: new Date().toISOString() };
  }

  // Incremental path: re-extract symbols only for files modified since last index.
  const indexEpochMs = new Date(previousIndex.createdAt).getTime();
  const previousFileSet = new Set(previousIndex.files);
  const currentFileSet  = new Set(files);

  const changedFiles: string[] = [];
  for (const file of files) {
    if (!previousFileSet.has(file)) {
      // new file — must scan
      changedFiles.push(file);
      continue;
    }
    let mtimeMs: number;
    try { mtimeMs = fs.statSync(file).mtimeMs; } catch { continue; }
    if (mtimeMs > indexEpochMs) changedFiles.push(file);
  }

  // Symbols from unchanged files: keep as-is. From changed files: re-extract. From deleted files: drop.
  const unchangedSymbols = previousIndex.symbols.filter(
    (s) => currentFileSet.has(s.file) && !changedFiles.includes(s.file)
  );
  const refreshedSymbols = extractSymbols(changedFiles);

  const stats = {
    total: files.length,
    unchanged: files.length - changedFiles.length,
    rescanned: changedFiles.length,
    removed: previousIndex.files.length - [...previousFileSet].filter((f) => currentFileSet.has(f)).length,
  };
  // Lightweight stderr report (only visible to the CLI, not the JSON-RPC stdout)
  if (process.stderr.isTTY) {
    process.stderr.write(
      `[incremental] ${stats.total} files: ${stats.unchanged} cached, ${stats.rescanned} rescanned, ${stats.removed} removed\n`
    );
  }

  return {
    projectPath,
    symbols: [...unchangedSymbols, ...refreshedSymbols],
    files,
    createdAt: new Date().toISOString(),
  };
}

function getFiles(projectPath: string): string[] {
  const results: string[] = [];

  function walk(dir: string) {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (IGNORE_DIRS.has(entry.name)) continue;
        if (IGNORE_PATH_PATTERNS.some((p) => p.test(fullPath))) continue;
        walk(fullPath);
      } else if (entry.isFile()) {
        if (
          IGNORE_FILE_PATTERNS.some((p) => p.test(entry.name)) ||
          IGNORE_PATH_PATTERNS.some((p) => p.test(fullPath))
        ) continue;

        const ext = path.extname(entry.name).toLowerCase();
        if (SUPPORTED_EXTENSIONS.has(ext)) {
          results.push(fullPath);
        } else if (ext === "" && hasShebang(fullPath)) {
          // extensionless executables (e.g. /usr/local/bin scripts, perl autoconf) — index if shebang present
          results.push(fullPath);
        }
      }
    }
  }

  walk(projectPath);
  return results;
}

function extractSymbols(files: string[]): Symbol[] {
  const symbols: Symbol[] = [];

  for (const file of files) {
    let content: string;
    try { content = fs.readFileSync(file, "utf-8"); } catch { continue; }
    const lines = content.split("\n");

    lines.forEach((line, i) => {
      const symbol = detectSymbol(line, i + 1, file);
      if (symbol) symbols.push(symbol);
    });
  }

  return symbols;
}

function detectSymbol(line: string, lineNumber: number, file: string): Symbol | null {
  for (const { regex, type, nameGroup } of ALL_PATTERNS) {
    const match = line.match(regex);
    if (!match) continue;
    const name = match[nameGroup];
    if (!name || name.length <= 1) continue;
    // skip common false positives
    if (["if", "for", "while", "switch", "catch", "return", "new"].includes(name)) continue;
    return { name, file, lineStart: lineNumber, lineEnd: lineNumber + 20, type };
  }
  return null;
}
