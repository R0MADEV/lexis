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
