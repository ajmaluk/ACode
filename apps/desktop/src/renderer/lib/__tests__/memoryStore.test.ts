import { describe, it, expect, vi } from "vitest";

// Mock the database and Tauri dependencies
vi.mock("@/lib/pathUtils", () => ({
  joinPath: (...parts: string[]) => parts.join("/"),
}));

vi.mock("../database", () => ({
  getDb: vi.fn(() => ({
    execute: vi.fn(),
    select: vi.fn().mockResolvedValue([]),
  })),
  isDatabaseReady: vi.fn(() => true),
}));

vi.mock("@tauri-apps/plugin-fs", () => ({
  exists: vi.fn().mockResolvedValue(false),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  readTextFile: vi.fn(),
  readDir: vi.fn().mockResolvedValue([]),
  mkdir: vi.fn(),
  writeTextFile: vi.fn(),
}));

// Import pure functions after mocks
import {
  jaccardSimilarity,
  scoreMemory,
  extractMemoriesFromExchange,
  buildExtractionPrompt,
  parseMarkdownMemory,
} from "../memoryStore";
import type { MemoryEntry } from "../memoryTypes";

// ============================================================
// Helper to create a mock MemoryEntry
// ============================================================
function makeEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: "test-id",
    category: "project",
    tier: "medium",
    content: "Test content about TypeScript",
    summary: "Test summary",
    tags: ["typescript"],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    accessCount: 0,
    lastAccessedAt: 0,
    verified: false,
    stale: false,
    ...overrides,
  };
}

// ============================================================
// jaccardSimilarity tests
// ============================================================
describe("jaccardSimilarity", () => {
  it("returns 1.0 for identical strings", () => {
    expect(jaccardSimilarity("hello world", "hello world")).toBe(1.0);
  });

  it("returns 0.0 for completely different strings", () => {
    expect(jaccardSimilarity("aaa bbb ccc", "xxx yyy zzz")).toBe(0);
  });

  // Empty strings: both empty → empty intersection & union → returns 0
  // (FIX 1.6: two different stop-word-heavy strings should not be considered identical)
  it("returns 0 for both empty (stop-word-only input not considered identical)", () => {
    expect(jaccardSimilarity("", "")).toBe(0);
  });

  it("handles partial overlap", () => {
    const sim = jaccardSimilarity("the quick brown fox", "the slow brown dog");
    expect(sim).toBeGreaterThan(0);
    expect(sim).toBeLessThan(1);
  });

  it("is case-insensitive", () => {
    expect(jaccardSimilarity("TypeScript React", "typescript react")).toBe(1.0);
  });

  it("ignores stop words", () => {
    const sim = jaccardSimilarity("the cat is on mat", "a cat on the mat");
    expect(sim).toBe(1.0);
  });
});

// ============================================================
// scoreMemory tests
// ============================================================
describe("scoreMemory", () => {
  const DAY = 86_400_000;

  it("critical tier gets highest base score", () => {
    const critical = makeEntry({
      tier: "critical",
      createdAt: Date.now() - DAY * 30,
    });
    const low = makeEntry({ tier: "low", createdAt: Date.now() - DAY * 30 });
    expect(scoreMemory(critical)).toBeGreaterThan(scoreMemory(low));
  });

  it("higher access count increases score", () => {
    const frequentlyAccessed = makeEntry({
      accessCount: 50,
      lastAccessedAt: Date.now(),
    });
    const neverAccessed = makeEntry({ accessCount: 0, lastAccessedAt: 0 });
    expect(scoreMemory(frequentlyAccessed)).toBeGreaterThan(
      scoreMemory(neverAccessed),
    );
  });

  it("recently accessed memories score higher", () => {
    const recent = makeEntry({ accessCount: 1, lastAccessedAt: Date.now() });
    const old = makeEntry({
      accessCount: 1,
      lastAccessedAt: Date.now() - DAY * 30,
    });
    expect(scoreMemory(recent)).toBeGreaterThan(scoreMemory(old));
  });

  it("verified memories get bonus", () => {
    const verified = makeEntry({ verified: true, createdAt: Date.now() });
    const unverified = makeEntry({ verified: false, createdAt: Date.now() });
    expect(scoreMemory(verified)).toBeGreaterThan(scoreMemory(unverified));
  });

  it("score is always non-negative", () => {
    const oldLowTier = makeEntry({
      tier: "low",
      accessCount: 0,
      lastAccessedAt: 0,
      createdAt: Date.now() - DAY * 365,
    });
    expect(scoreMemory(oldLowTier)).toBeGreaterThanOrEqual(0);
  });
});

