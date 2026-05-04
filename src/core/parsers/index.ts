// Registry of all language/DSL parsers. To add support for a new language:
//   1. Create src/core/parsers/<language>.ts exporting a ParserPattern[]
//   2. Add the import + spread below
//   3. Add the file extension(s) to SUPPORTED_EXTENSIONS in indexer.ts
//
// Order matters only for ambiguous patterns — earlier wins. Generic patterns
// (e.g. shell function regex) come last to let language-specific ones match first.
import { ParserPattern } from "./types";
import { JS_TS_PATTERNS } from "./javascript";
import { RUST_PATTERNS } from "./rust";
import { GO_PATTERNS } from "./go";
import { PYTHON_PATTERNS } from "./python";
import { PHP_PATTERNS } from "./php";
import { RUBY_PATTERNS } from "./ruby";
import { JVM_PATTERNS } from "./jvm";
import { SWIFT_PATTERNS } from "./swift";
import { DART_PATTERNS } from "./dart";
import { C_PATTERNS } from "./c";
import { SCALA_PATTERNS } from "./scala";
import { ELIXIR_PATTERNS } from "./elixir";
import { PERL_PATTERNS } from "./perl";
import { SHELL_PATTERNS } from "./shell";
import { KAMAILIO_PATTERNS } from "./kamailio";
import { ASTERISK_PATTERNS } from "./asterisk";
import { CGRATES_PATTERNS } from "./cgrates";

export const ALL_PATTERNS: ParserPattern[] = [
  ...JS_TS_PATTERNS,
  ...RUST_PATTERNS,
  ...GO_PATTERNS,
  ...PYTHON_PATTERNS,
  ...PHP_PATTERNS,
  ...RUBY_PATTERNS,
  ...JVM_PATTERNS,
  ...SWIFT_PATTERNS,
  ...DART_PATTERNS,
  ...C_PATTERNS,
  ...SCALA_PATTERNS,
  ...ELIXIR_PATTERNS,
  ...PERL_PATTERNS,
  ...KAMAILIO_PATTERNS,
  ...ASTERISK_PATTERNS,
  ...CGRATES_PATTERNS,
  // Shell last — its function regex `name() {` is generic enough to match
  // some other languages' anonymous blocks; let specific parsers win first.
  ...SHELL_PATTERNS,
];

export type { ParserPattern };
