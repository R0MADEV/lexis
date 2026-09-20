import * as path from "path";
import { watchedDirectories } from "../core/staleness";

const ROOT = path.resolve("/proj");
const p = (...parts: string[]) => path.join(ROOT, ...parts);

describe("watchedDirectories", () => {
  test("watches the directory each indexed file lives in", () => {
    const dirs = watchedDirectories(ROOT, [p("src", "core", "a.ts"), p("src", "mcp", "b.ts")]);
    expect(dirs).toContain(p("src", "core"));
    expect(dirs).toContain(p("src", "mcp"));
  });

  test("reaches nested directories — a new file lands beside existing code, not at the root", () => {
    // The old check scanned first-level dirs only. Creating src/core/new.ts bumps
    // the mtime of src/core, never of src, so those files were invisible.
    const dirs = watchedDirectories(ROOT, [p("src", "mcp", "tools", "deep.ts")]);
    expect(dirs).toContain(p("src", "mcp", "tools"));
  });

  test("watches the ancestors too, so a brand-new subdirectory is noticed", () => {
    const dirs = watchedDirectories(ROOT, [p("src", "core", "a.ts")]);
    expect(dirs).toContain(p("src"));
  });

  test("deduplicates — many files share a directory", () => {
    const dirs = watchedDirectories(ROOT, [p("src", "a.ts"), p("src", "b.ts"), p("src", "c.ts")]);
    expect(dirs.filter((d) => d === p("src"))).toHaveLength(1);
  });

  test("handles an empty index without throwing", () => {
    expect(watchedDirectories(ROOT, [])).toEqual([]);
  });

  test("stops at the shared root rather than walking up to the filesystem", () => {
    const dirs = watchedDirectories(ROOT, [p("src", "a.ts")]);
    expect(dirs).not.toContain(path.parse(path.resolve("/proj")).root);
  });
});