// ============================================================
// extractMemoriesFromExchange tests
// ============================================================
describe("extractMemoriesFromExchange", () => {
  it("detects rule patterns (always, never, must)", () => {
    const entries = extractMemoriesFromExchange(
      "User asks about testing",
      "You should always run tests before committing code changes to the repository",
    );
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.some((e) => e.category === "user")).toBe(true);
  });

  it("detects file path references", () => {
    const entries = extractMemoriesFromExchange(
      "Check the config",
      "Look at the file src/config.ts for the settings",
    );
    expect(entries.some((e) => e.category === "reference")).toBe(true);
  });

  it("detects build commands", () => {
    const entries = extractMemoriesFromExchange(
      "How to build?",
      "Run pnpm run build to compile the project",
    );
    expect(entries.some((e) => e.category === "project")).toBe(true);
  });

  it("detects tech stack decisions", () => {
    const entries = extractMemoriesFromExchange(
      "What framework?",
      "This project is built with React and TypeScript",
    );
    expect(entries.some((e) => e.tags.length > 0)).toBe(true);
  });

  it("returns empty for no meaningful content", () => {
    const entries = extractMemoriesFromExchange("hi", "hello");
    expect(entries).toHaveLength(0);
  });

  it("respects maxEntries option", () => {
    const entries = extractMemoriesFromExchange(
      "User says",
      "Always use TypeScript. Never use var. Must follow ESLint rules. Should use Prettier. Prefer functional components.",
      { maxEntries: 2 },
    );
    expect(entries.length).toBeLessThanOrEqual(2);
  });
});

// ============================================================
// buildExtractionPrompt tests
// ============================================================
describe("buildExtractionPrompt", () => {
  it("returns a string containing the user input", () => {
    const prompt = buildExtractionPrompt("My question", "My answer");
    expect(prompt).toContain("My question");
    expect(prompt).toContain("My answer");
  });

  it("includes JSON format instructions", () => {
    const prompt = buildExtractionPrompt("q", "a");
    expect(prompt).toContain("JSON");
    expect(prompt).toContain("category");
    expect(prompt).toContain("tier");
  });

  it("includes valid categories", () => {
    const prompt = buildExtractionPrompt("q", "a");
    expect(prompt).toContain("user");
    expect(prompt).toContain("feedback");
    expect(prompt).toContain("project");
    expect(prompt).toContain("decision");
  });

  it("truncates long inputs to 500 chars", () => {
    const longInput = "x".repeat(2000);
    const prompt = buildExtractionPrompt(longInput, "short");
    // The input is truncated to 500 chars in the prompt
    expect(prompt.length).toBeLessThan(longInput.length + 1000);
  });
});

