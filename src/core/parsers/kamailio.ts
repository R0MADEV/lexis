// Kamailio (.cfg) — SIP proxy/router. Routes are the unit of abstraction,
// equivalent to functions in code: FreeSWITCH-Kamailio bridges,
// VoIP backends, etc.
//
// Examples:
//   route[GET_DDI_PREFIX] { ... }
//   failure_route[MANAGE_FAILURE] { ... }
//   onreply_route[HANDLE_REPLY] { ... }
//   branch_route[BRANCH_LOGIC] { ... }
//   event_route[xhttp:request] { ... }
import { ParserPattern } from "./types";

export const KAMAILIO_PATTERNS: ParserPattern[] = [
  { regex: /^(?:route|failure_route|onreply_route|branch_route|event_route|onsend_route|reply_route)\[([^\]]+)\]/, type: "function", nameGroup: 1 },
];
