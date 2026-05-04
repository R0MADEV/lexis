import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { migrateIfNeeded, indexFilePath, notesFilePath, projectStorageDir } from "../adapters/storage/paths";
import { cleanupTmpProject } from "./test-utils";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lexis-paths-test-"));
});

afterEach(() => {
  cleanupTmpProject(tmpDir);
});

describe("migrateIfNeeded", () => {
  test("returns false when legacy file does not exist", () => {
    const legacy = path.join(tmpDir, "legacy.json");
    const central = path.join(tmpDir, "central.json");
    expect(migrateIfNeeded(legacy, central)).toBe(false);
  });

  test("moves legacy file to central when central does not exist", () => {
    const legacy = path.join(tmpDir, "legacy.json");
    const central = path.join(tmpDir, "central.json");
    fs.writeFileSync(legacy, '{"data":1}');

    const result = migrateIfNeeded(legacy, central);
    expect(result).toBe(true);
    expect(fs.existsSync(legacy)).toBe(false);
    expect(fs.existsSync(central)).toBe(true);
    expect(fs.readFileSync(central, "utf-8")).toBe('{"data":1}');
  });

  test("deletes legacy when central already exists", () => {
    const legacy = path.join(tmpDir, "legacy.json");
    const central = path.join(tmpDir, "central.json");
    fs.writeFileSync(legacy, "old");
    fs.writeFileSync(central, "new");

    const result = migrateIfNeeded(legacy, central);
    expect(result).toBe(true);
    expect(fs.existsSync(legacy)).toBe(false);
    expect(fs.readFileSync(central, "utf-8")).toBe("new");
  });
});

describe("project storage paths", () => {
  test("different projects map to different storage dirs", () => {
    const a = projectStorageDir(path.join(tmpDir, "project-a"));
    const b = projectStorageDir(path.join(tmpDir, "project-b"));
    expect(a).not.toBe(b);
  });

  test("same project always maps to same storage dir", () => {
    const projectPath = path.join(tmpDir, "myproject");
    const first = projectStorageDir(projectPath);
    const second = projectStorageDir(projectPath);
    expect(first).toBe(second);
  });

  test("storage dir is created on demand outside the project", () => {
    const projectPath = path.join(tmpDir, "outside-project");
    const storage = projectStorageDir(projectPath);
    expect(fs.existsSync(storage)).toBe(true);
    expect(storage.startsWith(projectPath)).toBe(false);
  });

  test("indexFilePath and notesFilePath live in the same project dir", () => {
    const projectPath = path.join(tmpDir, "shared");
    expect(path.dirname(indexFilePath(projectPath)))
      .toBe(path.dirname(notesFilePath(projectPath)));
  });
});
