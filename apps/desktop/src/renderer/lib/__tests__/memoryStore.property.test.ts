/**
 * ============================================================
 * PROPERTY-BASED TESTS — Markdown Round-Trip
 * ============================================================
 *
 * Uses fast-check to generate random MemoryEntry values and
 * verify that writeMemoryMarkdown() → parseMarkdownMemory()
 * preserves all fields that the implementation supports.
 *
 * The round-trip is:
 *   entry → writeMemoryMarkdown(frontmatter) → parseMarkdownMemory() → result
 *
 * We verify: result.id === entry.id, result.content === entry.content,
 * result.tags === entry.tags, etc.
 *
 * Properties tested:
 *   1. All primitive fields survive round-trip exactly
 *   2. Special characters (unicode, YAML delimiters) survive
 *   3. Tags with various formats survive round-trip
 *   4. Optional fields (sourceSession, sourceFile) are preserved
 *   5. Generated IDs with varying lengths round-trip correctly
 * ============================================================
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import fc from "fast-check";
import type { MemoryEntry } from "../memoryTypes";

// ─── Module-level mocks (hoisted by vitest) ──────────────────────────────

vi.mock("@tauri-apps/plugin-fs", () => ({
  exists: vi.fn().mockResolvedValue(true),
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeTextFile: vi.fn().mockResolvedValue(undefined),
  readDir: vi.fn().mockResolvedValue([]),
  readTextFile: vi.fn().mockResolvedValue(""),
  remove: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../database", () => ({
  getDb: vi.fn(() => {
    throw new Error("Database not used in property tests");
  }),
}));

vi.mock("@/lib/pathUtils", () => ({
  joinPath: (...parts: string[]) => parts.join("/"),
}));

// ─── Imports (resolved after mocks) ──────────────────────────────────────

import { writeMemoryMarkdown, parseMarkdownMemory } from "../memoryStore";

// ============================================================================
// FAST-CHECK ARBITRARIES
// ============================================================================

const VALID_CATEGORIES = ["user", "feedback", "project", "reference", "task", "decision"] as const;
const VALID_TIERS = ["critical", "high", "medium", "low"] as const;

/**
 * Generate printable-alphanumeric strings (no control chars, no YAML-special
 * bare-value chars like `|`, `>`, `:`, `#`, `[`, `]`, `{`, `}`, `"`, `'`).
 * These are safe to use as bare YAML values without quoting.
 */
const yamlSafeString = (minLen: number, maxLen: number): fc.Arbitrary<string> =>
  fc
    .string({ minLength: minLen, maxLength: maxLen })
    .map((s) =>
      s.replace(/[^a-zA-Z0-9_./@$!*() -]/g, "x"),
    );

/**
 * Generate random IDs safe for YAML values.
 * Excludes YAML-special characters to avoid quoting issues.
 */
const idArbitrary: fc.Arbitrary<string> = fc.oneof(
  // Standard UUID format (most common in practice)
  fc.uuid(),
  // Short IDs
  yamlSafeString(1, 8),
  // Very long IDs
  yamlSafeString(64, 128),
);

/**
 * Generate content strings with safe printable characters plus
 * known-safe special chars (unicode, newlines, YAML delimiters in body).
 */
const contentArbitrary: fc.Arbitrary<string> = fc.oneof(
  // Plain text
  fc.string({ minLength: 0, maxLength: 200 }),
  // Text with newlines and indentation (using \n only, not \r)
  fc.string({ minLength: 0, maxLength: 80 }).map((s) => `Line 1\nLine 2\n${s}\nLine 4`),
  // Text with double quotes
  fc.string({ minLength: 0, maxLength: 50 }).map((s) => `He said "${s}" and left`),
  // Text with YAML frontmatter delimiter (---) in body
  fc.string({ minLength: 0, maxLength: 50 }).map((s) => `Before\n---\nAfter ${s}`),
  // Text with colons, hashes, pipes in body (safe there, not frontmatter)
  fc.string({ minLength: 0, maxLength: 50 }).map((s) => `Key: value | pipe #hash ${s}`),
  // Unicode and emoji
  fc.string({ minLength: 0, maxLength: 50 }).map((s) => `Unicode: café ñoño 你好 🎉✨ ${s}`),
  // Code blocks
  fc.string({ minLength: 0, maxLength: 50 }).map((s) => "```typescript\nconst x: number = 42;\n" + s + "\n```"),
  // Empty string
  fc.constant(""),
  // Single character
  fc.constant("A"),
  // Whitespace-only (spaces and newlines only, no \r or \t)
  fc.constant("   \n   \n   "),
  // Long string
  fc.string({ minLength: 1000, maxLength: 5000 }),
  // Text with backslash (escaped in YAML)
  fc.string({ minLength: 0, maxLength: 50 }).map((s) => `C:${s}\\typescript`),
);

