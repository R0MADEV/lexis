// Rust
import { ParserPattern } from "./types";

export const RUST_PATTERNS: ParserPattern[] = [
  { regex: /^(pub(\s*\([^)]*\))?\s+)?(async\s+)?fn\s+(\w+)/, type: "function", nameGroup: 4 },
  { regex: /^(pub(\s*\([^)]*\))?\s+)?struct\s+(\w+)/, type: "class", nameGroup: 3 },
  { regex: /^(pub(\s*\([^)]*\))?\s+)?enum\s+(\w+)/, type: "class", nameGroup: 3 },
  { regex: /^(pub(\s*\([^)]*\))?\s+)?trait\s+(\w+)/, type: "class", nameGroup: 3 },
  { regex: /^(pub(\s*\([^)]*\))?\s+)?impl\s+(\w+)/, type: "class", nameGroup: 3 },
];
