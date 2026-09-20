import { normalizeRgOutput } from "../core/rg-output";

describe("normalizeRgOutput", () => {
  test("drops the carriage return ripgrep echoes back from a CRLF file", () => {
    expect(normalizeRgOutput("a.ts:1:hello\r\nb.ts:2:world\r\n")).toBe("a.ts:1:hello\nb.ts:2:world\n");
  });

  test("leaves LF output untouched", () => {
    expect(normalizeRgOutput("a.ts:1:hello\nb.ts:2:world\n")).toBe("a.ts:1:hello\nb.ts:2:world\n");
  });

  test("keeps a lone carriage return inside a line — it is content, not a terminator", () => {
    expect(normalizeRgOutput("a.ts:1:he\rllo\n")).toBe("a.ts:1:he\rllo\n");
  });

  test("handles empty output", () => {
    expect(normalizeRgOutput("")).toBe("");
  });
});
