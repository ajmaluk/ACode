/**
 * MCP Tool Cache — Caches MCP server tool lists to avoid re-fetching.
 *
 * Tools are cached with a TTL (time-to-live) to balance freshness vs performance.
 * Cache is invalidated when:
 * - TTL expires (default: 1 hour)
 * - Server is disconnected
 * - Manual cache clear
 */

interface CacheEntry {
  tools: { name: string; description: string; inputSchema?: Record<string, unknown> }[];
  timestamp: number;
  serverUrl?: string;
  ttlMs: number;
}

const CACHE_KEY_PREFIX = "dalam.mcp.cache.";
const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1 hour

// In-memory cache (faster than localStorage for repeated access)
const memoryCache = new Map<string, CacheEntry>();

/**
 * Get cached tools for an MCP server.
 * Returns null if cache miss or expired.
 */
export function getCachedTools(serverName: string): CacheEntry | null {
  // Check memory cache first
  const memEntry = memoryCache.get(serverName);
  if (memEntry && !isExpired(memEntry)) {
    return memEntry;
  }

  // Check localStorage fallback
  try {
    const key = CACHE_KEY_PREFIX + serverName;
    const raw = localStorage.getItem(key);
    if (raw) {
      const entry: CacheEntry = JSON.parse(raw);
      if (!isExpired(entry)) {
        // Populate memory cache
        memoryCache.set(serverName, entry);
        return entry;
      }
      // Expired — clean up
      localStorage.removeItem(key);
    }
  } catch {
    // Ignore parse errors
  }

  return null;
}

/**
 * Cache tools for an MCP server.
 */
export function cacheTools(
  serverName: string,
  tools: { name: string; description: string; inputSchema?: Record<string, unknown> }[],
  serverUrl?: string,
  ttlMs: number = DEFAULT_TTL_MS
): void {
  const entry: CacheEntry = {
    tools,
    timestamp: Date.now(),
    serverUrl,
    ttlMs,
  };

  // Store in memory
  memoryCache.set(serverName, entry);

  // Store in localStorage for persistence across page reloads
  try {
    const key = CACHE_KEY_PREFIX + serverName;
    localStorage.setItem(key, JSON.stringify(entry));
  } catch {
    // localStorage full or unavailable — memory cache is sufficient
  }
}

/**
 * Invalidate cache for a specific server.
 */
export function invalidateCache(serverName: string): void {
  memoryCache.delete(serverName);
  try {
    localStorage.removeItem(CACHE_KEY_PREFIX + serverName);
  } catch {
    // Ignore
  }
}

/**
 * Clear all MCP caches.
 */
export function clearAllCaches(): void {
  memoryCache.clear();
  try {
    const keys = Object.keys(localStorage).filter(k => k.startsWith(CACHE_KEY_PREFIX));
    for (const key of keys) {
      localStorage.removeItem(key);
    }
  } catch {
    // Ignore
  }
}

/**
 * Check if a cache entry is expired.
 */
function isExpired(entry: CacheEntry): boolean {
  const ttl = entry.ttlMs ?? DEFAULT_TTL_MS;
  return Date.now() - entry.timestamp > ttl;
}

/**
 * Get cache statistics for debugging.
 */
export function getCacheStats(): {
  memoryEntries: number;
  localStorageEntries: number;
  totalToolsCached: number;
} {
  let localStorageEntries = 0;
  let totalToolsCached = 0;

  try {
    const keys = Object.keys(localStorage).filter(k => k.startsWith(CACHE_KEY_PREFIX));
    localStorageEntries = keys.length;
    for (const key of keys) {
      const entry: CacheEntry = JSON.parse(localStorage.getItem(key) || "{}");
      totalToolsCached += entry.tools?.length || 0;
    }
  } catch {
    // Ignore
  }

  return {
    memoryEntries: memoryCache.size,
    localStorageEntries,
    totalToolsCached,
  };
}
