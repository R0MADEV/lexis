import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { migrateIfNeeded } from "../adapters/storage/paths";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lexis-paths-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
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
