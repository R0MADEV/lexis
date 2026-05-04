// Ruby
import { ParserPattern } from "./types";

export const RUBY_PATTERNS: ParserPattern[] = [
  { regex: /^def\s+(self\.)?(\w+)/, type: "function", nameGroup: 2 },
  { regex: /^class\s+(\w+)/, type: "class", nameGroup: 1 },
  { regex: /^module\s+(\w+)/, type: "class", nameGroup: 1 },
];
