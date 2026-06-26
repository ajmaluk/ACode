/**
 * ============================================================
 * DALAM DATABASE — SQLite + FTS5 via @tauri-apps/plugin-sql
 * ============================================================
 *
 * Initializes two logical databases:
 *   - project.db  — persistent, per-workspace (.dalam/project.db)
 *     Stores memories with FTS5 full-text search index.
 *     Source of truth lives in .dalam/memories/*.md (git-friendly).
 *     project.db is a local cache rebuilt from markdown on loss.
 *
 * Schema:
 *   memories       — main memory table
 *   memories_fts   — FTS5 virtual table for full-text search
 *   triggers       — keep FTS5 in sync on INSERT/UPDATE/DELETE
 *
 * Usage:
 *   const db = await initDatabase(workspacePath);
 *   // db is ready for queries
 * ============================================================
 */

import { joinPath } from "@/lib/pathUtils"; // eslint-disable-line @typescript-eslint/no-unused-vars

let dbInstance: any = null;
let currentWorkspacePath: string | null = null;
let dbLoadingPromise: Promise<any> | null = null;

// ─── Schema ──────────────────────────────────────────────────

const MEMORY_TABLE = `
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
);`;

const FTS_TABLE = `
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  id UNINDEXED,
  content,
  summary,
  tags,
  category UNINDEXED,
  content='memories',
  content_rowid='rowid'
);`;

// Triggers and Indexes are executed individually in initDatabase to ensure driver compatibility

// ─── Initialization ──────────────────────────────────────────

/**
 * Initialize the SQLite database for a workspace.
 * Creates tables and FTS5 indexes if they don't exist.
 * Returns the Database instance for queries.
 *
 * The database file is stored at <workspacePath>/.dalam/project.db.
 * This file should be gitignored — it's a local cache.
 */
export async function initDatabase(workspacePath: string): Promise<any> {
  if (dbInstance && currentWorkspacePath === workspacePath) return dbInstance;
  // Prevent concurrent init calls from leaking connections
  if (dbLoadingPromise) {
    await dbLoadingPromise;
    if (dbInstance && currentWorkspacePath === workspacePath) return dbInstance;
  }
  if (dbInstance) {
    await closeDatabase();
  }

  let Database: any;
  try {
    Database = (await import("@tauri-apps/plugin-sql")).default;
  } catch (e) {
    console.warn("[Database] SQLite plugin not available, memory search disabled:", e);
    return null;
  }

  const absPath = workspacePath.startsWith("/") ? workspacePath : `/${workspacePath}`;
  const dbPath = `sqlite:${absPath}/.dalam/project.db`;

  // Ensure .dalam directory exists before opening database
  try {
    const { exists, mkdir } = await import("@tauri-apps/plugin-fs");
    const dotDalam = absPath + "/.dalam";
    if (!(await exists(dotDalam))) {
      await mkdir(dotDalam, { recursive: true });
    }
  } catch {
    // mkdir may fail if already exists or permissions — proceed anyway
  }

  const initWork = async (): Promise<any> => {
    let db: any;
    try {
      db = await Database.load(dbPath);
    } catch (e) {
      const errMsg = (e as Error)?.message ?? String(e);
      if (errMsg.includes("No database driver") || errMsg.includes("driver")) {
        console.warn("[Database] SQLite driver not enabled. Add `features = [\"sqlite\"]` to tauri-plugin-sql in Cargo.toml.");
      } else {
        console.warn("[Database] Failed to load database at", dbPath, ":", e);
      }
      return null;
    }

    // Create tables
    await db.execute(MEMORY_TABLE);
    await db.execute(FTS_TABLE);

    // Create triggers individually
    await db.execute(`
      CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, id, content, summary, tags, category)
        VALUES (new.rowid, new.id, new.content, new.summary, new.tags, new.category);
      END;
    `);
    await db.execute(`
      CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, id, content, summary, tags, category)
        VALUES ('delete', old.rowid, old.id, old.content, old.summary, old.tags, old.category);
      END;
    `);
    await db.execute(`
      CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, id, content, summary, tags, category)
        VALUES ('delete', old.rowid, old.id, old.content, old.summary, old.tags, old.category);
        INSERT INTO memories_fts(rowid, id, content, summary, tags, category)
        VALUES (new.rowid, new.id, new.content, new.summary, new.tags, new.category);
      END;
    `);

    // Create indexes individually
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_mem_category ON memories(category);`);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_mem_tier     ON memories(tier);`);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_mem_stale    ON memories(stale);`);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_mem_accessed ON memories(last_accessed);`);

    return db;
  };

  dbLoadingPromise = initWork();
  let db: any;
  try {
    db = await dbLoadingPromise;
  } catch (error) {
    dbInstance = null;
    throw error;
  } finally {
    dbLoadingPromise = null;
  }

  if (db) {
    dbInstance = db;
    currentWorkspacePath = workspacePath;
  }
  return db;
}

/**
 * Check if the database is initialized and ready.
 */
export function isDatabaseReady(): boolean {
  return dbInstance !== null;
}

/**
 * Get the current database instance.
 * Returns null if not initialized (instead of throwing).
 */
export function getDb(): any {
  if (!dbInstance) {
    throw new Error("Database not initialized. Call initDatabase() first.");
  }
  return dbInstance;
}

/**
 * Close the database connection.
 * Call when the workspace is closed.
 */
export async function closeDatabase(): Promise<void> {
  if (dbInstance) {
    try {
      await dbInstance.close();
    } catch {
      // close() may not exist on older plugin versions
    }
    dbInstance = null;
    currentWorkspacePath = null;
  }
}
