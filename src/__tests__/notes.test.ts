import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { addNote, loadNotes, removeNote, searchNotes } from "../adapters/storage/notes-file";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lexis-notes-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("addNote / loadNotes", () => {
  test("adds and loads a single note", () => {
    addNote(tmpDir, "Found a bug in the auth flow", ["auth", "bug"], ["src/auth.ts"]);
    const notes = loadNotes(tmpDir);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.content).toBe("Found a bug in the auth flow");
    expect(notes[0]!.tags).toEqual(["auth", "bug"]);
    expect(notes[0]!.files).toEqual(["src/auth.ts"]);
  });

  test("adds multiple notes and loads all", () => {
    addNote(tmpDir, "First note", ["tag1"]);
    addNote(tmpDir, "Second note", ["tag2"]);
    addNote(tmpDir, "Third note", ["tag3"]);
    const notes = loadNotes(tmpDir);
    expect(notes).toHaveLength(3);
    expect(notes.map((n) => n.content)).toEqual(["First note", "Second note", "Third note"]);
  });

  test("notes survive round-trip through file", () => {
    addNote(tmpDir, "Multiline\ncontent here", ["multi"], ["a.ts", "b.ts"]);
    const notes = loadNotes(tmpDir);
    expect(notes[0]!.content).toBe("Multiline\ncontent here");
    expect(notes[0]!.files).toEqual(["a.ts", "b.ts"]);
  });

  test("note without tags or files", () => {
    addNote(tmpDir, "Simple note");
    const notes = loadNotes(tmpDir);
    expect(notes[0]!.tags).toEqual([]);
    expect(notes[0]!.files).toEqual([]);
  });

  test("tags are lowercased", () => {
    addNote(tmpDir, "Test", ["Auth", "BUG"]);
    const notes = loadNotes(tmpDir);
    expect(notes[0]!.tags).toEqual(["auth", "bug"]);
  });

  test("returns empty array when no file exists", () => {
    expect(loadNotes(tmpDir)).toEqual([]);
  });
});

describe("removeNote", () => {
  test("removes note by id", () => {
    const note = addNote(tmpDir, "To be removed");
    addNote(tmpDir, "To keep");
    const removed = removeNote(tmpDir, note.id);
    expect(removed).toBe(true);
    const notes = loadNotes(tmpDir);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.content).toBe("To keep");
  });

  test("returns false for unknown id", () => {
    addNote(tmpDir, "Existing");
    expect(removeNote(tmpDir, "nonexistent")).toBe(false);
  });
});

describe("searchNotes", () => {
  beforeEach(() => {
    addNote(tmpDir, "Kamailio reload bug", ["kamailio", "bug"], ["src/kamailio.ts"]);
    addNote(tmpDir, "Auth flow refactor", ["auth"], ["src/auth.ts"]);
    addNote(tmpDir, "Database connection pool", ["db", "perf"]);
  });

  test("returns all notes when no query", () => {
    expect(searchNotes(tmpDir, undefined)).toHaveLength(3);
  });

  test("filters by content substring", () => {
    const results = searchNotes(tmpDir, "kamailio");
    expect(results).toHaveLength(1);
    expect(results[0]!.content).toContain("Kamailio");
  });

  test("filters by tag", () => {
    const results = searchNotes(tmpDir, "bug");
    expect(results).toHaveLength(1);
    expect(results[0]!.tags).toContain("bug");
  });

  test("filters by file", () => {
    const results = searchNotes(tmpDir, "auth.ts");
    expect(results).toHaveLength(1);
    expect(results[0]!.files).toContain("src/auth.ts");
  });

  test("returns empty when nothing matches", () => {
    expect(searchNotes(tmpDir, "xyznonexistent")).toHaveLength(0);
  });

  test("search is case-insensitive", () => {
    const results = searchNotes(tmpDir, "KAMAILIO");
    expect(results).toHaveLength(1);
  });
});
