/**
 * ============================================================
 * DALAM DATABASE — SQLite + FTS5 via @tauri-apps/plugin-sql
 * ============================================================
 *
 * Minimal interface for the @tauri-apps/plugin-sql Database instance.
 * We only use `execute()` and `close()` from the driver.
 */
interface SqlDatabase {
  execute(sql: string, bindValues?: unknown[]): Promise<{ rowsAffected: number }>;
  select(sql: string, bindValues?: unknown[]): Promise<unknown[]>;
  close(): Promise<void>;
}

/**
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

let dbInstance: SqlDatabase | null = null;
let currentWorkspacePath: string | null = null;
let dbLoadingPromise: Promise<SqlDatabase | null> | null = null;
let dbLoadingWorkspace: string | null = null;

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

const GENES_TABLE = `
CREATE TABLE IF NOT EXISTS genes (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  description      TEXT NOT NULL,
  trigger_pattern  TEXT NOT NULL,
  action           TEXT NOT NULL,
  category         TEXT NOT NULL,
  confidence       REAL NOT NULL DEFAULT 0.5,
  activation_count INTEGER NOT NULL DEFAULT 0,
  success_count    INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL,
  last_activated   INTEGER NOT NULL DEFAULT 0,
  source           TEXT NOT NULL DEFAULT 'session',
  tags             TEXT NOT NULL DEFAULT '[]',
  workspace_id     TEXT
);`;

const KV_STORE_TABLE = `
CREATE TABLE IF NOT EXISTS kv_store (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);`;

const CODE_INDEX_TABLE = `
CREATE TABLE IF NOT EXISTS code_index (
  id          TEXT PRIMARY KEY,
  file_path   TEXT NOT NULL,
  file_name   TEXT NOT NULL,
  content     TEXT NOT NULL,
  language    TEXT,
  size_bytes  INTEGER,
  indexed_at  INTEGER NOT NULL
);`;

const CODE_INDEX_FTS = `
CREATE VIRTUAL TABLE IF NOT EXISTS code_index_fts USING fts5(
  id UNINDEXED,
  file_path,
  file_name,
  content,
  language UNINDEXED,
  content='code_index',
  content_rowid='rowid'
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

// ─── Path Normalization ──────────────────────────────────────

/**
 * Normalize a workspace path for use in SQLite connection strings.
 * Converts Windows backslashes to forward slashes and ensures the path
 * starts with a leading slash (as required by sqlite: URI scheme).
 *
 * Windows examples:
 *   "C:\\Users\\me\\project" → "C:/Users/me/project"
 *   "D:\\dev\\app"           → "D:/dev/app"
 *   "\\\" (already posix)    → "/"
 *
 * Unix examples:
 *   "/home/user/project" → "/home/user/project"
 *
 * Returns the full sqlite: URI string.
 */
export function normalizeDbPath(workspacePath: string): string {
  // Convert backslashes to forward slashes (Windows compatibility)
  let normalized = workspacePath.replace(/\\/g, "/");

  // Empty string → minimal relative path
  if (normalized === "") {
    return "sqlite:/.dalam/project.db";
  }

  // Strip trailing slashes (except root path "/" which stays as-is)
  if (normalized.length > 1) {
    normalized = normalized.replace(/\/+$/, "");
  }

  // Ensure absolute path prefix for sqlite: URI scheme
  const absPath = normalized.startsWith("/") ? normalized : `/${normalized}`;
  return `sqlite:${absPath}/.dalam/project.db`;
}

// ─── Initialization ──────────────────────────────────────────

/**
 * Initialize the SQLite database for a workspace.
 * Creates tables and FTS5 indexes if they don't exist.
 * Returns the Database instance for queries.
 *
 * The database file is stored at <workspacePath>/.dalam/project.db.
 * This file should be gitignored — it's a local cache.
 */
