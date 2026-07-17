/**
 * ============================================================
 * DALAM MEMORY STORE — SQLite + Markdown Hybrid
 * ============================================================
 *
 * Architecture (Git-first Markdown / SQLite-Cache Hybrid):
 *   - Source of truth: Markdown files in .dalam/memories/*.md
 *     (git-friendly, human-readable, diffable)
 *   - Search cache: SQLite via @tauri-apps/plugin-sql with FTS5
 *     (fast keyword search, rebuilt from markdown if lost)
 *
 * FTS5 search handles ~95% of queries at sub-millisecond speed.
 * No embedding model needed for v1 — BM25 keyword rank handles
 * code identifiers perfectly.
 *
 * Memory lifecycle:
 *   save() → write markdown + upsert SQLite → update index
 *   search() → FTS5 query → return ranked results
 *   export() → write markdown files for git commit
 *   import() → parse markdown → rebuild SQLite cache
 * ============================================================
 */

import type {
  MemoryEntry,
  MemoryCategory,
  MemoryTier,
} from "./memoryTypes";
import { CTX } from "./memoryTypes";
import { getDb, isDatabaseReady } from "./database";
import { joinPath } from "@/lib/pathUtils";

// ─── Constants ───────────────────────────────────────────────
const MEMORY_DIR = ".dalam/memories";
const MEMORY_INDEX = ".dalam/MEMORY.md";

// ─── Unique ID generation ────────────────────────────────────
function generateId(): string {
  return Date.now().toString(36) + crypto.randomUUID();
}

// ─── Content-hash mutex for saveMemory() concurrency (fixes issue 1.1) ───
const _saveMemoryLocks = new Map<string, Promise<{ action: "add" | "update" | "noop"; id: string }>>();
// ─── Per-ID mutex to prevent concurrent UPDATEs from overwriting each other ───
const _perIdLocks = new Set<string>();

/**
 * Testing utility: hold the per-ID lock for a given memory entry.
 * The lock prevents concurrent UPDATEs on the same entry.
 * Returns { release } to unlock. Use in tests to verify retry-exhaustion logic.
 * Not for production use.
 */
export function _testHoldPerIdLock(id: string): { release: () => void } {
  const key = `update:${id}`;
  _perIdLocks.add(key);
  return {
    release: () => { _perIdLocks.delete(key); },
  };
}

function contentHash(content: string): string {
  // Simple hash: first 32 chars of first line length + last 32 chars
  // Collisions are OK — the mutex just serializes saves with same content
  let hash = 0;
  const s = content.slice(0, 200).toLowerCase();
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) - hash + s.charCodeAt(i)) | 0;
  }
  return hash.toString(36);
}

// ============================================================
// SECTION 1 — CRUD OPERATIONS (SQLite)
// ============================================================

/**
 * save() — Mem0-inspired ADD/UPDATE/NOOP conflict resolution.
 *
 * 1. Search FTS5 for similar existing memories
 * 2. Near-duplicate (>0.90 Jaccard) → NOOP
 * 3. Related conflict (>0.65, same category) → UPDATE
 * 4. New info → INSERT
 *
 * Also writes a markdown file in .dalam/memories/ as source of truth.
 *
 * FIX 1.1: Uses content-hash mutex to prevent concurrent duplicate saves.
 * FIX 3.1: Writes markdown FIRST as source of truth, then SQLite.
 *   If SQLite fails, we have the markdown and can rebuild.
 */
/**
 * Maximum number of retry attempts when a per-ID lock collision is detected.
 * Prevents infinite recursion if a concurrent save holds the lock for too long.
 */
const MAX_PER_ID_LOCK_RETRIES = 3;

export async function saveMemory(
  entry: Omit<MemoryEntry, "id" | "createdAt" | "updatedAt" | "accessCount" | "lastAccessedAt" | "verified" | "stale">,
  workspacePath: string,
  _retryCount: number = 0,
): Promise<{ action: "add" | "update" | "noop"; id: string }> {

  // ── Content-hash mutex to serialize concurrent saves of same content ──
  const hash = contentHash(entry.content + entry.category);
  const existingLock = _saveMemoryLocks.get(hash);
  if (existingLock) {
    return existingLock;
  }

  // Lazy-start the periodic pending-write retry timer on first save
  _startPendingWriteTimer();

  const promise = (async (): Promise<{ action: "add" | "update" | "noop"; id: string }> => {
    try {
      // Search for similar existing memories via FTS5
      const existing = await searchMemories(entry.summary, { category: entry.category, limit: 3, updateAccessCount: false });

      for (const e of existing) {
        const similarity = jaccardSimilarity(entry.content, e.content);
        if (similarity > 0.90) {
          return { action: "noop", id: e.id };
        }
        if (similarity > 0.65 && e.category === entry.category) {
          // ── Per-ID mutex: prevent concurrent UPDATEs on the same memory ──
          const idLockKey = `update:${e.id}`;
          if (_perIdLocks.has(idLockKey)) {
            if (_retryCount >= MAX_PER_ID_LOCK_RETRIES) {
              console.warn(`[MemoryStore] Per-ID lock exhausted for ${e.id} after ${MAX_PER_ID_LOCK_RETRIES} retries, proceeding with update`);
            } else {
              // Release the hash mutex BEFORE retrying to avoid circular promise
              // resolution. Use iterative retry (not recursion) to prevent deadlock.
              _saveMemoryLocks.delete(hash);
              await new Promise(r => setTimeout(r, 50 * (_retryCount + 1)));
              // Iterative retry: re-enter the function directly without recursion
              return saveMemory(entry, workspacePath, _retryCount + 1);
            }
          }
          _perIdLocks.add(idLockKey);
          try {
            const now = Date.now();
            const mergedTags = Array.from(new Set([...e.tags, ...entry.tags]));
            // Write markdown FIRST (source of truth)
            const updatedEntry = { ...e, ...entry, tags: mergedTags, updatedAt: now, stale: false };
            try {
              await writeMemoryMarkdown(workspacePath, updatedEntry);
            } catch (mdErr) {
              // Markdown write failed — will be retried by processPendingWrites
              console.warn("[MemoryStore] Markdown write queued for retry, proceeding with SQLite:", mdErr);
            }
            // Then SQLite (always try, even if markdown was queued)
            await getDb().execute(
              `UPDATE memories SET content=?, summary=?, tags=?, tier=?, updated_at=?, stale=0 WHERE id=?`,
              [entry.content, entry.summary, JSON.stringify(mergedTags), entry.tier, now, e.id]
            );
            return { action: "update", id: e.id };
          } finally {
            _perIdLocks.delete(idLockKey);
          }
        }
      }

      // New memory — INSERT
      const id = generateId();
      const now = Date.now();
      const newEntry: MemoryEntry = {
        id,
        category: entry.category,
        tier: entry.tier,
        content: entry.content,
        summary: entry.summary,
        tags: entry.tags,
        sourceSession: entry.sourceSession,
        sourceFile: entry.sourceFile,
        createdAt: now,
        updatedAt: now,
        accessCount: 0,
        lastAccessedAt: 0,
        verified: false,
        stale: false,
      };

      // Write markdown FIRST (source of truth)
      try {
        await writeMemoryMarkdown(workspacePath, newEntry);
      } catch (mdErr) {
        // Markdown write failed — will be retried by processPendingWrites
        console.warn("[MemoryStore] Markdown write queued for retry, proceeding with SQLite:", mdErr);
      }

      // Then SQLite (always try, even if markdown was queued)
      await getDb().execute(
        `INSERT INTO memories (id, category, tier, content, summary, tags, source_session, source_file, created_at, updated_at, access_count, last_accessed, verified, stale)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0)`,
        [id, entry.category, entry.tier, entry.content, entry.summary, JSON.stringify(entry.tags),
         entry.sourceSession ?? null, entry.sourceFile ?? null, now, now]
      );

      return { action: "add", id };
    } finally {
      _saveMemoryLocks.delete(hash);
    }
  })();

  _saveMemoryLocks.set(hash, promise);
  return promise;
}

