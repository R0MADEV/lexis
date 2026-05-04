// Bash / sh / zsh
import { ParserPattern } from "./types";

export const SHELL_PATTERNS: ParserPattern[] = [
  { regex: /^(?:function\s+)?(\w+)\s*\(\s*\)\s*\{/, type: "function", nameGroup: 1 },
];
