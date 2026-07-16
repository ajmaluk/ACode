/* eslint-disable @typescript-eslint/no-explicit-any */
// The `any` type is used here intentionally for mock implementations where
// concrete database and filesystem types would be overly restrictive.

/**
 * Tests for recoverDeadLetters() and processPendingWrites().
 *
 * These tests mock the Tauri filesystem plugin (@tauri-apps/plugin-fs) and the
 * database module (./database) to simulate kv_store entries and markdown write
 * success/failure without hitting real filesystem or SQLite.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { MemoryEntry } from "./memoryTypes";

// ─── Module-level mocks (hoisted by vitest) ──────────────────────────────

vi.mock("@tauri-apps/plugin-fs", () => ({
  exists: vi.fn().mockResolvedValue(true),
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeTextFile: vi.fn().mockResolvedValue(undefined),
  readDir: vi.fn().mockResolvedValue([]),
  readTextFile: vi.fn().mockResolvedValue(""),
  remove: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./database", () => ({
  getDb: vi.fn(() => ({
    select: vi.fn().mockResolvedValue([]),
    execute: vi.fn().mockResolvedValue({ rowsAffected: 1 }),
  })),
  isDatabaseReady: vi.fn(() => true),
}));

// ─── Imports (resolved after mocks are in place) ─────────────────────────

import { recoverDeadLetters, processPendingWrites, writeMemoryMarkdown, parseMarkdownMemory } from "./memoryStore";
import { getDb } from "./database";

// ─── Helpers ─────────────────────────────────────────────────────────────

function createMockEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: "test-id-123",
    category: "project",
    tier: "medium",
    content: "Test content body",
    summary: "Test summary",
    tags: ["test"],
    sourceSession: undefined,
    sourceFile: undefined,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    accessCount: 0,
    lastAccessedAt: 0,
    verified: false,
    stale: false,
    ...overrides,
  };
}

function createDeadLetterRow(
  id: string,
  overrides?: Partial<{
    workspacePath: string;
    retries: number;
    memoryEntry: MemoryEntry;
  }>,
): { key: string; value: string } {
  const payload = {
    memoryEntry: createMockEntry({ id }),
    workspacePath: "/test/ws",
    retries: 0,
    ...overrides,
  };
  return {
    key: `dead_letter.markdown.${id}`,
    value: JSON.stringify(payload),
  };
}

/** Runtime type for the mock database object — used with `as any` cast in mockReturnValue */
interface MockDb {
  select: ReturnType<typeof vi.fn>;
  execute: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

/**
 * Create a mock database with overridable select/execute.
 * By default select returns [] and execute returns { rowsAffected: 1 }.
 */
function mockDb(opts?: {
  selectResult?: unknown[];
  selectError?: Error;
  executeResult?: { rowsAffected: number };
  executeError?: Error;
}): MockDb {
  const db: MockDb = {
    select: vi.fn(),
    execute: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  };

  if (opts?.selectError) {
    db.select.mockRejectedValue(opts.selectError);
  } else {
    db.select.mockResolvedValue(opts?.selectResult ?? []);
  }

  if (opts?.executeError) {
    db.execute.mockRejectedValue(opts.executeError);
  } else {
    db.execute.mockResolvedValue(opts?.executeResult ?? { rowsAffected: 1 });
  }

  return db;
}

// ============================================================================
// recoverDeadLetters()
// ============================================================================

describe("recoverDeadLetters", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Empty / no-op ─────────────────────────────────────────────────────

  it("returns 0 when kv_store has no dead-letter entries", async () => {
    const db = mockDb({ selectResult: [] });
    vi.mocked(getDb).mockReturnValue(db as any);

    const result = await recoverDeadLetters();

    expect(result).toBe(0);
    expect(db.select).toHaveBeenCalledWith(
      "SELECT key, value FROM kv_store WHERE key LIKE 'dead_letter.markdown.%'",
    );
    expect(db.execute).not.toHaveBeenCalled();
  });

  // ── Successful recovery ────────────────────────────────────────────────

  it("recovers a valid dead-letter entry: writes markdown and deletes from kv_store", async () => {
    const row = createDeadLetterRow("dead-001");
    const db = mockDb({ selectResult: [row] });
    vi.mocked(getDb).mockReturnValue(db as any);

    const result = await recoverDeadLetters();

    expect(result).toBe(1);
    // Should DELETE the kv_store row after successful markdown write
    expect(db.execute).toHaveBeenCalledWith(
      "DELETE FROM kv_store WHERE key = ?",
      ["dead_letter.markdown.dead-001"],
    );
  });

  it("recovers multiple entries and returns the count", async () => {
    const rows = [
      createDeadLetterRow("dead-1"),
      createDeadLetterRow("dead-2"),
      createDeadLetterRow("dead-3"),
    ];
    const db = mockDb({ selectResult: rows });
    vi.mocked(getDb).mockReturnValue(db as any);

    const result = await recoverDeadLetters();

    expect(result).toBe(3);
    expect(db.execute).toHaveBeenCalledTimes(3);
  });

  // ── Exhausted retries ──────────────────────────────────────────────────

  it("skips entries with exhausted retries and removes them", async () => {
    const row = createDeadLetterRow("dead-exhausted", { retries: 3 });
    const db = mockDb({ selectResult: [row] });
    vi.mocked(getDb).mockReturnValue(db as any);

    const result = await recoverDeadLetters();

    expect(result).toBe(0);
    // Should remove the exhausted entry
    expect(db.execute).toHaveBeenCalledWith(
      "DELETE FROM kv_store WHERE key = ?",
      ["dead_letter.markdown.dead-exhausted"],
    );
  });

  // ── Write succeeds but DELETE fails → retry increment ─────────────────

  it("increments retry count when db.execute(DELETE) fails after successful markdown write", async () => {
    const row = createDeadLetterRow("dead-del-fail", { retries: 0 });
    const db = mockDb({ selectResult: [row] });
    // Make the first execute call (DELETE) reject, but subsequent ones succeed
    db.execute
      .mockRejectedValueOnce(new Error("DELETE failed"))
      .mockResolvedValue({ rowsAffected: 1 });
    vi.mocked(getDb).mockReturnValue(db as any);

    const result = await recoverDeadLetters();

    expect(result).toBe(0);
    // First call was the DELETE (rejected), second should be UPDATE with retries incremented
    expect(db.execute.mock.calls[1]).toEqual([
      "UPDATE kv_store SET value = ? WHERE key = ?",
      expect.arrayContaining([
        expect.stringContaining('"retries":1'), // retries was 0, now 1
        "dead_letter.markdown.dead-del-fail",
      ]),
    ]);
  });

  // ── Invalid payload ────────────────────────────────────────────────────

  it("handles invalid JSON payload gracefully without throwing", async () => {
    const rows = [{ key: "dead_letter.markdown.bad-json", value: "not-valid-json" }];
    const db = mockDb({ selectResult: rows });
    vi.mocked(getDb).mockReturnValue(db as any);

    // Should not throw — both JSON.parse attempts fail (outer + inner catch)
    const result = await recoverDeadLetters();

    expect(result).toBe(0);
    // When both JSON.parse attempts fail, the inner catch silently swallows
    // the error. No db.execute is called because parse fails before any query.
    expect(db.execute).not.toHaveBeenCalled();
  });

  // ── Database error ─────────────────────────────────────────────────────

  it("returns 0 when getDb throws (database not ready)", async () => {
    vi.mocked(getDb).mockImplementation(() => {
      throw new Error("Database not initialized");
    });

    const result = await recoverDeadLetters();

    expect(result).toBe(0);
  });

  it("returns 0 when db.select throws", async () => {
    const db = mockDb({ selectError: new Error("SQL error") });
    vi.mocked(getDb).mockReturnValue(db as any);

    const result = await recoverDeadLetters();

    expect(result).toBe(0);
  });

  // ── maxRecover limit ───────────────────────────────────────────────────

  it("respects maxRecover limit (default: 50, test: 2)", async () => {
    const rows = Array.from({ length: 5 }, (_, i) =>
      createDeadLetterRow(`dead-limit-${i}`),
    );
    const db = mockDb({ selectResult: rows });
    vi.mocked(getDb).mockReturnValue(db as any);

    const result = await recoverDeadLetters(2);

    expect(result).toBe(2);
    expect(db.execute).toHaveBeenCalledTimes(2);
  });
});

