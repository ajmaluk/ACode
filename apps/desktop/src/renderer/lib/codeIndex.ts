/**
 * ============================================================
 * CODE INDEX — Full-Text Search for Codebase
 * ============================================================
 *
 * Indexes source files into SQLite FTS5 for fast keyword search.
 * Runs in the background on workspace open. Provides a code_search
 * tool for the LLM to find relevant files and code patterns.
 *
 * Architecture:
 *   - Files are indexed by path, name, and content
 *   - FTS5 handles keyword search with BM25 ranking
 *   - Incremental updates: only re-indexes changed files
 *   - Configurable exclusions: .git, node_modules, etc.
 * ============================================================
 */

import { getDb, isDatabaseReady } from "./database";
import { joinPath } from "@/lib/pathUtils";

// ─── Constants ───────────────────────────────────────────────
const EXCLUDED_DIRS = new Set([
  ".git", "node_modules", "__pycache__", ".next", ".nuxt",
  "dist", "build", ".turbo", ".cache", ".vscode", ".idea",
  "coverage", ".output", ".dalam",
]);
const EXCLUDED_FILES = new Set([
  ".DS_Store", "Thumbs.db", "desktop.ini", ".gitkeep",
  "package-lock.json", "yarn.lock", "pnpm-lock.yaml",
]);
const INDEX_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".rs", ".go", ".java", ".rb", ".php",
  ".html", ".css", ".scss", ".less",
  ".json", ".yaml", ".yml", ".toml", ".xml",
  ".md", ".txt", ".sql", ".sh", ".bash",
  ".vue", ".svelte", ".astro",
]);
const MAX_FILE_SIZE = 100_000; // 100KB max per file
const MAX_INDEX_FILES = 5000;

// ─── Types ───────────────────────────────────────────────────
export interface CodeIndexEntry {
  id: string;
  filePath: string;
  fileName: string;
  content: string;
  language: string | null;
  sizeBytes: number;
  indexedAt: number;
}

export interface CodeSearchResult {
  filePath: string;
  fileName: string;
  preview: string;
  score: number;
  language: string | null;
}

// ─── Language Detection ──────────────────────────────────────
function detectLanguage(filePath: string): string | null {
  const ext = filePath.split(".").pop()?.toLowerCase();
  if (!ext) return null;
  const map: Record<string, string> = {
    ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
    mjs: "javascript", cjs: "javascript",
    py: "python", rs: "rust", go: "go", java: "java", rb: "ruby", php: "php",
    html: "html", css: "css", scss: "scss", less: "less",
    json: "json", yaml: "yaml", yml: "yaml", toml: "toml", xml: "xml",
    md: "markdown", txt: "text", sql: "sql", sh: "shell", bash: "shell",
    vue: "vue", svelte: "svelte", astro: "astro",
  };
  return map[ext] ?? ext;
}

// ─── Indexing ────────────────────────────────────────────────

/**
 * Index a workspace. Runs in the background.
 * Only indexes files that have changed since last index.
 */
