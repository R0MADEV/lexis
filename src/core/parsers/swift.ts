// Swift
import { ParserPattern } from "./types";

export const SWIFT_PATTERNS: ParserPattern[] = [
  { regex: /^(public|private|internal|open|fileprivate)?\s*func\s+(\w+)/, type: "function", nameGroup: 2 },
  { regex: /^(public|private|internal|open|fileprivate)?\s*(class|struct|enum|protocol|extension)\s+(\w+)/, type: "class", nameGroup: 3 },
];
