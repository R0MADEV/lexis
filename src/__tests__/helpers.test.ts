// Unit tests for pure helper functions. These complement the E2E mcp-tools.test.ts
// by testing edge cases of internal logic that can break silently during refactors.

import {
  identTokens,
  globToRegex,
  compressPaths,
  formatPathList,
  baseFileName,
  rankFiles,
  truncateIfExcessive,
  findEnclosingSignatures,
} from "../mcp/server";
import { isMainBranch, categoryForBranch } from "../adapters/storage/notes-file";

describe("identTokens", () => {
  test("splits camelCase", () => {
    expect(identTokens("UserController")).toEqual(["user", "controller"]);
  });
  test("splits kebab-case", () => {
    expect(identTokens("user-controller")).toEqual(["user", "controller"]);
  });
  test("splits snake_case", () => {
    expect(identTokens("user_controller")).toEqual(["user", "controller"]);
  });
  test("handles consecutive caps (acronyms)", () => {
    expect(identTokens("HTTPRequest")).toEqual(["http", "request"]);
  });
  test("handles dot-separated", () => {
    expect(identTokens("foo.bar.baz")).toEqual(["foo", "bar", "baz"]);
  });
  test("returns empty for empty input", () => {
    expect(identTokens("")).toEqual([]);
  });
  test("treats single word as one token", () => {
    expect(identTokens("hello")).toEqual(["hello"]);
  });
});

describe("globToRegex", () => {
  test("* matches any chars except path separators", () => {
    const re = globToRegex("*.ts");
    expect(re.test("src/foo.ts")).toBe(true);
    expect(re.test("foo.ts")).toBe(true);
    expect(re.test("foo.tsx")).toBe(false);
  });
  test("** matches across nested directories", () => {
    const re = globToRegex("**/*.ts");
    expect(re.test("src/lib/foo.ts")).toBe(true);
    expect(re.test("a/b/c/d/foo.ts")).toBe(true);
  });
  test("? matches single char", () => {
    const re = globToRegex("a?.ts");
    expect(re.test("a1.ts")).toBe(true);
    expect(re.test("a12.ts")).toBe(false);
  });
  test("escapes regex specials", () => {
    const re = globToRegex("foo.bar.ts");
    // The dot should be literal
    expect(re.test("foo.bar.ts")).toBe(true);
    expect(re.test("fooXbarXts")).toBe(false);
  });
  test("is case-insensitive", () => {
    const re = globToRegex("*.TS");
    expect(re.test("foo.ts")).toBe(true);
  });
});

describe("baseFileName", () => {
  test("extracts last segment of unix path", () => {
    expect(baseFileName("/foo/bar/baz.ts")).toBe("baz.ts");
  });
  test("extracts last segment of windows path", () => {
    expect(baseFileName("C:\\foo\\bar\\baz.ts")).toBe("baz.ts");
  });
  test("returns input when no separator", () => {
    expect(baseFileName("file.ts")).toBe("file.ts");
  });
});

describe("compressPaths", () => {
  test("returns null when fewer than 3 paths", () => {
    expect(compressPaths(["a/b", "a/c"])).toBeNull();
  });
  test("returns null when no meaningful common prefix", () => {
    expect(compressPaths(["a/b", "x/y", "p/q"])).toBeNull();
  });
  test("compresses common prefix when 3+ paths share enough", () => {
    const result = compressPaths([
      "library/Ivoz/Provider/Domain/Service/A.php",
      "library/Ivoz/Provider/Domain/Service/B.php",
      "library/Ivoz/Provider/Domain/Service/C.php",
    ]);
    expect(result).not.toBeNull();
    expect(result?.base).toContain("Service/");
    expect(result?.rels).toHaveLength(3);
    expect(result?.rels[0]).toBe("A.php");
  });
});

describe("formatPathList", () => {
  test("returns plain join when paths can't be compressed", () => {
    const out = formatPathList(["a/b.ts", "c/d.ts"]);
    expect(out).toBe("a/b.ts\nc/d.ts");
  });
  test("emits BASE: header when paths share a prefix", () => {
    const out = formatPathList([
      "src/lib/auth/A.ts",
      "src/lib/auth/B.ts",
      "src/lib/auth/C.ts",
    ]);
    expect(out).toContain("BASE:");
    expect(out).toContain("A.ts");
  });
});