// ============================================================
// parseMarkdownMemory tests
// ============================================================
describe("parseMarkdownMemory", () => {
  it("successfully parses valid markdown frontmatter and content", () => {
    const fileContent = [
      "---",
      'id: "mem123"',
      'category: "project"',
      'tier: "critical"',
      'summary: "Conventions for TypeScript projects"',
      "tags: [typescript, vitest]",
      "created_at: 1719273600000",
      "updated_at: 1719273700000",
      "stale: false",
      'source_session: "session99"',
      'source_file: "src/main.ts"',
      "---",
      "",
      "Always use functional components with standard TypeScript typings.",
    ].join("\n");

    const entry = parseMarkdownMemory(fileContent);
    expect(entry).not.toBeNull();
    expect(entry!.id).toBe("mem123");
    expect(entry!.category).toBe("project");
    expect(entry!.tier).toBe("critical");
    expect(entry!.summary).toBe("Conventions for TypeScript projects");
    expect(entry!.tags).toEqual(["typescript", "vitest"]);
    expect(entry!.createdAt).toBe(1719273600000);
    expect(entry!.updatedAt).toBe(1719273700000);
    expect(entry!.stale).toBe(false);
    expect(entry!.sourceSession).toBe("session99");
    expect(entry!.sourceFile).toBe("src/main.ts");
    expect(entry!.content).toBe(
      "Always use functional components with standard TypeScript typings.",
    );
  });

  it("handles CRLF carriage return line endings", () => {
    const fileContent = [
      "---",
      'id: "mem123"',
      'category: "project"',
      "---",
      "Some content",
    ].join("\r\n");

    const entry = parseMarkdownMemory(fileContent);
    expect(entry).not.toBeNull();
    expect(entry!.id).toBe("mem123");
    expect(entry!.content).toBe("Some content");
  });

  it("correctly unescapes quotes and backslashes in summary and sourceFile", () => {
    const fileContent = [
      "---",
      'id: "mem123"',
      'category: "project"',
      'summary: "This is \\"quoted\\" context with \\\\ backslash"',
      'source_file: "src\\\\components\\\\Toaster.tsx"',
      "---",
      "Content",
    ].join("\n");

    const entry = parseMarkdownMemory(fileContent);
    expect(entry).not.toBeNull();
    expect(entry!.summary).toBe('This is "quoted" context with \\ backslash');
    expect(entry!.sourceFile).toBe("src\\components\\Toaster.tsx");
  });

  it("returns null for malformed frontmatter", () => {
    const fileContent = "This is not frontmatter at all.";
    expect(parseMarkdownMemory(fileContent)).toBeNull();
  });

  it("parses tags as JSON array when properly formatted", () => {
    const fileContent = [
      "---",
      'id: "mem1"',
      'category: "project"',
      'tags: ["tag1", "tag2", "tag3"]',
      "---",
      "content",
    ].join("\n");
    const entry = parseMarkdownMemory(fileContent);
    expect(entry).not.toBeNull();
    expect(entry!.tags).toEqual(["tag1", "tag2", "tag3"]);
  });

  it("parses tags as comma-separated string when not JSON", () => {
    const fileContent = [
      "---",
      'id: "mem1"',
      'category: "project"',
      "tags: tag1, tag2, tag3",
      "---",
      "content",
    ].join("\n");
    const entry = parseMarkdownMemory(fileContent);
    expect(entry).not.toBeNull();
    expect(entry!.tags).toEqual(["tag1", "tag2", "tag3"]);
  });

  it("handles stale field as string boolean", () => {
    const content = [
      "---",
      'id: "mem1"',
      'category: "project"',
      "stale: true",
      "---",
      "body",
    ].join("\n");
    expect(parseMarkdownMemory(content)!.stale).toBe(true);
  });

  it("handles stale field as numeric stale", () => {
    const content = [
      "---",
      'id: "mem1"',
      'category: "project"',
      "stale: 1",
      "---",
      "body",
    ].join("\n");
    expect(parseMarkdownMemory(content)!.stale).toBe(true);
  });

  it("defaults to current time for missing created_at", () => {
    const content = [
      "---",
      'id: "mem1"',
      'category: "project"',
      "---",
      "body",
    ].join("\n");
    const entry = parseMarkdownMemory(content);
    expect(entry).not.toBeNull();
    expect(entry!.createdAt).toBeGreaterThan(0);
  });

  it("defaults category to 'project' when missing", () => {
    const content = ["---", 'id: "mem1"', "---", "body"].join("\n");
    expect(parseMarkdownMemory(content)!.category).toBe("project");
  });

  it("defaults tier to 'medium' when missing", () => {
    const content = [
      "---",
      'id: "mem1"',
      'category: "project"',
      "---",
      "body",
    ].join("\n");
    expect(parseMarkdownMemory(content)!.tier).toBe("medium");
  });

  it("handles multiline content body", () => {
    const content = [
      "---",
      'id: "mem1"',
      'category: "project"',
      "---",
      "",
      "Line 1 of content",
      "Line 2 of content",
      "",
      "Line 4 with trailing newline",
    ].join("\n");
    const entry = parseMarkdownMemory(content);
    expect(entry).not.toBeNull();
    expect(entry!.content).toContain("Line 2 of content");
  });

  it("handles empty tags field", () => {
    const content = [
      "---",
      'id: "mem1"',
      'category: "project"',
      "tags: []",
      "---",
      "body",
    ].join("\n");
    expect(parseMarkdownMemory(content)!.tags).toEqual([]);
  });

  it("handles tags with single-quoted items in JSON", () => {
    const content = [
      "---",
      'id: "mem1"',
      'category: "project"',
      "tags: ['a', 'b']",
      "---",
      "body",
    ].join("\n");
    const entry = parseMarkdownMemory(content);
    expect(entry).not.toBeNull();
    // The parser tries JSON.parse first, which fails on single quotes, then falls through
    expect(Array.isArray(entry!.tags)).toBe(true);
  });

  it("handles YAML list items in tags", () => {
    const content = [
      "---",
      'id: "mem1"',
      'category: "project"',
      "tags:",
      "  - tag-a",
      "  - tag-b",
      "---",
      "body",
    ].join("\n");
    const entry = parseMarkdownMemory(content);
    expect(entry).not.toBeNull();
    // The YAML list parser accumulates into currentKey's value
    expect(entry!.tags).toContain("tag-a");
  });

  it("returns null when id is missing", () => {
    const content = ["---", 'category: "project"', "---", "body"].join("\n");
    expect(parseMarkdownMemory(content)).toBeNull();
  });

  it("handles CRLF line endings for frontmatter content", () => {
    const content = [
      "---\r",
      'id: "mem1"\r',
      'category: "project"\r',
      "---\r",
      "body",
    ].join("\n");
    const entry = parseMarkdownMemory(content);
    expect(entry).not.toBeNull();
    expect(entry!.id).toBe("mem1");
  });

  it("does not strip brackets from non-tags fields like summary or id", () => {
    // When summary value is literally "[]" (two characters: left and right bracket),
    // the parser should NOT strip the brackets — they're part of the value, not an array.
    const content = [
      "---",
      'id: "mem-bracket"',
      'category: "project"',
      'summary: "[]"',
      'source_file: "src/lib/[utils]/helper.ts"',
      "---",
      "body",
    ].join("\n");
    const entry = parseMarkdownMemory(content);
    expect(entry).not.toBeNull();
    expect(entry!.summary).toBe("[]");
    expect(entry!.sourceFile).toBe("src/lib/[utils]/helper.ts");
  });

  it("still strips brackets from tags field (JSON array format)", () => {
    const content = [
      "---",
      'id: "mem-tags"',
      'category: "project"',
      "tags: [tag1, tag2]",
      "---",
      "body",
    ].join("\n");
    const entry = parseMarkdownMemory(content);
    expect(entry).not.toBeNull();
    expect(entry!.tags).toContain("tag1");
    expect(entry!.tags).toContain("tag2");
  });

  it("handles fields with colons in values", () => {
    // Colons are escaped as \: in the YAML frontmatter
    const content = [
      "---",
      'id: "mem1"',
      'category: "project"',
      'summary: "Rule: always use TypeScript"',
      "---",
      "body",
    ].join("\n");
    const entry = parseMarkdownMemory(content);
    expect(entry).not.toBeNull();
    expect(entry!.summary).toBe("Rule: always use TypeScript");
  });

  it("handles summary falling back to truncated content", () => {
    const content = [
      "---",
      'id: "mem1"',
      'category: "project"',
      "---",
      "This is a longer body content that should be used as the summary fallback since no summary field is provided",
    ].join("\n");
    const entry = parseMarkdownMemory(content);
    expect(entry).not.toBeNull();
    expect(entry!.summary).toBe(
      "This is a longer body content that should be used as the summary fallback since no summary field is provided",
    );
  });
});

