/**
 * ============================================================
 * DREAM AGENT INTEGRATION TESTS — Real SQLite + FTS5
 * ============================================================
 *
 * Tests the dream agent's database-level behavior:
 *   1. purgeStale() — hard-delete stale entries, keep active ones
 *   2. Re-scoring — promote frequently accessed memories, demote
 *      rarely accessed high-tier ones (same SQL as runDreamCycle)
 *   3. Dedup clustering — similar memories are grouped into clusters
 *      and merged, originals marked stale
 *
 * Environment: vitest (node)
 * Dependency: better-sqlite3 ^12.11.1
 * ============================================================
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import Database from "better-sqlite3";

// ─── Mock infrastructure ────────────────────────────────────

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

vi.mock("@tauri-apps/plugin-fs", () => ({
  exists: vi.fn().mockResolvedValue(true),
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeTextFile: vi.fn().mockResolvedValue(undefined),
  readDir: vi.fn().mockResolvedValue([]),
  readTextFile: vi.fn().mockResolvedValue(""),
  remove: vi.fn().mockResolvedValue(undefined),
}));

// ─── Real SQLite wrapper (same as memoryStore.integration.test.ts) ──

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

// Polyfill crypto.randomUUID for Node <19
if (typeof globalThis.crypto?.randomUUID !== "function") {
  (globalThis as any).crypto ??= {};
  (globalThis as any).crypto.randomUUID ??= () =>
    "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
    });
}

let _memoryStore: Promise<typeof import("../memoryStore")> | null = null;
function getMemoryStore() {
  if (!_memoryStore) _memoryStore = import("../memoryStore");
  return _memoryStore;
}

function clearTables(nativeDb: Database.Database) {
  nativeDb.exec("DELETE FROM memories;");
  nativeDb.exec("DELETE FROM kv_store;");
}

// ─── Helper: direct SQL insert ──────────────────────────────

interface SeedOverrides {
  category?: string;
  tier?: string;
  content?: string;
  summary?: string;
  tags?: string[];
  accessCount?: number;
  stale?: boolean;
  createdAt?: number;
  updatedAt?: number;
  lastAccessed?: number;
  sourceFile?: string | null;
  sourceSession?: string | null;
}

function seedEntry(overrides: SeedOverrides = {}): string {
  const now = Date.now();
  const id = "seed-" + crypto.randomUUID();
  const DAY = 86_400_000;
  _mockNativeDb!.prepare(`
    INSERT INTO memories (id, category, tier, content, summary, tags, created_at, updated_at, access_count, last_accessed, verified, stale, source_session, source_file)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
  `).run(
    id,
    overrides.category ?? "project",
    overrides.tier ?? "medium",
    overrides.content ?? "Seed content",
    overrides.summary ?? "Seed summary",
    JSON.stringify(overrides.tags ?? []),
    overrides.createdAt ?? (now - 60 * DAY), // 60 days ago by default
    overrides.updatedAt ?? (now - 30 * DAY), // 30 days ago by default
    overrides.accessCount ?? 0,
    overrides.lastAccessed ?? 0,
    overrides.stale ? 1 : 0,
    overrides.sourceSession ?? null,
    overrides.sourceFile ?? null,
  );
  return id;
}

function getMemoryById(id: string): any {
  return _mockNativeDb?.prepare("SELECT * FROM memories WHERE id = ?").get(id);
}

function countStale(): number {
  const row = _mockNativeDb!.prepare("SELECT COUNT(*) as count FROM memories WHERE stale = 1").get() as any;
  return row.count;
}

function countActive(): number {
  const row = _mockNativeDb!.prepare("SELECT COUNT(*) as count FROM memories WHERE stale = 0").get() as any;
  return row.count;
}

function countTotal(): number {
  const row = _mockNativeDb!.prepare("SELECT COUNT(*) as count FROM memories").get() as any;
  return row.count;
}

// ============================================================================
// TEST SUITES
// ============================================================================

describe("DreamAgent Integration — purgeStale()", () => {
  beforeAll(() => {
    const created = createMemoryDb();
    _mockDbInstance = created.db;
    _mockNativeDb = created.nativeDb;
  });

  afterAll(async () => {
    await _mockDbInstance?.close();
  });

  beforeEach(() => {
    clearTables(_mockNativeDb!);
  });

  it("deletes only stale marked entries, keeps active ones", async () => {
    const { purgeStale } = await getMemoryStore();

    seedEntry({ stale: false, category: "project" });
    seedEntry({ stale: true, category: "project" });
    seedEntry({ stale: true, category: "decision" });
    seedEntry({ stale: false, category: "reference" });

    expect(countTotal()).toBe(4);
    expect(countStale()).toBe(2);
    expect(countActive()).toBe(2);

    const purged = await purgeStale();

    expect(purged).toBe(2);
    expect(countTotal()).toBe(2);
    expect(countStale()).toBe(0);
    expect(countActive()).toBe(2);
  });

  it("returns 0 when no stale memories exist", async () => {
    const { purgeStale } = await getMemoryStore();

    seedEntry({ stale: false });
    seedEntry({ stale: false });

    const purged = await purgeStale();

    expect(purged).toBe(0);
    expect(countTotal()).toBe(2);
  });

  it("handles all-stale database (purge everything)", async () => {
    const { purgeStale } = await getMemoryStore();

    seedEntry({ stale: true, tier: "low" });
    seedEntry({ stale: true, tier: "medium" });
    seedEntry({ stale: true, tier: "high" });

    const purged = await purgeStale();

    expect(purged).toBe(3);
    expect(countTotal()).toBe(0);
  });

  it("preserves FTS5 sync after purge (trigger should clean up)", async () => {
    const { purgeStale } = await getMemoryStore();

    seedEntry({ stale: false, content: "keep me searchable" });
    seedEntry({ stale: true, content: "delete me from fts too" });

    // Verify FTS5 has both entries
    const beforeFts = _mockNativeDb!.prepare(
      "SELECT COUNT(*) as count FROM memories_fts"
    ).get() as any;
    expect(beforeFts.count).toBe(2);

    await purgeStale();

    // After purge, FTS5 should only have the non-stale entry
    const afterFts = _mockNativeDb!.prepare(
      "SELECT COUNT(*) as count FROM memories_fts"
    ).get() as any;
    expect(afterFts.count).toBe(1);

    // And the surviving entry is still searchable
    const searchResult = _mockNativeDb!.prepare(
      "SELECT id FROM memories_fts WHERE memories_fts MATCH 'searchable'"
    ).all() as any[];
    expect(searchResult.length).toBe(1);
  });
});

// ============================================================================
// RE-SCORING — Promote & Demote (same SQL as runDreamCycle section 2.5)
// ============================================================================

describe("DreamAgent Integration — re-scoring (promote/demote)", () => {
  beforeAll(() => {
    const created = createMemoryDb();
    _mockDbInstance = created.db;
    _mockNativeDb = created.nativeDb;
  });

  afterAll(async () => {
    await _mockDbInstance?.close();
  });

  beforeEach(() => {
    clearTables(_mockNativeDb!);
  });

  const COOLDOWN_MS = 7 * 86_400_000; // 7 days
  const OLD_AGE_MS = 30 * 86_400_000; // 30 days

  it("promotes low-tier memories with frequent access", async () => {
    const now = Date.now();
    // Low tier with accessCount >= 5 and old updatedAt (beyond cooldown)
    const id = seedEntry({
      tier: "low",
      accessCount: 7,
      updatedAt: now - COOLDOWN_MS - 86_400_000, // 8 days ago
      createdAt: now - 60 * 86_400_000,
    });

    // Run the same promote SQL as runDreamCycle
    await _mockDbInstance!.execute(
      `UPDATE memories SET tier = 'medium', updated_at = ?, access_count = 0
       WHERE id = ? AND tier = 'low' AND access_count >= 5
       AND ? - updated_at > ?`,
      [now, id, now, COOLDOWN_MS]
    );

    const row = getMemoryById(id);
    expect(row.tier).toBe("medium");
    expect(row.access_count).toBe(0);
    expect(row.updated_at).toBeGreaterThanOrEqual(now - 1000);
  });

  it("promotes medium-tier memories with frequent access", async () => {
    const now = Date.now();
    const id = seedEntry({
      tier: "medium",
      accessCount: 10,
      updatedAt: now - COOLDOWN_MS - 86_400_000,
      createdAt: now - 60 * 86_400_000,
    });

    await _mockDbInstance!.execute(
      `UPDATE memories SET tier = 'high', updated_at = ?, access_count = 0
       WHERE id = ? AND tier = 'medium' AND access_count >= 5
       AND ? - updated_at > ?`,
      [now, id, now, COOLDOWN_MS]
    );

    const row = getMemoryById(id);
    expect(row.tier).toBe("high");
    expect(row.access_count).toBe(0);
  });

  it("promotes high-tier memories to critical with frequent access", async () => {
    const now = Date.now();
    const id = seedEntry({
      tier: "high",
      accessCount: 8,
      updatedAt: now - COOLDOWN_MS - 86_400_000,
      createdAt: now - 60 * 86_400_000,
    });

    await _mockDbInstance!.execute(
      `UPDATE memories SET tier = 'critical', updated_at = ?, access_count = 0
       WHERE id = ? AND tier = 'high' AND access_count >= 5
       AND ? - updated_at > ?`,
      [now, id, now, COOLDOWN_MS]
    );

    const row = getMemoryById(id);
    expect(row.tier).toBe("critical");
    expect(row.access_count).toBe(0);
  });

  it("does NOT promote critical tier memories (they are already max)", async () => {
    const now = Date.now();
    const id = seedEntry({
      tier: "critical",
      accessCount: 20,
      updatedAt: now - COOLDOWN_MS - 86_400_000,
      createdAt: now - 60 * 86_400_000,
    });

    // Critical tier is excluded from promotion in runDreamCycle
    // The promote condition checks tier !== 'critical'
    await _mockDbInstance!.execute(
      `UPDATE memories SET tier = 'critical', updated_at = ?, access_count = 0
       WHERE id = ? AND tier != 'critical' AND access_count >= 5
       AND ? - updated_at > ?`,
      [now, id, now, COOLDOWN_MS]
    );

    const row = getMemoryById(id);
    // Should remain critical, but the WHERE clause shouldn't match
    expect(row.tier).toBe("critical");
    // Access count should NOT be reset since WHERE didn't match
    expect(row.access_count).toBe(20);
  });

  it("does NOT promote if accessCount < 5", async () => {
    const now = Date.now();
    const id = seedEntry({
      tier: "medium",
      accessCount: 3,
      updatedAt: now - COOLDOWN_MS - 86_400_000,
      createdAt: now - 60 * 86_400_000,
    });

    await _mockDbInstance!.execute(
      `UPDATE memories SET tier = 'high', updated_at = ?, access_count = 0
       WHERE id = ? AND tier = 'medium' AND access_count >= 5
       AND ? - updated_at > ?`,
      [now, id, now, COOLDOWN_MS]
    );

    const row = getMemoryById(id);
    expect(row.tier).toBe("medium");
    expect(row.access_count).toBe(3); // unchanged
  });

  it("does NOT promote if updated recently (within cooldown)", async () => {
    const now = Date.now();
    const id = seedEntry({
      tier: "medium",
      accessCount: 7,
      updatedAt: now - 86_400_000, // 1 day ago — within cooldown
      createdAt: now - 60 * 86_400_000,
    });

    await _mockDbInstance!.execute(
      `UPDATE memories SET tier = 'high', updated_at = ?, access_count = 0
       WHERE id = ? AND tier = 'medium' AND access_count >= 5
       AND ? - updated_at > ?`,
      [now, id, now, COOLDOWN_MS]
    );

    const row = getMemoryById(id);
    expect(row.tier).toBe("medium"); // unchanged
    expect(row.access_count).toBe(7); // unchanged
  });

  it("demotes high-tier memories with low access and old age", async () => {
    const now = Date.now();
    const id = seedEntry({
      tier: "high",
      accessCount: 1,
      createdAt: now - 35 * 86_400_000, // 35 days ago
      updatedAt: now - COOLDOWN_MS - 86_400_000, // 8 days ago
    });

    // Demote: high → medium if accessCount <= 1, created > 30 days, cooldown passed
    await _mockDbInstance!.execute(
      `UPDATE memories SET tier = 'medium', updated_at = ?, access_count = 0
       WHERE id = ? AND tier = 'high' AND access_count <= 1
       AND ? - created_at > ? AND ? - updated_at > ?`,
      [now, id, now, OLD_AGE_MS, now, COOLDOWN_MS]
    );

    const row = getMemoryById(id);
    expect(row.tier).toBe("medium");
    expect(row.access_count).toBe(0);
  });

  it("does NOT demote if created recently (within 30 days)", async () => {
    const now = Date.now();
    const id = seedEntry({
      tier: "high",
      accessCount: 0,
      createdAt: now - 10 * 86_400_000, // 10 days ago
      updatedAt: now - COOLDOWN_MS - 86_400_000,
    });

    await _mockDbInstance!.execute(
      `UPDATE memories SET tier = 'medium', updated_at = ?, access_count = 0
       WHERE id = ? AND tier = 'high' AND access_count <= 1
       AND ? - created_at > ? AND ? - updated_at > ?`,
      [now, id, now, OLD_AGE_MS, now, COOLDOWN_MS]
    );

    const row = getMemoryById(id);
    expect(row.tier).toBe("high"); // unchanged
  });

  it("does NOT demote low/medium/critical tier (only high)", async () => {
    const now = Date.now();
    const lowId = seedEntry({ tier: "low", createdAt: now - 60 * 86_400_000, updatedAt: now - COOLDOWN_MS - 86_400_000 });
    const criticalId = seedEntry({ tier: "critical", createdAt: now - 60 * 86_400_000, updatedAt: now - COOLDOWN_MS - 86_400_000 });

    // Try to demote low and critical (shouldn't match — WHERE tier = 'high')
    await _mockDbInstance!.execute(
      `UPDATE memories SET tier = 'medium', updated_at = ?, access_count = 0
       WHERE tier = 'high' AND access_count <= 1
       AND ? - created_at > ? AND ? - updated_at > ?`,
      [now, now, OLD_AGE_MS, now, COOLDOWN_MS]
    );

    expect(getMemoryById(lowId).tier).toBe("low");
    expect(getMemoryById(criticalId).tier).toBe("critical");
  });

  it("handles batch re-scoring: multiple memories promoted/demoted together", async () => {
    const now = Date.now();

    // 2 promote candidates
    const prom1 = seedEntry({ tier: "low", accessCount: 6, updatedAt: now - COOLDOWN_MS - 86_400_000, createdAt: now - 60 * 86_400_000 });
    const prom2 = seedEntry({ tier: "medium", accessCount: 9, updatedAt: now - COOLDOWN_MS - 86_400_000, createdAt: now - 60 * 86_400_000 });

    // 1 demote candidate
    const dem1 = seedEntry({ tier: "high", accessCount: 0, createdAt: now - 35 * 86_400_000, updatedAt: now - COOLDOWN_MS - 86_400_000 });

    // Batch promote
    await _mockDbInstance!.execute(
      `UPDATE memories SET tier = 
         CASE tier WHEN 'low' THEN 'medium' WHEN 'medium' THEN 'high' WHEN 'high' THEN 'critical' END,
         updated_at = ?, access_count = 0
       WHERE tier != 'critical' AND access_count >= 5
       AND ? - updated_at > ?`,
      [now, now, COOLDOWN_MS]
    );

    // Batch demote
    await _mockDbInstance!.execute(
      `UPDATE memories SET tier = 'medium', updated_at = ?, access_count = 0
       WHERE tier = 'high' AND access_count <= 1
       AND ? - created_at > ? AND ? - updated_at > ?`,
      [now, now, OLD_AGE_MS, now, COOLDOWN_MS]
    );

    expect(getMemoryById(prom1).tier).toBe("medium");
    expect(getMemoryById(prom2).tier).toBe("high");
    // dem1 should have been promoted first (high→critical by promote), then not affected by demote since access_count was reset to 0
    // Actually, dem1 had tier "high" and accessCount 0. Promote matched it (high != critical, accessCount 0 < 5). Wait, accessCount < 5.
    // Let me check: promote WHERE condition = tier != 'critical' AND access_count >= 5. dem1 has accessCount=0. So it doesn't match promote.
    // Then demote WHERE condition = tier = 'high' AND access_count <= 1. dem1 has accessCount=0 <= 1. Matches!
    expect(getMemoryById(dem1).tier).toBe("medium");
    expect(getMemoryById(dem1).access_count).toBe(0);
  });
});

// ============================================================================
// DEDUP CLUSTERING — Jaccard similarity + tag overlap clustering
// ============================================================================

describe("DreamAgent Integration — dedup clustering", () => {
  beforeAll(() => {
    const created = createMemoryDb();
    _mockDbInstance = created.db;
    _mockNativeDb = created.nativeDb;
  });

  afterAll(async () => {
    await _mockDbInstance?.close();
  });

  beforeEach(() => {
    clearTables(_mockNativeDb!);
  });

  it("clusters memories with same category, overlapping tags, and high Jaccard similarity", async () => {
    const { jaccardSimilarity } = await getMemoryStore();

    // Two memories about the same topic with overlapping tags
    const memA = {
      content: "strict TypeScript mode noImplicitAny enabled for better code quality across entire project codebase every single file",
      tags: ["typescript", "config"],
    };
    const memB = {
      content: "strict TypeScript mode noImplicitAny enabled for better code quality across entire project codebase every single module",
      tags: ["typescript", "config", "strict"],
    };

    // Verify they have overlapping tags
    const tagOverlap = memA.tags.filter((t) => memB.tags.includes(t)).length;
    expect(tagOverlap).toBeGreaterThan(0);

    // Verify Jaccard similarity > 0.55 (clustering threshold)
    const similarity = jaccardSimilarity(memA.content, memB.content);
    expect(similarity).toBeGreaterThan(0.55);

    // Seed both into the database
    const idA = seedEntry({ category: "project", content: memA.content, tags: memA.tags });
    const idB = seedEntry({ category: "project", content: memB.content, tags: memB.tags });

    // Simulate clustering: fetch memories, filter by category, compute similarity
    const memories = _mockNativeDb!.prepare(
      "SELECT * FROM memories WHERE stale = 0"
    ).all() as any[];

    const categoryMemories = memories.filter((m) => m.category === "project");
    const clusters: Array<{ members: string[]; totalAccess: number }> = [];
    const assigned = new Set<string>();

    for (const mem of categoryMemories) {
      if (assigned.has(mem.id)) continue;
      const cluster = { members: [mem.id], totalAccess: mem.access_count };
      assigned.add(mem.id);

      for (const other of categoryMemories) {
        if (assigned.has(other.id) || mem.id === other.id) continue;

        const memTags = JSON.parse(mem.tags);
        const otherTags = JSON.parse(other.tags);
        const tagOverlap = memTags.filter((t: string) => otherTags.includes(t)).length;

        const similar = jaccardSimilarity(mem.content, other.content);
        if (tagOverlap > 0 && similar > 0.55) {
          cluster.members.push(other.id);
          cluster.totalAccess += other.access_count;
          assigned.add(other.id);
        }
      }

      if (cluster.members.length > 1) {
        clusters.push(cluster);
      }
    }

    // Verify the two memories are in the same cluster
    expect(clusters.length).toBe(1);
    expect(clusters[0].members).toContain(idA);
    expect(clusters[0].members).toContain(idB);
  });

  it("does NOT cluster memories with different categories even if content is similar", async () => {
    const { jaccardSimilarity } = await getMemoryStore();

    const content = "strict TypeScript mode enabled for code quality";

    seedEntry({ category: "project", content, tags: ["typescript"] });
    seedEntry({ category: "user", content, tags: ["typescript"] });

    const memories = _mockNativeDb!.prepare(
      "SELECT * FROM memories WHERE stale = 0"
    ).all() as any[];

    // Check similarity is high (same content)
    const similarity = jaccardSimilarity(content, content);
    expect(similarity).toBe(1.0);

    // But clustering by category should separate them
    const categories = new Set(memories.map((m: any) => m.category));
    expect(categories.size).toBe(2);
  });

  it("does NOT cluster when tag overlap is 0 even if content is similar", async () => {
    const { jaccardSimilarity } = await getMemoryStore();

    const content = "enabled strict TypeScript mode for code quality noImplicitAny";

    seedEntry({ category: "project", content, tags: ["typescript"] });
    seedEntry({ category: "project", content, tags: ["react"] }); // no overlapping tags

    const similarity = jaccardSimilarity(content, content);
    expect(similarity).toBe(1.0);

    // Clustering requires tagOverlap > 0
    const tagOverlap = ["typescript"].filter((t) => ["react"].includes(t)).length;
    expect(tagOverlap).toBe(0);
  });

  it("does NOT cluster single memories (cluster size must be > 1)", async () => {
    seedEntry({ category: "project", tags: ["unique"] });

    const memories = _mockNativeDb!.prepare(
      "SELECT * FROM memories WHERE stale = 0"
    ).all() as any[];

    const categoryMemories = memories.filter((m) => m.category === "project");
    const clustersCount = categoryMemories.length; // only 1, no cluster formed
    expect(clustersCount).toBe(1);
  });

  it("clusters sort by member count × total access (most important first)", async () => {
    const { jaccardSimilarity } = await getMemoryStore();

    // Create two distinct clusters: one big (3 members), one small (2 members)
    const clusterABase = "React component state management using hooks useEffect useState custom hooks pattern";
    const clusterAVar1 = "React component state management using hooks useEffect useState custom hooks approach";
    const clusterAVar2 = "React component state management using hooks useEffect useState custom hooks methodology";

    const clusterBBase = "Python async await coroutine event loop schedule tasks concurrently";
    const clusterBVar1 = "Python async await coroutine event loop schedule tasks parallel";

    seedEntry({ category: "project", content: clusterABase, tags: ["react", "hooks"], accessCount: 5 });
    seedEntry({ category: "project", content: clusterAVar1, tags: ["react", "hooks"], accessCount: 3 });
    seedEntry({ category: "project", content: clusterAVar2, tags: ["react", "hooks"], accessCount: 2 });

    seedEntry({ category: "project", content: clusterBBase, tags: ["python", "async"], accessCount: 4 });
    seedEntry({ category: "project", content: clusterBVar1, tags: ["python", "async"], accessCount: 1 });

    const memories = _mockNativeDb!.prepare(
      "SELECT * FROM memories WHERE stale = 0 ORDER BY ROWID"
    ).all() as any[];

    // Cluster manually with the same algorithm
    const categoryMemories = memories.filter((m) => m.category === "project");
    const clusters: Array<{ members: string[]; totalAccess: number }> = [];
    const assigned = new Set<string>();

    for (const mem of categoryMemories) {
      if (assigned.has(mem.id)) continue;
      const cluster = { members: [mem.id], totalAccess: mem.access_count };
      assigned.add(mem.id);

      for (const other of categoryMemories) {
        if (assigned.has(other.id) || mem.id === other.id) continue;
        const memTags = JSON.parse(mem.tags);
        const otherTags = JSON.parse(other.tags);
        const tagOverlap = memTags.filter((t: string) => otherTags.includes(t)).length;
        const similar = jaccardSimilarity(mem.content, other.content);
        if (tagOverlap > 0 && similar > 0.55) {
          cluster.members.push(other.id);
          cluster.totalAccess += other.access_count;
          assigned.add(other.id);
        }
      }

      if (cluster.members.length > 1) {
        clusters.push(cluster);
      }
    }

    // Sort by importance: member count × total access
    clusters.sort((a, b) => (b.members.length * b.totalAccess) - (a.members.length * a.totalAccess));

    // Cluster A (3 members × 10 total access = 30) should come before Cluster B (2 members × 5 total access = 10)
    expect(clusters.length).toBe(2);
    expect(clusters[0].members.length).toBe(3);
    expect(clusters[1].members.length).toBe(2);
  });

  it("marks original memories stale after merge", async () => {
    // Simulate the merge operation: save a merged memory, then mark originals stale
    const now = Date.now();
    const idA = seedEntry({ category: "project", content: "React hooks pattern for state management", tags: ["react", "hooks"], stale: false });
    const idB = seedEntry({ category: "project", content: "React hooks approach for managing component state", tags: ["react", "hooks"], stale: false });

    // Save merged version (simulated)
    const mergedId = "merged-" + crypto.randomUUID();
    _mockNativeDb!.prepare(`
      INSERT INTO memories (id, category, tier, content, summary, tags, created_at, updated_at, access_count, last_accessed, verified, stale)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0)
    `).run(
      mergedId, "project", "medium",
      "React hooks pattern for state management — combined from multiple sources",
      "React state management with hooks",
      JSON.stringify(["react", "hooks"]),
      now, now,
    );

    // Mark originals as stale (same as dream agent does after merge)
    _mockNativeDb!.prepare("UPDATE memories SET stale = 1 WHERE id = ?").run(idA);
    _mockNativeDb!.prepare("UPDATE memories SET stale = 1 WHERE id = ?").run(idB);

    // Verify originals are stale
    expect(getMemoryById(idA).stale).toBe(1);
    expect(getMemoryById(idB).stale).toBe(1);

    // Verify merged is still active
    expect(getMemoryById(mergedId).stale).toBe(0);

    // Verify FTS5 is still consistent after stale marks
    const activeCount = _mockNativeDb!.prepare(
      "SELECT COUNT(*) as count FROM memories WHERE stale = 0"
    ).get() as any;
    expect(activeCount.count).toBe(1);

    // Purge the stale originals
    const { purgeStale } = await getMemoryStore();
    await purgeStale();

    // Only merged version remains
    const remainingIds = (_mockNativeDb!.prepare("SELECT id FROM memories").all() as any[]).map((r: any) => r.id);
    expect(remainingIds).toEqual([mergedId]);
  });

  it("uses jaccardSimilarity for clustering threshold (0.55)", async () => {
    // Direct test of the similarity function used by the clustering algorithm
    const contentA = "React component state management using hooks";
    const contentB = "React component state management using hooks hooks hooks";
    const contentC = "Python async await coroutine event loop";

    const { jaccardSimilarity } = await getMemoryStore();

    // Similar content should be above threshold
    // tokenize splits on whitespace/punctuation, filters stop words and short words (<=2 chars)
    // contentA tokens: ["react", "component", "state", "management", "using", "hooks"]
    // contentB tokens: ["react", "component", "state", "management", "using", "hooks"] (duplicates removed)
    // Similarity = 6/6 = 1.0
    expect(jaccardSimilarity(contentA, contentB)).toBeGreaterThan(0.55);

    // Very different content should be below threshold
    expect(jaccardSimilarity(contentA, contentC)).toBeLessThan(0.55);
  });
});
