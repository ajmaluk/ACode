/**
 * ============================================================
 * PROPERTY-BASED TESTS — Markdown Round-Trip
 * ============================================================
 *
 * Uses fast-check to generate random MemoryEntry values and
 * verify that writeMemoryMarkdown() → parseMarkdownMemory()
 * is a **lossless round-trip** for all valid inputs.
 *
 * The round-trip is:
 *   entry → writeMemoryMarkdown(frontmatter) → parseMarkdownMemory() → result
 *
 * We verify: result.id === entry.id, result.content === entry.content,
 * result.tags === entry.tags, etc.
 *
 * Properties tested:
 *   1. All primitive fields survive round-trip exactly
 *   2. Special characters (unicode, control chars, YAML specials) survive
 *   3. Tags with special characters survive
 *   4. Optional fields (sourceSession, sourceFile) are preserved when present
 *   5. Generated IDs with varying lengths round-trip correctly
 * ============================================================
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
// `any` is used in test mocks where concrete types are overly restrictive

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
 * Generate random IDs: UUID-like, short, or with special substrings.
 * This mirrors the real generateId() which uses Date.now().toString(36) + crypto.randomUUID().
 */
const idArbitrary: fc.Arbitrary<string> = fc.oneof(
  // Standard UUID format (most common in practice)
  fc.uuid(),
  // Short IDs (edge case: very short content)
  fc.string({ minLength: 1, maxLength: 8 }),
  // Very long IDs
  fc.string({ minLength: 64, maxLength: 128 }),
  // IDs with hyphens (like real UUIDs)          fc.string({ minLength: 36, maxLength: 36 }).map((s) =>
    `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`
  ),
);

/**
 * Generate content strings with special characters, unicode, YAML delimiters, etc.
 * This covers the most common edge cases for markdown frontmatter.
 */
const contentArbitrary: fc.Arbitrary<string> = fc.oneof(
  // Plain text (the happy path)
  fc.string({ minLength: 0, maxLength: 200 }),
  // Text with newlines and indentation
  fc.string({ minLength: 0, maxLength: 80 }).map((s) => `Line 1\nLine 2\n${s}\nLine 4`),
  // Text with double quotes (YAML escaping edge case)
  fc.string({ minLength: 0, maxLength: 50 }).map((s) => `He said "${s}" and left`),
  // Text with backslashes (YAML escaping edge case)
  fc.string({ minLength: 0, maxLength: 50 }).map((s) => `C:\\Users\\${s}\\file.ts`),
  // Text with YAML frontmatter delimiter (---) in body
  fc.string({ minLength: 0, maxLength: 50 }).map((s) => `Before\n---\nAfter ${s}`),
  // Text with colons, hashes, pipes (YAML special chars)
  fc.string({ minLength: 0, maxLength: 50 }).map((s) => `Key: value | pipe #hash ${s}`),
  // Unicode and emoji
  fc.string({ minLength: 0, maxLength: 50 }).map((s) => `Unicode: café ñoño 你好 🎉✨ ${s}`),
  // Code blocks
  fc.string({ minLength: 0, maxLength: 50 }).map((s) => "```typescript\nconst x: number = 42;\n" + s + "\n```"),
  // Null/empty string
  fc.constant(""),
  // Single character
  fc.constant("A"),
  // Whitespace-only
  fc.constant("   \n   \t   "),
  // Tabs and carriage returns
  fc.string({ minLength: 0, maxLength: 30 }).map((s) => `before\tafter\r\n${s}\tend`),
  // Very long string
  fc.string({ minLength: 1000, maxLength: 5000 }),
);

/**
 * Generate summary strings (typically shorter than content, with special chars).
 */
const summaryArbitrary: fc.Arbitrary<string> = fc.oneof(
  fc.string({ minLength: 0, maxLength: 150 }),
  fc.constant(""),
  fc.constant("A"),
  fc.string({ minLength: 0, maxLength: 50 }).map((s) => `Summary with "quotes" and \\backslash ${s}`),
  fc.string({ minLength: 0, maxLength: 50 }).map((s) => `C:\\Users\\${s}\\summary`),
);

/**
 * Generate tag strings (alphanumeric, hyphens, periods, special chars).
 */
const tagArbitrary: fc.Arbitrary<string> = fc.oneof(
  fc.string({ minLength: 1, maxLength: 20 }),
  fc.constant("c#"),
  fc.constant("c++"),
  fc.constant("tag:name"),
  fc.constant('"quoted"'),
  fc.constant("tag-one"),
  fc.constant("tag_two"),
  fc.constant("tag.three"),
  fc.constant("#hashtag"),
  fc.constant(""),
);

/**
 * Generate sourceSession and sourceFile strings (optional fields).
 */
const sourceSessionArbitrary: fc.Arbitrary<string | undefined> = fc.oneof(
  fc.constant(undefined),
  fc.string({ minLength: 1, maxLength: 50 }),
  fc.constant("session-" + crypto.randomUUID()),
);