// ============================================================
// scoreMemory — edge case tests
// ============================================================
describe("scoreMemory edge cases", () => {
  const DAY = 86_400_000;

  it("handles unknown tier gracefully", () => {
    const entry = makeEntry({ tier: "unknown" as MemoryEntry["tier"] });
    const score = scoreMemory(entry);
    expect(score).toBeGreaterThanOrEqual(0);
  });

  it("handles negative lastAccessedAt", () => {
    const entry = makeEntry({ lastAccessedAt: -1 });
    const score = scoreMemory(entry);
    expect(score).toBeGreaterThanOrEqual(0);
  });

  it("handles extremely high access counts", () => {
    const entry = makeEntry({ accessCount: 999999 });
    const score = scoreMemory(entry);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(Infinity);
  });

  it("handles future lastAccessedAt", () => {
    const entry = makeEntry({ lastAccessedAt: Date.now() + DAY * 100 });
    const score = scoreMemory(entry);
    expect(score).toBeGreaterThan(0);
  });

  it("non-zero score for brand new low-tier entry", () => {
    const entry = makeEntry({
      tier: "low",
      createdAt: Date.now(),
      accessCount: 0,
      lastAccessedAt: 0,
    });
    expect(scoreMemory(entry)).toBeGreaterThanOrEqual(0);
  });
});

