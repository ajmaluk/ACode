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
import { getDb } from "./database";
import { joinPath } from "@/lib/pathUtils";

// ─── Constants ───────────────────────────────────────────────
const MEMORY_DIR = ".dalam/memories";
const MEMORY_INDEX = ".dalam/MEMORY.md";

// ─── Unique ID generation ────────────────────────────────────
function generateId(): string {
  return Date.now().toString(36) + crypto.randomUUID();
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
 */
export async function saveMemory(
  entry: Omit<MemoryEntry, "id" | "createdAt" | "updatedAt" | "accessCount" | "lastAccessedAt" | "verified" | "stale">,
  workspacePath: string
): Promise<{ action: "add" | "update" | "noop"; id: string }> {
  const db = getDb();

  // Search for similar existing memories via FTS5
  const existing = await searchMemories(entry.summary, { category: entry.category, limit: 3, updateAccessCount: false });

  for (const e of existing) {
    const similarity = jaccardSimilarity(entry.content, e.content);
    if (similarity > 0.90) {
      return { action: "noop", id: e.id };
    }
    if (similarity > 0.65 && e.category === entry.category) {
      // Update existing — newer truth wins
      const now = Date.now();
      const mergedTags = Array.from(new Set([...e.tags, ...entry.tags]));
      await db.execute(
        `UPDATE memories SET content=?, summary=?, tags=?, tier=?, updated_at=?, stale=0 WHERE id=?`,
        [entry.content, entry.summary, JSON.stringify(mergedTags), entry.tier, now, e.id]
      );
      // Update markdown file
      await writeMemoryMarkdown(workspacePath, { ...e, ...entry, tags: mergedTags, updatedAt: now, stale: false });
      return { action: "update", id: e.id };
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

  await db.execute(
    `INSERT INTO memories (id, category, tier, content, summary, tags, source_session, source_file, created_at, updated_at, access_count, last_accessed, verified, stale)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0)`,
    [id, entry.category, entry.tier, entry.content, entry.summary, JSON.stringify(entry.tags),
     entry.sourceSession ?? null, entry.sourceFile ?? null, now, now]
  );

  // Write markdown file as source of truth
  await writeMemoryMarkdown(workspacePath, newEntry);

  return { action: "add", id };
}

/**
 * markStale() — Soft delete. Dream agent does actual cleanup.
 */
export async function markStale(id: string): Promise<void> {
  const db = getDb();
  await db.execute(
    `UPDATE memories SET stale=1, updated_at=? WHERE id=?`,
    [Date.now(), id]
  );
}

/**
 * purgeStale() — Hard delete stale entries (dream agent).
 */
export async function purgeStale(workspacePath?: string): Promise<number> {
  const db = getDb();
  // First, get the IDs and categories of stale entries for markdown cleanup
  const staleEntries = await db.select(
    `SELECT id, category FROM memories WHERE stale=1`
  ) as { id: string; category: string }[];
  // Delete corresponding markdown files (best-effort)
  if (staleEntries.length > 0) {
    try {
      const { remove, exists: fsExists } = await import("@tauri-apps/plugin-fs");
      // Use provided workspacePath or fall back to active workspace
      let wsPath = workspacePath;
      if (!wsPath) {
        try {
          const { useWorkspace } = await import("@/store/useAppStore");
          const ws = useWorkspace.getState();
          const activeWs = ws.workspaces.find((w) => w.id === ws.activeWorkspaceId);
          wsPath = activeWs?.path;
        } catch (e) {
          if (import.meta.env.DEV) console.warn("[Memory] import(\"@/store/useAppStore\");:", e);
          // Store not available (e.g. during module-level cleanup) — skip markdown cleanup
        }
      }
      if (wsPath) {
        const memDir = joinPath(wsPath, ".dalam", "memories");
        for (const entry of staleEntries) {
          // Try current category first, then scan for any file with this ID suffix
          // (category may have changed since the file was written)
          const idSuffix = entry.id.slice(-12);
          const mdFile = joinPath(memDir, `${entry.category}-${idSuffix}.md`);
          if (await fsExists(mdFile)) {
            await remove(mdFile).catch(() => {});
          } else {
            // Scan for files with matching ID suffix (in case category changed)
            try {
              const { readDir } = await import("@tauri-apps/plugin-fs");
              const files = await readDir(memDir).catch(() => []);
              for (const f of files) {
                if (f.name && f.name.endsWith(`-${idSuffix}.md`)) {
                  await remove(joinPath(memDir, f.name)).catch(() => {});
                  break;
                }
              }
            } catch (e) {
              if (import.meta.env.DEV) console.warn("[Memory] import(\"@tauri-apps/plugin-fs\");:", e);
            }
          }
        }
      }
    } catch (e) {
      if (import.meta.env.DEV) console.warn("[Memory] import(\"@tauri-apps/plugin-fs\");:", e);
      // Markdown cleanup is best-effort
    }
  }
  const result = await db.execute(`DELETE FROM memories WHERE stale=1`);
  return result.rowsAffected;
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
  const db = getDb();
  const { category, limit = CTX.MEMORY_SEARCH_LIMIT, excludeStale = true, updateAccessCount = true } = opts;

  let sql = `
    SELECT m.*, memories_fts.rank as _rank
    FROM memories m
    JOIN memories_fts ON memories_fts.id = m.id
    WHERE memories_fts MATCH ?`;
  // Break multi-word query into individual tokens for better search results
  // Escape FTS5 special characters in each token
  function escapeFts5Token(token: string): string {
    return token
      .replace(/['"*+\-()^~\\:|/{}[\]!@]/g, ' ')  // Strip FTS5 special chars
      .replace(/"/g, ' ')                          // Strip double quotes
      .trim();
  }
  const tokens = query.split(/\s+/).map(escapeFts5Token).filter(t => t.length > 0);
  const ftsQuery = tokens.length > 0
    ? tokens.map(t => `"${t}"`).join(" OR ")
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
    return searchMemoriesFallback(query, opts);
  }
}

/**
 * Fallback search using LIKE (if FTS5 query syntax fails).
 */
async function searchMemoriesFallback(
  query: string,
  opts: { category?: MemoryCategory; tier?: MemoryTier; limit?: number; excludeStale?: boolean } = {}
): Promise<MemoryEntry[]> {
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
    if (import.meta.env.DEV) console.warn("[Memory] const db = getDb();:", e);
    return [];
  }
}

/**
 * getAllMemories() — Full list (for dream agent, export, etc.)
 */
export async function getAllMemories(opts: { excludeStale?: boolean } = {}): Promise<MemoryEntry[]> {
  try {
    const db = getDb();
    const { excludeStale = true } = opts;
    const sql = excludeStale
      ? `SELECT * FROM memories WHERE stale = 0 ORDER BY updated_at DESC`
      : `SELECT * FROM memories ORDER BY updated_at DESC`;
    const rows = await db.select(sql) as MemoryEntryRow[];
    return rows.map(parseRow);
  } catch (e) {
    if (import.meta.env.DEV) console.warn("[Memory] const db = getDb();:", e);
    return [];
  }
}

// ============================================================
// SECTION 3 — STATS & ANALYTICS
// ============================================================

/**
 * getMemoryStats() — Aggregate counts by category and tier.
 */
export async function getMemoryStats(): Promise<{
  total: number;
  byCategory: Record<string, number>;
  byTier: Record<string, number>;
  byCategoryTier: Record<string, Record<string, number>>;
  staleCount: number;
}> {
  const db = getDb();

  const totalRows = await db.select(
    `SELECT COUNT(*) as count FROM memories WHERE stale = 0`
  ) as { count: number }[];
  const total = totalRows[0]?.count ?? 0;

  const catRows = await db.select(
    `SELECT category, COUNT(*) as count FROM memories WHERE stale = 0 GROUP BY category`
  ) as { category: string; count: number }[];
  const byCategory: Record<string, number> = {};
  for (const row of catRows) byCategory[row.category] = row.count;

  const tierRows = await db.select(
    `SELECT tier, COUNT(*) as count FROM memories WHERE stale = 0 GROUP BY tier`
  ) as { tier: string; count: number }[];
  const byTier: Record<string, number> = {};
  for (const row of tierRows) byTier[row.tier] = row.count;

  // Per-category tier breakdown
  const catTierRows = await db.select(
    `SELECT category, tier, COUNT(*) as count FROM memories WHERE stale = 0 GROUP BY category, tier`
  ) as { category: string; tier: string; count: number }[];
  const byCategoryTier: Record<string, Record<string, number>> = {};
  for (const row of catTierRows) {
    if (!byCategoryTier[row.category]) byCategoryTier[row.category] = {};
    byCategoryTier[row.category][row.tier] = row.count;
  }

  const staleRows = await db.select(
    `SELECT COUNT(*) as count FROM memories WHERE stale = 1`
  ) as { count: number }[];
  const staleCount = staleRows[0]?.count ?? 0;

  return { total, byCategory, byTier, byCategoryTier, staleCount };
}

// ============================================================
// SECTION 4 — MARKDOWN SYNC (Source of Truth)
// ============================================================

/** Escape a string for safe inclusion in YAML double-quoted values. */
function yamlEscape(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")
    .replace(/:/g, "\\:")
    .replace(/#/g, "\\#")
    .replace(/\|/g, "\\|")
    .replace(/!/g, "\\!")
    .replace(/&/g, "\\&")
    .replace(/\*/g, "\\*");
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
}

// Write retry queue for failed markdown writes
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
 * Process pending markdown write retries. Call periodically (e.g., every 30s).
 */
export async function processPendingWrites(): Promise<void> {
  const now = Date.now();
  const stillPending: PendingWrite[] = [];

  for (const write of _pendingWrites) {
    if (write.retries >= MAX_WRITE_RETRIES) {
      console.error(`[MemoryStore] Giving up on markdown write for ${write.entry.id} after ${MAX_WRITE_RETRIES} retries`);
      continue;
    }

    if (now - write.timestamp < WRITE_RETRY_DELAY_MS * (write.retries + 1)) {
      stillPending.push(write);
      continue;
    }

    try {
      await writeMemoryMarkdown(write.workspacePath, write.entry);
    } catch (e) {
      if (import.meta.env.DEV) console.warn("[Memory] writeMemoryMarkdown(write.workspacePath, write.ent:", e);
      stillPending.push({
        ...write,
        retries: write.retries + 1,
        timestamp: now,
      });
    }
  }

  // Atomically swap to avoid race with concurrent push failures
  const oldQueue = _pendingWrites.splice(0, _pendingWrites.length);
  // Merge still-pending with any entries pushed by concurrent failures during processing
  const seenKeys = new Set(stillPending.map(w => w.entry.id));
  for (const w of oldQueue) {
    if (!seenKeys.has(w.entry.id)) {
      stillPending.push(w);
      seenKeys.add(w.entry.id);
    }
  }
  _pendingWrites.push(...stillPending);
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

  for (const entry of entries) {
    if (!entry.name?.endsWith(".md")) continue;

    try {
      const filePath = joinPath(memDir, entry.name);
      const content = await readTextFile(filePath);
      const parsed = parseMarkdownMemory(content);
      if (!parsed) continue;

      // Upsert into SQLite (re-acquire db handle each iteration to avoid stale ref on workspace switch)
      const db = getDb();
      const existing = await db.select(
        `SELECT id FROM memories WHERE id = ?`,
        [parsed.id]
      ) as MemoryEntryRow[];

      if (existing.length > 0) {
        await db.execute(
          `UPDATE memories SET category=?, tier=?, content=?, summary=?, tags=?, updated_at=?, stale=?, source_session=?, source_file=? WHERE id=?`,
          [parsed.category, parsed.tier, parsed.content, parsed.summary, JSON.stringify(parsed.tags), parsed.updatedAt, parsed.stale ? 1 : 0, parsed.sourceSession ?? null, parsed.sourceFile ?? null, parsed.id]
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

    const match = line.match(/^(\w+):\s*(.*)$/);
    if (match) {
      currentKey = match[1];
      let value = match[2].trim();
      // Strip quotes
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      // Unescape YAML escape sequences (order matters: \\ before \")
      value = value
        .replace(/\\\\/g, '\\')
        .replace(/\\"/g, '"')
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '\r')
        .replace(/\\t/g, '\t')
        .replace(/\\:/g, ':')
        .replace(/\\#/g, '#')
        .replace(/\\\|/g, '|')
        .replace(/\\!/g, '!')
        .replace(/\\&/g, '&')
        .replace(/\\\*/g, '*');
      // Parse arrays
      if (value.startsWith("[") && value.endsWith("]")) {
        value = value.slice(1, -1);
      }
      fields[currentKey] = value;
    } else {
      currentKey = "";
    }
  }

  if (!fields.id) return null;

  const VALID_CATEGORIES: readonly MemoryCategory[] = ["user", "feedback", "project", "reference", "task", "decision"];
  const VALID_TIERS: readonly MemoryTier[] = ["critical", "high", "medium", "low"];
  const rawCategory = String(fields.category ?? "").toLowerCase().replace(/[^a-z]/g, "");
  const rawTier = String(fields.tier ?? "").toLowerCase().replace(/[^a-z]/g, "");

  return {
    id: fields.id,
    category: (VALID_CATEGORIES.includes(rawCategory as MemoryCategory) ? rawCategory : "project") as MemoryCategory,
    tier: (VALID_TIERS.includes(rawTier as MemoryTier) ? rawTier : "medium") as MemoryTier,
    content: body.trim(),
    summary: fields.summary || body.trim().slice(0, 150),
    tags: (() => {
      if (!fields.tags) return [];
      try {
        const parsed = JSON.parse(fields.tags);
        if (Array.isArray(parsed)) {
          return parsed.map((t: string) => String(t).trim()).filter(Boolean);
        }
      } catch (e) {
        if (import.meta.env.DEV) console.warn("[Memory] JSON parse:", e);
        // not JSON, fall through to comma split
      }
      return fields.tags.split(/,\s*/).map((t: string) => t.trim().replace(/^"|"$/g, "")).filter(Boolean);
    })(),
    createdAt: (fields.created_at ? (parseInt(fields.created_at, 10) || Date.now()) : Date.now()),
    updatedAt: (fields.updated_at ? (parseInt(fields.updated_at, 10) || Date.now()) : Date.now()),
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
 */
export async function updateMemoryIndex(workspacePath: string): Promise<void> {
  const memories = await getAllMemories();
  const sorted = memories
    .sort((a, b) => {
      const tierDiff = tierWeight(a.tier) - tierWeight(b.tier);
      if (tierDiff !== 0) return tierDiff;
      return b.lastAccessedAt - a.lastAccessedAt;
    })
    .slice(0, CTX.MEMORY_INDEX_MAX_LINES);

  const lines = sorted.map((r) => {
    const icon = { critical: "🔴", high: "🟡", medium: "🔵", low: "⚪" }[r.tier];
    const cat = `[${r.category}]`;
    return `- ${icon} ${cat} ${r.summary} <!-- id:${r.id} -->`;
  });

  const header = [
    "# MEMORY.md — Project Memory Index",
    `<!-- generated: ${new Date().toISOString()} | entries: ${sorted.length}/${CTX.MEMORY_INDEX_MAX_LINES} -->`,
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
 */
export function extractMemoriesFromExchange(
  userInput: string,
  assistantResponse: string,
  opts: { sessionId?: string; maxEntries?: number } = {}
): Array<Omit<MemoryEntry, "id" | "createdAt" | "updatedAt" | "accessCount" | "lastAccessedAt" | "verified" | "stale">> {
  const { maxEntries = 3 } = opts;
  const entries: Array<Omit<MemoryEntry, "id" | "createdAt" | "updatedAt" | "accessCount" | "lastAccessedAt" | "verified" | "stale">> = [];
  const combined = userInput + "\n" + assistantResponse;

  // Detect project rules ("always", "never", "must")
  const rulePatterns = [
    /\b(always|never|must|don'?t|should|always use|always run)\b[^.]{10,80}/gi,
    /\b(prefer|stick to|use instead of)\b[^.]{10,80}/gi,
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
          if (import.meta.env.DEV) console.warn("[Memory] saveMemory(entry, workspacePath);:", e);
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
    if (import.meta.env.DEV) console.warn("[Memory] JSON parse:", e);
    tags = [];
  }
  return {
    id: row.id,
    category: row.category as MemoryCategory,
    tier: row.tier as MemoryTier,
    content: row.content,
    summary: row.summary,
    tags,
    sourceSession: row.source_session ?? undefined,
    sourceFile: row.source_file ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
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
  if (wordsA.size === 0 && wordsB.size === 0) return 1;
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
 * hyphens, and underscores within identifiers intact. */
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
  // Split on whitespace and common separators, but preserve code-like tokens
  // e.g. "file.ts", "src/lib/utils", "useState", "npm-run" stay intact
  const raw = text.toLowerCase().split(/[^a-z0-9_/.-]+/).filter(Boolean);
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
    if (import.meta.env.DEV) console.warn("[Memory] const db = getDb();:", e);
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
    if (import.meta.env.DEV) console.warn("[Memory] detectStaleMemories();:", e);
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
    if (import.meta.env.DEV) console.warn("[Memory] operation:", e);
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
 * Parse a JSON response from an LLM, handling common formatting issues:
 * - Strips markdown code fences (```json ... ```)
 * - Extracts JSON from surrounding text
 * - Returns null on parse failure
 */
export function parseLLMJson<T>(response: string): T | null {
  try {
    const cleaned = response.replace(/^```json\s*/i, "").replace(/```\s*$/, "").trim();
    // Try to extract JSON array
    const arrStart = cleaned.indexOf("[");
    const arrEnd = cleaned.lastIndexOf("]");
    if (arrStart !== -1 && arrEnd !== -1 && arrEnd > arrStart) {
      return JSON.parse(cleaned.slice(arrStart, arrEnd + 1)) as T;
    }
    // Try to extract JSON object
    const objStart = cleaned.indexOf("{");
    const objEnd = cleaned.lastIndexOf("}");
    if (objStart !== -1 && objEnd !== -1 && objEnd > objStart) {
      return JSON.parse(cleaned.slice(objStart, objEnd + 1)) as T;
    }
    // Try raw parse
    return JSON.parse(cleaned) as T;
  } catch (e) {
    if (import.meta.env.DEV) console.warn("[Memory] const cleaned = response.replace(/^```json\\s*/i, \":", e);
    return null;
  }
}