/**
 * Generate summary strings (typically shorter than content, with special chars).
 * Uses nullable approach instead of empty strings to avoid parsing edge cases.
 */
const summaryArbitrary: fc.Arbitrary<string> = fc.oneof(
  fc.string({ minLength: 1, maxLength: 150 }),
  fc.constant("A"),
  fc.string({ minLength: 0, maxLength: 50 }).map((s) => `Summary with "quotes" and backslash ${s}`),
  fc.string({ minLength: 0, maxLength: 50 }).map((s) => `C:${s}\\summary`),
);

/**
 * Generate tag strings.
 * Tags cannot contain commas (implementation splits on comma), YAML special chars,
 * or be empty strings (filtered by parseMarkdownMemory).
 */
const tagArbitrary: fc.Arbitrary<string> = fc
  .string({ minLength: 1, maxLength: 20 })
  .map((s) => s.replace(/[,:#\-\]{}'"]/g, "-"));

/**
 * Generate sourceSession and sourceFile strings (optional fields).
 */
const sourceSessionArbitrary: fc.Arbitrary<string | undefined> = fc.oneof(
  fc.constant(undefined),
  fc.string({ minLength: 1, maxLength: 50 }),
);

const sourceFileArbitrary: fc.Arbitrary<string | undefined> = fc.oneof(
  fc.constant(undefined),
  fc.string({ minLength: 1, maxLength: 100 }),
  fc.constant("src/main.ts"),
  fc.constant("/path/with spaces/file name.txt"),
);

/**
 * Generate timestamps (createdAt, updatedAt).
 */
const timestampArbitrary: fc.Arbitrary<number> = fc.oneof(
  fc.constant(0),                                // Unix epoch
  fc.integer({ min: 0, max: Date.now() * 2 }),   // Any realistic timestamp
);

/**
 * Full MemoryEntry arbitrary — generates complete, valid MemoryEntry objects.
 */
const memoryEntryArbitrary: fc.Arbitrary<MemoryEntry> = fc.record({
  id: idArbitrary,
  category: fc.constantFrom(...VALID_CATEGORIES),
  tier: fc.constantFrom(...VALID_TIERS),
  content: contentArbitrary,
  summary: summaryArbitrary,
  tags: fc.array(tagArbitrary, { minLength: 0, maxLength: 10 }),
  sourceSession: sourceSessionArbitrary,
  sourceFile: sourceFileArbitrary,
  createdAt: timestampArbitrary,
  updatedAt: timestampArbitrary,
  accessCount: fc.integer({ min: 0, max: 1000 }),
  lastAccessedAt: fc.integer({ min: 0, max: Date.now() * 2 }),
  verified: fc.boolean(),
  stale: fc.boolean(),
});

// ============================================================================
// ROUND-TRIP HELPER
// ============================================================================

/**
 * Call writeMemoryMarkdown(), capture the frontmatter from the mock, then
 * parse it back with parseMarkdownMemory(). Returns the parsed result.
 */
async function roundtrip(entry: MemoryEntry): Promise<MemoryEntry | null> {
  const { writeTextFile } = await import("@tauri-apps/plugin-fs");
  const mockWtf = vi.mocked(writeTextFile);
  mockWtf.mockClear();

  await writeMemoryMarkdown("/test/workspace", entry);

  // writeMemoryMarkdown calls writeTextFile(path, frontmatter)
  const frontmatter = mockWtf.mock.calls[0]?.[1] as string | undefined;
  if (!frontmatter) return null;

  return parseMarkdownMemory(frontmatter);
}

// ============================================================================
// PROPERTY TESTS
// ============================================================================

describe("Markdown round-trip property tests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Property 1: All fields survive round-trip ───────────────────────

  it("all primitive fields survive writeMemoryMarkdown → parseMarkdownMemory round-trip", async () => {
    await fc.assert(
      fc.asyncProperty(memoryEntryArbitrary, async (entry) => {
        const result = await roundtrip(entry);

        expect(result).not.toBeNull();

        // Identity fields — must match exactly
        expect(result!.id).toBe(entry.id);
        expect(result!.category).toBe(entry.category);
        expect(result!.tier).toBe(entry.tier);

        // Content — the body of the markdown, must match exactly (trimmed on parse)
        expect(result!.content).toBe(entry.content.trim());

        // Summary — written to frontmatter, must match exactly
        expect(result!.summary).toBe(entry.summary);

        // Tags — JSON array in frontmatter
        expect(result!.tags).toEqual(expect.arrayContaining(entry.tags));
        expect(entry.tags).toEqual(expect.arrayContaining(result!.tags));
        expect(result!.tags.length).toBe(entry.tags.length);

        // Timestamps — stored as integers in frontmatter
        expect(result!.createdAt).toBe(entry.createdAt);
        expect(result!.updatedAt).toBe(entry.updatedAt);

        // Stale — serialized as boolean in frontmatter
        expect(result!.stale).toBe(entry.stale);

        // Source fields — optional, preserved when present
        expect(result!.sourceSession).toBe(entry.sourceSession || undefined);
        expect(result!.sourceFile).toBe(entry.sourceFile || undefined);

        // Runtime-only fields — set to defaults (not stored in frontmatter)
        expect(result!.accessCount).toBe(0);
        expect(result!.lastAccessedAt).toBe(0);
        expect(result!.verified).toBe(false);
      }),
      { numRuns: 200, verbose: false },
    );
  });

  // ── Property 2: ID round-trip ──────────────────────────────────────

  it("round-trips IDs of any length and format", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          fc.uuid(),
          yamlSafeString(1, 8),
          yamlSafeString(100, 200),
        ),
        async (id) => {
          const entry: MemoryEntry = {
            id,
            category: "project",
            tier: "medium",
            content: "Test content",
            summary: "Test",
            tags: [],
            createdAt: 1_700_000_000_000,
            updatedAt: 1_700_000_000_000,
            accessCount: 0,
            lastAccessedAt: 0,
            verified: false,
            stale: false,
          };

          const result = await roundtrip(entry);
          expect(result).not.toBeNull();
          expect(result!.id).toBe(id);
        },
      ),
      { numRuns: 100 },
    );
  });

  // ── Property 3: Content with special chars ─────────────────────────

  it("round-trips content with special characters and YAML delimiters", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 0, maxLength: 200 }),
        async (content) => {
          const entry: MemoryEntry = {
            id: "test-special-content",
            category: "project",
            tier: "medium",
            content,
            summary: "Special content test",
            tags: [],
            createdAt: 1_700_000_000_000,
            updatedAt: 1_700_000_000_000,
            accessCount: 0,
            lastAccessedAt: 0,
            verified: false,
            stale: false,
          };

          const result = await roundtrip(entry);
          expect(result).not.toBeNull();
          // Content body is trimmed by parseMarkdownMemory
          expect(result!.content).toBe(content.trim());
        },
      ),
      { numRuns: 200 },
    );
  });

  // ── Property 4: Summary with special chars ─────────────────────────

  it("round-trips summary with quotes, backslashes, and special chars", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 150 }),
        async (summary) => {
          const entry: MemoryEntry = {
            id: "test-summary-special",
            category: "reference",
            tier: "high",
            content: "Body content",
            summary,
            tags: [],
            createdAt: 1_700_000_000_000,
            updatedAt: 1_700_000_000_000,
            accessCount: 0,
            lastAccessedAt: 0,
            verified: false,
            stale: false,
          };

          const result = await roundtrip(entry);
          expect(result).not.toBeNull();
          expect(result!.summary).toBe(summary);
        },
      ),
      { numRuns: 200 },
    );
  });

  // ── Property 5: Tags round-trip ────────────────────────────────────

  it("round-trips tags with various formats and special characters", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(tagArbitrary, { minLength: 0, maxLength: 10 }),
        async (tags) => {
          const entry: MemoryEntry = {
            id: "test-tags",
            category: "project",
            tier: "medium",
            content: "Tags test content",
            summary: "Tags test",
            tags,
            createdAt: 1_700_000_000_000,
            updatedAt: 1_700_000_000_000,
            accessCount: 0,
            lastAccessedAt: 0,
            verified: false,
            stale: false,
          };

          const result = await roundtrip(entry);
          expect(result).not.toBeNull();
          expect(result!.tags).toEqual(tags);
        },
      ),
      { numRuns: 200 },
    );
  });

  // ── Property 6: Category/tier enum values ─────────────────────────

  it("round-trips all valid category and tier combinations", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...VALID_CATEGORIES),
        fc.constantFrom(...VALID_TIERS),
        async (category, tier) => {
          const entry: MemoryEntry = {
            id: "test-cat-tier",
            category,
            tier,
            content: `Content for ${category} / ${tier}`,
            summary: `Test ${category} ${tier}`,
            tags: [],
            createdAt: 1_700_000_000_000,
            updatedAt: 1_700_000_000_000,
            accessCount: 0,
            lastAccessedAt: 0,
            verified: false,
            stale: false,
          };

          const result = await roundtrip(entry);
          expect(result).not.toBeNull();
          expect(result!.category).toBe(category);
          expect(result!.tier).toBe(tier);
        },
      ),
      { numRuns: 100 },
    );
  });

  // ── Property 7: Timestamps ────────────────────────────────────────

  it("round-trips timestamps including epoch (0) and large values", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          fc.constant(0),
          fc.integer({ min: 1_000_000_000_000, max: 2_000_000_000_000 }),
          fc.integer({ min: 0, max: 100 }),
        ),
        fc.oneof(
          fc.constant(0),
          fc.integer({ min: 1_000_000_000_000, max: 2_000_000_000_000 }),
        ),
        async (createdAt, updatedAt) => {
          const entry: MemoryEntry = {
            id: "test-ts",
            category: "project",
            tier: "low",
            content: "Timestamp test",
            summary: "Timestamp test",
            tags: [],
            createdAt,
            updatedAt,
            accessCount: 0,
            lastAccessedAt: 0,
            verified: false,
            stale: false,
          };

          const result = await roundtrip(entry);
          expect(result).not.toBeNull();
          expect(result!.createdAt).toBe(createdAt);
          expect(result!.updatedAt).toBe(updatedAt);
        },
      ),
      { numRuns: 100 },
    );
  });

  // ── Property 8: Stale flag ────────────────────────────────────────

  it("round-trips stale=true and stale=false", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.boolean(),
        async (stale) => {
          const entry: MemoryEntry = {
            id: "test-stale",
            category: "project",
            tier: "medium",
            content: "Stale flag test",
            summary: "Stale test",
            tags: [],
            createdAt: 1_700_000_000_000,
            updatedAt: 1_700_000_000_000,
            accessCount: 0,
            lastAccessedAt: 0,
            verified: false,
            stale,
          };

          const result = await roundtrip(entry);
          expect(result).not.toBeNull();
          expect(result!.stale).toBe(stale);
        },
      ),
      { numRuns: 50 },
    );
  });

  // ── Property 9: Optional source fields ────────────────────────────

  it("preserves sourceSession and sourceFile when present, omits when absent", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.option(fc.string({ minLength: 1, maxLength: 50 }), { nil: undefined }),
        fc.option(fc.string({ minLength: 1, maxLength: 100 }), { nil: undefined }),
        async (sourceSession, sourceFile) => {
          const entry: MemoryEntry = {
            id: "test-source",
            category: "feedback",
            tier: "high",
            content: "Source fields test",
            summary: "Source fields test",
            tags: [],
            createdAt: 1_700_000_000_000,
            updatedAt: 1_700_000_000_000,
            accessCount: 0,
            lastAccessedAt: 0,
            verified: false,
            stale: false,
            sourceSession,
            sourceFile,
          };

          const result = await roundtrip(entry);
          expect(result).not.toBeNull();
          expect(result!.sourceSession).toBe(sourceSession || undefined);
          expect(result!.sourceFile).toBe(sourceFile || undefined);
        },
      ),
      { numRuns: 100 },
    );
  });

  // ── Property 10: Empty memory entry ───────────────────────────────

  it("handles minimal memory entry with empty fields", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          id: fc.oneof(fc.uuid(), yamlSafeString(1, 50)),
          category: fc.constantFrom(...VALID_CATEGORIES),
          tier: fc.constantFrom(...VALID_TIERS),
          content: fc.constant(""),
          summary: fc.constant(""),
          tags: fc.constant<string[]>([]),
          sourceSession: fc.constant(undefined),
          sourceFile: fc.constant(undefined),
          createdAt: fc.constant(1_700_000_000_000),
          updatedAt: fc.constant(1_700_000_000_000),
          stale: fc.constant(false),
        }),
        async (fields) => {
          const entry: MemoryEntry = {
            ...fields,
            accessCount: 5,
            lastAccessedAt: 1_700_000_000_001,
            verified: true,
          };

          const result = await roundtrip(entry);
          expect(result).not.toBeNull();
          expect(result!.id).toBe(entry.id);
          expect(result!.category).toBe(entry.category);
          expect(result!.tier).toBe(entry.tier);
          expect(result!.content).toBe("");
          expect(result!.summary).toBe(entry.summary);
          expect(result!.tags).toEqual([]);
          expect(result!.stale).toBe(false);
          expect(result!.sourceSession).toBeUndefined();
          expect(result!.sourceFile).toBeUndefined();
        },
      ),
      { numRuns: 100 },
    );
  });
});
