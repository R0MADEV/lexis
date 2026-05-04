import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";
import { projectStorageDir, legacyNotesPath, migrateIfNeeded } from "./paths";

export interface Note {
  id: string;
  createdAt: string;
  content: string;
  tags: string[];
  files: string[];
  branch?: string;     // git branch this note belongs to
  category?: Category; // bugs / features / others
}

export type Category = "bugs" | "features" | "others";

const MAIN_BRANCHES = new Set(["main", "master", "develop", "dev", "trunk"]);

// Detect current git branch. Returns null when not a git repo or detached HEAD.
export function detectBranch(projectPath: string): string | null {
  const r = spawnSync("git", ["-C", projectPath, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf-8" });
  if (r.status !== 0) return null;
  const branch = (r.stdout ?? "").trim();
  if (!branch || branch === "HEAD") return null;
  return branch;
}

export function isMainBranch(branch: string): boolean {
  return MAIN_BRANCHES.has(branch.toLowerCase());
}

// Decide the category folder for a branch.
//              feature/feat → features; everything else → others.
export function categoryForBranch(branch: string): Category {
  const b = branch.toLowerCase();
  if (/^(fix|bugfix|hotfix|bug)[\/-]/.test(b)) return "bugs";
  if (/^(feature|feat)[\/-]/.test(b)) return "features";
  if (/^[a-z]+-\d+/i.test(branch)) return "bugs";  // JIRA-style ticket prefix
  return "others";
}

// Filesystem-safe filename derived from the branch.
function branchFileName(branch: string): string {
  return branch.replace(/[\/\\:*?"<>|]/g, "-").replace(/\.\.+/g, "-").slice(0, 200) + ".md";
}

// Resolve the notes file for the currently-active branch.
// Falls back to others/no-branch.md if no git context.
function activeNotesFile(projectPath: string): { file: string; branch: string; category: Category } {
  const branch = detectBranch(projectPath);
  const category: Category = branch ? categoryForBranch(branch) : "others";
  const baseName = branch ? branchFileName(branch) : "no-branch.md";
  const dir = path.join(projectStorageDir(projectPath), category);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return { file: path.join(dir, baseName), branch: branch ?? "(no branch)", category };
}

// Format / parse note in markdown
function formatNote(n: Note): string {
  // Human-readable date in the heading (truncated to minute) + a hidden full
  // timestamp line so we can recover ms-precision when parsing back.
  const date = n.createdAt.replace("T", " ").slice(0, 16);
  const lines: string[] = [`## ${date} · ${n.id}`];
  lines.push(`<!-- created: ${n.createdAt} -->`);
  if (n.branch) lines.push(`**Branch:** ${n.branch}`);
  if (n.tags.length > 0)  lines.push(`**Tags:** ${n.tags.join(", ")}`);
  if (n.files.length > 0) lines.push(`**Files:** ${n.files.join(", ")}`);
  lines.push("");
  lines.push(n.content.trim());
  return lines.join("\n");
}

function parseNote(block: string, defaultBranch?: string, defaultCategory?: Category): Note | null {
  const lines = block.split("\n");
  const headerMatch = lines[0]?.match(/^##\s+([\d:\- ]+)\s*·\s*(\w+)/);
  if (!headerMatch) return null;

  // Default to minute-precision parse from the heading; overridden if we find
  // the hidden full-timestamp marker below.
  let createdAt = (headerMatch[1] ?? "").trim().replace(" ", "T") + ":00Z";
  const id = headerMatch[2] ?? "";

  let tags: string[] = [];
  let files: string[] = [];
  let branch: string | undefined = defaultBranch;
  let bodyStart = 1;

  for (let i = 1; i < lines.length && i < 8; i++) {
    const l = lines[i] ?? "";
    const createdMatch = l.match(/^<!--\s*created:\s*(\S+)\s*-->\s*$/);
    if (createdMatch) { createdAt = createdMatch[1] ?? createdAt; bodyStart = i + 1; continue; }
    const branchMatch = l.match(/^\*\*Branch:\*\*\s*(.+)$/);
    if (branchMatch) { branch = (branchMatch[1] ?? "").trim() || undefined; bodyStart = i + 1; continue; }
    const tagMatch = l.match(/^\*\*Tags:\*\*\s*(.+)$/);
    if (tagMatch) {
      tags = (tagMatch[1] ?? "").split(",").map((t) => t.trim().toLowerCase()).filter(Boolean);
      bodyStart = i + 1;
      continue;
    }
    const fileMatch = l.match(/^\*\*Files:\*\*\s*(.+)$/);
    if (fileMatch) {
      files = (fileMatch[1] ?? "").split(",").map((f) => f.trim()).filter(Boolean);
      bodyStart = i + 1;
      continue;
    }
    if (l.trim() === "") { bodyStart = i + 1; continue; }
    break;
  }

  const content = lines.slice(bodyStart).join("\n").trim();
  if (!content) return null;

  return { id, createdAt, content, tags, files, branch, category: defaultCategory };
}

function parseFile(filePath: string, branch?: string, category?: Category): Note[] {
  if (!fs.existsSync(filePath)) return [];
  let raw: string;
  try { raw = fs.readFileSync(filePath, "utf-8"); } catch { return []; }

  const lines = raw.split("\n");
  const noteBlocks: string[] = [];
  let current: string[] = [];

  for (const line of lines) {
    if (/^##\s/.test(line)) {
      if (current.length > 0) noteBlocks.push(current.join("\n").trim());
      current = [line];
    } else if (current.length > 0) {
      if (/^-{3,}\s*$/.test(line.trim())) {
        if (current.length > 0) noteBlocks.push(current.join("\n").trim());
        current = [];
      } else {
        current.push(line);
      }
    }
  }
  if (current.length > 0) noteBlocks.push(current.join("\n").trim());

  const notes: Note[] = [];
  for (const block of noteBlocks) {
    const n = parseNote(block, branch, category);
    if (n) notes.push(n);
  }
  return notes.reverse();  // file is newest-first; in-memory list is oldest-first
}

// One-time migration: legacy flat notes.md → others/legacy-notes.md
function migrateLegacyFlatFile(projectPath: string): void {
  const root = projectStorageDir(projectPath);
  const flat = path.join(root, "notes.md");
  if (!fs.existsSync(flat)) return;
  const target = path.join(root, "others", "legacy-notes.md");
  if (!fs.existsSync(path.dirname(target))) fs.mkdirSync(path.dirname(target), { recursive: true });
  if (!fs.existsSync(target)) {
    try { fs.renameSync(flat, target); } catch { /* fall through */ }
  } else {
    try { fs.unlinkSync(flat); } catch { /* keep file */ }
  }
}

// Public API ----------------------------------------------------------------

// Load all notes across every category and branch file.
export function loadNotes(projectPath: string): Note[] {
  // Trigger one-time migrations
  migrateIfNeeded(legacyNotesPath(projectPath), path.join(projectStorageDir(projectPath), "others", "legacy-notes.md"));
  migrateLegacyFlatFile(projectPath);

  const root = projectStorageDir(projectPath);
  const all: Note[] = [];
  const categories: Category[] = ["bugs", "features", "others"];

  for (const cat of categories) {
    const dir = path.join(root, cat);
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir)) {
      if (!entry.endsWith(".md")) continue;
      const branch = entry.replace(/\.md$/, "").replace(/^legacy-notes$/, "");
      all.push(...parseFile(path.join(dir, entry), branch || undefined, cat));
    }
  }

  // Sort chronologically (oldest first), matching prior in-memory contract.
  all.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return all;
}

// Load notes only for the currently-checked-out branch.
export function loadNotesForCurrentBranch(projectPath: string): Note[] {
  const branch = detectBranch(projectPath);
  if (!branch || isMainBranch(branch)) return [];
  return loadNotes(projectPath).filter((n) => n.branch === branch);
}

export function saveNotes(projectPath: string, notes: Note[]): void {
  // Group by (category, branch-derived filename) and write each file.
  const byFile = new Map<string, Note[]>();
  for (const n of notes) {
    const cat: Category = n.category ?? "others";
    const branch = n.branch && n.branch !== "(no branch)" ? n.branch : "no-branch";
    const fileName = branchFileName(branch);
    const key = path.join(cat, fileName);
    if (!byFile.has(key)) byFile.set(key, []);
    byFile.get(key)!.push(n);
  }

  const root = projectStorageDir(projectPath);
  for (const [relPath, group] of byFile) {
    const full = path.join(root, relPath);
    if (!fs.existsSync(path.dirname(full))) fs.mkdirSync(path.dirname(full), { recursive: true });

    const ordered = group.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));  // newest first
    const branchLabel = group[0]?.branch ?? "(no branch)";
    const header = `# Lexis Notes — ${path.basename(projectPath)} · ${branchLabel}\n\n` +
                   `Persistent findings for this branch. Newest on top.\n`;
    const body = ordered.map(formatNote).join("\n\n---\n\n");
    fs.writeFileSync(full, `${header}\n${body}\n`);
  }
}

// Monotonically increasing timestamp generator. Two addNote() calls in the
// same millisecond would otherwise tie on createdAt and break ordering.
let lastTimestampMs = 0;
function monotonicTimestamp(): string {
  let ms = Date.now();
  if (ms <= lastTimestampMs) ms = lastTimestampMs + 1;
  lastTimestampMs = ms;
  return new Date(ms).toISOString();
}

// Add a note for the currently-checked-out branch.
export function addNote(
  projectPath: string,
  content: string,
  tags: string[] = [],
  files: string[] = []
): Note {
  const { branch, category } = activeNotesFile(projectPath);
  const note: Note = {
    id: Math.random().toString(36).slice(2, 8),
    createdAt: monotonicTimestamp(),
    content: content.trim(),
    tags: tags.map((t) => t.toLowerCase().trim()).filter(Boolean),
    files,
    branch,
    category,
  };
  const all = loadNotes(projectPath);
  all.push(note);
  saveNotes(projectPath, all);
  return note;
}

export function removeNote(projectPath: string, id: string): boolean {
  const notes = loadNotes(projectPath);
  const filtered = notes.filter((n) => n.id !== id);
  if (filtered.length === notes.length) return false;
  saveNotes(projectPath, filtered);
  return true;
}

export function searchNotes(projectPath: string, query: string | undefined): Note[] {
  const notes = loadNotes(projectPath);
  if (!query || !query.trim()) return notes.slice().reverse();  // newest first
  const q = query.toLowerCase();
  return notes
    .filter((n) =>
      n.content.toLowerCase().includes(q) ||
      n.tags.some((t) => t.includes(q)) ||
      n.files.some((f) => f.toLowerCase().includes(q)) ||
      (n.branch ?? "").toLowerCase().includes(q)
    )
    .reverse();
}
