// Which symbol owns a given line.
//
// The index stores lineEnd as lineStart + 20 for every symbol — a fixed guess,
// never a measurement. Code that filtered on `lineStart <= line && lineEnd >=
// line` therefore claimed a twenty-line window for a three-line function, and,
// worse, attributed nothing at all to a line thirty lines into a long one: that
// change simply disappeared from the report, with no sign it had been dropped.
//
// A symbol's real extent is bounded by wherever the next one starts, which is
// exact for symbols listed in file order and never silently drops a line.

import { Symbol as IndexedSymbol } from "./indexer";

export function enclosingSymbol(symbols: IndexedSymbol[], line: number): IndexedSymbol | null {
  let best: IndexedSymbol | null = null;
  for (const symbol of symbols) {
    if (symbol.lineStart > line) continue;
    if (!best || symbol.lineStart > best.lineStart) best = symbol;
  }
  return best;
}
