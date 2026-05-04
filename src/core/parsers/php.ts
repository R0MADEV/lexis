// PHP — includes Symfony Route attributes (PHP 8+)
import { ParserPattern } from "./types";

export const PHP_PATTERNS: ParserPattern[] = [
  // Symfony / Attribute-based routes — index path as symbol name for fast lookup
  { regex: /^#\[(?:Route|Get|Post|Put|Delete|Patch|Head|Options)\(\s*['"]([^'"]+)['"]/, type: "function", nameGroup: 1 },

  { regex: /^(public|private|protected|static|\s)*(function)\s+(\w+)\s*\(/, type: "function", nameGroup: 3 },
  { regex: /^(abstract\s+|final\s+)?class\s+(\w+)/, type: "class", nameGroup: 2 },
];
