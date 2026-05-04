// Python
import { ParserPattern } from "./types";

export const PYTHON_PATTERNS: ParserPattern[] = [
  { regex: /^def\s+(\w+)\s*\(/, type: "function", nameGroup: 1 },
  { regex: /^async\s+def\s+(\w+)\s*\(/, type: "function", nameGroup: 1 },
  { regex: /^class\s+(\w+)[\s:(]/, type: "class", nameGroup: 1 },
];
