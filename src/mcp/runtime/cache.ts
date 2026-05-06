// In-memory LRU cache for tool results. Saves repeated ripgrep/git invocations
// when Claude chains queries on the same symbol within a session. The TTL
// bounds staleness if files change mid-session.

const CACHE_MAX = 100;
const CACHE_TTL_MS = 5 * 60 * 1000;
const toolCache = new Map<string, { value: string; expires: number }>();

export function clearToolCacheForTests(): void {
  toolCache.clear();
}

export function cacheGet(key: string): string | null {
  const hit = toolCache.get(key);
  if (!hit) return null;
  if (hit.expires < Date.now()) { toolCache.delete(key); return null; }
  // refresh LRU position
  toolCache.delete(key);
  toolCache.set(key, hit);
  return hit.value;
}

export function cacheSet(key: string, value: string): void {
  if (toolCache.size >= CACHE_MAX) {
    const oldest = toolCache.keys().next().value;
    if (oldest !== undefined) toolCache.delete(oldest);
  }
  toolCache.set(key, { value, expires: Date.now() + CACHE_TTL_MS });
}
