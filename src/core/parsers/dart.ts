// Dart / Flutter
import { ParserPattern } from "./types";

export const DART_PATTERNS: ParserPattern[] = [
  { regex: /^(Future<\w+>|void|String|int|bool|double|dynamic|\w+)\s+(\w+)\s*\(/, type: "function", nameGroup: 2 },
];