export async function initDatabase(workspacePath: string): Promise<SqlDatabase | null> {
  if (dbInstance && currentWorkspacePath === workspacePath) return dbInstance;
  // Prevent concurrent init calls from leaking connections
  // Only await if the same workspace is being initialized
  if (dbLoadingPromise && dbLoadingWorkspace === workspacePath) {
    await dbLoadingPromise;
    if (dbInstance && currentWorkspacePath === workspacePath) return dbInstance;
  }
  // If a different workspace is loading, wait for it to finish first,
  // then re-check — the concurrent init may have already set dbInstance
  if (dbLoadingPromise && dbLoadingWorkspace !== workspacePath) {
    await dbLoadingPromise;
    // Re-check: if the concurrent init opened our workspace, return it
    if (dbInstance && currentWorkspacePath === workspacePath) return dbInstance;
  }
  if (dbInstance) {
    await closeDatabase();
  }

  let Database: { load(path: string): Promise<SqlDatabase> };
  try {
    Database = (await import("@tauri-apps/plugin-sql")).default as unknown as { load(path: string): Promise<SqlDatabase> };
  } catch (e) {
    console.warn("[Database] SQLite plugin not available, memory search disabled:", e);
    return null;
  }

  const dbPath = normalizeDbPath(workspacePath);

  // Ensure .dalam directory exists before opening database
  try {
    const { exists, mkdir } = await import("@tauri-apps/plugin-fs");
    // Use normalizeDbPath's internal logic: backslash -> /, then strip the sqlite: prefix
    // to get the canonical path for filesystem operations
    const dbPathForDir = normalizeDbPath(workspacePath).replace(/^sqlite:/, "");
    const dotDalam = dbPathForDir.replace(/\/project\.db$/, "");
    if (!(await exists(dotDalam))) {
      await mkdir(dotDalam, { recursive: true });
    }
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    if (msg.includes("forbidden") || msg.includes("scope")) {
      console.debug("[Database] Workspace inaccessible, memory disabled:", workspacePath);
      return null;
    }
    // mkdir may fail if already exists or permissions — proceed anyway
  }

  const initWork = async (): Promise<SqlDatabase | null> => {
    let db: SqlDatabase | null;
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
    await db.execute(GENES_TABLE);
    await db.execute(KV_STORE_TABLE);
    await db.execute(CODE_INDEX_TABLE);
    await db.execute(CODE_INDEX_FTS);

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
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_genes_workspace ON genes(workspace_id);`);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_genes_confidence ON genes(confidence);`);

    // Code index triggers
    await db.execute(`
      CREATE TRIGGER IF NOT EXISTS code_index_ai AFTER INSERT ON code_index BEGIN
        INSERT INTO code_index_fts(rowid, id, file_path, file_name, content, language)
        VALUES (new.rowid, new.id, new.file_path, new.file_name, new.content, new.language);
      END;
    `);
    await db.execute(`
      CREATE TRIGGER IF NOT EXISTS code_index_ad AFTER DELETE ON code_index BEGIN
        INSERT INTO code_index_fts(code_index_fts, rowid, id, file_path, file_name, content, language)
        VALUES ('delete', old.rowid, old.id, old.file_path, old.file_name, old.content, old.language);
      END;
    `);
    await db.execute(`
      CREATE TRIGGER IF NOT EXISTS code_index_au AFTER UPDATE ON code_index BEGIN
        INSERT INTO code_index_fts(code_index_fts, rowid, id, file_path, file_name, content, language)
        VALUES ('delete', old.rowid, old.id, old.file_path, old.file_name, old.content, old.language);
        INSERT INTO code_index_fts(rowid, id, file_path, file_name, content, language)
        VALUES (new.rowid, new.id, new.file_path, new.file_name, new.content, new.language);
      END;
    `);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_code_path ON code_index(file_path);`);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_code_lang ON code_index(language);`);

    return db;
  };

  dbLoadingWorkspace = workspacePath;
  dbLoadingPromise = initWork();
  let db: SqlDatabase | null;
  try {
    db = await dbLoadingPromise;
  } catch (error) {
    dbInstance = null;
    throw error;
  } finally {
    dbLoadingPromise = null;
    dbLoadingWorkspace = null;
  }

  // Only set dbInstance if nothing is set yet, or we're switching to a
  // different workspace. This prevents concurrent inits from clobbering.
  if (db && (!dbInstance || currentWorkspacePath !== workspacePath)) {
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
 * Throws if not initialized.
 */
export function getDb(): SqlDatabase {
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
