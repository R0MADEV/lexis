import { intSetting, resetSettingWarningsForTests } from "../core/settings";

describe("intSetting", () => {
  beforeEach(() => resetSettingWarningsForTests());

  test("reads a valid value", () => {
    expect(intSetting("20", 5, "LEXIS_X")).toBe(20);
    expect(intSetting("0", 5, "LEXIS_X")).toBe(0);
  });

  test("falls back when unset", () => {
    expect(intSetting(undefined, 5, "LEXIS_X")).toBe(5);
    expect(intSetting("", 5, "LEXIS_X")).toBe(5);
    expect(intSetting("   ", 5, "LEXIS_X")).toBe(5);
  });

  test("falls back on a value that is not a number, instead of yielding NaN", () => {
    expect(intSetting("abc", 5, "LEXIS_X")).toBe(5);
  });

  test("rejects a half-numeric value rather than silently taking its prefix", () => {
    // parseInt("20abc") is 20, which hides the typo. A setting is either valid or it is not.
    expect(intSetting("20abc", 5, "LEXIS_X")).toBe(5);
  });

  test("rejects a negative value — a negative limit would quietly drop results", () => {
    expect(intSetting("-3", 5, "LEXIS_X")).toBe(5);
  });

  test("tolerates surrounding whitespace on an otherwise valid value", () => {
    expect(intSetting(" 20 ", 5, "LEXIS_X")).toBe(20);
  });

  test("says something when it rejects a value — that is the whole point", () => {
    const written: string[] = [];
    const original = process.stderr.write;
    (process.stderr as NodeJS.WriteStream).write = ((chunk: string) => { written.push(String(chunk)); return true; }) as typeof original;
    try {
      intSetting("abc", 5, "LEXIS_TOOL_RESULT_LIMIT");
    } finally {
      (process.stderr as NodeJS.WriteStream).write = original;
    }
    expect(written.join("")).toContain("LEXIS_TOOL_RESULT_LIMIT");
    expect(written.join("")).toContain("abc");
  });

  test("warns once per setting, not on every call", () => {
    const written: string[] = [];
    const original = process.stderr.write;
    (process.stderr as NodeJS.WriteStream).write = ((chunk: string) => { written.push(String(chunk)); return true; }) as typeof original;
    try {
      intSetting("abc", 5, "LEXIS_NOISY");
      intSetting("abc", 5, "LEXIS_NOISY");
      intSetting("abc", 5, "LEXIS_NOISY");
    } finally {
      (process.stderr as NodeJS.WriteStream).write = original;
    }
    const mentions = written.join("").split("LEXIS_NOISY").length - 1;
    expect(mentions).toBe(1);
  });
});