// ============================================================================
// processPendingWrites()
// ============================================================================

describe("processPendingWrites", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("is a no-op when there are no pending writes and no dead letters", async () => {
    const db = mockDb({ selectResult: [] });
    vi.mocked(getDb).mockReturnValue(db as any);

    // Should not throw
    await expect(processPendingWrites()).resolves.toBeUndefined();

    // recoverDeadLetters() is called internally — should query kv_store
    expect(db.select).toHaveBeenCalledWith(
      "SELECT key, value FROM kv_store WHERE key LIKE 'dead_letter.markdown.%'",
    );
  });

  it("recovers dead letters before processing pending writes", async () => {
    // Set up a recoverable dead letter in kv_store
    const row = createDeadLetterRow("dead-before-pending");
    const db = mockDb({ selectResult: [row] });
    vi.mocked(getDb).mockReturnValue(db as any);

    await processPendingWrites();

    // Should have been recovered (markdown written) and deleted from kv_store
    expect(db.execute).toHaveBeenCalledWith(
      "DELETE FROM kv_store WHERE key = ?",
      ["dead_letter.markdown.dead-before-pending"],
    );
  });

  it("does not throw when a pending write is deferred for retry", async () => {
    // Trigger a pending write failure by making writeTextFile throw
    const { writeTextFile } = await import("@tauri-apps/plugin-fs");
    vi.mocked(writeTextFile).mockRejectedValue(new Error("Disk full"));

    // Write a memory entry — this will fail internally and push to _pendingWrites
    const entry = createMockEntry({ id: "pending-deferred" });
    await writeMemoryMarkdown("/test/ws", entry).catch(() => {});

    const db = mockDb({ selectResult: [] });
    vi.mocked(getDb).mockReturnValue(db as any);

    // Should not throw — errors caught internally
    await expect(processPendingWrites()).resolves.toBeUndefined();
  });

  it("defers retry when deferral period has not yet elapsed", async () => {
    // Make writeTextFile throw so writeMemoryMarkdown fails
    const { writeTextFile } = await import("@tauri-apps/plugin-fs");
    vi.mocked(writeTextFile).mockRejectedValue(new Error("Disk full"));

    // Write a memory entry — pushes to _pendingWrites with retries=0, timestamp=now
    const entry = createMockEntry({ id: "pending-defer" });
    await writeMemoryMarkdown("/test/ws", entry).catch(() => {});

    const db = mockDb({ selectResult: [] });
    vi.mocked(getDb).mockReturnValue(db as any);

    // processPendingWrites will:
    // 1. Call recoverDeadLetters (empty kv_store → 0)
    // 2. Process _pendingWrites — the entry has retries=0, timestamp=now
    //    Deferral check: now - timestamp < 5000 (WRITE_RETRY_DELAY_MS * 1)
    //    → stays in stillPending, no retry
    // 3. Merge back into _pendingWrites
    await processPendingWrites();

    // The entry was NOT retried (deferral period active), so no write attempt
    // happened. No kv_store dead-letter queries were issued beyond the
    // initial recoverDeadLetters() call.
    const countCall = db.select.mock.calls.filter(
      (call: unknown[]) => typeof call[0] === "string" && (call[0] as string).includes("COUNT(*)"),
    );
    // COUNT(*) query only runs if deadLetters[] is non-empty, which requires
    // retries >= MAX_WRITE_RETRIES. Since entry wasn't retried, it's empty.
    expect(countCall).toHaveLength(0);
    // Verify processPendingWrites completed without error
    expect(db.execute).not.toHaveBeenCalled();
  });
});