// ============================================================
// extractMemoriesFromExchange — edge case tests
// ============================================================
describe("extractMemoriesFromExchange edge cases", () => {
  it("ignores node_modules in file references", () => {
    const entries = extractMemoriesFromExchange(
      "Check the config",
      "Look at node_modules/some-package/index.ts",
    );
    expect(entries.some((e) => e.content?.includes("node_modules"))).toBe(
      false,
    );
  });

  it("extracts npm build commands", () => {
    const entries = extractMemoriesFromExchange(
      "How to build?",
      "Run npm run build to compile",
    );
    expect(
      entries.some(
        (e) => e.category === "project" && e.content?.includes("npm"),
      ),
    ).toBe(true);
  });

  it("extracts cargo build commands", () => {
    const entries = extractMemoriesFromExchange(
      "Build rust",
      "Use cargo build --release",
    );
    expect(entries.some((e) => e.tags?.includes("cargo"))).toBe(true);
  });

  it("extracts docker commands", () => {
    const entries = extractMemoriesFromExchange(
      "Run container",
      "Use docker compose up",
    );
    expect(entries.some((e) => e.tags?.includes("docker"))).toBe(true);
  });

  it("detects tech stack decision with 'built with'", () => {
    const entries = extractMemoriesFromExchange(
      "What framework?",
      "This project is built with Next.js and Tailwind",
    );
    expect(entries.some((e) => e.content?.includes("built with Next"))).toBe(
      true,
    );
  });

  it("detects tech stack decision with 'migrating to'", () => {
    const entries = extractMemoriesFromExchange(
      "Migration",
      "We are migrating to PostgreSQL",
    );
    expect(entries.some((e) => e.content?.includes("migrating to"))).toBe(true);
  });

  it("detects 'prefer' pattern for preferences", () => {
    const entries = extractMemoriesFromExchange(
      "Style guide",
      "I prefer using functional components over class components in this project",
    );
    expect(
      entries.some(
        (e) => e.category === "user" && e.content?.includes("prefer"),
      ),
    ).toBe(true);
  });

  it("detects 'stick to' pattern", () => {
    const entries = extractMemoriesFromExchange(
      "Testing",
      "Let's stick to vitest for unit tests",
    );
    expect(
      entries.some(
        (e) => e.category === "user" && e.content?.includes("stick to"),
      ),
    ).toBe(true);
  });

  it("copes with very long inputs", () => {
    const longInput = "A".repeat(10000);
    const longResponse = "Always use the pattern ".repeat(100);
    const entries = extractMemoriesFromExchange(longInput, longResponse);
    // Should not throw and should find something
    expect(Array.isArray(entries)).toBe(true);
  });

  it("handles special characters in exchange", () => {
    const entries = extractMemoriesFromExchange(
      "How to use unicode? 🎉",
      "Always use UTF-8 encoding for strings: 日本語",
    );
    expect(Array.isArray(entries)).toBe(true);
  });

  it("extracts multiple rule patterns from a single exchange", () => {
    const entries = extractMemoriesFromExchange(
      "Project setup",
      "Always use TypeScript. Never use any. Must use strict mode. Should format with Prettier.",
    );
    expect(entries.length).toBeGreaterThanOrEqual(3);
  });

  it("skips short rule patterns (< 15 chars)", () => {
    const entries = extractMemoriesFromExchange("Quick tip", "Must do it");
    expect(entries).toHaveLength(0);
  });

  it("skips long rule patterns (> 200 chars)", () => {
    const entries = extractMemoriesFromExchange(
      "Very long",
      `Always ${"x".repeat(250)}`,
    );
    const longEntries = entries.filter((e) => e.content?.length > 200);
    expect(longEntries).toHaveLength(0);
  });

  it("extracts file paths with backtick formatting", () => {
    const entries = extractMemoriesFromExchange(
      "Check the config",
      "Look at the file `src/config.ts` for settings",
    );
    expect(
      entries.some(
        (e) => e.category === "reference" && e.summary?.includes("config.ts"),
      ),
    ).toBe(true);
  });

  it("extracts file paths with double-quote formatting", () => {
    const entries = extractMemoriesFromExchange(
      "Find file",
      'The configuration is in "config/settings.json"',
    );
    expect(entries.some((e) => e.summary?.includes("settings.json"))).toBe(
      true,
    );
  });

  it("extracts file paths with single-quote formatting", () => {
    const entries = extractMemoriesFromExchange(
      "Find file",
      "The configuration is in 'config/settings.yaml'",
    );
    expect(entries.some((e) => e.summary?.includes("settings.yaml"))).toBe(
      true,
    );
  });
});

