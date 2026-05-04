// Asterisk dialplan (.conf) — telephony PBX. Contexts are namespaces of
// dial logic, called from other contexts via Goto / Macro.
//
// Examples:
//   [from-internal]
//   [outbound-routes]
//   [add-headers-users]
//   [macro-record-call]
//
// Match only standalone bracket headers, not inline expressions.
import { ParserPattern } from "./types";

export const ASTERISK_PATTERNS: ParserPattern[] = [
  { regex: /^\[([a-zA-Z][\w-]*)\]\s*$/, type: "class", nameGroup: 1 },
];
