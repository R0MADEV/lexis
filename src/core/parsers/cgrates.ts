// CGRates — telecom rating/charging engine. The Go runtime is already covered
// by GO_PATTERNS; this parser captures the *configuration* layer where named
// profiles live in JSON files (Account, Attribute, Filter, Resource, Charger,
// Threshold, Trend, Ranking, Route, Dispatcher profiles).
//
// CGRates profile IDs follow strong naming conventions, e.g.:
//   "ID": "ACT_PRF_PostpaidUser"
//   "ID": "ATTR_ACNT_1001"
//   "ID": "FLTR_DST_PREMIUM"
//   "ID": "THD_HighCost"
//
// We only run this parser on files that look like CGRates data — JSONs whose
// path contains "cgrates" or whose filename matches known CGRates configs.
// This prevents the pattern from polluting package.json / tsconfig.json / etc.
import { ParserPattern } from "./types";

const CGRATES_ID_PREFIXES = [
  "ACT", "ACNT", "ACC",            // Accounts / Action profiles
  "ATTR",                          // Attribute profiles
  "FLTR",                          // Filter profiles
  "RES",                           // Resource profiles
  "CHRG",                          // Charger profiles
  "THD",                           // Threshold profiles
  "TRD",                           // Trend profiles
  "RNK",                           // Ranking profiles
  "RTE", "RT",                     // Route profiles
  "DSP",                           // Dispatcher profiles
  "STS",                           // Stats profiles
  "TP",                            // Tariff Plan ids
];

const ID_REGEX = new RegExp(
  `"(?:ID|Id)"\\s*:\\s*"((?:${CGRATES_ID_PREFIXES.join("|")})_[A-Za-z0-9_]+)"`
);

const CGRATES_FILES = /(?:^|[\/\\])(cgrates(?:[._-]\w+)?\.json|dispatchers\.json|tariff[._-]?plans?[\/\\])/i;
const CGRATES_PATH = /(?:^|[\/\\])(cgrates|tariffplans|tariff_plans)(?:[\/\\]|$)/i;

function isCgratesFile(file: string): boolean {
  return CGRATES_FILES.test(file) || CGRATES_PATH.test(file);
}

export const CGRATES_PATTERNS: ParserPattern[] = [
  { regex: ID_REGEX, type: "class", nameGroup: 1, appliesTo: isCgratesFile },
];