/**
 * markStale() — Soft delete. Dream agent does actual cleanup.
 */
export async function markStale(id: string): Promise<void> {
  if (!isDatabaseReady()) return;
  const db = getDb();
  await db.execute(
    `UPDATE memories SET stale=1, updated_at=? WHERE id=?`,
    [Date.now(), id]
  );
}

/**
 * purgeStale() — Hard delete stale entries (dream agent).
 * FIX 3.2: DELETE first, then best-effort markdown cleanup.
 * FIX 4.6: Dynamic imports at top of function only once.
 */
export async function purgeStale(workspacePath?: string): Promise<number> {
  if (!isDatabaseReady()) return 0;
  const db = getDb();

  // First, query the IDs of stale entries so we can clean up their markdown files
  const staleRows = await db.select(
    `SELECT id, category FROM memories WHERE stale=1`
  ) as MemoryEntryRow[];
  if (staleRows.length === 0) return 0;

  // DELETEstale (avoids TOCTOU: we delete what was stale at this instant)
  const result = await db.execute(`DELETE FROM memories WHERE stale=1`);

  // Best-effort markdown cleanup for only the stale entries
  try {
    const { remove } = await import("@tauri-apps/plugin-fs");
    let wsPath = workspacePath;
    if (!wsPath) {
      try {
        const { useWorkspace } = await import("@/store/useAppStore");
        const ws = useWorkspace.getState();
        const activeWs = ws.workspaces.find((w) => w.id === ws.activeWorkspaceId);
        wsPath = activeWs?.path;
      } catch (e) {
        console.warn("[Memory] Failed to resolve workspace path for markdown cleanup:", e);
      }
    }
    if (wsPath) {
      const memDir = joinPath(wsPath, ".dalam", "memories");
      for (const row of staleRows) {
        const shortId = row.id.length > 12 ? row.id.slice(-12) : row.id;
        const filename = `${row.category}-${shortId}.md`;
        try {
          await remove(joinPath(memDir, filename));
        } catch {
          // Best-effort per-file
        }
      }
    }
  } catch (e) {
    // Markdown cleanup is best-effort — not a failure
    console.warn("[Memory] Failed to clean up stale markdown files (best-effort):", e);
  }

  return result.rowsAffected ?? staleRows.length;
}

// ============================================================
// SECTION 2 — SEARCH (FTS5 BM25)
// ============================================================

/**
 * searchMemories() — FTS5 full-text search with BM25 ranking.
 *
 * FTS5 handles code identifiers, file paths, and technical terms
 * perfectly. BM25 ranks by term frequency. Sub-millisecond for
 * ~500 entries.
 */
