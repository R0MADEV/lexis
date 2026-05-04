// Go
import { ParserPattern } from "./types";

export const GO_PATTERNS: ParserPattern[] = [
  { regex: /^func\s+(\w+)\s*\(/, type: "function", nameGroup: 1 },
  { regex: /^func\s+\([^)]+\)\s+(\w+)\s*\(/, type: "method", nameGroup: 1 },
  { regex: /^type\s+(\w+)\s+(struct|interface)/, type: "class", nameGroup: 1 },
];