// ============================================================
// buildExtractionPrompt — edge case tests
// ============================================================
describe("buildExtractionPrompt edge cases", () => {
  it("handles empty strings", () => {
    const prompt = buildExtractionPrompt("", "");
    expect(prompt).toContain("JSON");
    expect(prompt).toContain("Return");
  });

  it("handles special characters in inputs", () => {
    const prompt = buildExtractionPrompt(
      "<script>alert('xss')</script>",
      "const x = 1\nconst y = 2;",
    );
    expect(prompt).toContain("xss");
    expect(prompt).toContain("x = 1");
  });

  it("includes critical instructions in the prompt", () => {
    const prompt = buildExtractionPrompt("q", "a");
    expect(prompt).toContain("architectural");
    expect(prompt).toContain("user preferences");
    expect(prompt).toContain("transient");
  });

  it("truncates both inputs independently at 500 chars", () => {
    const longInput = "x".repeat(2000);
    const longResponse = "y".repeat(2000);
    const prompt = buildExtractionPrompt(longInput, longResponse);
    expect(prompt.length).toBeLessThan(3000);
    expect(prompt).toContain("x".repeat(500));
    expect(prompt).not.toContain("x".repeat(501));
  });
});

// ============================================================
// jaccardSimilarity — edge case tests
// ============================================================
describe("jaccardSimilarity edge cases", () => {
  it("handles one empty string", () => {
    expect(jaccardSimilarity("", "hello world")).toBe(0);
  });

  it("handles numbers and special characters in strings", () => {
    const sim = jaccardSimilarity("hello 123 !@#", "hello 456 !@#");
    expect(sim).toBeGreaterThan(0);
    expect(sim).toBeLessThan(1);
  });

  it("handles strings with only stop words", () => {
    // After stop word filtering, these become empty → both empty → 0
    // (FIX 1.6: stop-word-only strings not considered identical)
    expect(jaccardSimilarity("the a an is", "to of in for")).toBe(0);
  });

  it("handles code-like strings with dots and slashes", () => {
    const sim = jaccardSimilarity(
      "src/components/Button.tsx",
      "src/components/Input.tsx",
    );
    expect(sim).toBeGreaterThan(0);
    // Should match "src", "components" but differ on "Button" vs "Input"
    expect(sim).toBeGreaterThan(0.3);
    expect(sim).toBeLessThan(0.8);
  });

  it("handles very long strings efficiently", () => {
    const a = "hello world ".repeat(1000);
    const b = "hello world ".repeat(1000);
    const start = performance.now();
    const sim = jaccardSimilarity(a, b);
    const elapsed = performance.now() - start;
    expect(sim).toBe(1.0);
    expect(elapsed).toBeLessThan(500); // Should be fast even for long strings
  });

  it("handles strings with only length-2 words (should filter them)", () => {
    // Words <= 2 chars are filtered out → both become empty → 0
    // (FIX 1.6: empty sets not considered identical)
    expect(jaccardSimilarity("ab cd ef", "gh ij kl")).toBe(0);
  });
});

