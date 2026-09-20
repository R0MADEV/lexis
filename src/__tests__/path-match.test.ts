import { pathFilterMatches } from "../core/path-match";

describe("pathFilterMatches", () => {
  test("a filter written with / matches a windows path stored with backslashes", () => {
    expect(pathFilterMatches("C:\\proj\\src\\admin\\Home.ts", "src/admin")).toBe(true);
  });

  test("a filter written with backslashes matches a posix path", () => {
    expect(pathFilterMatches("/proj/src/admin/Home.ts", "src\\admin")).toBe(true);
  });

  test("same separator on both sides still works", () => {
    expect(pathFilterMatches("/proj/src/admin/Home.ts", "src/admin")).toBe(true);
    expect(pathFilterMatches("C:\\proj\\src\\admin\\Home.ts", "src\\admin")).toBe(true);
  });

  test("case-insensitive", () => {
    expect(pathFilterMatches("/proj/src/Admin/Home.ts", "SRC/ADMIN")).toBe(true);
  });

  test("does not match a different path", () => {
    expect(pathFilterMatches("C:\\proj\\src\\app\\Home.ts", "src/admin")).toBe(false);
    expect(pathFilterMatches("/proj/src/app/Home.ts", "src/admin")).toBe(false);
  });

  test("an empty filter matches everything", () => {
    expect(pathFilterMatches("/proj/src/a.ts", "")).toBe(true);
  });
});
