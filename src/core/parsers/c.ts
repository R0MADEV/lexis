// C / C++
import { ParserPattern } from "./types";

export const C_PATTERNS: ParserPattern[] = [
  { regex: /^(\w[\w\s*<>]+)\s+(\w+)\s*\([^)]*\)\s*(\{|$)/, type: "function", nameGroup: 2 },
];
