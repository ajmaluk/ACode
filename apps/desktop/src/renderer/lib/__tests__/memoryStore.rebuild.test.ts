/**
 * ============================================================
 * UNIT TESTS — rebuildFromMarkdown()
 * ============================================================
 *
 * Tests the rebuildFromMarkdown() function which reads markdown
 * memory files and upserts them into the SQLite database cache.
 *
 * Architecture (Git-first Markdown / SQLite-Cache Hybrid):
 *   - Source of truth: Markdown files in .dalam/memories/*.md
 *   - Search cache: SQLite rebuilt from markdown if lost
 *
 * These tests mock @tauri-apps/plugin-fs for file I/O and
 * mock the database module to verify SQLite upsert logic.
 * ============================================================
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Module-level mocks (hoisted by vitest) ──────────────────────────────

vi.mock("@/lib/pathUtils", () => ({
  joinPath: (...parts: string[]) => parts.join("/"),
}));

// ─── Database mock — use vitest's built-in .mock.calls for tracking ──────

interface MinimalDb {
  select: ReturnType<typeof vi.fn>;
  execute: ReturnType<typeof vi.fn>;
}

function createDbMock(): MinimalDb {
  return {
    select: vi.fn().mockResolvedValue([]),
    execute: vi.fn().mockResolvedValue({ rowsAffected: 1 }),
  };
}

let mockDb: MinimalDb;

vi.mock("../database", () => ({
  getDb: vi.fn(() => mockDb),
}));

// ─── Tauri plugin-fs mock — override in beforeEach ───────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mockExists: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mockMkdir: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mockReadDir: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mockReadTextFile: any;

vi.mock("@tauri-apps/plugin-fs", () => ({
  exists: vi.fn((...args: unknown[]) => mockExists(...args)),
  mkdir: vi.fn((...args: unknown[]) => mockMkdir(...args)),
  readDir: vi.fn((...args: unknown[]) => mockReadDir(...args)),
  readTextFile: vi.fn((...args: unknown[]) => mockReadTextFile(...args)),
  writeTextFile: vi.fn().mockResolvedValue(undefined),
  remove: vi.fn().mockResolvedValue(undefined),
}));

// ============================================================================
// HELPER: Build valid markdown frontmatter
// ============================================================================

function createMarkdownContent(overrides: {
  id?: string;
  category?: string;
  tier?: string;
  summary?: string;
  tags?: string;
  created_at?: string;
  updated_at?: string;
  stale?: string;
  source_session?: string;
  source_file?: string;
  body?: string;
} = {}): string {
  const lines = [
    "---",
    `id: "${overrides.id ?? "mem-001"}"`,
    `category: "${overrides.category ?? "project"}"`,
    `tier: "${overrides.tier ?? "medium"}"`,
    `summary: "${overrides.summary ?? "Test memory"}"`,
    `tags: ${overrides.tags ?? "[test]"}`,
    `created_at: ${overrides.created_at ?? "1719273600000"}`,
    `updated_at: ${overrides.updated_at ?? "1719273700000"}`,
    `stale: ${overrides.stale ?? "false"}`,
    ...(overrides.source_session ? [`source_session: "${overrides.source_session}"`] : []),
    ...(overrides.source_file ? [`source_file: "${overrides.source_file}"`] : []),
    "---",
    "",
    overrides.body ?? "Test content body.",
  ];
  return lines.join("\n");
}

// ============================================================================
// SETUP
// ============================================================================

beforeEach(() => {
  // Reset file I/O mocks to fresh instances
  mockExists = vi.fn().mockResolvedValue(true);
  mockMkdir = vi.fn().mockResolvedValue(undefined);
  mockReadDir = vi.fn().mockResolvedValue([]);
  mockReadTextFile = vi.fn().mockRejectedValue(new Error("Not mocked"));
  // Create fresh database mock
  mockDb = createDbMock();
});

// ============================================================================
// TESTS
// ============================================================================

describe("rebuildFromMarkdown", () => {
  it("creates memory directory if it does not exist and returns 0", async () => {
    mockExists.mockResolvedValue(false);
    mockMkdir.mockResolvedValue(undefined);
    mockReadDir.mockResolvedValue([]);

    const { rebuildFromMarkdown } = await import("../memoryStore");
    const count = await rebuildFromMarkdown("/test/workspace");

    expect(count).toBe(0);
    expect(mockExists).toHaveBeenCalledWith("/test/workspace/.dalam/memories");
    expect(mockMkdir).toHaveBeenCalledWith("/test/workspace/.dalam/memories", { recursive: true });
    // No database calls since there are no files
    expect(mockDb.execute.mock.calls).toHaveLength(0);
    expect(mockDb.select.mock.calls).toHaveLength(0);
  });

  it("returns 0 when memory directory has no .md files", async () => {
    mockExists.mockResolvedValue(true);
    mockReadDir.mockResolvedValue([
      { name: "README.txt" },
      { name: "notes.txt" },
      { name: ".DS_Store" },
    ]);

    const { rebuildFromMarkdown } = await import("../memoryStore");
    const count = await rebuildFromMarkdown("/test/workspace");

    expect(count).toBe(0);
    // Should not try to read non-.md files
    expect(mockReadTextFile).not.toHaveBeenCalled();
  });

  it("parses a single .md file and inserts into SQLite", async () => {
    mockExists.mockResolvedValue(true);
    mockReadDir.mockResolvedValue([{ name: "project-mem-001.md" }]);
    mockReadTextFile.mockResolvedValue(createMarkdownContent({
      id: "mem-001",
      summary: "Test memory",
      body: "Important project rule.",
    }));

    const { rebuildFromMarkdown } = await import("../memoryStore");
    const count = await rebuildFromMarkdown("/test/workspace");

    expect(count).toBe(1);

    // Should check for existing entry first (SELECT)
    const selectCalls = mockDb.select.mock.calls.filter(
      (call: unknown[]) => String(call[0]).includes("SELECT") && String(call[0]).includes("WHERE id =")
    );
    expect(selectCalls.length).toBeGreaterThanOrEqual(1);
    expect(selectCalls[0][1]).toContain("mem-001");

    // Should INSERT since no existing entry was found (default select returns [])
    const insertCalls = mockDb.execute.mock.calls.filter(
      (call: unknown[]) => String(call[0]).includes("INSERT INTO memories")
    );
    expect(insertCalls).toHaveLength(1);
    const insertParams = insertCalls[0][1] as unknown[];
    expect(insertParams[0]).toBe("mem-001");
    expect(insertParams[1]).toBe("project");
    expect(insertParams[2]).toBe("medium");
    expect(insertParams[3]).toBe("Important project rule.");
    expect(insertParams[4]).toBe("Test memory");

    // Should NOT call UPDATE
    const updateCalls = mockDb.execute.mock.calls.filter(
      (call: unknown[]) => String(call[0]).includes("UPDATE memories SET")
    );
    expect(updateCalls).toHaveLength(0);
  });

  it("updates existing entry when same ID found in SQLite", async () => {
    mockExists.mockResolvedValue(true);
    mockReadDir.mockResolvedValue([{ name: "project-mem-001.md" }]);
    mockReadTextFile.mockResolvedValue(createMarkdownContent({
      id: "mem-001",
      summary: "Updated summary",
      body: "Updated content.",
    }));

    // Simulate: SELECT finds existing entry
    mockDb.select.mockImplementation((sql: string, ..._args: unknown[]) => {
      if (sql.includes("SELECT id FROM memories WHERE id =")) {
        return Promise.resolve([{ id: "mem-001" }]);
      }
      return Promise.resolve([]); // default for other queries (e.g., recoverDeadLetters)
    });

    const { rebuildFromMarkdown } = await import("../memoryStore");
    const count = await rebuildFromMarkdown("/test/workspace");

    expect(count).toBe(1);

    // Should UPDATE existing entry
    const updateCalls = mockDb.execute.mock.calls.filter(
      (call: unknown[]) => String(call[0]).includes("UPDATE memories SET")
    );
    expect(updateCalls).toHaveLength(1);
    const updateParams = updateCalls[0][1] as unknown[];
    // UPDATE params order: [0]=category, [1]=tier, [2]=content, [3]=summary,
    // [4]=tags, [5]=updated_at, [6]=stale, [7]=source_session, [8]=source_file, [9]=id
    expect(updateParams[updateParams.length - 1]).toBe("mem-001");
    expect(updateParams[0]).toBe("project");
    expect(updateParams[2]).toBe("Updated content.");
    expect(updateParams[3]).toBe("Updated summary");

    // Should NOT INSERT
    const insertCalls = mockDb.execute.mock.calls.filter(
      (call: unknown[]) => String(call[0]).includes("INSERT INTO memories")
    );
    expect(insertCalls).toHaveLength(0);
  });

  it("processes multiple .md files and returns correct count", async () => {
    mockExists.mockResolvedValue(true);
    mockReadDir.mockResolvedValue([
      { name: "project-mem-001.md" },
      { name: "reference-mem-002.md" },
      { name: "feedback-mem-003.md" },
    ]);

    const fileContents: Record<string, string> = {
      "project-mem-001.md": createMarkdownContent({
        id: "mem-001",
        category: "project",
        summary: "First memory",
        body: "First content.",
      }),
      "reference-mem-002.md": createMarkdownContent({
        id: "mem-002",
        category: "reference",
        summary: "Second memory",
        body: "Second content.",
      }),
      "feedback-mem-003.md": createMarkdownContent({
        id: "mem-003",
        category: "feedback",
        summary: "Third memory",
        body: "Third content.",
      }),
    };

    mockReadTextFile.mockImplementation((filePath: string) => {
      const fileName = filePath.split("/").pop() ?? "";
      const content = fileContents[fileName];
      if (content) return Promise.resolve(content);
      return Promise.reject(new Error("File not found"));
    });

    const { rebuildFromMarkdown } = await import("../memoryStore");
    const count = await rebuildFromMarkdown("/test/workspace");

    expect(count).toBe(3);

    // Should have 3 INSERT calls (3 distinct IDs)
    const insertCalls = mockDb.execute.mock.calls.filter(
      (call: unknown[]) => String(call[0]).includes("INSERT INTO memories")
    );
    expect(insertCalls).toHaveLength(3);

    // Verify all three entries inserted
    const insertedIds = insertCalls.map((c: unknown[]) => (c[1] as unknown[])[0]);
    expect(insertedIds).toContain("mem-001");
    expect(insertedIds).toContain("mem-002");
    expect(insertedIds).toContain("mem-003");
  });

  it("skips non-.md files and non-file entries", async () => {
    mockExists.mockResolvedValue(true);
    mockReadDir.mockResolvedValue([
      { name: "project-mem-001.md" },
      { name: "notes.txt" },
      { name: "image.png" },
    ]);

    mockReadTextFile.mockImplementation((filePath: string) => {
      const fileName = filePath.split("/").pop() ?? "";
      if (fileName === "project-mem-001.md") {
        return Promise.resolve(createMarkdownContent({
          id: "mem-001",
          body: "Only this file matters.",
        }));
      }
      return Promise.reject(new Error("Should not be called"));
    });

    const { rebuildFromMarkdown } = await import("../memoryStore");
    const count = await rebuildFromMarkdown("/test/workspace");

    expect(count).toBe(1);

    // Should only read the .md file
    expect(mockReadTextFile).toHaveBeenCalledTimes(1);

    // Only one INSERT for the .md file
    const insertCalls = mockDb.execute.mock.calls.filter(
      (call: unknown[]) => String(call[0]).includes("INSERT INTO memories")
    );
    expect(insertCalls).toHaveLength(1);
  });

  it("skips files that fail to parse and continues processing", async () => {
    mockExists.mockResolvedValue(true);
    mockReadDir.mockResolvedValue([
      { name: "project-good.md" },
      { name: "project-bad.md" },
      { name: "project-good2.md" },
    ]);

    mockReadTextFile.mockImplementation((filePath: string) => {
      const fileName = filePath.split("/").pop() ?? "";
      if (fileName === "project-good.md") {
        return Promise.resolve(createMarkdownContent({
          id: "good-001",
          body: "Good memory.",
        }));
      }
      if (fileName === "project-bad.md") {
        // Invalid markdown (no frontmatter) → parse failure
        return Promise.resolve("This is not valid markdown frontmatter at all.");
      }
      if (fileName === "project-good2.md") {
        return Promise.resolve(createMarkdownContent({
          id: "good-002",
          body: "Another good memory.",
        }));
      }
      return Promise.reject(new Error("Unexpected file"));
    });

    const { rebuildFromMarkdown } = await import("../memoryStore");
    const count = await rebuildFromMarkdown("/test/workspace");

    // Should only count successfully parsed files
    expect(count).toBe(2);

    // Should only INSERT the two valid memories
    const insertCalls = mockDb.execute.mock.calls.filter(
      (call: unknown[]) => String(call[0]).includes("INSERT INTO memories")
    );
    expect(insertCalls).toHaveLength(2);
  });

  it("returns 0 when workspace is inaccessible (forbidden)", async () => {
    mockExists.mockRejectedValue(new Error("forbidden"));

    const { rebuildFromMarkdown } = await import("../memoryStore");
    const count = await rebuildFromMarkdown("/test/workspace");

    expect(count).toBe(0);
    // No DB calls should have been made
    expect(mockDb.execute.mock.calls).toHaveLength(0);
  });

  it("handles directory with mixed file types and reads only .md files", async () => {
    mockExists.mockResolvedValue(true);
    mockReadDir.mockResolvedValue([
      { name: "project-mem-001.md" },
      { name: "tsconfig.json" },
      { name: "src" },
      { name: "src/main.ts" },
    ]);

    mockReadTextFile.mockImplementation((filePath: string) => {
      const fileName = filePath.split("/").pop() ?? "";
      if (fileName === "project-mem-001.md") {
        return Promise.resolve(createMarkdownContent({
          id: "mem-001",
          body: "Only relevant file.",
        }));
      }
      return Promise.reject(new Error("Should not read non-.md files"));
    });

    const { rebuildFromMarkdown } = await import("../memoryStore");
    const count = await rebuildFromMarkdown("/test/workspace");

    expect(count).toBe(1);
    expect(mockReadTextFile).toHaveBeenCalledTimes(1);
  });

  it("saves source_file path for new INSERT entries", async () => {
    mockExists.mockResolvedValue(true);
    mockReadDir.mockResolvedValue([{ name: "project-mem-001.md" }]);
    mockReadTextFile.mockResolvedValue(createMarkdownContent({
      id: "mem-001",
      body: "Memory with source file tracking.",
    }));

    const { rebuildFromMarkdown } = await import("../memoryStore");
    await rebuildFromMarkdown("/test/workspace");

    // The INSERT should include source_file = parsed.sourceFile || filePath
    const insertCalls = mockDb.execute.mock.calls.filter(
      (call: unknown[]) => String(call[0]).includes("INSERT INTO memories")
    );
    expect(insertCalls).toHaveLength(1);
    const params = insertCalls[0][1] as unknown[];
    // source_file is at parameter index 7 in the INSERT VALUES order
    // order: id, category, tier, content, summary, tags, source_session, source_file, ...
    expect(params[7]).toContain("project-mem-001.md");
  });

  it("preserves source_session when present in frontmatter", async () => {
    mockExists.mockResolvedValue(true);
    mockReadDir.mockResolvedValue([{ name: "feedback-session-001.md" }]);
    mockReadTextFile.mockResolvedValue(createMarkdownContent({
      id: "mem-session",
      category: "feedback",
      summary: "User feedback memory",
      body: "User reported a bug.",
      source_session: "session-abc-123",
    }));

    const { rebuildFromMarkdown } = await import("../memoryStore");
    await rebuildFromMarkdown("/test/workspace");

    const insertCalls = mockDb.execute.mock.calls.filter(
      (call: unknown[]) => String(call[0]).includes("INSERT INTO memories")
    );
    expect(insertCalls).toHaveLength(1);
    const params = insertCalls[0][1] as unknown[];
    // source_session is at parameter index 6 in the INSERT VALUES order
    expect(params[6]).toBe("session-abc-123");
  });

  it("calls recoverDeadLetters at the end of rebuild (kv_store SELECT query)", async () => {
    mockExists.mockResolvedValue(true);
    mockReadDir.mockResolvedValue([{ name: "project-mem-001.md" }]);
    mockReadTextFile.mockResolvedValue(createMarkdownContent({
      id: "mem-001",
      body: "Memory with dead letter recovery.",
    }));

    const { rebuildFromMarkdown } = await import("../memoryStore");
    await rebuildFromMarkdown("/test/workspace");

    // recoverDeadLetters queries kv_store for dead-letter entries
    const kvSelectCalls = mockDb.select.mock.calls.filter(
      (call: unknown[]) => String(call[0]).includes("kv_store") && String(call[0]).includes("dead_letter.markdown.%")
    );
    expect(kvSelectCalls.length).toBeGreaterThanOrEqual(1);
  });
});
