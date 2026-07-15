/**
 * ============================================================
 * MEMORY STORE INTEGRATION TESTS — Real SQLite + FTS5
 * ============================================================
 *
 * These tests create a genuine in-memory SQLite database via
 * better-sqlite3, set up the full memory schema (tables, FTS5
 * virtual tables, triggers, indexes), wrap it in the project's
 * SqlDatabase interface, and then test saveMemory() and
 * searchMemories() end-to-end.
 *
 * Environment: vitest (node)
 * Dependency: better-sqlite3 ^12.11.1
 * ============================================================
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import Database from "better-sqlite3";

// ─── Mock infrastructure for injecting real SQLite ───────────────────────
// vi.mock MUST be at the top level — vitest hoists it before imports resolve.
// We use module-scoped variables captured by the mock factory closure.

let _mockDbInstance: {
  execute(sql: string, bindValues?: unknown[]): Promise<{ rowsAffected: number }>;
  select<T = unknown>(sql: string, bindValues?: unknown[]): Promise<T[]>;
  close(): Promise<void>;
} | null = null;
let _mockNativeDb: Database.Database | null = null;

vi.mock("../database", () => ({
  getDb: vi.fn(() => {
    if (!_mockDbInstance) throw new Error("Database not initialized by beforeAll");
    return _mockDbInstance;
  }),
}));

// Mock @tauri-apps/plugin-fs so writeMemoryMarkdown doesn't touch real filesystem
vi.mock("@tauri-apps/plugin-fs", () => ({
  exists: vi.fn().mockResolvedValue(true),
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeTextFile: vi.fn().mockResolvedValue(undefined),
  readDir: vi.fn().mockResolvedValue([]),
  readTextFile: vi.fn().mockResolvedValue(""),
  remove: vi.fn().mockResolvedValue(undefined),
}));

// ─── Real SQLite wrapper implementing SqlDatabase interface ───────────────

interface SqlDatabase {
  execute(sql: string, bindValues?: unknown[]): Promise<{ rowsAffected: number }>;
  select<T = unknown>(sql: string, bindValues?: unknown[]): Promise<T[]>;
  close(): Promise<void>;
}

function createMemoryDb(): { db: SqlDatabase; nativeDb: Database.Database } {
  const nativeDb = new Database(":memory:");
  nativeDb.exec("PRAGMA journal_mode=WAL;");

  nativeDb.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id            TEXT PRIMARY KEY,
      category      TEXT NOT NULL,
      tier          TEXT NOT NULL DEFAULT 'medium',
      content       TEXT NOT NULL,
      summary       TEXT NOT NULL,
      tags          TEXT NOT NULL DEFAULT '[]',
      source_session TEXT,
      source_file   TEXT,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL,
      access_count  INTEGER DEFAULT 0,
      last_accessed INTEGER DEFAULT 0,
      verified      INTEGER DEFAULT 0,
      stale         INTEGER DEFAULT 0
    );
  `);

  nativeDb.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      id UNINDEXED, content, summary, tags, category UNINDEXED,
      content='memories', content_rowid='rowid'
    );
  `);

  nativeDb.exec(`
    CREATE TABLE IF NOT EXISTS kv_store (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);

  nativeDb.exec(`
    CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, id, content, summary, tags, category)
      VALUES (new.rowid, new.id, new.content, new.summary, new.tags, new.category);
    END;
  `);
  nativeDb.exec(`
    CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, id, content, summary, tags, category)
      VALUES ('delete', old.rowid, old.id, old.content, old.summary, old.tags, old.category);
    END;
  `);
  nativeDb.exec(`
    CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, id, content, summary, tags, category)
      VALUES ('delete', old.rowid, old.id, old.content, old.summary, old.tags, old.category);
      INSERT INTO memories_fts(rowid, id, content, summary, tags, category)
      VALUES (new.rowid, new.id, new.content, new.summary, new.tags, new.category);
    END;
  `);

  nativeDb.exec("CREATE INDEX IF NOT EXISTS idx_mem_category ON memories(category);");
  nativeDb.exec("CREATE INDEX IF NOT EXISTS idx_mem_tier     ON memories(tier);");
  nativeDb.exec("CREATE INDEX IF NOT EXISTS idx_mem_stale    ON memories(stale);");
  nativeDb.exec("CREATE INDEX IF NOT EXISTS idx_mem_accessed ON memories(last_accessed);");
  nativeDb.exec("CREATE INDEX IF NOT EXISTS idx_mem_budget   ON memories(stale, access_count, updated_at);");

  const db: SqlDatabase = {
    async execute(sql: string, bindValues?: unknown[]) {
      const stmt = nativeDb.prepare(sql);
      const result = stmt.run(...(bindValues ?? []));
      return { rowsAffected: result.changes };
    },
    async select<T = unknown>(sql: string, bindValues?: unknown[]) {
      const stmt = nativeDb.prepare(sql);
      return (bindValues && bindValues.length > 0 ? stmt.all(...bindValues) : stmt.all()) as T[];
    },
    async close() { nativeDb.close(); },
  };

  return { db, nativeDb };
}

// Ensure crypto.randomUUID is available (Node <19)
if (typeof globalThis.crypto?.randomUUID !== "function") {
  (globalThis as any).crypto ??= {};
  (globalThis as any).crypto.randomUUID ??= () =>
    "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
    });
}

// Dynamic import helper — vitest vi.mock hoisting ensures the db mock is
// in place before the dynamic import resolves.
let _memoryStore: Promise<typeof import("../memoryStore")> | null = null;
function getMemoryStore() {
  if (!_memoryStore) _memoryStore = import("../memoryStore");
  return _memoryStore;
}

function clearTables(nativeDb: Database.Database) {
  // Delete from memories FIRST — the memories_ad trigger automatically
  // cleans up the FTS5 virtual table to avoid SQLITE_CORRUPT_VTAB errors.
  nativeDb.exec("DELETE FROM memories;");
  nativeDb.exec("DELETE FROM kv_store;");
}

// ============================================================================
// TEST SUITES
// ============================================================================

describe("MemoryStore SQLite Integration", () => {
  beforeAll(() => {
    const created = createMemoryDb();
    _mockDbInstance = created.db;
    _mockNativeDb = created.nativeDb;
  });

  afterAll(async () => {
    await _mockDbInstance?.close();
  });

  function countMemories(stale?: boolean): number {
    if (!_mockNativeDb) return 0;
    const sql = stale !== undefined
      ? `SELECT COUNT(*) as count FROM memories WHERE stale = ${stale ? 1 : 0}`
      : "SELECT COUNT(*) as count FROM memories";
    const row = _mockNativeDb.prepare(sql).get() as any;
    return row.count;
  }

  function getMemoryById(id: string): any {
    return _mockNativeDb?.prepare("SELECT * FROM memories WHERE id = ?").get(id);
  }

  function searchFts5(query: string): any[] {
    return _mockNativeDb?.prepare(
      "SELECT m.* FROM memories m JOIN memories_fts ON memories_fts.id = m.id WHERE memories_fts MATCH ? ORDER BY memories_fts.rank"
    ).all(query) ?? [];
  }

  // Direct SQL insert helper for seeding test data (bypasses saveMemory logic)
  function seedEntry(overrides: Partial<{
    content: string; summary: string; tags: string[];
    category: string; tier: string;
  }> = {}) {
    const now = Date.now();
    const id = "seed-" + crypto.randomUUID();
    _mockNativeDb!.prepare(`
      INSERT INTO memories (id, category, tier, content, summary, tags, created_at, updated_at, access_count, last_accessed, verified, stale)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0)
    `).run(
      id,
      overrides.category ?? "project",
      overrides.tier ?? "medium",
      overrides.content ?? "Seed content",
      overrides.summary ?? "Seed summary",
      JSON.stringify(overrides.tags ?? ["seed"]),
      now, now,
    );
    return id;
  }

  // ===================================================================
  // saveMemory() — INSERT
  // ===================================================================

  describe("saveMemory() - INSERT", () => {
    beforeAll(() => { clearTables(_mockNativeDb!); });

    it("inserts a new memory entry into SQLite and FTS5", async () => {
      const { saveMemory } = await getMemoryStore();

      const result = await saveMemory({
        category: "decision", tier: "high",
        content: "We decided to use tRPC for type-safe API communication",
        summary: "Decision: use tRPC",
        tags: ["tRPC", "typescript", "api"],
        sourceSession: undefined,
        sourceFile: undefined,
      }, "/test/ws");

      expect(result.action).toBe("add");
      expect(result.id).toBeTruthy();

      const row = getMemoryById(result.id);
      expect(row).not.toBeNull();
      expect(row.category).toBe("decision");
      expect(row.tier).toBe("high");
      expect(row.content).toContain("tRPC");
      expect(row.summary).toBe("Decision: use tRPC");

      // Verify FTS5 has the entry
      const ftsResults = searchFts5("tRPC");
      expect(ftsResults.length).toBeGreaterThanOrEqual(1);
      expect(ftsResults.some((r: any) => r.id === result.id)).toBe(true);
    });

    it("inserts memories with different categories and tiers", async () => {
      const { saveMemory } = await getMemoryStore();

      const entries: Array<{ category: any; tier: any; content: string; summary: string; tags: string[] }> = [
        { category: "user", tier: "critical", content: "User prefers dark mode", summary: "Dark mode preference", tags: ["ui"] },
        { category: "feedback", tier: "low", content: "Minor UI glitch on hover", summary: "Hover glitch", tags: ["bug"] },
        { category: "reference", tier: "medium", content: "API docs at /docs/v2", summary: "API docs ref", tags: ["docs"] },
      ];

      for (const entry of entries) {
        const result = await saveMemory({ ...entry, sourceSession: undefined, sourceFile: undefined }, "/test/ws");
        expect(result.action).toBe("add");
        const row = getMemoryById(result.id);
        expect(row.category).toBe(entry.category);
        expect(row.tier).toBe(entry.tier);
      }

      // 1 from previous test + 3 new = 4
      expect(countMemories()).toBe(4);
    });

    it("sets default values for access_count, last_accessed, verified, and stale", async () => {
      const { saveMemory } = await getMemoryStore();

      const result = await saveMemory({
        category: "project", tier: "medium",
        content: "Defaults test", summary: "Defaults test",
        tags: [], sourceSession: undefined, sourceFile: undefined,
      }, "/test/ws");

      const row = getMemoryById(result.id);
      expect(row.access_count).toBe(0);
      expect(row.last_accessed).toBe(0);
      expect(row.verified).toBe(0);
      expect(row.stale).toBe(0);
    });
  });

  // ===================================================================
  // saveMemory() — NOOP (Jaccard similarity > 0.90)
  // ===================================================================
  //
  // NOTE: Jaccard similarity uses tokenize() which filters stop words,
  // short words (≤2 chars), and splits path-like tokens. With ~20
  // meaningful tokens and only 1 differing, similarity ≈ 19/21 ≈ 0.905.

  describe("saveMemory() - NOOP (similarity > 0.90)", () => {
    beforeAll(() => { clearTables(_mockNativeDb!); });

    it("returns NOOP for near-duplicate content", async () => {
      const { saveMemory } = await getMemoryStore();

      // ~20 meaningful tokens: change 1 word (file → module) → 19/21 ≈ 0.905 > 0.90
      const baseContent =
        "strict TypeScript mode noImplicitAny enabled for better code quality across entire project codebase every single file module class function variable method approach";
      const nearDuplicate =
        "strict TypeScript mode noImplicitAny enabled for better code quality across entire project codebase every single directory module class function variable method approach";

      const first = await saveMemory({
        category: "project", tier: "high",
        content: baseContent, summary: "TypeScript strict rules",
        tags: ["typescript"], sourceSession: undefined, sourceFile: undefined,
      }, "/test/ws");
      expect(first.action).toBe("add");

      const second = await saveMemory({
        category: "project", tier: "high",
        content: nearDuplicate, summary: "TypeScript strict rules",
        tags: ["typescript"], sourceSession: undefined, sourceFile: undefined,
      }, "/test/ws");

      expect(second.action).toBe("noop");
      expect(second.id).toBe(first.id);
      expect(countMemories()).toBe(1);
    });
  });

  // ===================================================================
  // saveMemory() — UPDATE (0.65 < Jaccard < 0.90, same category)
  // ===================================================================

  describe("saveMemory() - UPDATE (similarity 0.65-0.90)", () => {
    beforeAll(() => { clearTables(_mockNativeDb!); });

    it("updates existing memory when similarity > 0.65 and same category", async () => {
      const { saveMemory } = await getMemoryStore();

      // ~10 meaningful tokens, ~70% overlap → similarity ≈ 0.75
      const baseContent =
        "strict TypeScript mode noImplicitAny enabled better code quality project";
      const relatedContent =
        "strict TypeScript mode type hints enabled better code quality project";

      const first = await saveMemory({
        category: "project", tier: "medium",
        content: baseContent, summary: "TypeScript rules",
        tags: ["typescript"], sourceSession: undefined, sourceFile: undefined,
      }, "/test/ws");
      expect(first.action).toBe("add");

      const second = await saveMemory({
        category: "project", tier: "high",
        content: relatedContent, summary: "Updated TypeScript rules",
        tags: ["typescript", "hints"], sourceSession: undefined, sourceFile: undefined,
      }, "/test/ws");

      expect(second.action).toBe("update");
      expect(second.id).toBe(first.id);

      const row = getMemoryById(second.id);
      expect(row.content).toBe(relatedContent);
      const tags = JSON.parse(row.tags);
      expect(tags).toContain("typescript");
      expect(tags).toContain("hints");
    });

    it("adds new entry when similarity < 0.65 (different enough)", async () => {
      const { saveMemory } = await getMemoryStore();

      const baseContent = "always strict TypeScript mode noImplicitAny enabled";
      const differentContent = "Python async await event loop coroutine async function";

      await saveMemory({
        category: "project", tier: "medium",
        content: baseContent, summary: "TypeScript rules",
        tags: ["typescript"], sourceSession: undefined, sourceFile: undefined,
      }, "/test/ws");

      const second = await saveMemory({
        category: "project", tier: "low",
        content: differentContent, summary: "Python async",
        tags: ["python"], sourceSession: undefined, sourceFile: undefined,
      }, "/test/ws");

      // Low similarity (< 0.65) with different content → INSERT new entry
      expect(second.action).toBe("add");
      // Test 1 inserted 1 entry (UPDATE doesn't add). Test 2 inserted base + different = 2 more. Total: 3.
      expect(countMemories()).toBe(3);
    });
  });

  // ===================================================================
  // saveMemory() — Concurrent save dedup (content-hash mutex)
  // ===================================================================

  describe("saveMemory() - concurrency", () => {
    // Each concurrency test needs a clean slate since we're counting entries
    beforeEach(() => { clearTables(_mockNativeDb!); });

    it("returns the same result for concurrent saves with identical content", async () => {
      const { saveMemory } = await getMemoryStore();

      const entry = {
        category: "project" as const, tier: "medium" as const,
        content: "Concurrent save test content",
        summary: "Concurrent test",
        tags: ["test"] as string[],
        sourceSession: undefined as string | undefined,
        sourceFile: undefined as string | undefined,
      };

      const [result1, result2] = await Promise.all([
        saveMemory(entry, "/test/ws"),
        saveMemory(entry, "/test/ws"),
      ]);

      expect(result1.action).toBe(result2.action);
      expect(result1.id).toBe(result2.id);
      expect(countMemories()).toBe(1);
    });

    it("handles 50 parallel saves with identical content — all return same result, only 1 DB entry", async () => {
      const { saveMemory } = await getMemoryStore();

      const entry = {
        category: "decision" as const,
        tier: "high" as const,
        content: "Heavy concurrency dedup test content for mutex verification",
        summary: "Dedup test",
        tags: ["concurrency", "mutex"] as string[],
        sourceSession: undefined as string | undefined,
        sourceFile: undefined as string | undefined,
      };

      // Fire 50 parallel saveMemory() calls with EXACTLY the same content
      const CONCURRENCY = 50;
      const promises = Array.from({ length: CONCURRENCY }, () =>
        saveMemory(entry, "/test/ws"),
      );

      const results = await Promise.all(promises);

      // All 50 should have the same action and id
      const uniqueActions = new Set(results.map((r) => r.action));
      const uniqueIds = new Set(results.map((r) => r.id));

      expect(uniqueActions.size).toBe(1);
      expect(uniqueIds.size).toBe(1);

      // Only 1 memory entry should exist in the database
      expect(countMemories()).toBe(1);

      // The action should be "add" (first insert)
      expect(results[0].action).toBe("add");
      expect(results[0].id).toBeTruthy();

      // Verify the entry is searchable via FTS5
      const { searchMemories } = await getMemoryStore();
      const searchResults = await searchMemories("concurrency", { limit: 5, updateAccessCount: false });
      expect(searchResults.length).toBeGreaterThanOrEqual(1);
      expect(searchResults.some((r) => r.id === results[0].id)).toBe(true);
    });

    it("handles 50 parallel saves with same content but different entry metadata (same hash)", async () => {
      // The content-hash mutex uses `content + category` as the hash key.
      // Different metadata fields (tier, summary, tags) should NOT affect the hash.
      const { saveMemory } = await getMemoryStore();

      const content = "Content-based hash collision test for mutex verification";
      const category = "project" as const;

      const CONCURRENCY = 50;
      const promises = Array.from({ length: CONCURRENCY }, (_, i) =>
        saveMemory({
          category,
          tier: i % 2 === 0 ? "high" as const : "low" as const,
          content,
          summary: `Summary ${i}`,
          tags: [`tag-${i}`],
          sourceSession: undefined,
          sourceFile: undefined,
        }, "/test/ws"),
      );

      const results = await Promise.all(promises);

      // All should have the same result from the hash mutex
      const uniqueActions = new Set(results.map((r) => r.action));
      const uniqueIds = new Set(results.map((r) => r.id));

      expect(uniqueActions.size).toBe(1);
      expect(uniqueIds.size).toBe(1);

      // Only 1 entry in DB (the rest were deduped by the hash mutex)
      expect(countMemories()).toBe(1);

      // Verify the single saved entry has the expected content and category
      const rows = _mockNativeDb!.prepare("SELECT * FROM memories").all() as any[];
      expect(rows.length).toBe(1);
      expect(rows[0].content).toBe(content);
      expect(rows[0].category).toBe(category);
    });

    // ===================================================================
    // STRESS TESTS — 100+ concurrent calls
    // ===================================================================

    it("handles 100 parallel identical saves — hash mutex holds at 2x previous load", async () => {
      const { saveMemory } = await getMemoryStore();

      const entry = {
        category: "reference" as const,
        tier: "high" as const,
        content: "Stress test 100 concurrent saves with identical content for mutex ceiling",
        summary: "Stress 100",
        tags: ["stress", "100"] as string[],
        sourceSession: undefined as string | undefined,
        sourceFile: undefined as string | undefined,
      };

      const promises = Array.from({ length: 100 }, () =>
        saveMemory(entry, "/test/ws"),
      );
      const results = await Promise.all(promises);

      // All 100 return the same result
      const uniqueActions = new Set(results.map((r) => r.action));
      const uniqueIds = new Set(results.map((r) => r.id));
      expect(uniqueActions.size).toBe(1);
      expect(uniqueIds.size).toBe(1);

      // Only 1 DB entry
      expect(countMemories()).toBe(1);

      // Verify FTS5 is still consistent
      const { searchMemories } = await getMemoryStore();
      const searchResults = await searchMemories("stress", { limit: 5, updateAccessCount: false });
      expect(searchResults.length).toBeGreaterThanOrEqual(1);
    });

    it("handles 500 parallel identical saves — mutex ceiling test", async () => {
      const { saveMemory } = await getMemoryStore();

      const entry = {
        category: "decision" as const,
        tier: "medium" as const,
        content: "Stress test 500 concurrent saves with identical content for mutex ceiling verification",
        summary: "Stress 500",
        tags: ["stress", "500"] as string[],
        sourceSession: undefined as string | undefined,
        sourceFile: undefined as string | undefined,
      };

      const promises = Array.from({ length: 500 }, () =>
        saveMemory(entry, "/test/ws"),
      );
      const results = await Promise.all(promises);

      // All 500 return the same result from the hash mutex
      const uniqueActions = new Set(results.map((r) => r.action));
      const uniqueIds = new Set(results.map((r) => r.id));
      expect(uniqueActions.size).toBe(1);
      expect(uniqueIds.size).toBe(1);

      // Only 1 DB entry
      expect(countMemories()).toBe(1);
    });

    it("handles 100 parallel saves with unique content — no hash collisions, all INSERT", async () => {
      const { saveMemory } = await getMemoryStore();

      // CRITICAL: tokenize() filters out words with length ≤ 2 and stop words.
      // To guarantee Jaccard similarity is 0 between any pair, each entry must
      // have tokens ≥3 chars that don't overlap with other entries' tokens.
      function uniqueContent(i: number): string {
        // Pad base-36 to ≥3 chars so tokens survive the tokenizer filter
        const base = i.toString(36);
        const padded = base.length >= 3 ? base : base.padEnd(3, "x");
        return Array.from({ length: 8 }, () => padded).join(" ");
      }

      const promises = Array.from({ length: 100 }, (_, i) =>
        saveMemory({
          // Unique category per entry so the UPDATE branch (same category
          // + similarity > 0.65) never triggers. Unique summary so FTS5
          // searches don't accidentally match batch-mates from concurrent runs.
          category: `cat${i}` as any,
          tier: "medium" as const,
          content: uniqueContent(i),
          summary: `Uniq${i}`,
          tags: [`tag-${i}`],
          sourceSession: undefined,
          sourceFile: undefined,
        }, "/test/ws"),
      );

      const results = await Promise.all(promises);

      // All 100 must have unique IDs (no false dedup from timing races)
      const uniqueIds = new Set(results.map((r) => r.id));
      expect(uniqueIds.size).toBe(100);

      // All should be "add" actions (distinct categories + unique content)
      const adds = results.filter((r) => r.action === "add");
      expect(adds.length).toBe(100);

      // DB should have exactly 100 rows
      expect(countMemories()).toBe(100);
    });

    it("handles 100 parallel saves where 50 are identical (deduped) and 50 are unique — mixed contention", async () => {
      const { saveMemory } = await getMemoryStore();

      const sharedContent = "Shared content for mixed stress test with exact content across all identical entries";

      // Each unique entry needs distinct tokens ≥3 chars to avoid Jaccard
      // overlap with other unique entries or with the shared content.
      // Also use per-entry categories to prevent any UPDATE branch triggering.
      function uniqueContent(i: number): string {
        const base = i.toString(36);
        const padded = base.length >= 3 ? base : base.padEnd(3, "y");
        return Array.from({ length: 8 }, () => padded).join(" ");
      }

      const results = await Promise.all(
        Array.from({ length: 100 }, (_, i) => {
          // Even indices: identical content (hash mutex dedup)
          // Odd indices: unique content (all INSERT)
          if (i % 2 === 0) {
            return saveMemory({
              category: "project" as const,
              tier: "high" as const,
              content: sharedContent,
              summary: "Shared stress",
              tags: ["shared"],
              sourceSession: undefined,
              sourceFile: undefined,
            }, "/test/ws");
          }
          return saveMemory({
            category: `mix${i}` as any,
            tier: "low" as const,
            content: uniqueContent(i),
            summary: `Mix${i}`,
            tags: [`unique-${i}`],
            sourceSession: undefined,
            sourceFile: undefined,
          }, "/test/ws");
        }),
      );

      // 50 shared → 1 deduped entry (hash mutex); 50 unique → 50 entries
      // Note: hash mutex returns { action: "add", id: sameId } for ALL
      // deduped callers, so adds.length will be 100, NOT 51.
      const uniqueIds = new Set(results.map((r) => r.id));
      expect(uniqueIds.size).toBe(51);

      // DB should have exactly 51 rows (1 shared + 50 unique)
      expect(countMemories()).toBe(51);
    });
  });

  // ===================================================================
  // searchMemories() — FTS5 full-text search
  // ===================================================================

  describe("searchMemories() - FTS5 search", () => {
    beforeAll(() => {
      clearTables(_mockNativeDb!);
      seedEntry({
        content: "The project uses React with TypeScript for UI components",
        summary: "React + TypeScript", tags: ["react", "typescript"],
        category: "project", tier: "high",
      });
      seedEntry({
        content: "Backend API uses Node.js with Express framework",
        summary: "Node + Express", tags: ["node", "express"],
        category: "project", tier: "medium",
      });
      seedEntry({
        content: "Database schema uses PostgreSQL with Prisma ORM",
        summary: "Postgres + Prisma", tags: ["postgres", "prisma"],
        category: "project", tier: "high",
      });
      seedEntry({
        content: "User prefers dark mode for the editor interface",
        summary: "Dark mode preference", tags: ["ui", "preference"],
        category: "user", tier: "low",
      });
      seedEntry({
        content: "Deployment uses Docker containers on AWS ECS",
        summary: "Docker + AWS", tags: ["docker", "aws"],
        category: "reference", tier: "medium",
      });
      seedEntry({
        content: "Critical: authentication must use OAuth 2.0 with PKCE",
        summary: "OAuth 2.0 PKCE", tags: ["auth", "security"],
        category: "decision", tier: "critical",
      });
      seedEntry({
        content: "Feedback: the error messages should be more descriptive",
        summary: "Error messages feedback", tags: ["feedback", "ux"],
        category: "feedback", tier: "medium",
      });
    });

    it("finds memories matching a single keyword via FTS5", async () => {
      const { searchMemories } = await getMemoryStore();
      const results = await searchMemories("TypeScript", { limit: 10, updateAccessCount: false });
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results.some((r) => r.content.toLowerCase().includes("typescript"))).toBe(true);
    });

    it("returns empty array for non-matching query", async () => {
      const { searchMemories } = await getMemoryStore();
      const results = await searchMemories("xyznonexistent12345", { limit: 10, updateAccessCount: false });
      expect(results).toEqual([]);
    });

    it("filters by category when provided", async () => {
      const { searchMemories } = await getMemoryStore();
      const results = await searchMemories("TypeScript", { category: "user", limit: 10, updateAccessCount: false });
      expect(results).toHaveLength(0);
    });

    it("finds category-filtered results when both match", async () => {
      const { searchMemories } = await getMemoryStore();
      const results = await searchMemories("dark", { category: "user", limit: 10, updateAccessCount: false });
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].category).toBe("user");
      expect(results[0].content).toContain("dark mode");
    });

    it("excludes stale memories by default", async () => {
      const { searchMemories, saveMemory } = await getMemoryStore();

      const result = await saveMemory({
        category: "project", tier: "low",
        content: "Stale test memory for search exclusion",
        summary: "Stale test",
        tags: ["stale"], sourceSession: undefined, sourceFile: undefined,
      }, "/test/ws");

      _mockNativeDb!.prepare("UPDATE memories SET stale = 1 WHERE id = ?").run(result.id);

      const results = await searchMemories("Stale test", { limit: 10, updateAccessCount: false });
      expect(results.some((r) => r.id === result.id)).toBe(false);
    });

    it("includes stale memories when excludeStale=false", async () => {
      const { searchMemories } = await getMemoryStore();
      const results = await searchMemories("Stale test", { limit: 10, excludeStale: false, updateAccessCount: false });
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results.some((r) => r.content.includes("Stale test"))).toBe(true);
    });

    it("supports prefix matching for partial words", async () => {
      const { searchMemories } = await getMemoryStore();
      const results = await searchMemories("Type", { limit: 10, updateAccessCount: false });
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results.some((r) => r.content.toLowerCase().includes("typescript"))).toBe(true);
    });

    it("respects the limit parameter", async () => {
      const { searchMemories } = await getMemoryStore();
      const results = await searchMemories("the", { limit: 2, updateAccessCount: false });
      expect(results.length).toBeLessThanOrEqual(2);
    });

    it("updates access_count when updateAccessCount=true (default)", async () => {
      const { searchMemories } = await getMemoryStore();
      const results = await searchMemories("React", { limit: 5 });
      if (results.length > 0) {
        const row = getMemoryById(results[0].id);
        expect(row.access_count).toBeGreaterThan(0);
        expect(row.last_accessed).toBeGreaterThan(0);
      }
    });
  });

  // ===================================================================
  // saveMemory() — Edge cases
  // ===================================================================

  describe("saveMemory() - edge cases", () => {
    beforeAll(() => { clearTables(_mockNativeDb!); });

    it("handles empty tags array", async () => {
      const { saveMemory } = await getMemoryStore();
      const result = await saveMemory({
        category: "project", tier: "medium",
        content: "Memory with no tags", summary: "No tags",
        tags: [], sourceSession: undefined, sourceFile: undefined,
      }, "/test/ws");
      expect(result.action).toBe("add");
      const row = getMemoryById(result.id);
      expect(JSON.parse(row.tags)).toEqual([]);
    });

    it("stores sourceSession and sourceFile when provided", async () => {
      const { saveMemory } = await getMemoryStore();
      const result = await saveMemory({
        category: "decision", tier: "critical",
        content: "Store session and file refs", summary: "Session refs test",
        tags: [], sourceSession: "session-abc-123", sourceFile: "/src/main.ts",
      }, "/test/ws");
      const row = getMemoryById(result.id);
      expect(row.source_session).toBe("session-abc-123");
      expect(row.source_file).toBe("/src/main.ts");
    });

    it("handles very long content without truncation", async () => {
      const { saveMemory } = await getMemoryStore();
      const longContent = "A".repeat(10000);
      const result = await saveMemory({
        category: "project", tier: "low",
        content: longContent, summary: "Long content test",
        tags: ["long"], sourceSession: undefined, sourceFile: undefined,
      }, "/test/ws");
      expect(result.action).toBe("add");
      const row = getMemoryById(result.id);
      expect((row.content as string).length).toBe(10000);
    });

    it("saves multiple memories with unique content", async () => {
      const { saveMemory } = await getMemoryStore();
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          saveMemory({
            category: "project", tier: "medium",
            content: `Unique memory number ${i}`,
            summary: `Memory ${i}`,
            tags: [`tag-${i}`],
            sourceSession: undefined, sourceFile: undefined,
          }, "/test/ws")
        )
      );
      expect(results.every((r) => r.action === "add")).toBe(true);
      const uniqueIds = new Set(results.map((r) => r.id));
      expect(uniqueIds.size).toBe(10);
    });
  });

  // ===================================================================
  // searchMemories() — Edge cases
  // ===================================================================

  describe("searchMemories() - edge cases", () => {
    beforeAll(() => {
      clearTables(_mockNativeDb!);
      seedEntry({
        content: "Edge case search target content for tests",
        summary: "Edge case", tags: ["edge"],
        category: "project", tier: "medium",
      });
    });

    it("handles empty query string gracefully", async () => {
      const { searchMemories } = await getMemoryStore();
      const results = await searchMemories("", { limit: 5, updateAccessCount: false });
      expect(results).toEqual([]);
    });

    it("handles special characters in query", async () => {
      const { searchMemories } = await getMemoryStore();
      const results = await searchMemories("React++[test]", { limit: 5, updateAccessCount: false });
      expect(Array.isArray(results)).toBe(true);
    });

    it("handles very long query strings", async () => {
      const { searchMemories } = await getMemoryStore();
      const longQuery = "test ".repeat(200);
      const results = await searchMemories(longQuery, { limit: 5, updateAccessCount: false });
      expect(Array.isArray(results)).toBe(true);
    });
  });

  // ===================================================================
  // saveMemory() — Concurrent UPDATE contention
  // ===================================================================
  //
  // Tests that multiple concurrent saveMemory() calls targeting the same
  // existing memory all successfully perform their UPDATE.
  //
  // Each concurrent call must have DIFFERENT content (to bypass the
  // content-hash mutex) but content must be ~0.80 Jaccard similar to the
  // same existing entry in the same category (to trigger the UPDATE
  // branch rather than INSERT).
  //
  // STRESS TESTS: 100+ concurrent updates to the same entry exercise the
  // per-ID lock (MAX_PER_ID_LOCK_RETRIES=3) and the circular-promise fix.
  // With 100 callers colliding on the same per-ID lock, many will hit the
  // retry path — they delete the hash mutex, wait 50-150ms, recurse with
  // a fresh FTS5 search, re-check the per-ID lock, and proceed.

  describe("saveMemory() - concurrent UPDATE", () => {
    beforeEach(() => { clearTables(_mockNativeDb!); });

    // ===================================================================
    // RETRY-EXHAUSTION — deliberately hold per-ID lock
    // ===================================================================

    it("exhausts per-ID lock retries when lock is deliberately held — proceeds with update after MAX_RETRIES", async () => {
      const { saveMemory, _testHoldPerIdLock } = await getMemoryStore();

      // Insert a base entry that the UPDATE branch will target
      const base = await saveMemory({
        category: "project", tier: "medium",
        content: "strict TypeScript mode noImplicitAny enabled better code quality project overall",
        summary: "TypeScript strict",
        tags: ["typescript"],
        sourceSession: undefined, sourceFile: undefined,
      }, "/test/ws");
      expect(base.action).toBe("add");

      // Spy on console.warn to verify the exhaustion log
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      // Deliberately hold the per-ID lock so saveMemory's UPDATE branch
      // cannot acquire it. The first check sees it held, retries 3 times
      // with backoff, then exhausts MAX_PER_ID_LOCK_RETRIES and proceeds.
      const lock = _testHoldPerIdLock(base.id);

      let result;
      try {
        // This content has ~0.82 Jaccard similarity to the base (same
        // category "project") → triggers the UPDATE branch.
        result = await saveMemory({
          category: "project", tier: "high",
          content: "strict TypeScript mode noUnusedLocals enabled better code quality project overall",
          summary: "TypeScript strict",
          tags: ["typescript", "strict-mode"],
          sourceSession: undefined, sourceFile: undefined,
        }, "/test/ws");
      } finally {
        // Release the lock immediately, before assertions, so the Set is
        // always clean even if an assertion below throws.
        lock.release();
      }

      // Despite retry exhaustion, the call should still succeed as an UPDATE
      // (the else-branch after MAX_RETRIES proceeds without the per-ID lock)
      expect(result!.action).toBe("update");
      expect(result!.id).toBe(base.id);

      // Verify the DB still has exactly 1 entry (no duplicate INSERT)
      expect(countMemories()).toBe(1);

      // Verify the exhaustion warning was emitted
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Per-ID lock exhausted"),
      );

      warnSpy.mockRestore();
    });

    it("3 concurrent updates to the same base entry all return 'update' with same id", async () => {
      const { saveMemory } = await getMemoryStore();

      // Insert base entry (10 meaningful tokens after stop-word filter)
      const base = await saveMemory({
        category: "project", tier: "medium",
        content: "strict TypeScript mode noImplicitAny enabled better code quality project overall",
        summary: "TypeScript strict",
        tags: ["typescript"],
        sourceSession: undefined, sourceFile: undefined,
      }, "/test/ws");
      expect(base.action).toBe("add");

      // 3 variants — each changes 1 token out of ~10 → Jaccard ~9/11 ≈ 0.82
      // Different content so the content-hash mutex does NOT dedup them.
      const variants = [
        "strict TypeScript mode noUnusedLocals enabled better code quality project overall",
        "strict TypeScript mode noUncheckedIndexedAccess enabled better code quality project overall",
        "strict TypeScript mode exactOptionalPropertyTypes enabled better code quality project overall",
      ];

      const results = await Promise.all(
        variants.map((content) =>
          saveMemory({
            category: "project",
            tier: "high",
            content,
            summary: "TypeScript strict",
            tags: ["typescript", "strict-mode"],
            sourceSession: undefined,
            sourceFile: undefined,
          }, "/test/ws"),
        ),
      );

      // All should UPDATE the same base entry
      expect(results.every((r) => r.action === "update")).toBe(true);
      expect(results.every((r) => r.id === base.id)).toBe(true);

      // DB still has exactly 1 entry (updates, not inserts)
      expect(countMemories()).toBe(1);

      // Final content should be one of the variants
      const row = getMemoryById(base.id);
      expect(variants).toContain(row.content);

      // Tier and tags should reflect the update
      expect(JSON.parse(row.tags)).toContain("strict-mode");
    });

    it("5 concurrent updates to the same memory all succeed", async () => {
      const { saveMemory } = await getMemoryStore();

      // Base content uses "chosen" token — none of the variants use this word.
      // Variants change the first token (package manager name), keeping all
      // other tokens identical.
      const base = await saveMemory({
        category: "decision", tier: "low",
        content: "chosen package manager project dependencies management overall approach best",
        summary: "Package decision",
        tags: ["package-manager"],
        sourceSession: undefined, sourceFile: undefined,
      }, "/test/ws");
      expect(base.action).toBe("add");

      // 5 variants — each changes 1 token (package manager name) → Jaccard ~8/10 = 0.80
      const managers = ["yarn", "npm", "bun", "cargo", "pnpm"];
      const variants = managers.map(
        (mgr) => `${mgr} package manager project dependencies management overall approach best`,
      );

      const results = await Promise.all(
        variants.map((content) =>
          saveMemory({
            category: "decision",
            tier: "high",
            content,
            summary: "Package decision",
            tags: ["package-manager"],
            sourceSession: undefined,
            sourceFile: undefined,
          }, "/test/ws"),
        ),
      );

      // All should succeed — none use "chosen" (the base's unique token),
      // so none triggers NOOP (would need similarity > 0.90).
      expect(results.every((r) => r.action === "update")).toBe(true);
      expect(results.every((r) => r.id === base.id)).toBe(true);
      expect(countMemories()).toBe(1);

      const row = getMemoryById(base.id);
      expect(variants).toContain(row.content);
    });

    // ===================================================================
    // STRESS TESTS — 100+ concurrent UPDATEs to the same entry
    // ===================================================================

    it("handles 100 parallel updates to the same base entry — all return 'update' with same ID", async () => {
      const { saveMemory } = await getMemoryStore();

      // Base entry with 9 meaningful tokens (10 after including the unique token)
      // Uses "chosen" as the unique token that variants will replace.
      const base = await saveMemory({
        category: "project",
        tier: "medium",
        content: "chosen framework package manager project dependencies management overall approach best",
        summary: "Stress update",
        tags: ["stress"],
        sourceSession: undefined,
        sourceFile: undefined,
      }, "/test/ws");
      expect(base.action).toBe("add");

      // Generate 100 unique variants. Each changes the first token from "chosen"
      // to a unique 3+ char token. Jaccard between any variant and the base:
      // 9 matching tokens out of 11 union → ~0.82 > 0.65 (UPDATE window).
      // Different content per variant → different hash → no hash mutex dedup.
      function variantContent(i: number): string {
        // padStart ensures tokens ≥3 chars to survive tokenize() length filter
        const padded = i.toString(36).padStart(3, "z");
        return `${padded} framework package manager project dependencies management overall approach best`;
      }

      const promises = Array.from({ length: 100 }, (_, i) =>
        saveMemory({
          category: "project",
          tier: "high",
          content: variantContent(i),
          summary: "Stress update",
          tags: ["stress", "update"],
          sourceSession: undefined,
          sourceFile: undefined,
        }, "/test/ws"),
      );

      const results = await Promise.all(promises);

      // All 100 should UPDATE the same base entry
      const uniqueIds = new Set(results.map((r) => r.id));
      const updates = results.filter((r) => r.action === "update");

      expect(uniqueIds.size).toBe(1);
      expect(uniqueIds.has(base.id)).toBe(true);
      expect(updates.length).toBe(100);

      // DB still has exactly 1 entry
      expect(countMemories()).toBe(1);

      // Final content should be one of the variants
      const row = getMemoryById(base.id);
      const expectedVariants = Array.from({ length: 100 }, (_, i) => variantContent(i));
      expect(expectedVariants).toContain(row.content);
    });

    it("handles 100 parallel updates where 50 share content (hash mutex dedup) and 50 are unique — mixed contention", async () => {
      const { saveMemory } = await getMemoryStore();

      // Base entry with a unique token "chosen" that variants will replace.
      const base = await saveMemory({
        category: "decision",
        tier: "low",
        content: "chosen stack framework language library tool database deployment hosting platform",
        summary: "Mixed update",
        tags: ["base"],
        sourceSession: undefined,
        sourceFile: undefined,
      }, "/test/ws");
      expect(base.action).toBe("add");

      // Even indices: identical shared content → hash mutex dedup
      // Odd indices: unique content → different hash, all UPDATE
      const sharedContent = "chosen stack framework language library tool database deployment hosting platform";

      function uniqueUpdateContent(i: number): string {
        const padded = i.toString(36).padStart(3, "y");
        return `${padded} stack framework language library tool database deployment hosting platform`;
      }

      const results = await Promise.all(
        Array.from({ length: 100 }, (_, i) => {
          if (i % 2 === 0) {
            return saveMemory({
              category: "decision",
              tier: "high",
              content: sharedContent,
              summary: "Mixed update",
              tags: ["shared"],
              sourceSession: undefined,
              sourceFile: undefined,
            }, "/test/ws");
          }
          return saveMemory({
            category: "decision",
            tier: "medium",
            content: uniqueUpdateContent(i),
            summary: "Mixed update",
            tags: [`unique-${i}`],
            sourceSession: undefined,
            sourceFile: undefined,
          }, "/test/ws");
        }),
      );

      // 50 shared → 1 deduped (hash mutex); 50 unique → all UPDATE the same base
      // Total unique IDs = 1 (the base ID, since all UPDATE the same entry)
      const uniqueIds = new Set(results.map((r) => r.id));
      expect(uniqueIds.size).toBe(1);
      expect(uniqueIds.has(base.id)).toBe(true);

      // Note: the hash mutex returns { action: "noop", id: base.id } for ALL
      // deduped callers (shared content is identical to base → Jaccard 1.0).
      // The unique variants return "update". So actions will be a mix of "noop" and "update".
      const updates = results.filter((r) => r.action === "update");
      expect(updates.length).toBe(50);

      // DB has exactly 1 entry (all UPDATEd the same base)
      expect(countMemories()).toBe(1);

      // Final content should be one of the variant strings (50 unique or shared)
      const row = getMemoryById(base.id);
      const allVariants = [
        sharedContent,
        ...Array.from({ length: 100 }, (_, i) => uniqueUpdateContent(i)),
      ];
      expect(allVariants).toContain(row.content);
    });
  });

  // ===================================================================
  // Combined save + search end-to-end
  // ===================================================================

  describe("save + search end-to-end", () => {
    beforeAll(() => { clearTables(_mockNativeDb!); });

    it("saves a memory and immediately finds it via search", async () => {
      const { saveMemory, searchMemories } = await getMemoryStore();

      await saveMemory({
        category: "decision", tier: "critical",
        content: "Use pnpm as the package manager for this project",
        summary: "Package manager: pnpm",
        tags: ["pnpm", "package-manager"],
        sourceSession: undefined, sourceFile: undefined,
      }, "/test/ws");

      const results = await searchMemories("pnpm", { limit: 5, updateAccessCount: false });
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].summary).toBe("Package manager: pnpm");
      expect(results[0].tags).toContain("pnpm");
    });

    it("preserves all entry fields through save → search round-trip", async () => {
      const { saveMemory, searchMemories } = await getMemoryStore();

      const saveResult = await saveMemory({
        category: "feedback", tier: "low",
        content: "Remember to add pagination to the user list endpoint",
        summary: "Pagination reminder",
        tags: ["api", "pagination", "todo"],
        sourceSession: undefined, sourceFile: undefined,
      }, "/test/ws");

      expect(saveResult.action).toBe("add");

      const searchResults = await searchMemories("pagination", { limit: 5, updateAccessCount: false });
      const found = searchResults.find((r) => r.id === saveResult.id);
      expect(found).toBeDefined();
      expect(found!.category).toBe("feedback");
      expect(found!.tier).toBe("low");
      expect(found!.content).toBe("Remember to add pagination to the user list endpoint");
      expect(found!.summary).toBe("Pagination reminder");
      expect(found!.tags).toEqual(["api", "pagination", "todo"]);
    });
  });
});
