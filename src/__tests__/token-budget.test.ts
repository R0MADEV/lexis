import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { TOOLS } from "../mcp/tools-registry";
import { LEXIS_INSTRUCTIONS } from "../mcp/instructions";
import { indexProject } from "../core/indexer";
import { dispatchTool } from "../mcp/server";
import { cleanupTmpProject } from "./test-utils";

// Load cost is what every session pays before doing any work, and it only ever
// creeps upward — one description at a time, each increase reasonable on its
// own. These ceilings exist to make that creep fail a build instead of going
// unnoticed until someone thinks to measure. Raise one deliberately, with the
// new number in the commit message, never to make a red test go green.
const approxTokens = (s: string) => Math.round(s.length / 3.5);

const LOAD_CEILING = 4600;
// search_code is legitimately the heaviest — it documents eight output modes —
// and sits at 1,197 bytes. The ceiling leaves room for wording changes while
// still catching a tool that doubles.
const TOOL_CEILING_BYTES = 1400;
const INSTRUCTIONS_CEILING_BYTES = 1500;

describe("load cost", () => {
  test("the whole tools/list payload plus instructions stays under the ceiling", () => {
    const cost = approxTokens(JSON.stringify(TOOLS) + LEXIS_INSTRUCTIONS);
    expect(cost).toBeLessThan(LOAD_CEILING);
  });

  test("no single tool definition dominates the payload", () => {
    const heavy = TOOLS
      .map((t) => ({ name: t.name, bytes: Buffer.byteLength(JSON.stringify(t), "utf8") }))
      .filter((t) => t.bytes > TOOL_CEILING_BYTES);
    expect(heavy).toEqual([]);
  });

  test("the instructions field stays a briefing, not a manual", () => {
    expect(Buffer.byteLength(LEXIS_INSTRUCTIONS, "utf8")).toBeLessThan(INSTRUCTIONS_CEILING_BYTES);
  });
});

describe("output size", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lexis-budget-test-"));
  });
  afterEach(() => cleanupTmpProject(tmpDir));

  function write(rel: string, content: string) {
    const abs = path.join(tmpDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }

  function smallProject() {
    for (let i = 0; i < 10; i++) {
      write(`src/routes/route${i}.ts`, `export function handler${i}() { return ${i}; }\n`);
      write(`src/services/service${i}.ts`, `export class Service${i} { run() { return ${i}; } }\n`);
    }
    write("src/index.ts", "export function main() { return 0; }\n");
    return indexProject(tmpDir, null);
  }

  test("list_entrypoints stays compact on a 21-file project", () => {
    const idx = smallProject();
    const out = dispatchTool("list_entrypoints", {}, idx, tmpDir);
    expect(approxTokens(out)).toBeLessThan(900);
  });

  test("search_code in compact mode respects the result limit it advertises", () => {
    const idx = smallProject();
    const out = dispatchTool("search_code", { query: "handler", top_k: 3 }, idx, tmpDir);
    expect(approxTokens(out)).toBeLessThan(1500);
  });
});

// The one-call path can only replace the chain if it actually carries what the
// chain returned. This asserts the substitution is not lossy; whether an agent
// chooses it is a question for telemetry, not for a test.
describe("investigate covers the chain it replaces", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lexis-chain-test-"));
  });
  afterEach(() => cleanupTmpProject(tmpDir));

  function write(rel: string, content: string) {
    const abs = path.join(tmpDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }

  function projectWithCallerAndTest() {
    write("src/auth.ts", "export function authorize(user: string) { return user.length > 0; }\n");
    write("src/handler.ts", "import { authorize } from './auth';\nexport function handle(u: string) { return authorize(u); }\n");
    write("src/auth.test.ts", "import { authorize } from './auth';\ntest('authorize', () => { authorize('x'); });\n");
    return indexProject(tmpDir, null);
  }

  test("carries the definition get_symbol would have returned", () => {
    const idx = projectWithCallerAndTest();
    const chain = dispatchTool("get_symbol", { name: "authorize" }, idx, tmpDir);
    const single = dispatchTool("investigate", { name: "authorize" }, idx, tmpDir);
    expect(chain).toContain("function authorize");
    expect(single).toContain("function authorize");
  });

  test("carries the caller find_references would have returned", () => {
    const idx = projectWithCallerAndTest();
    const chain = dispatchTool("find_references", { symbol: "authorize" }, idx, tmpDir);
    const single = dispatchTool("investigate", { name: "authorize" }, idx, tmpDir);
    expect(chain).toContain("handler.ts");
    expect(single).toContain("handler.ts");
  });

  test("carries the test tests_for would have returned", () => {
    const idx = projectWithCallerAndTest();
    const chain = dispatchTool("tests_for", { target: "authorize" }, idx, tmpDir);
    const single = dispatchTool("investigate", { name: "authorize" }, idx, tmpDir);
    expect(chain).toContain("auth.test.ts");
    expect(single).toContain("auth.test.ts");
  });

  test("costs less than running the chain it replaces", () => {
    const idx = projectWithCallerAndTest();
    const chain =
      approxTokens(dispatchTool("get_symbol", { name: "authorize" }, idx, tmpDir)) +
      approxTokens(dispatchTool("find_references", { symbol: "authorize" }, idx, tmpDir)) +
      approxTokens(dispatchTool("tests_for", { target: "authorize" }, idx, tmpDir));
    const single = approxTokens(dispatchTool("investigate", { name: "authorize" }, idx, tmpDir));
    expect(single).toBeLessThan(chain);
  });
});
