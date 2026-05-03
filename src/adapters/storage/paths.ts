import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const LEXIS_HOME = path.join(os.homedir(), ".lexis");
const PROJECTS_DIR = path.join(LEXIS_HOME, "projects");

// Convert an absolute project path to a directory-safe slug.
// /Users/romangomez/Desktop/irontec/ivozprovider → Users-romangomez-Desktop-irontec-ivozprovider
function slugify(projectPath: string): string {
  const abs = path.resolve(projectPath);
  return abs
    .replace(/^\/+|\/+$/g, "")     // trim leading/trailing slashes
    .replace(/[\/\\]/g, "-")
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .slice(0, 200);                 // bound length
}

// Per-project storage directory inside ~/.lexis/projects/<slug>/
// Created on demand, never inside the user's repo.
export function projectStorageDir(projectPath: string): string {
  const dir = path.join(PROJECTS_DIR, slugify(projectPath));
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function indexFilePath(projectPath: string): string {
  return path.join(projectStorageDir(projectPath), "index.json");
}

export function notesFilePath(projectPath: string): string {
  return path.join(projectStorageDir(projectPath), "notes.md");
}

// Legacy paths inside the project — kept for one-time migration.
export function legacyIndexPath(projectPath: string): string {
  return path.join(projectPath, ".lexis-index.json");
}

export function legacyNotesPath(projectPath: string): string {
  return path.join(projectPath, ".lexis-notes.md");
}

// One-shot migration: move legacy file out of the user's project into ~/.lexis/.
// - Legacy + no central → move it (preserve user data)
// - Legacy + central exists → delete the legacy stray (central is canonical)
// - Neither → noop
export function migrateIfNeeded(legacyPath: string, centralPath: string): boolean {
  if (!fs.existsSync(legacyPath)) return false;

  // Case 1: central exists → just remove the legacy stray
  if (fs.existsSync(centralPath)) {
    try { fs.unlinkSync(legacyPath); return true; } catch { return false; }
  }

  // Case 2: only legacy exists → move it to central
  try {
    fs.renameSync(legacyPath, centralPath);
    return true;
  } catch {
    try {
      fs.copyFileSync(legacyPath, centralPath);
      fs.unlinkSync(legacyPath);
      return true;
    } catch {
      return false;
    }
  }
}

// For UX: list all known projects in ~/.lexis/projects/
export function listKnownProjects(): Array<{ slug: string; storageDir: string }> {
  if (!fs.existsSync(PROJECTS_DIR)) return [];
  return fs.readdirSync(PROJECTS_DIR)
    .filter((s) => fs.statSync(path.join(PROJECTS_DIR, s)).isDirectory())
    .map((slug) => ({ slug, storageDir: path.join(PROJECTS_DIR, slug) }));
}
