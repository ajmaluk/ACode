/**
 * Regex Cache — avoids recompiling the same patterns repeatedly.
 *
 * Limited to 100 entries to prevent memory bloat. Evicts oldest on overflow.
 */

const MAX_CACHE_SIZE = 100;
const _cache = new Map<string, RegExp>();

/**
 * Get a compiled RegExp, reusing a cached instance if the pattern+flags match.
 * Returns null if the pattern is invalid.
 */
export function getCachedRegex(pattern: string, flags?: string): RegExp | null {
  const key = `${pattern}::${flags ?? ""}`;
  const cached = _cache.get(key);
  if (cached) return cached;

  // Enforce max pattern length to prevent ReDoS
  if (pattern.length > 200) {
    console.warn(`[RegexCache] Pattern too long (${pattern.length} chars), skipping`);
    return null;
  }

  try {
    const regex = new RegExp(pattern, flags);
    if (_cache.size >= MAX_CACHE_SIZE) {
      // Evict oldest entry
      const firstKey = _cache.keys().next().value;
      if (firstKey !== undefined) _cache.delete(firstKey);
    }
    _cache.set(key, regex);
    return regex;
  } catch {
    return null;
  }
}

/**
 * Clear the regex cache (e.g. on config change).
 */
export function clearRegexCache(): void {
  _cache.clear();
}
