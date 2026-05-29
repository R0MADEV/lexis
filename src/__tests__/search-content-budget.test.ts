import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { indexProject } from "../core/indexer";
import { dispatchTool, clearToolCacheForTests } from "../mcp/server";
import { cleanupTmpProject } from "./test-utils";

let tmpDir: string;
const originalBudget = process.env["LEXIS_CONTENT_BUDGET"];

function write(rel: string, content: string) {
  const abs = path.join(tmpDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

// A class with `lines` body lines, all mentioning the query term so it ranks.
function bigClass(name: string, lines: number): string {
  const body = Array.from({ length: lines }, (_, i) => `  method${i}() { return this.widget${i}; }`).join("\n");
  return `export class ${name} {\n${body}\n}`;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lexis-budget-test-"));
});

afterEach(() => {
  cleanupTmpProject(tmpDir);
  if (originalBudget === undefined) delete process.env["LEXIS_CONTENT_BUDGET"];
  else process.env["LEXIS_CONTENT_BUDGET"] = originalBudget;
});

describe("search_code content budget", () => {
  test("small bodies under budget all render as full content", () => {
    process.env["LEXIS_CONTENT_BUDGET"] = "100000"; // effectively unlimited
    write("src/a.ts", `export class WidgetAlpha { run() { return 1; } }`);
    write("src/b.ts", `export class WidgetBeta { run() { return 2; } }`);
    const idx = indexProject(tmpDir, null);

    const result = dispatchTool("search_code", { query: "Widget", output: "content", top_k: 10 }, idx, tmpDir);

    // Both full blocks present, no compact-overflow marker.
    expect(result).toContain("CODE:");
    expect(result).not.toMatch(/shown compact/i);
  });

  test("large bodies over budget keep first full and demote the rest to compact", () => {
    process.env["LEXIS_CONTENT_BUDGET"] = "120"; // tiny: first block forced, rest compact
    write("src/a.ts", bigClass("WidgetAlpha", 40));
    write("src/b.ts", bigClass("WidgetBeta", 40));
    write("src/c.ts", bigClass("WidgetGamma", 40));
    const idx = indexProject(tmpDir, null);

    const result = dispatchTool("search_code", { query: "Widget", output: "content", top_k: 10 }, idx, tmpDir);

    // At least one full CODE block, plus the compact-overflow marker for the rest.
    expect(result).toContain("CODE:");
    expect(result).toMatch(/shown compact/i);
    // Overflowed results appear as compact path:line lines, not full code fences.
    const codeFences = (result.match(/CODE:/g) ?? []).length;
    expect(codeFences).toBeLessThan(3); // not all 3 rendered full
  });

  test("respects LEXIS_CONTENT_BUDGET — lower budget yields fewer full blocks", () => {
    write("src/a.ts", bigClass("WidgetAlpha", 30));
    write("src/b.ts", bigClass("WidgetBeta", 30));
    write("src/c.ts", bigClass("WidgetGamma", 30));
    write("src/d.ts", bigClass("WidgetDelta", 30));
    const idx = indexProject(tmpDir, null);

    process.env["LEXIS_CONTENT_BUDGET"] = "100000";
    const generous = dispatchTool("search_code", { query: "Widget", output: "content", top_k: 10 }, idx, tmpDir);

    // The budget is an env var, not a tool arg, so it isn't part of the cache
    // key — clear the cache so the second call re-runs instead of replaying.
    clearToolCacheForTests();
    process.env["LEXIS_CONTENT_BUDGET"] = "150";
    const tight = dispatchTool("search_code", { query: "Widget", output: "content", top_k: 10 }, idx, tmpDir);

    const fencesGenerous = (generous.match(/CODE:/g) ?? []).length;
    const fencesTight = (tight.match(/CODE:/g) ?? []).length;
    expect(fencesTight).toBeLessThan(fencesGenerous);
  });

  test("a single oversized result still renders full (never returns zero content)", () => {
    process.env["LEXIS_CONTENT_BUDGET"] = "10"; // smaller than any real body
    write("src/a.ts", bigClass("WidgetSolo", 50));
    const idx = indexProject(tmpDir, null);

    const result = dispatchTool("search_code", { query: "WidgetSolo", output: "content", top_k: 10 }, idx, tmpDir);

    // Even though it blows the budget, the first/only result must come back full.
    expect(result).toContain("CODE:");
    expect(result).toContain("WidgetSolo");
  });

  test("demoted overflow results carry a code preview, not just a bare pointer", () => {
    process.env["LEXIS_CONTENT_BUDGET"] = "120"; // force overflow after the first block
    write("src/a.ts", bigClass("WidgetAlpha", 40));
    write("src/b.ts", bigClass("WidgetBeta", 40));
    const idx = indexProject(tmpDir, null);

    const result = dispatchTool("search_code", { query: "Widget", output: "content", top_k: 10 }, idx, tmpDir);

    // Everything after the "shown compact" marker is the demoted section. It must
    // contain a code preview (a body line), not only "path:line name".
    const marker = result.search(/shown compact/i);
    expect(marker).toBeGreaterThan(-1);
    const overflowSection = result.slice(marker);
    expect(overflowSection).toMatch(/return|method|\{/); // some code leaked through as preview
  });

  test("content_budget arg overrides the env default", () => {
    write("src/a.ts", bigClass("WidgetAlpha", 40));
    write("src/b.ts", bigClass("WidgetBeta", 40));
    write("src/c.ts", bigClass("WidgetGamma", 40));
    const idx = indexProject(tmpDir, null);

    // Env says tiny, but the arg asks for plenty → all full, no overflow marker.
    process.env["LEXIS_CONTENT_BUDGET"] = "50";
    const generousArg = dispatchTool(
      "search_code",
      { query: "Widget", output: "content", top_k: 10, content_budget: 100000 },
      idx,
      tmpDir,
    );
    expect(generousArg).not.toMatch(/shown compact/i);

    clearToolCacheForTests();

    // Env says huge, but the arg asks for tiny → overflow kicks in.
    process.env["LEXIS_CONTENT_BUDGET"] = "100000";
    const tightArg = dispatchTool(
      "search_code",
      { query: "Widget", output: "content", top_k: 10, content_budget: 80 },
      idx,
      tmpDir,
    );
    expect(tightArg).toMatch(/shown compact/i);
  });
});