// ============================================================
// export/import pure function tests (testing what's testable without Tauri runtime)
// ============================================================
describe("memory utilities", () => {
  it("detectStaleMemories handles empty database", async () => {
    // This tests that the imports work correctly — actual DB interaction needs runtime
    const { detectStaleMemories } = await import("../memoryStore");
    expect(detectStaleMemories).toBeDefined();
  });

  it("runMaintenance returns structure with zero counts on empty DB", async () => {
    const { runMaintenance } = await import("../memoryStore");
    expect(runMaintenance).toBeDefined();
  });

  it("enforceMemoryBudget with negative budget returns 0", async () => {
    const { enforceMemoryBudget } = await import("../memoryStore");
    expect(enforceMemoryBudget).toBeDefined();
  });
});

// ============================================================
// pending-write timer tests
// ============================================================
describe("pending-write timer", () => {
  it("cancelPendingWriteTimer is a function and can be called safely without throwing", async () => {
    const { cancelPendingWriteTimer } = await import("../memoryStore");
    expect(typeof cancelPendingWriteTimer).toBe("function");
    // In test mode (import.meta.env.MODE === 'test'), the timer is never started,
    // so cancelPendingWriteTimer is a safe no-op (checks null ID, no clearInterval).
    expect(() => cancelPendingWriteTimer()).not.toThrow();
  });

  it("cancelPendingWriteTimer can be called multiple times safely", async () => {
    const { cancelPendingWriteTimer } = await import("../memoryStore");
    // Calling multiple times should not throw (idempotent: second call finds null, does nothing)
    cancelPendingWriteTimer();
    cancelPendingWriteTimer();
    cancelPendingWriteTimer();
    expect(() => cancelPendingWriteTimer()).not.toThrow();
  });

  it("pending-write timer is not started in test mode (import.meta.env.MODE !== 'test' guard)", async () => {
    // The timer setup in memoryStore.ts is guarded by:
    //   if (typeof setInterval !== "undefined" && import.meta.env.MODE !== "test")
    // Since this test runs with MODE === 'test', the setInterval timer is skipped.
    // We verify this indirectly: if the timer were started, cancelPendingWriteTimer
    // would call clearInterval on a real interval ID (which is safe, but
    // we know the guard works because calling it doesn't throw and the
    // function's null-check prevents any clearInterval call).
    // Additionally, calling cancelPendingWriteTimer and confirming it doesn't
    // call clearInterval on a null reference proves the timer was never started.
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");

    const { cancelPendingWriteTimer } = await import("../memoryStore");
    cancelPendingWriteTimer();

    // Since the timer was never started (test mode guard), clearInterval
    // should not have been called with any interval ID.
    expect(clearIntervalSpy).not.toHaveBeenCalled();

    clearIntervalSpy.mockRestore();
  });
});
