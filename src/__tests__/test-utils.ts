import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// Clean up everything a test created:
//   - the temporary project directory
//   - all storage dirs under ~/.lexis/projects/ that derive from this tmpDir
//     (covers tests that index sub-paths like tmpDir/sub-project)
//
// Tests that call indexProject() or projectStorageDir() leak storage dirs
// unless this helper is invoked in afterEach.
export function cleanupTmpProject(tmpDir: string): void {
  fs.rmSync(tmpDir, { recursive: true, force: true });

  // Slug derivation mirrors paths.ts slugify(): strip leading slashes, replace
  // separators with "-". Any storage dir whose name starts with the tmpDir slug
  // belongs to this test.
  const slugPrefix = tmpDir
    .replace(/^\/+|\/+$/g, "")
    .replace(/[\/\\]/g, "-")
    .replace(/[^A-Za-z0-9._-]/g, "_");

  const projectsRoot = path.join(os.homedir(), ".lexis", "projects");
  if (!fs.existsSync(projectsRoot)) return;

  for (const entry of fs.readdirSync(projectsRoot)) {
    if (entry.startsWith(slugPrefix)) {
      try { fs.rmSync(path.join(projectsRoot, entry), { recursive: true, force: true }); }
      catch { /* ignore */ }
    }
  }
}
