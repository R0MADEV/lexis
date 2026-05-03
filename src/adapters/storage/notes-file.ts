import * as fs from "fs";
import * as path from "path";
import { notesFilePath, legacyNotesPath, migrateIfNeeded } from "./paths";

const MAX_NOTES = 200;

export interface Note {
  id: string;
  createdAt: string;
  content: string;
  tags: string[];
  files: string[];
}

function notesPath(projectPath: string): string {
  const central = notesFilePath(projectPath);
  migrateIfNeeded(legacyNotesPath(projectPath), central);
  return central;
}

// Format a single note as a Markdown block. Newest notes go on top, so the
// first thing Claude sees when reading the file is the latest finding.
function formatNote(n: Note): string {
  const date = n.createdAt.replace("T", " ").slice(0, 16);
  const lines: string[] = [`## ${date} · ${n.id}`];
  if (n.tags.length > 0)  lines.push(`**Tags:** ${n.tags.join(", ")}`);
  if (n.files.length > 0) lines.push(`**Files:** ${n.files.join(", ")}`);
  lines.push("");
  lines.push(n.content.trim());
  return lines.join("\n");
}

// Parse a markdown note block back into structured form. Conservative: any
// section we can't parse is silently dropped (to survive manual edits).
function parseNote(block: string): Note | null {
  const lines = block.split("\n");
  const headerMatch = lines[0]?.match(/^##\s+([\d:\- ]+)\s*·\s*(\w+)/);
  if (!headerMatch) return null;

  const createdAt = (headerMatch[1] ?? "").trim().replace(" ", "T") + ":00Z";
  const id = headerMatch[2] ?? "";

  let tags: string[] = [];
  let files: string[] = [];
  let bodyStart = 1;

  for (let i = 1; i < lines.length && i < 5; i++) {
    const l = lines[i] ?? "";
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

  return { id, createdAt, content, tags, files };
}

export function loadNotes(projectPath: string): Note[] {
  const f = notesPath(projectPath);
  if (!fs.existsSync(f)) return [];
  try {
    const raw = fs.readFileSync(f, "utf-8");
    // Split by lines starting with "## " (each note's H2 header).
    // Works regardless of whether `---` separators are present.
    const lines = raw.split("\n");
    const noteBlocks: string[] = [];
    let current: string[] = [];

    for (const line of lines) {
      if (/^##\s/.test(line)) {
        if (current.length > 0) noteBlocks.push(current.join("\n").trim());
        current = [line];
      } else if (current.length > 0) {
        // strip trailing `---` separator lines from previous block
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
      const n = parseNote(block);
      if (n) notes.push(n);
    }
    // notes are stored newest-first in the file; reverse for chronological in-memory order
    return notes.reverse();
  } catch {
    return [];
  }
}

export function saveNotes(projectPath: string, notes: Note[]): void {
  const trimmed = notes.slice(-MAX_NOTES);
  // Newest first so Claude reads recent context immediately
  const ordered = trimmed.slice().reverse();
  const header = `# Lexis Notes — ${path.basename(projectPath)}\n\n` +
                 `Persistent findings across sessions. Newest on top.\n`;
  const body = ordered.map(formatNote).join("\n\n---\n\n");
  fs.writeFileSync(notesPath(projectPath), `${header}\n${body}\n`);
}

export function addNote(
  projectPath: string,
  content: string,
  tags: string[] = [],
  files: string[] = []
): Note {
  const notes = loadNotes(projectPath);
  const note: Note = {
    id: Math.random().toString(36).slice(2, 8),
    createdAt: new Date().toISOString(),
    content: content.trim(),
    tags: tags.map((t) => t.toLowerCase().trim()).filter(Boolean),
    files,
  };
  notes.push(note);
  saveNotes(projectPath, notes);
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
      n.files.some((f) => f.toLowerCase().includes(q))
    )
    .reverse();
}
