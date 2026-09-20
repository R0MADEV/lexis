// Incoming tool arguments: rewrite legacy names, then reject undeclared ones.
//
// One concept, one name.
//
// The tools grew six different names for two ideas: the file a tool operates on
// (path, file, target) and narrowing results by path (file_filter, scope,
// path_filter). Agents guess wrong and burn a round-trip on the error, or worse,
// pass a name the tool silently ignores.
//
// Canonical: `path` for the file a tool reads, `path_filter` for narrowing.
// The older names keep working — they are rewritten here, before dispatch and
// before the cache key is built, so an alias and its canonical form share the
// same cache entry.
//
// `target` is deliberately absent: explain, tests_for and find_writes take a
// symbol OR a file, so it is not a path parameter. `defined_in` is absent too —
// it selects which definition to report on, not where results may live.

import { TOOLS } from "../tools-registry";
import { editDistance } from "../../core/searcher";

const ALIASES: Record<string, Record<string, string>> = {
  outline:        { file: "path" },
  get_context:    { file: "path" },
  resolve_import: { file: "path" },
  get_symbol:     { file_filter: "path_filter" },
  list_symbols:   { file_filter: "path_filter" },
  investigate:    { file_filter: "path_filter" },
  dead_code:      { scope: "path_filter" },
};

export function normalizeArgs(
  tool: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const aliases = ALIASES[tool];
  if (!aliases) return args;

  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    const canonical = aliases[key] ?? key;
    const isAlias = canonical !== key;
    // An explicitly passed canonical value always wins over its alias.
    if (isAlias && args[canonical] !== undefined) continue;
    normalized[canonical] = value;
  }
  return normalized;
}

// An undeclared parameter used to be swallowed in silence. That is the worst
// possible outcome: an agent that passes path="src/" to a tool without path
// scoping gets whole-project results and concludes they were scoped, then
// reasons about the codebase on data it believes is narrower than it is. One
// round-trip spent on an error beats an analysis built on a wrong assumption,
// so the call is refused and the message names what the tool does accept.
//
// Runs after normalizeArgs, so a legacy name is validated in canonical form.

let accepted: Map<string, string[]> | null = null;

function acceptedParams(tool: string): string[] | null {
  if (!accepted) {
    accepted = new Map(
      TOOLS.map((t) => [t.name, Object.keys(t.inputSchema.properties ?? {})])
    );
  }
  return accepted.get(tool) ?? null;
}

export function validateArgs(tool: string, args: Record<string, unknown>): string | null {
  const allowed = acceptedParams(tool);
  // An unknown tool is the dispatcher's error to report, not this one's.
  if (!allowed) return null;

  const unknown = Object.keys(args).filter((key) => !allowed.includes(key));
  if (unknown.length === 0) return null;

  const named = unknown.map((u) => `'${u}'`).join(", ");
  const accepts = allowed.length > 0 ? allowed.join(", ") : "(no parameters)";

  const suggestions = [...new Set(unknown.map((u) => closestParam(u, allowed)).filter(Boolean))];
  const hint = suggestions.length > 0
    ? ` Did you mean ${suggestions.map((s) => `'${s}'`).join(", ")}?`
    : "";

  return `Error: ${tool} does not accept ${named}.${hint} Accepted: ${accepts}.\n` +
    `The call was refused rather than run without it — passing an unsupported ` +
    `scope would have returned results wider than you asked for.`;
}

// The two ways a parameter name goes wrong. A near-miss on the concept — "path"
// where the tool declares "path_filter" — is textually a prefix, not a typo, so
// edit distance never catches it; that one is the failure issue #2 described.
// A genuine typo is the other, and two edits covers it. Names under three
// characters are excluded from the containment rule, or "s" would look like a
// prefix of half the registry.
const MIN_CONTAINMENT_LENGTH = 3;
const MAX_TYPO_DISTANCE = 2;

function closestParam(unknown: string, allowed: string[]): string | null {
  const name = unknown.toLowerCase();

  if (name.length >= MIN_CONTAINMENT_LENGTH) {
    const related = allowed.find((a) => {
      const candidate = a.toLowerCase();
      return candidate.includes(name) || name.includes(candidate);
    });
    if (related) return related;
  }

  let best: { name: string; distance: number } | null = null;
  for (const candidate of allowed) {
    const distance = editDistance(name, candidate.toLowerCase(), MAX_TYPO_DISTANCE);
    if (distance <= MAX_TYPO_DISTANCE && (!best || distance < best.distance)) {
      best = { name: candidate, distance };
    }
  }
  return best?.name ?? null;
}