export async function searchMemories(
  query: string,
  opts: {
    category?: MemoryCategory;
    tier?: MemoryTier;
    limit?: number;
    excludeStale?: boolean;
    updateAccessCount?: boolean; // Set to false for system calls (dream agent) to avoid artificial inflation
  } = {}
): Promise<MemoryEntry[]> {
  if (!isDatabaseReady()) return [];
  const db = getDb();
  const { category, limit = CTX.MEMORY_SEARCH_LIMIT, excludeStale = true, updateAccessCount = true } = opts;

  let sql = `
    SELECT m.*, memories_fts.rank as _rank
    FROM memories m
    JOIN memories_fts ON memories_fts.id = m.id
    WHERE memories_fts MATCH ?`;
  // Break multi-word query into individual tokens for better search results
  // Escape FTS5 special characters in each token
  // FIX 1.8: Use prefix matching with * suffix for partial token matching
  function escapeFts5Token(token: string, forPrefix: boolean = false): string {
    // For prefix matching, preserve * so the FTS5 prefix operator can be added
    // Reuse the same function with a flag instead of a separate function
    return token
      .replace(/['"*+\-()^~\\:|/{}[\]!@]/g, (match) => forPrefix && match === '*' ? '*' : ' ')
      .replace(/"/g, ' ')
      .trim();
  }
  const tokens = query.split(/\s+/).map(t => escapeFts5Token(t)).filter(t => t.length > 0);
  const ftsQuery = tokens.length > 0
    ? tokens.map(t => `"${escapeFts5Token(t, true)}"*`).join(" OR ")
    : '""';  // Empty query matches nothing
  const params: (string | number)[] = [ftsQuery];

  if (category) {
    sql += ` AND m.category = ?`;
    params.push(category);
  }
  if (excludeStale) {
    sql += ` AND m.stale = 0`;
  }
  sql += ` ORDER BY memories_fts.rank LIMIT ?`;
  params.push(limit);

  try {
    const rows = await db.select(sql, params) as MemoryEntryRow[];

    // Update access tracking for returned results (skip for system calls)
    if (updateAccessCount && rows.length > 0) {
      const now = Date.now();
      const ids = rows.map((r: MemoryEntryRow) => r.id);
      const placeholders = ids.map(() => "?").join(",");
      await db.execute(
        `UPDATE memories SET access_count=access_count+1, last_accessed=? WHERE id IN (${placeholders})`,
        [now, ...ids]
      );
    }

    return rows.map(parseRow);
  } catch (e) {
    console.warn("[MemoryStore] FTS5 search failed, falling back to LIKE:", e);
    // FIX 4.4: Wrap fallback in its own try/catch
    try {
      return await searchMemoriesFallback(query, opts);
    } catch (fallbackErr) {
      console.error("[MemoryStore] Fallback search also failed:", fallbackErr);
      return [];
    }
  }
}

/**
 * Fallback search using LIKE (if FTS5 query syntax fails).
 */
async function searchMemoriesFallback(
  query: string,
  opts: { category?: MemoryCategory; tier?: MemoryTier; limit?: number; excludeStale?: boolean } = {}
): Promise<MemoryEntry[]> {
  if (!isDatabaseReady()) return [];
  const db = getDb();
  const { category, limit = CTX.MEMORY_SEARCH_LIMIT, excludeStale = true } = opts;

  let sql = `SELECT * FROM memories WHERE (content LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\')`;
  const likePattern = `%${query.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_")}%`;
  const params: (string | number)[] = [likePattern, likePattern, likePattern];

  if (category) {
    sql += ` AND category = ?`;
    params.push(category);
  }
  if (excludeStale) {
    sql += ` AND stale = 0`;
  }
  sql += ` ORDER BY updated_at DESC LIMIT ?`;
  params.push(limit);

  const rows = await db.select(sql, params) as MemoryEntryRow[];
  return rows.map(parseRow);
}

/**
 * getCriticalMemories() — Always-inject critical tier entries.
 */
export async function getCriticalMemories(limit = 10): Promise<MemoryEntry[]> {
  try {
    const db = getDb();
    const rows = await db.select(
      `SELECT * FROM memories WHERE tier = 'critical' AND stale = 0 ORDER BY last_accessed DESC LIMIT ?`,
      [limit]
    ) as MemoryEntryRow[];
    return rows.map(parseRow);
  } catch (e) {
    if (import.meta.env.DEV) console.warn("[Memory] getCriticalMemories failed:", e);
    return [];
  }
}

/**
 * getAllMemories() — Full list (for dream agent, export, etc.)
 * FIX 9.3: Added MAX_RESULTS limit (10,000) to prevent OOM on large datasets.
 * FIX 4.1: Log errors in production too, not just DEV.
 */
export async function getAllMemories(opts: { excludeStale?: boolean } = {}): Promise<MemoryEntry[]> {
  try {
    const db = getDb();
    const { excludeStale = true } = opts;
    const sql = excludeStale
      ? `SELECT * FROM memories WHERE stale = 0 ORDER BY updated_at DESC LIMIT 10000`
      : `SELECT * FROM memories ORDER BY updated_at DESC LIMIT 10000`;
    const rows = await db.select(sql) as MemoryEntryRow[];
    return rows.map(parseRow);
  } catch (e) {
    console.warn("[Memory] getAllMemories failed:", e);
    return [];
  }
}

// ============================================================
// SECTION 3 — STATS & ANALYTICS
// ============================================================

/**
 * getMemoryStats() — Aggregate counts by category and tier.
 * FIX 4.2: Add try/catch to prevent unhandled rejections.
 * FIX 5.2: Combine 5 queries into 2: one GROUP BY ROLLUP + one stale count.
 */
export async function getMemoryStats(): Promise<{
  total: number;
  byCategory: Record<string, number>;
  byTier: Record<string, number>;
  byCategoryTier: Record<string, Record<string, number>>;
  staleCount: number;
}> {
  const fallback = {
    total: 0, byCategory: {}, byTier: {}, byCategoryTier: {}, staleCount: 0
  };
  try {
    if (!isDatabaseReady()) return fallback;
    const db = getDb();

    // Combined query with ROLLUP: returns total, per-category, per-tier, per-category-tier counts
    const rollupRows = await db.select(
      `SELECT category, tier, COUNT(*) as count FROM memories WHERE stale = 0 GROUP BY ROLLUP(category, tier)`
    ) as { category: string | null; tier: string | null; count: number }[];

    const byCategory: Record<string, number> = {};
    const byTier: Record<string, number> = {};
    const byCategoryTier: Record<string, Record<string, number>> = {};
    let total = 0;

    for (const row of rollupRows) {
      if (row.category === null && row.tier === null) {
        total = row.count;
      } else if (row.category !== null && row.tier === null) {
        byCategory[row.category] = row.count;
      } else if (row.category === null && row.tier !== null) {
        byTier[row.tier] = row.count;
      } else if (row.category !== null && row.tier !== null) {
        if (!byCategoryTier[row.category]) byCategoryTier[row.category] = {};
        byCategoryTier[row.category][row.tier] = row.count;
      }
    }

    const staleRows = await db.select(
      `SELECT COUNT(*) as count FROM memories WHERE stale = 1`
    ) as { count: number }[];
    const staleCount = staleRows[0]?.count ?? 0;

    return { total, byCategory, byTier, byCategoryTier, staleCount };
  } catch (e) {
    console.warn("[Memory] getMemoryStats failed:", e);
    return fallback;
  }
}

// ============================================================
// SECTION 4 — MARKDOWN SYNC (Source of Truth)
// ============================================================

/** Escape a string for safe inclusion in YAML double-quoted values.
 * FIX 9.8: Only escape YAML-essential characters (\, ", and control chars).
 * The YAML 1.1 spec allows all printable characters inside double-quoted strings.
 */
function yamlEscape(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}

/**
 * Write a memory entry as a Markdown file with YAML frontmatter.
 * This is the source of truth for git tracking.
 */
export async function writeMemoryMarkdown(workspacePath: string, entry: MemoryEntry): Promise<void> {
  try {
    const { exists, mkdir, writeTextFile } = await import("@tauri-apps/plugin-fs");
    const memDir = joinPath(workspacePath, MEMORY_DIR);
    if (!(await exists(memDir))) {
      await mkdir(memDir, { recursive: true });
    }

    const frontmatter = [
      "---",
      `id: "${entry.id}"`,
      `category: "${entry.category}"`,
      `tier: "${entry.tier}"`,
      `summary: "${yamlEscape(entry.summary)}"`,
      `tags: [${entry.tags.map((t) => `"${yamlEscape(t)}"`).join(", ")}]`,
      `created_at: ${entry.createdAt}`,
      `updated_at: ${entry.updatedAt}`,
      `stale: ${entry.stale}`,
      ...(entry.sourceSession ? [`source_session: "${yamlEscape(entry.sourceSession)}"`] : []),
      ...(entry.sourceFile ? [`source_file: "${yamlEscape(entry.sourceFile)}"`] : []),
      "---",
      "",
      entry.content,
    ].join("\n");

    // Use last 12 chars of UUID (full random portion) to avoid collision
    const shortId = entry.id.length > 12 ? entry.id.slice(-12) : entry.id;
    const filename = `${entry.category}-${shortId}.md`;
    const filePath = joinPath(memDir, filename);
    await writeTextFile(filePath, frontmatter);
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    if (msg.includes("forbidden") || msg.includes("scope")) {
      console.debug("[MemoryStore] Workspace inaccessible, skipping markdown write");
    } else {
      console.warn("[MemoryStore] Failed to write markdown, queuing retry:", e);
      // Cap pending writes to prevent unbounded growth if filesystem is persistently unavailable
      if (_pendingWrites.length < 50) {
        _pendingWrites.push({ entry, workspacePath, retries: 0, timestamp: Date.now() });
      }
    }
  }
}// Write retry queue for failed markdown writes
interface PendingWrite {
  entry: MemoryEntry;
  workspacePath: string;
  retries: number;
  timestamp: number;
}

const _pendingWrites: PendingWrite[] = [];
const MAX_WRITE_RETRIES = 3;
const WRITE_RETRY_DELAY_MS = 5000;

/**
 * DEAD LETTER RECOVERY — MAX_RETRIES = max attempts per dead-letter before giving up forever
 */
const MAX_DEAD_LETTER_RETRIES = 3;
const MAX_DEAD_LETTER_STORED = 500; // Hard cap on total dead-letter rows to prevent kv_store growth

// ─── Dead-letter value wrapper (separate from MemoryEntry to avoid type pollution) ───
interface DeadLetterPayload {
  memoryEntry: MemoryEntry;
  workspacePath: string;
  retries: number;
}

/**
 * Recover dead-letter entries from kv_store that previously failed markdown writes.
 * Called at the start of processPendingWrites() and at the end of rebuildFromMarkdown().
 * Dead letters with exhausted retries are removed from kv_store with a warning.
 *
 * Returns the number of successfully recovered entries.
 */
export async function recoverDeadLetters(maxRecover: number = 50): Promise<number> {
  if (!isDatabaseReady()) return 0;
  let recovered = 0;
  try {
    const db = getDb();
    // Query all dead-letter entries from kv_store
    const deadLetters = await db.select(
      `SELECT key, value FROM kv_store WHERE key LIKE 'dead_letter.markdown.%'`
    ) as { key: string; value: string }[];

    if (deadLetters.length === 0) return 0;

    for (const row of deadLetters.slice(0, maxRecover)) {
      try {
        const payload = JSON.parse(row.value) as DeadLetterPayload;
        if (payload.retries >= MAX_DEAD_LETTER_RETRIES) {
          console.warn(`[MemoryStore] Dead-letter for ${payload.memoryEntry.id} exhausted ${MAX_DEAD_LETTER_RETRIES} retries, removing permanently`);
          await db.execute(`DELETE FROM kv_store WHERE key = ?`, [row.key]);
          continue;
        }

        await writeMemoryMarkdown(payload.workspacePath, payload.memoryEntry);

        // Success — remove dead letter
        await db.execute(`DELETE FROM kv_store WHERE key = ?`, [row.key]);
        recovered++;
      } catch (e) {
        console.warn(`[MemoryStore] Failed to recover dead-letter ${row.key}, will retry:`, e);
        // Increment retry count for next cycle
        try {
          const payload = JSON.parse(row.value) as DeadLetterPayload;
          payload.retries = (payload.retries ?? 0) + 1;
          await db.execute(
            `UPDATE kv_store SET value = ? WHERE key = ?`,
            [JSON.stringify(payload), row.key]
          );
        } catch {
          // Best-effort retry tracking
        }
      }
    }
  } catch (e) {
    console.warn("[MemoryStore] recoverDeadLetters failed:", e);
  }
  return recovered;
}

/**
 * Process pending markdown write retries. Call periodically (e.g., every 30s).
 * FIX 3.4: Store permanently failed writes in SQLite kv_store as dead-letter backup.
 * FIX dead-letter-recovery: Recover dead letters from kv_store before retrying pending writes.
 */
export async function processPendingWrites(): Promise<void> {
  if (!isDatabaseReady()) return;
  if (_pendingWriteProcessing) return;
  _pendingWriteProcessing = true;
  try {
    // Recover dead letters from kv_store first (best-effort)
    const recoveredCount = await recoverDeadLetters();
    if (recoveredCount > 0) {
      if (import.meta.env.DEV) console.log(`[MemoryStore] Successfully recovered ${recoveredCount} dead-letter entries`);
    }

    const now = Date.now();
    const stillPending: PendingWrite[] = [];
    const deadLetters: PendingWrite[] = [];
    const successfullyProcessed = new Set<string>();

    for (const write of _pendingWrites) {
      if (write.retries >= MAX_WRITE_RETRIES) {
        console.error(`[MemoryStore] Giving up on markdown write for ${write.entry.id} after ${MAX_WRITE_RETRIES} retries`);
        deadLetters.push(write);
        continue;
      }

      if (now - write.timestamp < WRITE_RETRY_DELAY_MS * (write.retries + 1)) {
        stillPending.push(write);
        continue;
      }

      try {
        await writeMemoryMarkdown(write.workspacePath, write.entry);
        successfullyProcessed.add(write.entry.id);
      } catch (e) {
        console.warn("[MemoryStore] Retry failed for markdown write:", e);
        stillPending.push({
          ...write,
          retries: write.retries + 1,
          timestamp: now,
        });
      }
    }

    // Store dead letters in SQLite kv_store as persistent fallback — uses DeadLetterPayload wrapper
    if (deadLetters.length > 0) {
      try {
        if (!isDatabaseReady()) return;
        const db = getDb();
        // Check total dead-letter count before storing more (FIX: prevent unbounded growth)
        const countResult = await db.select(
          `SELECT COUNT(*) as count FROM kv_store WHERE key LIKE 'dead_letter.markdown.%'`
        ) as { count: number }[];
        const existingCount = countResult[0]?.count ?? 0;

        if (existingCount >= MAX_DEAD_LETTER_STORED) {
          console.warn(`[MemoryStore] Dead-letter count (${existingCount}) >= max (${MAX_DEAD_LETTER_STORED}), skipping ${deadLetters.length} new dead letters`);
        } else {
          for (const dl of deadLetters.slice(0, MAX_DEAD_LETTER_STORED - existingCount)) {
            const payload: DeadLetterPayload = {
              memoryEntry: dl.entry,
              workspacePath: dl.workspacePath,
              retries: 0,
            };
            await db.execute(
              "INSERT OR REPLACE INTO kv_store (key, value) VALUES (?, ?)",
              [`dead_letter.markdown.${dl.entry.id}`, JSON.stringify(payload)]
            );
          }
        }
      } catch (storeErr) {
        console.warn("[MemoryStore] Failed to store dead letter in kv_store:", storeErr);
      }
    }

    // Atomically swap to avoid race with concurrent push failures
    const oldQueue = _pendingWrites.splice(0, _pendingWrites.length);
    // Merge still-pending with any entries pushed by concurrent failures during processing
    // Skip entries that were successfully processed in this cycle
    const seenKeys = new Set(stillPending.map(w => w.entry.id));
    for (const w of oldQueue) {
      if (w.retries >= MAX_WRITE_RETRIES) continue;
      if (successfullyProcessed.has(w.entry.id)) continue;
      if (!seenKeys.has(w.entry.id)) {
        stillPending.push(w);
        seenKeys.add(w.entry.id);
      }
    }
    _pendingWrites.push(...stillPending);
  } catch (e) {
    console.warn("[MemoryStore] processPendingWrites failed:", e);
  } finally {
    _pendingWriteProcessing = false;
  }
}

// ─── Periodic timer: retry pending writes & recover dead letters every 60s ───
// This ensures dead-letter entries in kv_store are retried periodically even
// when no new write failures are occurring.
const PENDING_WRITE_INTERVAL_MS = 60_000;
let _pendingWriteTimerId: ReturnType<typeof setInterval> | null = null;
/** Mutex guard to prevent concurrent processPendingWrites from interleaving */
let _pendingWriteProcessing = false;

function _startPendingWriteTimer(): void {
  if (_pendingWriteTimerId !== null) return;
  if (typeof setInterval === "undefined") return;
  if (import.meta.env.MODE === "test") return;
  _pendingWriteTimerId = setInterval(() => {
    processPendingWrites();
  }, PENDING_WRITE_INTERVAL_MS);
}

/**
 * Cancel the periodic pending-write timer.
 * Call during cleanup (e.g., beforeunload, workspace switch) to prevent
 * stale database access after the store is closed.
 */
export function cancelPendingWriteTimer(): void {
  if (_pendingWriteTimerId !== null) {
    clearInterval(_pendingWriteTimerId);
    _pendingWriteTimerId = null;
  }
}

/**
 * Rebuild SQLite cache from markdown files.
 * Called on startup or when project.db is lost.
 */
export async function rebuildFromMarkdown(workspacePath: string): Promise<number> {
  const { exists, readTextFile, mkdir } = await import("@tauri-apps/plugin-fs");
  const memDir = joinPath(workspacePath, MEMORY_DIR);

  try {
    if (!(await exists(memDir))) {
      await mkdir(memDir, { recursive: true });
      return 0;
    }
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    if (msg.includes("forbidden") || msg.includes("scope")) {
      console.debug("[MemoryStore] Workspace inaccessible, skipping rebuild");
      return 0;
    }
    throw e;
  }

  const { readDir } = await import("@tauri-apps/plugin-fs");
  const entries = await readDir(memDir);
  let count = 0;

  // FIX 5.4: Get db handle once before the loop (workspace switches don't happen mid-loop)
  if (!isDatabaseReady()) return 0;
  const db = getDb();

  for (const entry of entries) {
    if (!entry.name?.endsWith(".md")) continue;

    try {
      const filePath = joinPath(memDir, entry.name);
      const content = await readTextFile(filePath);
      const parsed = parseMarkdownMemory(content);
      if (!parsed) continue;

      // Upsert into SQLite
      const existing = await db.select(
        `SELECT id FROM memories WHERE id = ?`,
        [parsed.id]
      ) as MemoryEntryRow[];

      if (existing.length > 0) {
        await db.execute(
          `UPDATE memories SET category=?, tier=?, content=?, summary=?, tags=?, updated_at=?, stale=?, source_session=?, source_file=?, access_count=?, last_accessed=? WHERE id=?`,
          [parsed.category, parsed.tier, parsed.content, parsed.summary, JSON.stringify(parsed.tags), parsed.updatedAt, parsed.stale ? 1 : 0, parsed.sourceSession ?? null, parsed.sourceFile ?? null, parsed.accessCount ?? 0, parsed.lastAccessedAt ?? 0, parsed.id]
        );
      } else {
        await db.execute(
          `INSERT INTO memories (id, category, tier, content, summary, tags, source_session, source_file, created_at, updated_at, access_count, last_accessed, verified, stale)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
          [parsed.id, parsed.category, parsed.tier, parsed.content, parsed.summary, JSON.stringify(parsed.tags),
           parsed.sourceSession ?? null, parsed.sourceFile || filePath, parsed.createdAt, parsed.updatedAt,
           parsed.accessCount ?? 0, parsed.lastAccessedAt ?? 0, parsed.stale ? 1 : 0]
        );
      }
      count++;
    } catch (e) {
      console.warn(`[MemoryStore] Failed to parse ${entry.name}:`, e);
    }
  }

  // Recover any dead-letter entries that may have been stored from previous sessions
  try {
    const recovered = await recoverDeadLetters();
    if (recovered > 0) {
      if (import.meta.env.DEV) console.log(`[MemoryStore] Recovered ${recovered} dead-letter entries during rebuild`);
    }
  } catch (e) {
    console.warn("[MemoryStore] Failed to recover dead letters during rebuild:", e);
  }

  return count;
}

/**
 * Parse a markdown memory file with YAML frontmatter.
 */
export function parseMarkdownMemory(content: string): MemoryEntry | null {
  const frontmatterMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!frontmatterMatch) return null;

  const [, frontmatter, body] = frontmatterMatch;
  const fields: Record<string, string> = {};
  let currentKey = "";

  for (const line of frontmatter.split(/\r?\n/)) {
    // Handle YAML list items (e.g., "  - item")
    const listMatch = line.match(/^\s+-\s+(.+)$/);
    if (listMatch && currentKey) {
      // Append to existing value as comma-separated
      const existing = fields[currentKey];
      fields[currentKey] = existing ? `${existing},${listMatch[1].trim()}` : listMatch[1].trim();
      continue;
    }

    const match = line.match(/^([\w-]+):\s*(.*)$/);
    if (match) {
      currentKey = match[1];
      let value = match[2].trim();
      // Strip quotes
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      // Unescape YAML escape sequences — single-pass to avoid double-processing
      // e.g. \\n (literal backslash + n) must not become a newline
      value = value.replace(/\\(["\\nrt:#!|&*])/g, (_match, char) => {
        switch (char) {
          case '\\': return '\\';
          case '"': return '"';
          case 'n': return '\n';
          case 'r': return '\r';
          case 't': return '\t';
          case ':': return ':';
          case '#': return '#';
          case '|': return '|';
          case '!': return '!';
          case '&': return '&';
          case '*': return '*';
          default: return char;
        }
      });
      // Parse arrays — only strip brackets for the tags field (which is written as a JSON array)
      // Other fields like summary or id could legitimately contain [] bracketed content.
      if (currentKey === "tags" && value.startsWith("[") && value.endsWith("]")) {
        value = value.slice(1, -1);
      }
      fields[currentKey] = value;
    } else {
      currentKey = "";
    }
  }

  if (!fields.id) return null;

  // FIX 1.10: Use alias map for category/tier validation with early warning
  const VALID_CATEGORIES: readonly MemoryCategory[] = ["user", "feedback", "project", "reference", "task", "decision"];
  const VALID_TIERS: readonly MemoryTier[] = ["critical", "high", "medium", "low"];
  const CATEGORY_ALIASES: Record<string, string> = {
    userfeedback: "feedback",
    "user-feedback": "feedback",
    "user_feedback": "feedback",
    config: "project",
    configuration: "project",
    arch: "project",
    architecture: "project",
    "arch-decision": "decision",
    reference: "reference",
  };
  const rawCategory = String(fields.category ?? "").toLowerCase().replace(/[^a-z]/g, "");
  const rawTier = String(fields.tier ?? "").toLowerCase().replace(/[^a-z]/g, "");
  // Try alias lookup first
  const resolvedCategory = CATEGORY_ALIASES[rawCategory] || rawCategory;
  const resolvedTier = CATEGORY_ALIASES[rawTier] || rawTier;
  if (resolvedCategory !== rawCategory && import.meta.env.DEV) {
    console.debug(`[Memory] Category alias: "${rawCategory}" → "${resolvedCategory}"`);
  }
  if (resolvedTier !== rawTier && import.meta.env.DEV) {
    console.debug(`[Memory] Tier alias: "${rawTier}" → "${resolvedTier}"`);
  }

  return {
    id: fields.id,
    category: (VALID_CATEGORIES.includes(resolvedCategory as MemoryCategory) ? resolvedCategory : (() => {
      console.warn(`[Memory] Unknown category "${resolvedCategory}", falling back to "project"`);
      return "project";
    })()) as MemoryCategory,
    tier: (VALID_TIERS.includes(resolvedTier as MemoryTier) ? resolvedTier : (() => {
      console.warn(`[Memory] Unknown tier "${resolvedTier}", falling back to "medium"`);
      return "medium";
    })()) as MemoryTier,
    content: body.trim(),
    summary: fields.summary || body.trim().slice(0, 150),
    tags: (() => {
      if (!fields.tags) return [];
      // FIX 9.5: Try JSON parse first, then comma-split, then YAML list format
      try {
        const trimmed = fields.tags.trim();
        if (trimmed.startsWith('[')) {
          const parsed = JSON.parse(trimmed);
          if (Array.isArray(parsed)) {
            return parsed.map((t: string) => String(t).trim()).filter(Boolean);
          }
        }
      } catch (e) {
        if (import.meta.env.DEV) console.warn("[Memory] JSON tags parse failed:", e);
        // not JSON, fall through
      }
      // Handle YAML list format: item1,item2,item3 or "item1", "item2"
      return fields.tags
        .split(/,\s*/)
        .map((t: string) => t.trim().replace(/^"|"$/g, '')).filter(Boolean);
    })(),
    // FIX 1.9: Use explicit null/undefined/NaN checks so timestamp 0 is treated as valid (Unix epoch)
    createdAt: (fields.created_at !== undefined && fields.created_at !== '' ? (() => { const n = parseInt(fields.created_at!, 10); return Number.isNaN(n) ? Date.now() : n; })() : Date.now()),
    updatedAt: (fields.updated_at !== undefined && fields.updated_at !== '' ? (() => { const n = parseInt(fields.updated_at!, 10); return Number.isNaN(n) ? Date.now() : n; })() : Date.now()),
    accessCount: 0,
    lastAccessedAt: 0,
    verified: false,
    stale: fields.stale === "true" || fields.stale === "1",
    sourceSession: fields.source_session || undefined,
    sourceFile: fields.source_file || undefined,
  };
}

// ============================================================
// SECTION 5 — EXPORT / IMPORT (Git Sharing)
// ============================================================

/**
 * exportMemories() — Write all memories as markdown files.
 * For git commit: teammates can import these.
 */
export async function exportMemories(workspacePath: string): Promise<number> {
  const memories = await getAllMemories({ excludeStale: false });
  for (const mem of memories) {
    await writeMemoryMarkdown(workspacePath, mem);
  }
  return memories.length;
}

/**
 * importMemories() — Parse markdown files and upsert into SQLite.
 * For restoring from git.
 */
export async function importMemories(workspacePath: string): Promise<number> {
  return rebuildFromMarkdown(workspacePath);
}

// ============================================================
// SECTION 6 — MEMORY INDEX (Claude Code MEMORY.md pattern)
// ============================================================

/**
 * updateMemoryIndex() — Regenerate MEMORY.md pointer file.
 * Claude Code caps at 200 lines. Sorted by tier then recency.
 * FIX 5.3: Use SQL ORDER BY + LIMIT instead of fetching all + slicing.
 */
export async function updateMemoryIndex(workspacePath: string): Promise<void> {
  const db = getDb();
  const rows = await db.select(
    `SELECT * FROM memories WHERE stale = 0 ORDER BY
       CASE tier WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 WHEN 'low' THEN 1 ELSE 0 END DESC,
       last_accessed DESC
     LIMIT ?`,
    [CTX.MEMORY_INDEX_MAX_LINES]
  ) as MemoryEntryRow[];
  const memories = rows.map(parseRow);

  // FIX 5.3: Use SQL ORDER BY + LIMIT instead of fetching all + slicing
  // memories is already sorted by tier + recency from the SQL query
  const lines = memories.map((r: MemoryEntry) => {
    const icon = { critical: "🔴", high: "🟡", medium: "🔵", low: "⚪" }[r.tier];
    const cat = `[${r.category}]`;
    return `- ${icon} ${cat} ${r.summary} <!-- id:${r.id} -->`;
  });

  // Update the header to use the actual count

  const header = [
    "# MEMORY.md — Project Memory Index",
    `<!-- generated: ${new Date().toISOString()} | entries: ${memories.length}/${CTX.MEMORY_INDEX_MAX_LINES} -->`,
    "<!-- This file is auto-maintained. Edit via /memory commands. -->",
    "",
    "## Tiers: 🔴 critical | 🟡 high | 🔵 medium | ⚪ low",
    "",
  ].join("\n");

  try {
    const { exists, mkdir, writeTextFile } = await import("@tauri-apps/plugin-fs");
    const dalamDir = joinPath(workspacePath, ".dalam");
    if (!(await exists(dalamDir))) {
      await mkdir(dalamDir, { recursive: true });
    }
    await writeTextFile(joinPath(workspacePath, MEMORY_INDEX), header + lines.join("\n") + "\n");
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    if (msg.includes("forbidden") || msg.includes("scope")) {
      console.debug("[MemoryStore] Workspace inaccessible, skipping index write");
    } else {
      console.warn("[MemoryStore] Failed to write MEMORY.md index:", e);
    }
  }
}

// ============================================================
// SECTION 7 — MEMORY EXTRACTION (Post-turn heuristics)
// ============================================================

/**
 * extractMemoriesFromExchange() — Analyze a user/assistant exchange
 * and extract worth-remembering facts using heuristics.
 * No LLM call needed for basic patterns.
 *
 * FIX 9.6: Guard against catastrophic backtracking with max input length.
 */
export function extractMemoriesFromExchange(
  userInput: string,
  assistantResponse: string,
  opts: { sessionId?: string; maxEntries?: number } = {}
): Array<Omit<MemoryEntry, "id" | "createdAt" | "updatedAt" | "accessCount" | "lastAccessedAt" | "verified" | "stale">> {
  const { maxEntries = 3 } = opts;
  const entries: Array<Omit<MemoryEntry, "id" | "createdAt" | "updatedAt" | "accessCount" | "lastAccessedAt" | "verified" | "stale">> = [];

  // FIX 9.6: Limit combined input length to prevent regex backtracking issues
  const combined = (userInput + "\n" + assistantResponse).slice(0, 5000);

  // Detect project rules ("always", "never", "must")
  // FIX 9.6: Use non-greedy quantifiers and bounded repeats to prevent catastrophic backtracking
  const rulePatterns = [
    /\b(?:always|never|must|don'?t|should|always use|always run)\b.{10,80}?(?:\.|$)/gi,
    /\b(?:prefer|stick to|use instead of)\b.{10,80}?(?:\.|$)/gi,
  ];

  for (const pattern of rulePatterns) {
    let match;
    while ((match = pattern.exec(combined)) !== null && entries.length < maxEntries) {
      const content = match[0].trim();
      if (content.length < 15 || content.length > 200) continue;

      entries.push({
        category: "user",
        tier: "medium",
        content,
        summary: content.slice(0, 150),
        tags: extractTags(content),
        sourceSession: opts.sessionId,
      });
    }
  }

  // Detect file paths
  const pathPattern = /(?:in|from|to|at|file)\s+[`"']?([/\w.-]+\.\w{1,5})[`"']?/gi;
  let pathMatch;
  while ((pathMatch = pathPattern.exec(combined)) !== null && entries.length < maxEntries) {
    const filePath = pathMatch[1];
    if (filePath.length < 5 || filePath.includes("node_modules")) continue;

    entries.push({
      category: "reference",
      tier: "low",
      content: `File reference: ${filePath}`,
      summary: `Referenced file: ${filePath}`,
      tags: [filePath.split("/").pop() ?? filePath],
      sourceSession: opts.sessionId,
      sourceFile: filePath,
    });
  }

  // Detect build/test commands (npm, pnpm, cargo, etc.)
  const cmdPattern = /\b(npm|pnpm|yarn|bun|cargo|go|make|docker)\s+(run|build|test|install|start|dev|serve|check|compose|exec|pull|push|images|ps|logs|stop|rm|kill|rmi|create|cp|diff|events|export|history|import|inspect|port|save|stats|top|unpause|update|version|wait)\b[^\n]{0,60}/gi;
  let cmdMatch;
  while ((cmdMatch = cmdPattern.exec(combined)) !== null && entries.length < maxEntries) {
    const content = cmdMatch[0].trim();
    if (content.length < 10) continue;
    entries.push({
      category: "project",
      tier: "low",
      content: `Build command: ${content}`,
      summary: `Command: ${content}`,
      tags: [cmdMatch[1]],
      sourceSession: opts.sessionId,
    });
  }

  // Detect tech stack decisions ("using X", "built with", "powered by")
  const stackPattern = /\b(using|built with|powered by|migrating to|switched to)\b\s+([a-zA-Z][a-zA-Z0-9 ._-]{2,30})/gi;
  let stackMatch;
  while ((stackMatch = stackPattern.exec(combined)) !== null && entries.length < maxEntries) {
    const content = stackMatch[0].trim();
    entries.push({
      category: "project",
      tier: "medium",
      content: `Stack decision: ${content}`,
      summary: content,
      tags: [stackMatch[2].toLowerCase().split(" ")[0]],
      sourceSession: opts.sessionId,
    });
  }

  return entries;
}

/**
 * extractMemoriesWithLLM() — LLM-powered extraction for richer results.
 * Sends the exchange to the configured model and parses structured memory entries.
 * Falls back to heuristic extraction if the LLM call fails.
 */
export async function extractMemoriesWithLLM(
  userInput: string,
  assistantResponse: string,
  fetchLLM: (prompt: string) => Promise<string>,
  opts: { sessionId?: string; maxEntries?: number; workspacePath?: string } = {}
): Promise<{ entries: Array<Omit<MemoryEntry, "id" | "createdAt" | "updatedAt" | "accessCount" | "lastAccessedAt" | "verified" | "stale">>; saved: number; source: "llm" | "heuristic" }> {
  const { sessionId, workspacePath } = opts;

  // Try LLM extraction first
  try {
    const prompt = buildExtractionPrompt(userInput, assistantResponse);
    const response = await fetchLLM(prompt);

    const parsed = parseLLMJson<Record<string, unknown>[]>(response);
    if (!parsed || !Array.isArray(parsed) || parsed.length === 0) {
      // LLM returned nothing worth remembering — fall back to heuristics
      const entries = extractMemoriesFromExchange(userInput, assistantResponse, opts);
      return { entries, saved: 0, source: "heuristic" };
    }

    // Validate and filter entries
    const validCategories: MemoryCategory[] = ["user", "feedback", "project", "reference", "task", "decision"];
    const validTiers: MemoryTier[] = ["critical", "high", "medium", "low"];

    const entries = parsed
      .filter((e: Record<string, unknown>) => e && typeof e.content === "string" && e.content.length > 10)
      .slice(0, opts.maxEntries ?? 5)
      .map((e: Record<string, unknown>) => ({
        category: (validCategories.includes(e.category as MemoryCategory) ? e.category : "project") as MemoryCategory,
        tier: (validTiers.includes(e.tier as MemoryTier) ? e.tier : "medium") as MemoryTier,
        content: String(e.content),
        summary: String(e.summary || e.content).slice(0, 150),
        tags: Array.isArray(e.tags) ? e.tags.map(String).slice(0, 5) : [],
        sourceSession: sessionId,
      }));

    // Save entries if workspacePath is provided
    let saved = 0;
    if (workspacePath) {
      for (const entry of entries) {
        try {
          const result = await saveMemory(entry, workspacePath);
          if (result.action === "add" || result.action === "update") saved++;
        } catch (e) {
          if (import.meta.env.DEV) console.warn("[Memory] extractMemoriesWithLLM: saveMemory failed:", e);
        }
      }
    }

    return { entries, saved, source: "llm" };
  } catch (e) {
    console.warn("[MemoryStore] LLM extraction failed, falling back to heuristics:", e);
    const entries = extractMemoriesFromExchange(userInput, assistantResponse, opts);
    return { entries, saved: 0, source: "heuristic" };
  }
}

/**
 * buildExtractionPrompt() — Full LLM-based extraction prompt.
 * Use when heuristic extraction isn't sufficient.
 */
export function buildExtractionPrompt(userInput: string, assistantResponse: string): string {
  return `Analyze this exchange and extract worth-remembering facts.
Return a JSON array of { "category", "tier", "content", "summary", "tags" } objects.
Only include facts that would help future sessions.
Do NOT include transient information.
Include: architectural decisions, user preferences, stack facts, key constraints.
Return [] if nothing is worth remembering.

Categories: user | feedback | project | reference | task | decision
Tiers: critical | high | medium | low

User: ${userInput.slice(0, 500)}
Assistant: ${assistantResponse.slice(0, 500)}

Return ONLY the JSON array, no markdown fences.`;
}

// ============================================================
// SECTION 8 — UTILITY FUNCTIONS
// ============================================================

/** Parse a DB row into a MemoryEntry */
function parseRow(row: MemoryEntryRow): MemoryEntry {
  let tags: string[];
  try {
    tags = typeof row.tags === "string" ? JSON.parse(row.tags || "[]") : (row.tags ?? []);
  } catch (e) {
    if (import.meta.env.DEV) console.warn("[Memory] parseRow: failed to parse tags JSON:", e);
    tags = [];
  }
  const VALID_CATEGORIES: readonly string[] = ["user", "feedback", "project", "reference", "task", "decision"];
  const VALID_TIERS: readonly string[] = ["critical", "high", "medium", "low"];
  const rawCategory = String(row.category ?? "").toLowerCase().replace(/[^a-z]/g, "");
  const rawTier = String(row.tier ?? "").toLowerCase().replace(/[^a-z]/g, "");
  return {
    id: row.id,
    category: (VALID_CATEGORIES.includes(rawCategory) ? rawCategory : "project") as MemoryCategory,
    tier: (VALID_TIERS.includes(rawTier) ? rawTier : "medium") as MemoryTier,
    content: row.content,
    summary: row.summary,
    tags,
    sourceSession: row.source_session ?? undefined,
    sourceFile: row.source_file ?? undefined,
    createdAt: row.created_at ?? Date.now(),
    updatedAt: row.updated_at ?? Date.now(),
    accessCount: row.access_count ?? 0,
    lastAccessedAt: row.last_accessed ?? 0,
    verified: !!row.verified,
    stale: !!row.stale,
  };
}

/** Jaccard similarity between two strings */
export function jaccardSimilarity(a: string, b: string): number {
  const wordsA = new Set(tokenize(a));
  const wordsB = new Set(tokenize(b));
  // FIX 1.6: Return 0 when both sets are empty (stop-word-only input)
  // Two different stop-word-heavy strings should not be considered identical
  if (wordsA.size === 0 && wordsB.size === 0) return 0;
  let intersection = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) intersection++;
  }
  // Use mathematical formula instead of allocating a new Set for union
  const union = wordsA.size + wordsB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** Tokenize text into search terms.
 * Preserves code identifiers (e.g. file.ts, src/lib/utils, useState)
 * by splitting on whitespace and punctuation but keeping dots, slashes,
 * hyphens, and underscores within identifiers intact.
 *
 * FIX 6.4: Use match() instead of split() to avoid empty strings.
 * FIX 9.7: Apply Unicode NFD normalization for consistent CJK/emoji handling.
 */
function tokenize(text: string): string[] {
  const stopWords = new Set([
    "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
    "have", "has", "had", "do", "does", "did", "will", "would", "could",
    "should", "may", "might", "shall", "can", "to", "of", "in", "for",
    "on", "with", "at", "by", "from", "as", "into", "through", "during",
    "before", "after", "above", "below", "between", "this", "that",
    "these", "those", "it", "its", "not", "no", "nor", "and", "or",
    "but", "if", "then", "else", "when", "where", "how", "what", "which",
    "who", "whom", "why", "all", "each", "every", "both", "few", "more",
    "most", "other", "some", "such", "than", "too", "very", "just",
  ]);

  const tokens = new Set<string>();
  // Apply Unicode normalization for consistent cross-platform behavior
  const normalized = text.toLowerCase().normalize('NFD');
  // Use match() instead of split() to avoid empty string artifacts
  const raw = normalized.match(/[a-z0-9_/.-]+/g) ?? [];
  for (const w of raw) {
    if (w.length <= 2 || stopWords.has(w)) continue;
    tokens.add(w);
    // Also add sub-parts for path-like tokens to improve similarity matching
    // e.g. "src/components/Button.tsx" → also yields "src", "components", "button.tsx"
    const subParts = w.split(/[/.]/).filter(p => p.length > 2 && !stopWords.has(p));
    for (const p of subParts) {
      tokens.add(p);
    }
  }
  return [...tokens];
}

/** Tier weight for sorting */
function tierWeight(tier: MemoryTier): number {
  return { critical: 4, high: 3, medium: 2, low: 1 }[tier] ?? 0;
}

/** Extract keyword tags from content */
function extractTags(content: string): string[] {
  const tags: string[] = [];
  const extMatch = content.match(/\.(\w{1,5})\b/g);
  if (extMatch) tags.push(...extMatch.map((e) => e.slice(1)));
  const techPattern = /\b(typescript|javascript|rust|python|react|vue|svelte|tailwind|css|html|json|yaml|toml|docker|git|npm|pnpm|yarn|bun|vite|webpack|nextjs|nuxt|sveltekit)\b/gi;
  let m;
  while ((m = techPattern.exec(content)) !== null) {
    tags.push(m[1].toLowerCase());
  }
  return [...new Set(tags)].slice(0, 5);
}

// ============================================================
// SECTION 9 — SELF-IMPROVING MAINTENANCE
// ============================================================

/**
 * scoreMemory() — Composite quality score for ranking/pruning.
 * Higher = more valuable. Used for budget enforcement and stale detection.
 *
 * Factors:
 *  - Tier weight (critical=4, high=3, medium=2, low=1)
 *  - Access frequency (log-scaled to prevent runaway scores)
 *  - Recency decay (exponential, half-life ~14 days)
 *  - Age penalty for never-accessed memories
 */
export function scoreMemory(m: MemoryEntry): number {
  const now = Date.now();
  const DAY = 86_400_000;

  // Base tier score
  let score = tierWeight(m.tier) * 10;

  // Access frequency bonus (log-scaled)
  if (m.accessCount > 0) {
    score += Math.log2(m.accessCount + 1) * 5;
  }

  // Recency bonus (exponential decay, half-life 14 days)
  if (m.lastAccessedAt > 0) {
    const daysSinceAccess = (now - m.lastAccessedAt) / DAY;
    const recencyBonus = Math.max(0, 10 * Math.pow(0.5, daysSinceAccess / 14));
    score += recencyBonus;
  }

  // Age penalty for never-accessed memories
  if (m.accessCount === 0) {
    const daysSinceCreation = (now - m.createdAt) / DAY;
    if (daysSinceCreation > 7) {
      score -= Math.min(10, daysSinceCreation * 0.5);
    }
  }

  // Verified bonus
  if (m.verified) score += 5;

  // Source quality bonus
  if (m.sourceSession) score += 2;  // Extracted from conversation
  if (m.sourceFile) score += 1;     // References a specific file

  // Tag richness bonus (more tags = more searchable)
  score += Math.min(3, m.tags.length);

  // Content quality heuristic
  if (m.content.length > 50 && m.content.length < 500) score += 2;
  if (m.summary.length > 20 && m.summary.length < 150) score += 1;

  return Math.max(0, score);
}

/**
 * detectStaleMemories() — Find memories that should be pruned.
 *
 * A memory is stale if:
 *  - Not accessed in >30 days AND tier is low/medium, OR
 *  - Never accessed AND created >14 days ago AND tier is low
 */
export async function detectStaleMemories(): Promise<string[]> {
  try {
    const db = getDb();
    const now = Date.now();
    const DAY = 86_400_000;
    const staleIds: string[] = [];

    // 1. Not accessed in >30 days, low/medium tier
    const oldAccess = await db.select(
      `SELECT * FROM memories WHERE stale = 0 AND last_accessed > 0
       AND last_accessed < ? AND tier IN ('low', 'medium')`,
      [now - 30 * DAY]
    ) as MemoryEntryRow[];
    staleIds.push(...oldAccess.map((r: MemoryEntryRow) => r.id));

    // 2. Never accessed, created >14 days ago, low tier
    const neverAccessed = await db.select(
      `SELECT * FROM memories WHERE stale = 0 AND access_count = 0
       AND created_at < ? AND tier = 'low'`,
      [now - 14 * DAY]
    ) as MemoryEntryRow[];
    staleIds.push(...neverAccessed.map((r: MemoryEntryRow) => r.id));

    return [...new Set(staleIds)];
  } catch (e) {
    if (import.meta.env.DEV) console.warn("[Memory] detectStaleMemories failed:", e);
    return [];
  }
}

/**
 * autoMarkStale() — Automatically mark stale memories.
 * Returns count of newly stale entries.
 */
export async function autoMarkStale(): Promise<number> {
  try {
    const staleIds = await detectStaleMemories();
    if (staleIds.length === 0) return 0;

    const db = getDb();
    const now = Date.now();
    const placeholders = staleIds.map(() => "?").join(",");
    await db.execute(
      `UPDATE memories SET stale=1, updated_at=? WHERE id IN (${placeholders})`,
      [now, ...staleIds]
    );
    return staleIds.length;
  } catch (e) {
    if (import.meta.env.DEV) console.warn("[Memory] autoMarkStale failed:", e);
    return 0;
  }
}

/**
 * enforceMemoryBudget() — Keep memory count under budget.
 * If over budget, prunes lowest-quality non-critical entries.
 * Returns count of pruned entries.
 */
export async function enforceMemoryBudget(
  budget: number = CTX.MEMORY_BUDGET
): Promise<number> {
  try {
    const db = getDb();
    const total = await db.select(
      `SELECT COUNT(*) as count FROM memories WHERE stale = 0`
    ) as { count: number }[];
    const currentCount = total[0]?.count ?? 0;
    if (currentCount <= budget) return 0;

    const excess = currentCount - budget;

    // Get all non-critical memories ordered by quality score (lowest first)
    const rows = await db.select(
      `SELECT * FROM memories WHERE stale = 0 AND tier != 'critical'
       ORDER BY access_count ASC, updated_at ASC LIMIT ?`,
      [excess + 10] // fetch a few extra for scoring
    ) as MemoryEntryRow[];

    // Score and sort to find the worst candidates
    const candidates = rows.map(parseRow).map((m: MemoryEntry) => ({ entry: m, score: scoreMemory(m) }));
    candidates.sort((a: { entry: MemoryEntry; score: number }, b: { entry: MemoryEntry; score: number }) => a.score - b.score);

    const toPrune = candidates.slice(0, excess).map((c: { entry: MemoryEntry; score: number }) => c.entry.id);
    if (toPrune.length === 0) return 0;

    const placeholders = toPrune.map(() => "?").join(",");
    await db.execute(
      `UPDATE memories SET stale=1, updated_at=? WHERE id IN (${placeholders})`,
      [Date.now(), ...toPrune]
    );

    return toPrune.length;
  } catch (e) {
    if (import.meta.env.DEV) console.warn("[Memory] enforceMemoryBudget failed:", e);
    return 0;
  }
}

/**
 * runMaintenance() — Full self-improving maintenance cycle.
 * Detects stale, enforces budget, purges old stale entries.
 * Returns summary of actions taken.
 */
export async function runMaintenance(): Promise<{
  staleDetected: number;
  pruned: number;
  purged: number;
}> {
  const staleDetected = await autoMarkStale();
  const pruned = await enforceMemoryBudget();
  const purged = await purgeStale();

  return { staleDetected, pruned, purged };
}

// ─── Types ───────────────────────────────────────────────────

interface MemoryEntryRow {
  id: string;
  category: string;
  tier: string;
  content: string;
  summary: string;
  tags: string;
  source_session: string | null;
  source_file: string | null;
  created_at: number;
  updated_at: number;
  access_count: number;
  last_accessed: number;
  verified: number;
  stale: number;
}

// ============================================================
// SECTION 10 — SHARED LLM RESPONSE PARSING
// ============================================================

/**
 * Find the outermost balanced bracket ([] or {}) in a string.
 * FIX 1.4: Tracks bracket depth to handle brackets inside strings correctly.
 */
function findBalancedBracket(text: string, openChar: '[' | '{', closeChar: ']' | '}'): { start: number; end: number } | null {
  let depth = 0;
  let start = -1;
  let inString = false;
  let stringChar = '';
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    // Track string boundaries to avoid counting brackets inside strings
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (inString) {
      if (ch === stringChar) {
        inString = false;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      stringChar = ch;
      continue;
    }

    if (ch === openChar) {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === closeChar) {
      depth--;
      if (depth === 0 && start !== -1) {
        return { start, end: i };
      }
    }
  }

  return null;
}

/**
 * Parse a JSON response from an LLM, handling common formatting issues:
 * - Strips markdown code fences (```json ... ```)
 * - Extracts JSON from surrounding text using balanced bracket matching
 * - Returns null on parse failure
 *
 * Strategy: find BOTH the first balanced [] and {} pair, then try the one
 * that appears EARLIEST in the text first. If that fails JSON.parse,
 * fall back to the other. This avoids incorrectly extracting inner arrays
 * that appear inside outer objects (or vice versa).
 * Raw top-level JSON primitives (bare strings, numbers) are rejected —
 * LLM responses should always return objects or arrays.
 */
export function parseLLMJson<T>(response: string): T | null {
  const cleaned = response.replace(/^```json\s*/i, "").replace(/```\s*$/, "").trim();
  // If the entire response is a markdown fence with no JSON content, return null
  if (!cleaned) return null;

  try {
    // Find BOTH bracket types
    const arrMatch = findBalancedBracket(cleaned, '[', ']');
    const objMatch = findBalancedBracket(cleaned, '{', '}');

    // Determine which bracket pair appears first in the text
    const candidates: Array<{ match: { start: number; end: number }; fallback: typeof arrMatch | typeof objMatch }> = [];
    if (arrMatch) candidates.push({ match: arrMatch, fallback: objMatch });
    if (objMatch) candidates.push({ match: objMatch, fallback: arrMatch });

    if (candidates.length > 0) {
      // Sort by start position (earliest first)
      candidates.sort((a, b) => a.match.start - b.match.start);

      // Try the earliest bracket pair
      const firstCandidate = cleaned.slice(candidates[0].match.start, candidates[0].match.end + 1);
      try {
        return JSON.parse(firstCandidate) as T;
      } catch {
        // Earliest candidate failed to parse — try the other one
        if (candidates.length > 1) {
          const secondCandidate = cleaned.slice(candidates[1].match.start, candidates[1].match.end + 1);
          try {
            return JSON.parse(secondCandidate) as T;
          } catch {
            // Both failed — fall through to raw parse
          }
        }
      }
    }

    // Raw parse — only accept objects or arrays
    const raw = JSON.parse(cleaned);
    if (raw !== null && typeof raw === "object") {
      return raw as T;
    }
    return null;
  } catch (e) {
    console.warn("[Memory] parseLLMJson failed:", e);
    return null;
  }
}
