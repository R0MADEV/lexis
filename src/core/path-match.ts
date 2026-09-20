// Path filters are written by hand ("src/auth"), but indexed paths carry the
// platform's separator — backslashes on Windows. Comparing them raw makes every
// path filter silently match nothing there, which looks like "no results"
// rather than like a bug. Both sides are normalized to "/" before comparing.

export function pathFilterMatches(file: string, filter: string): boolean {
  return normalizePath(file).includes(normalizePath(filter));
}

export function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").toLowerCase();
}