// ============================================================================
// writeMemoryMarkdown() + parseMarkdownMemory() — Full round-trip
// ============================================================================

/**
 * Helper: call writeMemoryMarkdown(), then extract the written frontmatter
 * from the writeTextFile mock, and parse it back with parseMarkdownMemory().
 */
async function roundtrip(entry: MemoryEntry): Promise<MemoryEntry | null> {
  const { writeTextFile } = await import("@tauri-apps/plugin-fs");
  const mockWtf = vi.mocked(writeTextFile);
  mockWtf.mockClear();

  await writeMemoryMarkdown("/test/workspace", entry);

  // writeMemoryMarkdown calls writeTextFile(path, frontmatter)
  expect(mockWtf).toHaveBeenCalledTimes(1);
  const frontmatter = mockWtf.mock.calls[0][1] as string;
  return parseMarkdownMemory(frontmatter);
}

describe("writeMemoryMarkdown + parseMarkdownMemory round-trip", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Basic round-trip ────────────────────────────────────────────────

  it("preserves all fields through write → parse round-trip", async () => {
    const entry = createMockEntry({
      id: "rt-basic",
      category: "decision",
      tier: "high",
      content: "Important architectural decision",
      summary: "Architectural decision: use tRPC",
      tags: ["typescript", "api", "tRPC"],
      sourceSession: "session-rt-1",
      sourceFile: "src/arch.md",
    });

    const result = await roundtrip(entry);

    expect(result).not.toBeNull();
    expect(result!.id).toBe(entry.id);
    expect(result!.category).toBe(entry.category);
    expect(result!.tier).toBe(entry.tier);
    expect(result!.content).toBe(entry.content);
    expect(result!.summary).toBe(entry.summary);
    expect(result!.tags).toEqual(entry.tags);
    expect(result!.sourceSession).toBe(entry.sourceSession);
    expect(result!.sourceFile).toBe(entry.sourceFile);
    expect(result!.stale).toBe(entry.stale);
    expect(result!.createdAt).toBe(entry.createdAt);
    expect(result!.updatedAt).toBe(entry.updatedAt);
  });

  // ── Optional fields absent ───────────────────────────────────────────

  it("handles entries without sourceSession or sourceFile", async () => {
    const entry = createMockEntry({
      id: "rt-no-optional",
      sourceSession: undefined,
      sourceFile: undefined,
    });

    const result = await roundtrip(entry);

    expect(result).not.toBeNull();
    expect(result!.sourceSession).toBeUndefined();
    expect(result!.sourceFile).toBeUndefined();
    expect(result!.content).toBe(entry.content);
  });

  // ── Special characters in summary ─────────────────────────────────────

  it("round-trips double quotes in summary", async () => {
    const entry = createMockEntry({
      id: "rt-quotes",
      summary: 'Use "double quotes" carefully',
    });

    const result = await roundtrip(entry);

    expect(result).not.toBeNull();
    expect(result!.summary).toBe('Use "double quotes" carefully');
  });

  it("round-trips backslashes in summary", async () => {
    const entry = createMockEntry({
      id: "rt-backslash",
      summary: "C:\\Users\\test\\file.ts",
    });

    const result = await roundtrip(entry);

    expect(result).not.toBeNull();
    expect(result!.summary).toBe("C:\\Users\\test\\file.ts");
  });

  it("round-trips newlines in summary", async () => {
    const entry = createMockEntry({
      id: "rt-newline",
      summary: "line1\nline2\nline3",
    });

    const result = await roundtrip(entry);

    expect(result).not.toBeNull();
    expect(result!.summary).toBe("line1\nline2\nline3");
  });

  it("round-trips tabs and carriage returns in summary", async () => {
    const entry = createMockEntry({
      id: "rt-control",
      summary: "before\tafter\r\nend",
    });

    const result = await roundtrip(entry);

    expect(result).not.toBeNull();
    expect(result!.summary).toBe("before\tafter\r\nend");
  });

  // ── Tags edge cases ─────────────────────────────────────────────────

  it("round-trips empty tags array", async () => {
    const entry = createMockEntry({
      id: "rt-empty-tags",
      tags: [],
    });

    const result = await roundtrip(entry);

    expect(result).not.toBeNull();
    expect(result!.tags).toEqual([]);
  });

  it("round-trips tags with special characters", async () => {
    const entry = createMockEntry({
      id: "rt-special-tags",
      tags: ["tag-one", "tag_two", "tag.three", "c++"],
    });

    const result = await roundtrip(entry);

    expect(result).not.toBeNull();
    expect(result!.tags).toContain("tag-one");
    expect(result!.tags).toContain("tag_two");
    expect(result!.tags).toContain("tag.three");
    expect(result!.tags).toContain("c++");
  });

  // ── Stale flag ───────────────────────────────────────────────────────

  it("round-trips stale=true", async () => {
    const entry = createMockEntry({
      id: "rt-stale",
      stale: true,
    });

    const result = await roundtrip(entry);

    expect(result).not.toBeNull();
    expect(result!.stale).toBe(true);
  });

  // ── Timestamps ───────────────────────────────────────────────────────

  it("round-trips timestamp 0 (Unix epoch)", async () => {
    const entry = createMockEntry({
      id: "rt-epoch",
      createdAt: 0,
      updatedAt: 0,
    });

    const result = await roundtrip(entry);

    expect(result).not.toBeNull();
    expect(result!.createdAt).toBe(0);
    expect(result!.updatedAt).toBe(0);
  });

  it("round-trips large timestamps (near future)", async () => {
    const future = 1_899_345_600_000; // Year 2030
    const entry = createMockEntry({
      id: "rt-future",
      createdAt: future,
      updatedAt: future,
    });

    const result = await roundtrip(entry);

    expect(result).not.toBeNull();
    expect(result!.createdAt).toBe(future);
    expect(result!.updatedAt).toBe(future);
  });

  // ── Content body ─────────────────────────────────────────────────────

  it("round-trips multi-line content body", async () => {
    const entry = createMockEntry({
      id: "rt-multiline",
      content: "Line 1\nLine 2\n\nLine 4 with `code`",
    });

    const result = await roundtrip(entry);

    expect(result).not.toBeNull();
    expect(result!.content).toBe("Line 1\nLine 2\n\nLine 4 with `code`");
  });

  it("round-trips content with unicode and emoji", async () => {
    const entry = createMockEntry({
      id: "rt-unicode",
      content: "Unicode: café ñoño 你好 🎉✨\nEmoji: 🚀🔥💯",
    });

    const result = await roundtrip(entry);

    expect(result).not.toBeNull();
    expect(result!.content).toBe("Unicode: café ñoño 你好 🎉✨\nEmoji: 🚀🔥💯");
  });

  it("round-trips content with code snippets", async () => {
    const entry = createMockEntry({
      id: "rt-code",
      content: '```typescript\nconst x: number = 42;\nconsole.log(x);\n```',
    });

    const result = await roundtrip(entry);

    expect(result).not.toBeNull();
    expect(result!.content).toBe('```typescript\nconst x: number = 42;\nconsole.log(x);\n```');
  });

  // ── All valid categories and tiers ───────────────────────────────────

  const VALID_CATEGORIES = ["user", "feedback", "project", "reference", "task", "decision"] as const;
  const VALID_TIERS = ["critical", "high", "medium", "low"] as const;

  for (const cat of VALID_CATEGORIES) {
    for (const tier of VALID_TIERS) {
      it(`round-trips category="${cat}" tier="${tier}"`, async () => {
        const entry = createMockEntry({
          id: `rt-${cat}-${tier}`,
          category: cat as any,
          tier: tier as any,
        });

        const result = await roundtrip(entry);

        expect(result).not.toBeNull();
        expect(result!.category).toBe(cat);
        expect(result!.tier).toBe(tier);
      });
    }
  }

  // ── Content with YAML-like delimiters ──────────────────────────────

  it("round-trips content containing YAML frontmatter delimiter (---)", async () => {
    const entry = createMockEntry({
      id: "rt-yaml-in-content",
      content: "Some text\n\n---\n\nThis has a horizontal rule in it",
    });

    const result = await roundtrip(entry);

    expect(result).not.toBeNull();
    expect(result!.content).toBe("Some text\n\n---\n\nThis has a horizontal rule in it");
  });

  // ── Tags with special characters ─────────────────────────────────────

  it("round-trips tags with embedded quotes and YAML special chars", async () => {
    const entry = createMockEntry({
      id: "rt-tag-quotes",
      tags: ["c#", "tag:name", '"quoted"'],
    });

    const result = await roundtrip(entry);

    expect(result).not.toBeNull();
    expect(result!.tags).toContain("c#");
    expect(result!.tags).toContain("tag:name");
    expect(result!.tags).toContain('"quoted"');
  });

  // ── Write fails gracefully ───────────────────────────────────────────

  it("catches error and queues retry when writeTextFile throws", async () => {
    const { writeTextFile } = await import("@tauri-apps/plugin-fs");
    vi.mocked(writeTextFile).mockRejectedValue(new Error("Permission denied"));

    const entry = createMockEntry({ id: "rt-fail" });

    // writeMemoryMarkdown catches errors internally — should not throw
    await expect(writeMemoryMarkdown("/test/ws", entry)).resolves.toBeUndefined();

    // writeTextFile was called (attempted), then failed
    expect(writeTextFile).toHaveBeenCalledTimes(1);
  });
});