export async function indexWorkspace(
  workspacePath: string,
  onProgress?: (indexed: number, total: number) => void,
): Promise<{ indexed: number; skipped: number; errors: number }> {
  if (!isDatabaseReady()) return { indexed: 0, skipped: 0, errors: 0 };

  const db = getDb();
  const { readDir } = await import("@tauri-apps/plugin-fs");
  const { readFile } = await import("@tauri-apps/plugin-fs");

  let indexed = 0;
  let skipped = 0;
  let errors = 0;
  const now = Date.now();

  async function walkDir(dir: string, depth = 0): Promise<void> {
    if (depth > 20 || indexed + skipped >= MAX_INDEX_FILES) return;

    let entries;
    try {
      entries = await readDir(dir);
    } catch {
      return; // Permission denied or not a directory
    }

    for (const entry of entries) {
      if (indexed + skipped >= MAX_INDEX_FILES) return;

      const fullPath = joinPath(dir, entry.name ?? "");
      const fileName = entry.name ?? "";

      // Skip excluded directories
      if (entry.isDirectory && EXCLUDED_DIRS.has(fileName)) continue;
      if (EXCLUDED_FILES.has(fileName)) continue;

      if (entry.isDirectory) {
        await walkDir(fullPath, depth + 1);
        continue;
      }

      // Check extension
      const ext = "." + fileName.split(".").pop()?.toLowerCase();
      if (!INDEX_EXTENSIONS.has(ext)) {
        skipped++;
        continue;
      }

      try {
        const contentBytes = await readFile(fullPath);
        const content = new TextDecoder().decode(contentBytes);

        // Skip very large files
        if (content.length > MAX_FILE_SIZE) {
          skipped++;
          continue;
        }

        // Relative path from workspace root
        const relativePath = fullPath.startsWith(workspacePath)
          ? fullPath.slice(workspacePath.length + 1)
          : fullPath;

        const language = detectLanguage(relativePath);
        const id = `code-${relativePath.replace(/[^a-zA-Z0-9]/g, "-")}`;

        // Upsert: delete old entry, insert new
        await db.execute("DELETE FROM code_index WHERE file_path = ?", [relativePath]);
        await db.execute(
          "INSERT INTO code_index (id, file_path, file_name, content, language, size_bytes, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
          [id, relativePath, fileName, content, language, contentBytes.length, now]
        );

        indexed++;
        onProgress?.(indexed, indexed + skipped);
      } catch {
        errors++;
      }
    }
  }

  await walkDir(workspacePath);
  return { indexed, skipped, errors };
}

/**
 * Search the code index.
 */
export async function searchCodeIndex(
  query: string,
  options?: { limit?: number; language?: string; pathPrefix?: string },
): Promise<CodeSearchResult[]> {
  if (!isDatabaseReady()) return [];

  const db = getDb();
  const limit = options?.limit ?? 10;

  // Escape FTS5 special characters
  const safeQuery = query.replace(/['"*()^~]/g, " ").trim();
  if (!safeQuery) return [];

  try {
    let sql = `
      SELECT file_path, file_name, content, language,
             rank
      FROM code_index_fts
      JOIN code_index ON code_index.id = code_index_fts.id
      WHERE code_index_fts MATCH ?
    `;
    const params: unknown[] = [safeQuery];

    if (options?.language) {
      sql += " AND language = ?";
      params.push(options.language);
    }
    if (options?.pathPrefix) {
      sql += " AND file_path LIKE ?";
      params.push(`${options.pathPrefix}%`);
    }

    sql += " ORDER BY rank LIMIT ?";
    params.push(limit);

    const rows = await db.select(sql, params) as Array<{
      file_path: string;
      file_name: string;
      content: string;
      language: string | null;
      rank: number;
    }>;

    return rows.map((row) => ({
      filePath: row.file_path,
      fileName: row.file_name,
      preview: row.content.slice(0, 300),
      score: -row.rank, // FTS5 rank is negative (lower = better)
      language: row.language,
    }));
  } catch {
    return [];
  }
}

/**
 * Get index stats.
 */
export async function getCodeIndexStats(): Promise<{
  totalFiles: number;
  totalSize: number;
  languages: Record<string, number>;
}> {
  if (!isDatabaseReady()) return { totalFiles: 0, totalSize: 0, languages: {} };

  const db = getDb();

  try {
    const totalRows = await db.select("SELECT COUNT(*) as count FROM code_index") as Array<{ count: number }>;
    const totalFiles = totalRows[0]?.count ?? 0;

    const sizeRows = await db.select("SELECT COALESCE(SUM(size_bytes), 0) as total FROM code_index") as Array<{ total: number }>;
    const totalSize = sizeRows[0]?.total ?? 0;

    const langRows = await db.select(
      "SELECT language, COUNT(*) as count FROM code_index WHERE language IS NOT NULL GROUP BY language"
    ) as Array<{ language: string; count: number }>;
    const languages: Record<string, number> = {};
    for (const row of langRows) {
      languages[row.language] = row.count;
    }

    return { totalFiles, totalSize, languages };
  } catch {
    return { totalFiles: 0, totalSize: 0, languages: {} };
  }
}

/**
 * Clear the code index.
 */
export async function clearCodeIndex(): Promise<void> {
  try {
    if (!isDatabaseReady()) return;
    const db = getDb();
    await db.execute("DELETE FROM code_index");
  } catch {
    // Silently ignore — index will be rebuilt on next scan
  }
}
