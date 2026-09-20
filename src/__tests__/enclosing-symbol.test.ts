import { enclosingSymbol } from "../core/enclosing-symbol";
import { Symbol as IndexedSymbol } from "../core/indexer";

const sym = (name: string, lineStart: number): IndexedSymbol =>
  ({ name, file: "/p/a.ts", lineStart, lineEnd: lineStart + 20, type: "function" });

// lineEnd in the index is lineStart + 20 for every symbol — a fixed guess, not a
// measurement. Anything deciding which symbol owns a line has to ignore it.
const symbols = [sym("first", 10), sym("second", 50), sym("third", 200)];

describe("enclosingSymbol", () => {
  test("picks the symbol a line falls inside", () => {
    expect(enclosingSymbol(symbols, 55)?.name).toBe("second");
  });

  test("picks the definition line itself", () => {
    expect(enclosingSymbol(symbols, 50)?.name).toBe("second");
  });

  test("reaches past the stored twenty-line guess", () => {
    // Line 45 is 35 lines into `first`. The old check required lineEnd >= line,
    // with lineEnd = 30, so this line belonged to nobody and vanished.
    expect(enclosingSymbol(symbols, 45)?.name).toBe("first");
  });

  test("does not attribute a line above the first symbol", () => {
    expect(enclosingSymbol(symbols, 3)).toBeNull();
  });

  test("stops at the next symbol rather than running over it", () => {
    expect(enclosingSymbol(symbols, 199)?.name).toBe("second");
    expect(enclosingSymbol(symbols, 200)?.name).toBe("third");
  });

  test("handles an empty symbol list", () => {
    expect(enclosingSymbol([], 5)).toBeNull();
  });

  test("does not care what order the symbols arrive in", () => {
    const shuffled = [symbols[2]!, symbols[0]!, symbols[1]!];
    expect(enclosingSymbol(shuffled, 55)?.name).toBe("second");
  });
});
