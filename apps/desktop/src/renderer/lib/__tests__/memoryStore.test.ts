import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock localStorage
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => { store[key] = value; },
    removeItem: (key: string) => { delete store[key]; },
    clear: () => { store = {}; },
    get length() { return Object.keys(store).length; },
    key: (i: number) => Object.keys(store)[i] ?? null,
  };
})();
Object.defineProperty(globalThis, "localStorage", { value: localStorageMock });

// Mock the database and Tauri dependencies
vi.mock("@/lib/pathUtils", () => ({
  joinPath: (...parts: string[]) => parts.join("/"),
}));

vi.mock("../database", () => ({
  getDb: vi.fn(() => ({
    execute: vi.fn(),
    select: vi.fn().mockResolvedValue([]),
  })),
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

  // Empty strings: both empty → empty intersection & union → returns 1.0 by convention
  it("returns 1.0 for both empty (convention: empty ∩ empty / empty ∪ empty)", () => {
    expect(jaccardSimilarity("", "")).toBe(1.0);
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
    const critical = makeEntry({ tier: "critical", createdAt: Date.now() - DAY * 30 });
    const low = makeEntry({ tier: "low", createdAt: Date.now() - DAY * 30 });
    expect(scoreMemory(critical)).toBeGreaterThan(scoreMemory(low));
  });

  it("higher access count increases score", () => {
    const frequentlyAccessed = makeEntry({ accessCount: 50, lastAccessedAt: Date.now() });
    const neverAccessed = makeEntry({ accessCount: 0, lastAccessedAt: 0 });
    expect(scoreMemory(frequentlyAccessed)).toBeGreaterThan(scoreMemory(neverAccessed));
  });

  it("recently accessed memories score higher", () => {
    const recent = makeEntry({ accessCount: 1, lastAccessedAt: Date.now() });
    const old = makeEntry({ accessCount: 1, lastAccessedAt: Date.now() - DAY * 30 });
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
      "You should always run tests before committing code changes to the repository"
    );
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.some((e) => e.category === "user")).toBe(true);
  });

  it("detects file path references", () => {
    const entries = extractMemoriesFromExchange(
      "Check the config",
      "Look at the file src/config.ts for the settings"
    );
    expect(entries.some((e) => e.category === "reference")).toBe(true);
  });

  it("detects build commands", () => {
    const entries = extractMemoriesFromExchange(
      "How to build?",
      "Run pnpm run build to compile the project"
    );
    expect(entries.some((e) => e.category === "project")).toBe(true);
  });

  it("detects tech stack decisions", () => {
    const entries = extractMemoriesFromExchange(
      "What framework?",
      "This project is built with React and TypeScript"
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
      { maxEntries: 2 }
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
      "Always use functional components with standard TypeScript typings."
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
    expect(entry!.content).toBe("Always use functional components with standard TypeScript typings.");
  });

  it("handles CRLF carriage return line endings", () => {
    const fileContent = [
      "---",
      'id: "mem123"',
      'category: "project"',
      "---",
      "Some content"
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
      "Content"
    ].join("\n");

    const entry = parseMarkdownMemory(fileContent);
    expect(entry).not.toBeNull();
    expect(entry!.summary).toBe('This is "quoted" context with \\ backslash');
    expect(entry!.sourceFile).toBe('src\\components\\Toaster.tsx');
  });

  it("returns null for malformed frontmatter", () => {
    const fileContent = "This is not frontmatter at all.";
    expect(parseMarkdownMemory(fileContent)).toBeNull();
  });
});


