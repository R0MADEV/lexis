// TypeScript / JavaScript / JSX / TSX
import { ParserPattern } from "./types";

export const JS_TS_PATTERNS: ParserPattern[] = [
  { regex: /^(export\s+)?(default\s+)?(async\s+)?function\s+(\w+)/, type: "function", nameGroup: 4 },
  { regex: /^(export\s+)?(const|let|var)\s+(\w+)\s*=\s*(async\s+)?(\(|function)/, type: "function", nameGroup: 3 },
  { regex: /^(export\s+)?(abstract\s+)?class\s+(\w+)/, type: "class", nameGroup: 3 },
  { regex: /^(export\s+)?interface\s+(\w+)/, type: "class", nameGroup: 2 },
  { regex: /^(export\s+)?enum\s+(\w+)/, type: "class", nameGroup: 2 },
  { regex: /^(export\s+)?(const|let|var)\s+(\w+)/, type: "variable", nameGroup: 3 },
];
