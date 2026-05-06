// Note-related tool handlers: note (save), notes (recall), forget (delete).
// Storage lives in adapters/storage/notes-file.ts; these are thin wrappers
// that handle MCP arg parsing and output formatting.

import { addNote, removeNote, searchNotes } from "../../adapters/storage/notes-file";
import { log } from "../runtime/jsonrpc";

export function execNote(
  args: Record<string, unknown>,
  projectPath: string,
): string {
  const content = args["content"] as string;
  if (!content || content.trim().length < 10) {
    return "Error: 'content' must be at least 10 chars (substantial finding only).";
  }
  const tags = Array.isArray(args["tags"]) ? (args["tags"] as string[]) : [];
  const files = Array.isArray(args["files"]) ? (args["files"] as string[]) : [];

  log(`[note] tags=${tags.join(",")} files=${files.length}`);

  const note = addNote(projectPath, content, tags, files);
  return `Saved note ${note.id}.\n  Tags: ${note.tags.join(", ") || "(none)"}\n  Files: ${note.files.join(", ") || "(none)"}\n  ${note.content.split("\n")[0]?.slice(0, 100)}…`;
}

export function execNotes(
  args: Record<string, unknown>,
  projectPath: string,
): string {
  const query = args["query"] as string | undefined;
  const limit = typeof args["limit"] === "number" ? Math.min(args["limit"], 50) : 10;

  log(`[notes] query=${query ?? "(latest)"} limit=${limit}`);

  const notes = searchNotes(projectPath, query).slice(0, limit);
  if (notes.length === 0) {
    return query
      ? `No notes match "${query}".`
      : `No notes saved yet. Use 'note' to record findings worth keeping across sessions.`;
  }

  const blocks = notes.map((n) => {
    const date = n.createdAt.replace("T", " ").slice(0, 16);
    const head = `## ${date} · ${n.id}`;
    const meta: string[] = [];
    if (n.tags.length > 0)  meta.push(`Tags: ${n.tags.join(", ")}`);
    if (n.files.length > 0) meta.push(`Files: ${n.files.join(", ")}`);
    const metaLine = meta.length > 0 ? `\n${meta.join(" | ")}` : "";
    return `${head}${metaLine}\n${n.content}`;
  });

  return `Notes (${notes.length}${query ? ` matching "${query}"` : ", newest first"}):\n\n${blocks.join("\n\n---\n\n")}`;
}

export function execForget(
  args: Record<string, unknown>,
  projectPath: string,
): string {
  const id = args["id"] as string;
  if (!id) return "Error: 'id' is required.";
  log(`[forget] id=${id}`);
  return removeNote(projectPath, id) ? `Forgot note ${id}.` : `Note ${id} not found.`;
}