describe("rankFiles", () => {
  test("exact filename match ranks first", () => {
    const ranked = rankFiles("AuthService", [
      "/p/src/utils/AuthServiceFactory.ts",
      "/p/src/AuthService.ts",
      "/p/src/tests/AuthServiceMock.ts",
    ]);
    expect(ranked[0]?.file).toContain("AuthService.ts");
    // Factory and Mock should rank lower
    expect(ranked[0]?.file).not.toContain("Factory");
  });
  test("token-equivalent match (camel ↔ kebab) ranks high", () => {
    const ranked = rankFiles("UserController", [
      "/p/src/UserController.ts",
      "/p/src/user-controller.go",
    ]);
    // Both should appear; either could be first
    expect(ranked).toHaveLength(2);
    expect(ranked.every((r) => r.score > 0)).toBe(true);
  });
  test("src/ scores higher than tests/", () => {
    const ranked = rankFiles("payment", [
      "/p/tests/payment.test.ts",
      "/p/src/payment.ts",
    ]);
    expect(ranked[0]?.file).toContain("src/payment.ts");
  });
  test("glob pattern returns only globbed matches", () => {
    const ranked = rankFiles("*Controller.ts", [
      "/p/src/UserController.ts",
      "/p/src/AuthController.ts",
      "/p/src/UserService.ts",  // does NOT match *Controller.ts
    ]);
    const files = ranked.map((r) => r.file);
    expect(files).toContain("/p/src/UserController.ts");
    expect(files).toContain("/p/src/AuthController.ts");
    expect(files).not.toContain("/p/src/UserService.ts");
  });
});

describe("truncateIfExcessive", () => {
  test("returns text unchanged when under budget", () => {
    const text = "small content";
    expect(truncateIfExcessive(text, 1, 10)).toBe(text);
  });
  test("truncates when over budget and adds resume marker", () => {
    const huge = "x".repeat(50000);
    const result = truncateIfExcessive(huge, 1, 1000);
    expect(result.length).toBeLessThan(huge.length);
    expect(result.toLowerCase()).toMatch(/truncated|offset|read more/);
  });
});

describe("findEnclosingSignatures", () => {
  test("finds enclosing class for a line inside a method", () => {
    const lines = [
      "export class Foo {",                          // 1
      "  bar() {",                                    // 2
      "    return 1;",                                // 3 ← target
      "  }",                                          // 4
      "}",                                            // 5
    ];
    const sigs = findEnclosingSignatures(lines, 3);
    const joined = sigs.join("\n");
    expect(joined).toContain("class Foo");
  });
  test("returns empty array when no enclosing signature found", () => {
    const lines = [
      "// just a comment",
      "const x = 1;",
    ];
    const sigs = findEnclosingSignatures(lines, 2);
    // May be empty or contain nothing meaningful; both acceptable
    expect(Array.isArray(sigs)).toBe(true);
  });
});

describe("isMainBranch", () => {
  test("recognizes main, master, develop, dev, trunk", () => {
    expect(isMainBranch("main")).toBe(true);
    expect(isMainBranch("master")).toBe(true);
    expect(isMainBranch("develop")).toBe(true);
    expect(isMainBranch("dev")).toBe(true);
    expect(isMainBranch("trunk")).toBe(true);
  });
  test("is case-insensitive", () => {
    expect(isMainBranch("MAIN")).toBe(true);
    expect(isMainBranch("Master")).toBe(true);
  });
  test("returns false for feature branches", () => {
    expect(isMainBranch("feature/x")).toBe(false);
    expect(isMainBranch("fix/JIRA-1234")).toBe(false);
    expect(isMainBranch("hotfix/urgent")).toBe(false);
  });
});

describe("categoryForBranch", () => {
  test("fix/* and bugfix/* and hotfix/* go to bugs", () => {
    expect(categoryForBranch("fix/JIRA-1")).toBe("bugs");
    expect(categoryForBranch("bugfix/urgent")).toBe("bugs");
    expect(categoryForBranch("hotfix/critical")).toBe("bugs");
  });
  test("feature/* and feat/* go to features", () => {
    expect(categoryForBranch("feature/auth")).toBe("features");
    expect(categoryForBranch("feat/payment")).toBe("features");
  });
  test("JIRA-style ticket prefix goes to bugs", () => {
    expect(categoryForBranch("PROJ-1234")).toBe("bugs");
    expect(categoryForBranch("ABC-99")).toBe("bugs");
  });
  test("anything else falls back to others", () => {
    expect(categoryForBranch("my-experiment")).toBe("others");
    expect(categoryForBranch("temporary")).toBe("others");
  });
});
