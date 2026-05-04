// Java / Kotlin / C# — JVM family + .NET (similar enough to share)
import { ParserPattern } from "./types";

export const JVM_PATTERNS: ParserPattern[] = [
  { regex: /^(public|private|protected|internal|static|override|abstract|final|async|sealed|virtual|extern)[\s\w<>\[\]]*\s+(\w+)\s*\(/, type: "method", nameGroup: 2 },
  { regex: /^(public|private|protected|internal|abstract|final|sealed|open)?\s*(class|interface|enum|record|object|data class)\s+(\w+)/, type: "class", nameGroup: 3 },

  // Kotlin functions (top-level)
  { regex: /^(suspend\s+)?fun\s+(\w+)/, type: "function", nameGroup: 2 },
];
