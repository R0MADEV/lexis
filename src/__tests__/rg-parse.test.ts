import { parseRgLine } from "../core/rg-output";

describe("parseRgLine", () => {
  test("splits an ordinary ripgrep line", () => {
    expect(parseRgLine("src/a.ts:42:  const x = 1;")).toEqual({
      file: "src/a.ts", line: 42, content: "  const x = 1;",
    });
  });

  test("stops at the FIRST line number, not the last", () => {
    // Greedy matching took the last ":<digits>:" in the line, so a match whose
    // own content mentioned one produced a file path made of source text.
    const line = `src/t.test.ts:5:  expect(f("a.ts:1:hello")).toBe("b.ts:2:world");`;
    expect(parseRgLine(line)).toEqual({
      file: "src/t.test.ts",
      line: 5,
      content: `  expect(f("a.ts:1:hello")).toBe("b.ts:2:world");`,
    });
  });

  test("handles a windows path with a drive letter", () => {
    expect(parseRgLine("C:\\proj\\src\\a.ts:7:code")).toEqual({
      file: "C:\\proj\\src\\a.ts", line: 7, content: "code",
    });
  });

  test("handles content with a url and port", () => {
    const parsed = parseRgLine("src/api.ts:12:  fetch('http://host:8080/x');");
    expect(parsed?.file).toBe("src/api.ts");
    expect(parsed?.line).toBe(12);
  });

  test("keeps an empty match line rather than dropping it", () => {
    expect(parseRgLine("src/a.ts:3:")).toEqual({ file: "src/a.ts", line: 3, content: "" });
  });

  test("returns null for a line that is not a match", () => {
    expect(parseRgLine("")).toBeNull();
    expect(parseRgLine("no line number here")).toBeNull();
  });
});
