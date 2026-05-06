// Pure path utilities used by multiple tool handlers. No fs, no side effects.

export function baseFileName(file: string): string {
  const i = Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\"));
  return i === -1 ? file : file.slice(i + 1);
}

// Detect the longest common path prefix (truncated to a path separator) so we
// can print it once at the top of a result list and use short relative paths
// for each entry. Saves ~30% of tokens in deep monorepos with long paths.
//
// Returns null when compression isn't worth it (fewer than 3 paths, prefix
// too short to matter, or paths don't share a meaningful directory).
const MIN_COMPRESS_PATHS = 3;
const MIN_COMPRESS_PREFIX_LEN = 12;

export function compressPaths(paths: string[]): { base: string; rels: string[] } | null {
  if (paths.length < MIN_COMPRESS_PATHS) return null;

  let prefix = paths[0] ?? "";
  for (let i = 1; i < paths.length; i++) {
    const p = paths[i] ?? "";
    let j = 0;
    while (j < prefix.length && j < p.length && prefix[j] === p[j]) j++;
    prefix = prefix.slice(0, j);
    if (prefix.length === 0) break;
  }

  const lastSep = Math.max(prefix.lastIndexOf("/"), prefix.lastIndexOf("\\"));
  if (lastSep < MIN_COMPRESS_PREFIX_LEN) return null;

  const base = prefix.slice(0, lastSep + 1);
  return { base, rels: paths.map((p) => p.slice(base.length)) };
}

export function formatPathList(paths: string[]): string {
  const c = compressPaths(paths);
  if (!c) return paths.join("\n");
  return `BASE: ${c.base}\n\n${c.rels.join("\n")}`;
}