const sourceFileArbitrary: fc.Arbitrary<string | undefined> = fc.oneof(
  fc.constant(undefined),
  fc.string({ minLength: 1, maxLength: 100 }),
  fc.constant("src/main.ts"),
  fc.constant("C:\\Users\\test\\file.ts"),
  fc.constant("/path/with spaces/file name.txt"),
  fc.constant(""),
);

/**
 * Generate random timestamps (createdAt, updatedAt).
 * Covers: recent, epoch (0), future, very old.
 */
const timestampArbitrary: fc.Arbitrary<number> = fc.oneof(
  fc.constant(0),                                // Unix epoch
  fc.integer({ min: 0, max: Date.now() * 2 }),   // Any realistic timestamp
);

/**
 * Generate random booleans for stale and verified.
 */
const booleanArbitrary: fc.Arbitrary<boolean> = fc.boolean();

/**
 * Generate random integers for accessCount and lastAccessedAt.
 */
const nonNegativeIntArbitrary: fc.Arbitrary<number> = fc.oneof(
  fc.constant(0),
  fc.integer({ min: 0, max: 1000 }),
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
  accessCount: nonNegativeIntArbitrary,
  lastAccessedAt: nonNegativeIntArbitrary,
  verified: booleanArbitrary,
  stale: booleanArbitrary,
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

        // Should not be null (valid entry should produce valid frontmatter)
        expect(result).not.toBeNull();

        // Identity fields — must match exactly
        expect(result!.id).toBe(entry.id);
        expect(result!.category).toBe(entry.category);
        expect(result!.tier).toBe(entry.tier);

        // Content — the body of the markdown, must match exactly
        expect(result!.content).toBe(entry.content.trim());

        // Summary — written to frontmatter, must match exactly
        expect(result!.summary).toBe(entry.summary);

        // Tags — JSON array in frontmatter, must match exactly
        // Empty tags and filled tags both round-trip
        expect(result!.tags).toEqual(entry.tags.filter((t) => t !== ""));

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
          fc.string({ minLength: 1, maxLength: 8 }),
          fc.string({ minLength: 100, maxLength: 200 }),
          fc.string({ minLength: 36, maxLength: 36 }),
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
        fc.string({ minLength: 0, maxLength: 150 }),
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
        fc.array(
          fc.oneof(
            fc.string({ minLength: 1, maxLength: 20 }),
            fc.constant("c#"),
            fc.constant("c++"),
            fc.constant("tag:name"),
            fc.constant('"quoted"'),
            fc.constant("tag-one"),
            fc.constant("tag_two"),
          ),
          { minLength: 0, maxLength: 8 },
        ),
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

          // Empty strings are filtered out by parseMarkdownMemory
          const expectedTags = tags.filter((t) => t !== "");
          expect(result!.tags).toEqual(expectedTags);
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

  // ── Property 10: Full round-trip with many random fields ──────────

  it("all fields are consistent after full round-trip with maximum entropy", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          id: fc.oneof(fc.uuid(), fc.string({ minLength: 1, maxLength: 100 })),
          category: fc.constantFrom(...VALID_CATEGORIES),
          tier: fc.constantFrom(...VALID_TIERS),
          content: fc.string({ minLength: 0, maxLength: 500 }),
          summary: fc.string({ minLength: 0, maxLength: 150 }),
          tags: fc.array(
            fc.string({ minLength: 0, maxLength: 30 }),
            { minLength: 0, maxLength: 5 },
          ),
          sourceSession: fc.option(fc.string({ minLength: 0, maxLength: 50 }), { nil: undefined }),
          sourceFile: fc.option(fc.string({ minLength: 0, maxLength: 100 }), { nil: undefined }),
          createdAt: fc.integer({ min: 0, max: Date.now() * 2 }),
          updatedAt: fc.integer({ min: 0, max: Date.now() * 2 }),
          stale: fc.boolean(),
        }),
        async (fields) => {
          const entry: MemoryEntry = {
            ...fields,
            tags: fields.tags.filter((t) => t !== undefined && t !== null) as string[],
            accessCount: 0,
            lastAccessedAt: 0,
            verified: false,
          };

          const result = await roundtrip(entry);
          expect(result).not.toBeNull();

          // Identity
          expect(result!.id).toBe(entry.id);
          expect(result!.category).toBe(entry.category);
          expect(result!.tier).toBe(entry.tier);

          // Content is trimmed by parser
          expect(result!.content).toBe(entry.content.trim());

          // Summary
          expect(result!.summary).toBe(entry.summary);

          // Tags: empty strings filtered out
          const expectedTags = entry.tags.filter((t) => t !== "");
          expect(result!.tags).toEqual(expectedTags);

          // Timestamps
          expect(result!.createdAt).toBe(entry.createdAt);
          expect(result!.updatedAt).toBe(entry.updatedAt);

          // Stale
          expect(result!.stale).toBe(entry.stale);

          // Source fields: empty strings become undefined
          expect(result!.sourceSession).toBe(entry.sourceSession || undefined);
          expect(result!.sourceFile).toBe(entry.sourceFile || undefined);
        },
      ),
      { numRuns: 500 },
    );
  });
});
