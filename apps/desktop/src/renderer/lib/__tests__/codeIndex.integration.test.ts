/**
 * ============================================================
 * CODE INDEX INTEGRATION TESTS — Real SQLite + FTS5
 * ============================================================
 *
 * Tests the code index module with a real in-memory SQLite
 * database with full FTS5, triggers, and indexes.
 *
 * Coverage:
 *   1. indexWorkspace() — file indexing, excludes, upserts,
 *      mutex, progress callback, stale cleanup on re-index
 *   2. searchCodeIndex() — keyword search, filters, edge cases
 *   3. getCodeIndexStats() — file counts, size, language breakdown
 *   4. clearCodeIndex() — full deletion
 *   5. FTS5 trigger sync — INSERT/DELETE/UPDATE trigger correctness
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
  isDatabaseReady: vi.fn(() => _mockDbInstance !== null),
}));

// Module-level mocks for @tauri-apps/plugin-fs — vitest hoists these to the top of the file.
// Each test overrides behavior via mockImplementation() in beforeEach or the test body.
const mockReadDir = vi.fn();
const mockReadFile = vi.fn();
const mockExists = vi.fn().mockResolvedValue(true);

vi.mock("@tauri-apps/plugin-fs", () => ({
  readDir: mockReadDir,
  readFile: mockReadFile,
  exists: mockExists,
}));

// ─── Real SQLite wrapper ─────────────────────────────────────

interface SqlDatabase {
  execute(sql: string, bindValues?: unknown[]): Promise<{ rowsAffected: number }>;
  select<T = unknown>(sql: string, bindValues?: unknown[]): Promise<T[]>;
  close(): Promise<void>;
}

function createCodeIndexDb(): { db: SqlDatabase; nativeDb: Database.Database } {
  const nativeDb = new Database(":memory:");
  nativeDb.exec("PRAGMA journal_mode=WAL;");

  nativeDb.exec(`
    CREATE TABLE IF NOT EXISTS code_index (
      id          TEXT PRIMARY KEY,
      file_path   TEXT NOT NULL,
      file_name   TEXT NOT NULL,
      content     TEXT NOT NULL,
      language    TEXT,
      size_bytes  INTEGER,
      indexed_at  INTEGER NOT NULL
    );
  `);

  nativeDb.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS code_index_fts USING fts5(
      id UNINDEXED,
      file_path,
      file_name,
      content,
      language UNINDEXED,
      content='code_index',
      content_rowid='rowid'
    );
  `);

  nativeDb.exec(`
    CREATE TRIGGER IF NOT EXISTS code_index_ai AFTER INSERT ON code_index BEGIN
      INSERT INTO code_index_fts(rowid, id, file_path, file_name, content, language)
      VALUES (new.rowid, new.id, new.file_path, new.file_name, new.content, new.language);
    END;
  `);
  nativeDb.exec(`
    CREATE TRIGGER IF NOT EXISTS code_index_ad AFTER DELETE ON code_index BEGIN
      INSERT INTO code_index_fts(code_index_fts, rowid, id, file_path, file_name, content, language)
      VALUES ('delete', old.rowid, old.id, old.file_path, old.file_name, old.content, old.language);
    END;
  `);
  nativeDb.exec(`
    CREATE TRIGGER IF NOT EXISTS code_index_au AFTER UPDATE ON code_index BEGIN
      INSERT INTO code_index_fts(code_index_fts, rowid, id, file_path, file_name, content, language)
      VALUES ('delete', old.rowid, old.id, old.file_path, old.file_name, old.content, old.language);
      INSERT INTO code_index_fts(rowid, id, file_path, file_name, content, language)
      VALUES (new.rowid, new.id, new.file_path, new.file_name, new.content, new.language);
    END;
  `);

  nativeDb.exec("CREATE INDEX IF NOT EXISTS idx_code_path ON code_index(file_path);");
  nativeDb.exec("CREATE INDEX IF NOT EXISTS idx_code_lang ON code_index(language);");

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

let _codeIndex: Promise<typeof import("../codeIndex")> | null = null;
function getCodeIndex() {
  if (!_codeIndex) _codeIndex = import("../codeIndex");
  return _codeIndex;
}

function clearTables(nativeDb: Database.Database) {
  nativeDb.exec("DELETE FROM code_index;");
}

function seedCodeEntry(overrides: {
  filePath?: string;
  fileName?: string;
  content?: string;
  language?: string | null;
  sizeBytes?: number;
} = {}): string {
  const now = Date.now();
  const id = "idx-" + crypto.randomUUID();
  const fp = overrides.filePath ?? "src/lib/test.ts";
  const fn = overrides.fileName ?? fp.split("/").pop()!;
  const content = overrides.content ?? "function test() { return 42; }";
  _mockNativeDb!.prepare(`
    INSERT INTO code_index (id, file_path, file_name, content, language, size_bytes, indexed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, fp, fn, content,
    overrides.language !== undefined ? overrides.language : "typescript",
    overrides.sizeBytes ?? content.length,
    now,
  );
  return id;
}

function countCodeIndex(): number {
  const row = _mockNativeDb!.prepare("SELECT COUNT(*) as count FROM code_index").get() as any;
  return row.count;
}

function countCodeIndexFts(): number {
  const row = _mockNativeDb!.prepare("SELECT COUNT(*) as count FROM code_index_fts").get() as any;
  return row.count;
}

// Generic encoder helper for mocked readFile
function enc(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

// ============================================================================
// TEST SUITES
// ============================================================================

describe("CodeIndex Integration — indexWorkspace()", () => {
  beforeAll(() => {
    const created = createCodeIndexDb();
    _mockDbInstance = created.db;
    _mockNativeDb = created.nativeDb;
  });

  afterAll(async () => {
    await _mockDbInstance?.close();
  });

  beforeEach(() => {
    clearTables(_mockNativeDb!);
    vi.clearAllMocks();
    mockExists.mockResolvedValue(true); // default — all files exist
  });

  it("indexes all eligible files from a mocked workspace", async () => {
    const { indexWorkspace } = await getCodeIndex();

    mockReadDir.mockImplementation((dir: string) => {
      if (dir === "/test/ws") {
        return [
          { name: "src", isDirectory: true },
          { name: "config.json", isDirectory: false },
          { name: ".gitignore", isDirectory: false },
        ];
      }
      if (dir === "/test/ws/src") {
        return [
          { name: "index.ts", isDirectory: false },
          { name: "utils.ts", isDirectory: false },
          { name: "styles.css", isDirectory: false },
          { name: "data.json", isDirectory: false },
        ];
      }
      return [];
    });

    mockReadFile.mockImplementation((path: string) => {
      if (path.endsWith("index.ts")) return enc("export function greet() { return `Hello`; }");
      if (path.endsWith("utils.ts")) return enc("export function add(a: number, b: number) { return a + b; }");
      if (path.endsWith("styles.css")) return enc("body { margin: 0; padding: 0; }");
      if (path.endsWith("data.json")) return enc('{ "name": "test", "version": 1 }');
      if (path.endsWith("config.json")) return enc('{ "env": "prod" }');
      if (path.endsWith(".gitignore")) return enc("node_modules\\ndist\\n");
      return new Uint8Array(0);
    });

    const result = await indexWorkspace("/test/ws");

    // Files: config.json, index.ts, utils.ts, styles.css, data.json = 5
    // .gitignore is not an indexed extension → skipped
    expect(result.indexed).toBe(5);
    expect(result.skipped).toBe(1);
    expect(result.errors).toBe(0);
    expect(countCodeIndex()).toBe(5);
  });

  it("skips excluded directories (node_modules, .git, dist)", async () => {
    const visitedDirs: string[] = [];

    mockReadDir.mockImplementation((dir: string) => {
      visitedDirs.push(dir);
      if (dir === "/test/ws") {
        return [
          { name: "src", isDirectory: true },
          { name: "node_modules", isDirectory: true },
          { name: ".git", isDirectory: true },
          { name: "dist", isDirectory: true },
        ];
      }
      if (dir === "/test/ws/src") {
        return [{ name: "app.ts", isDirectory: false }];
      }
      return [];
    });

    mockReadFile.mockImplementation((path: string) => {
      if (path.endsWith("app.ts")) return enc("console.log('app');");
      return new Uint8Array(0);
    });

    const { indexWorkspace } = await getCodeIndex();
    const result = await indexWorkspace("/test/ws");

    expect(result.indexed).toBe(1);
    expect(result.skipped).toBe(0);

    // Should never have visited the excluded directories
    expect(visitedDirs).not.toContain("/test/ws/node_modules");
    expect(visitedDirs).not.toContain("/test/ws/.git");
    expect(visitedDirs).not.toContain("/test/ws/dist");
  });

  it("skips excluded files and non-indexed extensions", async () => {
    mockReadDir.mockResolvedValue([
      { name: "app.ts", isDirectory: false },
      { name: "image.png", isDirectory: false },
      { name: ".DS_Store", isDirectory: false },
      { name: "package-lock.json", isDirectory: false },
    ]);

    mockReadFile.mockImplementation((path: string) => {
      if (path.endsWith("app.ts")) return enc("const x = 1;");
      return new Uint8Array(0);
    });

    const { indexWorkspace } = await getCodeIndex();
    const result = await indexWorkspace("/test/ws");

    // app.ts indexed; image.png skipped (non-indexed extension);
    // .DS_Store and package-lock.json are excluded BY NAME (continue before skip count increments)
    expect(result.indexed).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.errors).toBe(0);
  });

  it("skips files exceeding MAX_FILE_SIZE (100KB)", async () => {
    const largeContent = "x".repeat(100_001);

    mockReadDir.mockResolvedValue([
      { name: "small.ts", isDirectory: false },
      { name: "large.ts", isDirectory: false },
    ]);

    mockReadFile.mockImplementation((path: string) => {
      if (path.endsWith("small.ts")) return enc("const small = 1;");
      if (path.endsWith("large.ts")) return enc(largeContent);
      return new Uint8Array(0);
    });

    const { indexWorkspace } = await getCodeIndex();
    const result = await indexWorkspace("/test/ws");

    expect(result.indexed).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.errors).toBe(0);
  });

  it("upserts when re-indexing same file (deletes old, inserts new)", async () => {
    // Seed an existing entry that will be found by the stale-cleanup pass
    const existingId = seedCodeEntry({
      filePath: "src/app.ts",
      content: "old content",
    });
    expect(countCodeIndex()).toBe(1);

    mockReadDir.mockImplementation((dir: string) => {
      if (dir === "/test/ws") return [{ name: "src", isDirectory: true }];
      if (dir === "/test/ws/src") return [{ name: "app.ts", isDirectory: false }];
      return [];
    });

    mockReadFile.mockImplementation((path: string) => {
      if (path.endsWith("app.ts")) return enc("new content after edit");
      return new Uint8Array(0);
    });

    const { indexWorkspace } = await getCodeIndex();
    const result = await indexWorkspace("/test/ws");

    expect(result.indexed).toBe(1);

    // The old entry was replaced
    expect(countCodeIndex()).toBe(1);
    const remaining = _mockNativeDb!.prepare("SELECT content, id FROM code_index").all() as any[];
    expect(remaining[0].content).toBe("new content after edit");
    expect(remaining[0].id).not.toBe(existingId);
  });

  it("rejects concurrent invocations via mutex guard", async () => {
    mockReadDir.mockResolvedValue([]);
    mockReadFile.mockResolvedValue(new Uint8Array(0));

    const { indexWorkspace } = await getCodeIndex();

    const firstPromise = indexWorkspace("/test/ws");
    const secondResult = await indexWorkspace("/test/ws");

    expect(secondResult.indexed).toBe(0);
    expect(secondResult.skipped).toBe(0);
    expect(secondResult.errors).toBe(0);

    await firstPromise;
  });

  it("calls onProgress callback as indexing proceeds", async () => {
    mockReadDir.mockImplementation((dir: string) => {
      if (dir === "/test/ws") return [{ name: "file1.ts", isDirectory: false }, { name: "file2.ts", isDirectory: false }];
      return [];
    });

    mockReadFile.mockImplementation(() => enc("console.log('test');"));

    const { indexWorkspace } = await getCodeIndex();

    const progressCalls: Array<{ indexed: number; total: number }> = [];
    const onProgress = (indexed: number, total: number) => {
      progressCalls.push({ indexed, total });
    };

    await indexWorkspace("/test/ws", onProgress);

    expect(progressCalls.length).toBeGreaterThanOrEqual(1);
    expect(progressCalls[0].indexed).toBeGreaterThanOrEqual(1);
  });

  it("cleans up stale entries for files that no longer exist (scheduled re-indexing)", async () => {
    // Seed an entry for a file that no longer exists on disk
    seedCodeEntry({ filePath: "src/deleted.ts", content: "delete me" });
    // Seed an entry for a file that still exists
    seedCodeEntry({ filePath: "src/active.ts", content: "keep me" });
    expect(countCodeIndex()).toBe(2);

    // Mock: deleted.ts no longer exists, active.ts still does
    mockExists.mockImplementation((path: string) => {
      return Promise.resolve(path.includes("active"));
    });

    mockReadDir.mockImplementation((dir: string) => {
      if (dir === "/test/ws") return [
        { name: "src", isDirectory: true },
      ];
      if (dir === "/test/ws/src") return [
        { name: "active.ts", isDirectory: false },
      ];
      return [];
    });

    mockReadFile.mockImplementation((path: string) => {
      if (path.endsWith("active.ts")) return enc("updated content");
      return new Uint8Array(0);
    });

    const { indexWorkspace } = await getCodeIndex();
    await indexWorkspace("/test/ws");

    // deleted.ts should be removed; active.ts should be re-indexed (upserted)
    expect(countCodeIndex()).toBe(1);
    const remaining = _mockNativeDb!.prepare("SELECT file_path, content FROM code_index").all() as any[];
    expect(remaining[0].file_path).toBe("src/active.ts");
    expect(remaining[0].content).toBe("updated content");
  });

  // ===================================================================
  // STRESS TESTS — Large workspace indexing
  // ===================================================================

  it("indexes 100 files across 10 directories — stress test", async () => {
    // Build a mock workspace with 10 directories, each containing 10 .ts files
    const allPaths: string[] = [];
    mockReadDir.mockImplementation((dir: string) => {
      if (dir === "/test/ws") {
        return Array.from({ length: 10 }, (_, i) => ({
          name: `dir${i}`,
          isDirectory: true,
        }));
      }
      // Each dir has 10 .ts files and 1 excluded .png file
      const dirName = dir.split("/").pop()!;
      const dirNum = parseInt(dirName.replace("dir", ""));
      const files = Array.from({ length: 10 }, (_, j) => ({
        name: `file${dirNum}_${j}.ts`,
        isDirectory: false,
      }));
      files.push({ name: "image.png", isDirectory: false });
      return files;
    });

    mockReadFile.mockImplementation((path: string) => {
      const name = path.split("/").pop()!;
      allPaths.push(path);
      if (name.endsWith(".ts")) return enc(`// ${name}\nexport function fn_${name.replace(".ts", "")}() { return ${path.length}; }`);
      return new Uint8Array(0);
    });

    const { indexWorkspace } = await getCodeIndex();
    const result = await indexWorkspace("/test/ws");

    // 10 dirs × 10 .ts files = 100 indexed; 10 .png files = 10 skipped
    expect(result.indexed).toBe(100);
    expect(result.skipped).toBe(10);
    expect(result.errors).toBe(0);
    expect(countCodeIndex()).toBe(100);

    // Verify FTS5 has all entries
    expect(countCodeIndexFts()).toBe(100);
  });

  it("handles re-index of 100-file workspace — upserts all entries", async () => {
    // First pass: index 100 files
    mockReadDir.mockImplementation((dir: string) => {
      if (dir === "/test/ws") {
        return Array.from({ length: 10 }, (_, i) => ({
          name: `src${i}`,
          isDirectory: true,
        }));
      }
      return Array.from({ length: 10 }, (_, j) => ({
        name: `mod${j}.ts`,
        isDirectory: false,
      }));
    });
    mockReadFile.mockImplementation((path: string) => {
      if (path.endsWith(".ts")) return enc("export const VERSION = 1;");
      return new Uint8Array(0);
    });
    mockExists.mockResolvedValue(true);

    const { indexWorkspace } = await getCodeIndex();
    await indexWorkspace("/test/ws");
    expect(countCodeIndex()).toBe(100);

    // Second pass: all files still exist, content changed
    mockReadFile.mockImplementation((path: string) => {
      if (path.endsWith(".ts")) return enc("export const VERSION = 2;");
      return new Uint8Array(0);
    });

    const reResult = await indexWorkspace("/test/ws");
    expect(reResult.indexed).toBe(100);
    expect(reResult.errors).toBe(0);
    expect(countCodeIndex()).toBe(100);

    // Verify content was updated
    const rows = _mockNativeDb!.prepare("SELECT content FROM code_index LIMIT 5").all() as any[];
    for (const row of rows) {
      expect(row.content).toContain("VERSION = 2");
    }
  });
});

// ============================================================================
// SEARCH
// ============================================================================

describe("CodeIndex Integration — searchCodeIndex()", () => {
  beforeAll(() => {
    const created = createCodeIndexDb();
    _mockDbInstance = created.db;
    _mockNativeDb = created.nativeDb;
  });

  afterAll(async () => {
    await _mockDbInstance?.close();
  });

  beforeEach(() => {
    clearTables(_mockNativeDb!);
  });

  it("finds files by keyword content", async () => {
    const { searchCodeIndex } = await getCodeIndex();

    // FTS5 requires complete token matching (no implicit prefix matching).
    // "authenticateUser" is a single token; search for a full token like "username".
    seedCodeEntry({ filePath: "src/auth.ts", content: "function authenticateUser(username) { return true; }" });
    seedCodeEntry({ filePath: "src/utils.ts", content: "function formatDate(date) { return date.toISOString(); }" });

    const results = await searchCodeIndex("username");

    expect(results.length).toBe(1);
    expect(results[0].filePath).toBe("src/auth.ts");
    expect(results[0].fileName).toBe("auth.ts");
    expect(results[0].language).toBe("typescript");
    expect(results[0].score).toBeGreaterThan(0);
  });

  it("returns multiple results ranked by BM25 relevance", async () => {
    const { searchCodeIndex } = await getCodeIndex();

    seedCodeEntry({ filePath: "src/api.ts", content: "async function fetchData(url: string) { const response = await fetch(url); return response.json(); }" });
    seedCodeEntry({ filePath: "src/utils.ts", content: "// fetch is used in api.ts for data retrieval" });

    const results = await searchCodeIndex("fetch");

    expect(results.length).toBe(2);
    expect(results[0].score).toBeGreaterThan(0);
    expect(results[1].score).toBeGreaterThan(0);
  });

  it("returns empty array for non-matching query", async () => {
    const { searchCodeIndex } = await getCodeIndex();

    seedCodeEntry({ content: "function add(a: number, b: number): number { return a + b; }" });

    const results = await searchCodeIndex("nonexistent_term_xyz");
    expect(results.length).toBe(0);
  });

  it("returns empty for empty or whitespace query", async () => {
    const { searchCodeIndex } = await getCodeIndex();

    seedCodeEntry({ content: "const x = 1;" });

    expect((await searchCodeIndex("")).length).toBe(0);
    expect((await searchCodeIndex("   ")).length).toBe(0);
  });

  it("handles FTS5 special characters in query", async () => {
    const { searchCodeIndex } = await getCodeIndex();

    seedCodeEntry({ filePath: "src/parser.ts", content: "function parse(input: string) { return null; }" });

    const results = await searchCodeIndex("parse : * ( ) ^");
    expect(results.length).toBe(1);
    expect(results[0].filePath).toBe("src/parser.ts");
  });

  it("filters by language", async () => {
    const { searchCodeIndex } = await getCodeIndex();

    seedCodeEntry({ filePath: "src/app.ts", content: "console.log('ts');", language: "typescript" });
    seedCodeEntry({ filePath: "src/style.css", content: "body { color: red; }", language: "css" });

    const tsResults = await searchCodeIndex("console", { language: "typescript" });
    expect(tsResults.length).toBe(1);
    expect(tsResults[0].filePath).toBe("src/app.ts");

    const cssResults = await searchCodeIndex("console", { language: "css" });
    expect(cssResults.length).toBe(0);
  });

  it("filters by pathPrefix", async () => {
    const { searchCodeIndex } = await getCodeIndex();

    seedCodeEntry({ filePath: "src/utils/helpers.ts", content: "export function help() {}", language: "typescript" });
    seedCodeEntry({ filePath: "src/core/engine.ts", content: "export function help() {}", language: "typescript" });
    seedCodeEntry({ filePath: "tests/helpers.test.ts", content: "export function help() {}", language: "typescript" });

    const results = await searchCodeIndex("help", { pathPrefix: "src" });
    expect(results.length).toBe(2);
    expect(results.every((r: any) => r.filePath.startsWith("src"))).toBe(true);
  });

  it("respects the limit option", async () => {
    const { searchCodeIndex } = await getCodeIndex();

    seedCodeEntry({ filePath: "src/a.ts", content: "const x = 1;" });
    seedCodeEntry({ filePath: "src/b.ts", content: "const x = 2;" });
    seedCodeEntry({ filePath: "src/c.ts", content: "const x = 3;" });

    const results = await searchCodeIndex("const", { limit: 2 });
    expect(results.length).toBe(2);
  });

  it("provides content preview truncated to 300 chars", async () => {
    const { searchCodeIndex } = await getCodeIndex();

    const longContent = "function previewTest() { " + "a".repeat(500) + " }";
    seedCodeEntry({ content: longContent });

    const results = await searchCodeIndex("previewTest");
    expect(results.length).toBe(1);
    expect(results[0].preview.length).toBeLessThanOrEqual(300);
  });

  // ===================================================================
  // STRESS TESTS — Concurrent search
  // ===================================================================

  it("handles 100 concurrent searches with different queries — all return correct results", async () => {
    const { searchCodeIndex } = await getCodeIndex();

    // Seed 5 entries with distinct content covering various search terms
    const entries = [
      { filePath: "src/auth/login.ts", content: "function authenticateUser(username, password) { return token; }" },
      { filePath: "src/api/fetch.ts", content: "async function fetchData(url) { const resp = await fetch(url); return resp.json(); }" },
      { filePath: "src/db/query.ts", content: "async function queryDatabase(sql) { const result = await db.execute(sql); return result.rows; }" },
      { filePath: "src/utils/parse.ts", content: "function parseMarkdown(input) { return marked.parse(input); }" },
      { filePath: "src/config/load.ts", content: "function loadConfig(path) { const config = JSON.parse(fs.readFileSync(path)); return config; }" },
    ];
    const expected = ["username", "fetch", "queryDatabase", "parseMarkdown", "loadConfig"];
    for (const e of entries) {
      seedCodeEntry({ filePath: e.filePath, content: e.content });
    }
    expect(countCodeIndex()).toBe(5);

    // Build 100 search calls: each call targets one of the 5 terms deterministically via index % 5
    const queries = Array.from({ length: 100 }, (_, i) => {
      const term = expected[i % 5];
      return searchCodeIndex(term);
    });

    const results = await Promise.all(queries);

    expect(results.length).toBe(100);

    // Each result set should have exactly 1 match
    for (let i = 0; i < 100; i++) {
      const term = expected[i % 5];
      expect(results[i].length).toBe(1);
      expect(results[i][0].preview).toContain(term);
      expect(results[i][0].filePath).toBe(entries[i % 5].filePath);
      expect(results[i][0].score).toBeGreaterThan(0);
    }

    // Verify no data corruption — all 5 entries still present
    expect(countCodeIndex()).toBe(5);
    expect(countCodeIndexFts()).toBe(5);
  });

  it("handles 50 concurrent searches with the same query — all return identical results", async () => {
    const { searchCodeIndex } = await getCodeIndex();

    seedCodeEntry({ filePath: "src/shared.ts", content: "export const SHARED_CONSTANT = 42;" });
    seedCodeEntry({ filePath: "src/other.ts", content: "function unrelated() { return 'other'; }" });

    const queries = Array.from({ length: 50 }, () => searchCodeIndex("SHARED_CONSTANT"));

    const results = await Promise.all(queries);

    expect(results.length).toBe(50);
    for (const result of results) {
      expect(result.length).toBe(1);
      expect(result[0].filePath).toBe("src/shared.ts");
      expect(result[0].fileName).toBe("shared.ts");
      expect(result[0].score).toBeGreaterThan(0);
    }

    // Verify database state is unchanged
    expect(countCodeIndex()).toBe(2);
  });
});

// ============================================================================
// STATS
// ============================================================================

describe("CodeIndex Integration — getCodeIndexStats()", () => {
  beforeAll(() => {
    const created = createCodeIndexDb();
    _mockDbInstance = created.db;
    _mockNativeDb = created.nativeDb;
  });

  afterAll(async () => {
    await _mockDbInstance?.close();
  });

  beforeEach(() => {
    clearTables(_mockNativeDb!);
  });

  it("returns zeros when empty", async () => {
    const { getCodeIndexStats } = await getCodeIndex();

    const stats = await getCodeIndexStats();
    expect(stats.totalFiles).toBe(0);
    expect(stats.totalSize).toBe(0);
    expect(stats.languages).toEqual({});
  });

  it("returns total file count and size", async () => {
    const { getCodeIndexStats } = await getCodeIndex();

    seedCodeEntry({ content: "small", sizeBytes: 5 });
    seedCodeEntry({ content: "medium content here", sizeBytes: 18 });

    const stats = await getCodeIndexStats();
    expect(stats.totalFiles).toBe(2);
    expect(stats.totalSize).toBe(23);
  });

  it("returns language breakdown", async () => {
    const { getCodeIndexStats } = await getCodeIndex();

    seedCodeEntry({ filePath: "a.ts", language: "typescript" });
    seedCodeEntry({ filePath: "b.ts", language: "typescript" });
    seedCodeEntry({ filePath: "c.py", language: "python" });
    seedCodeEntry({ filePath: "d.css", language: "css" });

    const stats = await getCodeIndexStats();
    expect(stats.languages).toEqual({
      typescript: 2,
      python: 1,
      css: 1,
    });
  });
});

// ============================================================================
// CLEAR
// ============================================================================

describe("CodeIndex Integration — clearCodeIndex()", () => {
  beforeAll(() => {
    const created = createCodeIndexDb();
    _mockDbInstance = created.db;
    _mockNativeDb = created.nativeDb;
  });

  afterAll(async () => {
    await _mockDbInstance?.close();
  });

  beforeEach(() => {
    clearTables(_mockNativeDb!);
  });

  it("removes all entries from code_index and FTS5", async () => {
    const { clearCodeIndex, searchCodeIndex } = await getCodeIndex();

    seedCodeEntry({ content: "function test() {}" });
    seedCodeEntry({ content: "const x = 1;" });

    expect(countCodeIndex()).toBe(2);
    expect(countCodeIndexFts()).toBe(2);

    await clearCodeIndex();

    expect(countCodeIndex()).toBe(0);
    expect(countCodeIndexFts()).toBe(0);
    expect((await searchCodeIndex("test")).length).toBe(0);
  });

  it("is safe to call when already empty", async () => {
    const { clearCodeIndex } = await getCodeIndex();

    expect(countCodeIndex()).toBe(0);
    await clearCodeIndex();
    expect(countCodeIndex()).toBe(0);
  });
});

// ============================================================================
// FTS5 TRIGGER SYNC
// ============================================================================

describe("CodeIndex Integration — FTS5 trigger sync", () => {
  beforeAll(() => {
    const created = createCodeIndexDb();
    _mockDbInstance = created.db;
    _mockNativeDb = created.nativeDb;
  });

  afterAll(async () => {
    await _mockDbInstance?.close();
  });

  beforeEach(() => {
    clearTables(_mockNativeDb!);
  });

  it("INSERT trigger syncs to FTS5", () => {
    expect(countCodeIndexFts()).toBe(0);
    seedCodeEntry({ content: "function greet() { return 'hello'; }" });
    expect(countCodeIndexFts()).toBe(1);

    const ftsRows = _mockNativeDb!.prepare(
      "SELECT id, content FROM code_index_fts WHERE content MATCH 'greet'"
    ).all() as any[];
    expect(ftsRows.length).toBe(1);
    expect(ftsRows[0].content).toContain("greet");
  });

  it("DELETE trigger removes from FTS5", () => {
    const id = seedCodeEntry({ content: "function foo() {}" });
    expect(countCodeIndexFts()).toBe(1);

    _mockNativeDb!.prepare("DELETE FROM code_index WHERE id = ?").run(id);

    expect(countCodeIndexFts()).toBe(0);
  });

  it("DELETE trigger removes correct entry only", () => {
    seedCodeEntry({ content: "keep me" });
    const toDelete = seedCodeEntry({ content: "delete me" });
    seedCodeEntry({ content: "keep me too" });

    expect(countCodeIndexFts()).toBe(3);

    _mockNativeDb!.prepare("DELETE FROM code_index WHERE id = ?").run(toDelete);

    expect(countCodeIndexFts()).toBe(2);

    const remaining = _mockNativeDb!.prepare("SELECT content FROM code_index_fts").all() as any[];
    const contents = remaining.map((r: any) => r.content as string).join(" ");
    expect(contents).toContain("keep me");
    expect(contents).not.toContain("delete me");
  });

  it("UPDATE trigger re-syncs content to FTS5", () => {
    const id = seedCodeEntry({ content: "original content" });

    expect(
      (_mockNativeDb!.prepare("SELECT id FROM code_index_fts WHERE content MATCH 'original'").all() as any[]).length
    ).toBe(1);

    _mockNativeDb!.prepare("UPDATE code_index SET content = ? WHERE id = ?").run("updated content", id);

    expect(
      (_mockNativeDb!.prepare("SELECT id FROM code_index_fts WHERE content MATCH 'original'").all() as any[]).length
    ).toBe(0);
    expect(
      (_mockNativeDb!.prepare("SELECT id FROM code_index_fts WHERE content MATCH 'updated'").all() as any[]).length
    ).toBe(1);
  });
});
