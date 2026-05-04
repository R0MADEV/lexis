// Perl
import { ParserPattern } from "./types";

export const PERL_PATTERNS: ParserPattern[] = [
  { regex: /^sub\s+(\w+)\s*[({]/, type: "function", nameGroup: 1 },
  { regex: /^package\s+([\w:]+)\s*;/, type: "class", nameGroup: 1 },
];
