import { describe, it, expect } from "vitest";
import { normalizeDbPath } from "./database";
import { jaccardSimilarity, parseLLMJson, parseMarkdownMemory } from "./memoryStore";

describe("normalizeDbPath", () => {
  // ─── Windows paths ───────────────────────────────────────────

  it("converts Windows backslash path to forward-slash sqlite URI", () => {
    expect(normalizeDbPath("C:\\Users\\me\\my-project")).toBe(
      "sqlite:/C:/Users/me/my-project/.dalam/project.db",
    );
  });

  it("handles Windows path with drive letter only", () => {
    expect(normalizeDbPath("D:\\")).toBe("sqlite:/D:/.dalam/project.db");
  });

  it("handles Windows deep nested path", () => {
    expect(normalizeDbPath("C:\\Users\\john\\Documents\\workspace\\app")).toBe(
      "sqlite:/C:/Users/john/Documents/workspace/app/.dalam/project.db",
    );
  });

  it("handles Windows path with mixed separators (already some forward slashes)", () => {
    expect(normalizeDbPath("C:/Users\\me\\project")).toBe(
      "sqlite:/C:/Users/me/project/.dalam/project.db",
    );
  });

  it("handles Windows path with trailing backslash", () => {
    expect(normalizeDbPath("C:\\Users\\me\\project\\")).toBe(
      "sqlite:/C:/Users/me/project/.dalam/project.db",
    );
  });

  it("handles Windows network path (UNC)", () => {
    expect(normalizeDbPath("\\\\server\\share\\project")).toBe(
      "sqlite://server/share/project/.dalam/project.db",
    );
  });

  // ─── Unix paths ─────────────────────────────────────────────

  it("preserves Unix absolute path", () => {
    expect(normalizeDbPath("/home/user/project")).toBe(
      "sqlite:/home/user/project/.dalam/project.db",
    );
  });

  it("handles Unix path with trailing slash", () => {
    expect(normalizeDbPath("/home/user/project/")).toBe(
      "sqlite:/home/user/project/.dalam/project.db",
    );
  });

  it("handles deep Unix path", () => {
    expect(normalizeDbPath("/var/www/html/app")).toBe(
      "sqlite:/var/www/html/app/.dalam/project.db",
    );
  });

  it("handles Unix root path", () => {
    // FIX 1.5: Root path now uses triple-slash for correct absolute path resolution
    expect(normalizeDbPath("/")).toBe("sqlite:///.dalam/project.db");
  });

  // ─── Edge cases ─────────────────────────────────────────────

  it("handles empty string", () => {
    expect(normalizeDbPath("")).toBe("sqlite:.dalam/project.db");
  });

  it("handles relative path (no leading slash)", () => {
    expect(normalizeDbPath("relative/path")).toBe(
      "sqlite:/relative/path/.dalam/project.db",
    );
  });

  it("handles dot path", () => {
    expect(normalizeDbPath(".")).toBe("sqlite:/./.dalam/project.db");
  });

  it("handles path with spaces", () => {
    expect(normalizeDbPath("C:\\Users\\me\\my project\\folder")).toBe(
      "sqlite:/C:/Users/me/my project/folder/.dalam/project.db",
    );
  });

  it("handles path with special characters", () => {
    expect(normalizeDbPath("/home/user/my_app-v2.0 (copy)")).toBe(
      "sqlite:/home/user/my_app-v2.0 (copy)/.dalam/project.db",
    );
  });

  it("handles Windows path with single component", () => {
    expect(normalizeDbPath("C:\\project")).toBe(
      "sqlite:/C:/project/.dalam/project.db",
    );
  });

  // ─── macOS-style paths ──────────────────────────────────────

  it("handles macOS /Users path", () => {
    expect(normalizeDbPath("/Users/developer/Projects/dalam")).toBe(
      "sqlite:/Users/developer/Projects/dalam/.dalam/project.db",
    );
  });

  // ─── Determinism ────────────────────────────────────────────

  it("produces same result for semantically identical Windows and Unix paths", () => {
    const winResult = normalizeDbPath("C:\\Users\\me\\project");
    const unixResult = normalizeDbPath("C:/Users/me/project");
    expect(winResult).toBe(unixResult);
  });

  it("is deterministic — same input always produces same output", () => {
    const input = "C:\\Users\\me\\project";
    expect(normalizeDbPath(input)).toBe(normalizeDbPath(input));
  });
});

// ─── FIX 10.1: Add test coverage for memoryStore utility functions ───

describe("jaccardSimilarity", () => {
  it("returns 1.0 for identical strings", () => {
    expect(jaccardSimilarity("hello world", "hello world")).toBe(1);
  });

  it("returns 0.0 for completely different strings", () => {
    expect(jaccardSimilarity("abc", "xyz")).toBe(0);
  });

  it("returns value between 0 and 1 for partially similar strings", () => {
    const sim = jaccardSimilarity("hello world foo", "hello world bar");
    expect(sim).toBeGreaterThan(0);
    expect(sim).toBeLessThan(1);
  });

  it("returns 0 for stop-word-only inputs (FIX 1.6)", () => {
    expect(jaccardSimilarity("the a an is", "the a an is")).toBe(0);
  });

  it("handles empty strings", () => {
    expect(jaccardSimilarity("", "")).toBe(0);
  });

  it("handles one empty string", () => {
    expect(jaccardSimilarity("hello", "")).toBe(0);
  });

  it("handles special characters and code paths", () => {
    const sim = jaccardSimilarity(
      "import React from 'react'",
      "import { useState } from 'react'",
    );
    expect(sim).toBeGreaterThan(0);
  });
});

describe("parseLLMJson", () => {
  it("parses plain JSON array", () => {
    const result = parseLLMJson<number[]>('[1, 2, 3]');
    expect(result).toEqual([1, 2, 3]);
  });

  it("parses JSON with markdown fences", () => {
    const result = parseLLMJson<{ name: string }[]>('```json\n[{"name": "test"}]\n```');
    expect(result).toEqual([{ name: "test" }]);
  });

  it("handles brackets inside JSON strings (FIX 1.4)", () => {
    const result = parseLLMJson<{ summary: string }[]>('[{"summary": "some [text] here"}]');
    expect(result).toEqual([{ summary: "some [text] here" }]);
  });

  it("handles nested brackets correctly", () => {
    const result = parseLLMJson<{ nested: number[] }[]>('[{"nested": [1, 2, [3]]}]');
    expect(result).toEqual([{ nested: [1, 2, [3]] }]);
  });

  it("parses plain JSON object", () => {
    const result = parseLLMJson<{ key: string }>('{"key": "value"}');
    expect(result).toEqual({ key: "value" });
  });

  it("returns null for invalid JSON", () => {
    const result = parseLLMJson("not json at all");
    expect(result).toBeNull();
  });

  it("handles nested objects with array inside", () => {
    const json = '[{"id": 1, "tags": ["a", "b", "c"]}, {"id": 2, "tags": ["d"]}]';
    const result = parseLLMJson<{ id: number; tags: string[] }[]>(json);
    expect(result).toHaveLength(2);
    expect(result![0].tags).toHaveLength(3);
  });
});

// ─── FIX 10.2: Markdown round-trip tests for parseMarkdownMemory() ───

describe("parseMarkdownMemory", () => {
  // Helper: mimics the yamlEscape function from memoryStore.ts (not exported)
  function yamlEscape(s: string): string {
    return s
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\n/g, "\\n")
      .replace(/\r/g, "\\r")
      .replace(/\t/g, "\\t");
  }

  // Helper: build a markdown frontmatter string matching writeMemoryMarkdown()'s format
  function buildMarkdown(opts: {
    id?: string;
    category?: string;
    tier?: string;
    summary?: string;
    tags?: string[];
    content?: string;
    stale?: boolean;
    createdAt?: number;
    updatedAt?: number;
    sourceSession?: string;
    sourceFile?: string;
    rawTags?: string; // Override tags line entirely (for malformed/alternative formats)
  }): string {
    const id = opts.id ?? "test-mem-123";
    const category = opts.category ?? "project";
    const tier = opts.tier ?? "medium";
    const summary = yamlEscape(opts.summary ?? "Test summary");
    const tagsLine = opts.rawTags ?? `[${(opts.tags ?? ["tag1"]).map(t => `"${yamlEscape(t)}"`).join(", ")}]`;
    const createdAt = opts.createdAt ?? 1700000000000;
    const updatedAt = opts.updatedAt ?? 1700000000000;
    const stale = opts.stale ?? false;
    const content = opts.content ?? "Memory content body";

    const lines = [
      "---",
      `id: "${id}"`,
      `category: "${category}"`,
      `tier: "${tier}"`,
      `summary: "${summary}"`,
      `tags: ${tagsLine}`,
      `created_at: ${createdAt}`,
      `updated_at: ${updatedAt}`,
      `stale: ${stale}`,
    ];
    if (opts.sourceSession !== undefined) {
      lines.push(`source_session: "${yamlEscape(opts.sourceSession)}"`);
    }
    if (opts.sourceFile !== undefined) {
      lines.push(`source_file: "${yamlEscape(opts.sourceFile)}"`);
    }
    lines.push("---", "", content);
    return lines.join("\n");
  }

  // ─── Basic round-trip ─────────────────────────────────────

  it("parses a standard markdown memory entry", () => {
    const md = buildMarkdown({
      id: "mem-1",
      category: "project",
      tier: "high",
      summary: "Important project rule",
      tags: ["typescript", "react"],
      content: "Always use TypeScript strict mode",
      stale: false,
    });
    const result = parseMarkdownMemory(md);
    expect(result).not.toBeNull();
    expect(result!.id).toBe("mem-1");
    expect(result!.category).toBe("project");
    expect(result!.tier).toBe("high");
    expect(result!.summary).toBe("Important project rule");
    expect(result!.tags).toEqual(["typescript", "react"]);
    expect(result!.content).toBe("Always use TypeScript strict mode");
    expect(result!.stale).toBe(false);
  });

  it("preserves all optional fields when present", () => {
    const md = buildMarkdown({
      sourceSession: "session-abc",
      sourceFile: "src/main.ts",
    });
    const result = parseMarkdownMemory(md);
    expect(result!.sourceSession).toBe("session-abc");
    expect(result!.sourceFile).toBe("src/main.ts");
  });

  it("source fields are undefined when absent", () => {
    const md = buildMarkdown({});
    const result = parseMarkdownMemory(md);
    expect(result!.sourceSession).toBeUndefined();
    expect(result!.sourceFile).toBeUndefined();
  });

  it("parses stale=true correctly", () => {
    const md = buildMarkdown({ stale: true });
    const result = parseMarkdownMemory(md);
    expect(result!.stale).toBe(true);
  });

  // ─── Tags formats ─────────────────────────────────────────

  it("parses tags from JSON array format", () => {
    const md = buildMarkdown({ tags: ["alpha", "beta", "gamma"] });
    const result = parseMarkdownMemory(md);
    expect(result!.tags).toEqual(["alpha", "beta", "gamma"]);
  });

  it("parses tags from comma-separated format (when JSON fails)", () => {
    const md = buildMarkdown({ rawTags: "alpha, beta, gamma" });
    const result = parseMarkdownMemory(md);
    expect(result!.tags).toEqual(["alpha", "beta", "gamma"]);
  });

  it("returns empty tags array when tags field is missing", () => {
    // Build frontmatter without a tags line
    const md = [
      "---",
      'id: "mem-1"',
      'category: "project"',
      'tier: "medium"',
      'summary: "Test"',
      "created_at: 1700000000000",
      "updated_at: 1700000000000",
      "stale: false",
      "---",
      "",
      "content",
    ].join("\n");
    const result = parseMarkdownMemory(md);
    expect(result!.tags).toEqual([]);
  });

  // ─── Special characters / YAML escaping ───────────────────

  it("handles double quotes in summary", () => {
    const md = buildMarkdown({ summary: 'Use "strict" mode' });
    const result = parseMarkdownMemory(md);
    expect(result!.summary).toBe('Use "strict" mode');
  });

  it("handles backslashes in summary", () => {
    const md = buildMarkdown({ summary: "C:\\Users\\test\\file.ts" });
    const result = parseMarkdownMemory(md);
    expect(result!.summary).toBe("C:\\Users\\test\\file.ts");
  });

  it("handles newlines in summary (escaped)", () => {
    const md = buildMarkdown({ summary: "line1\nline2" });
    const result = parseMarkdownMemory(md);
    expect(result!.summary).toBe("line1\nline2");
  });

  it("handles colons and special YAML chars in summary", () => {
    const md = buildMarkdown({ summary: "Key: value (priority > 5) & stuff" });
    const result = parseMarkdownMemory(md);
    expect(result!.summary).toBe("Key: value (priority > 5) & stuff");
  });

  // ─── Timestamp edge cases (FIX 1.9) ───────────────────────

  it("accepts timestamp 0 as valid (Unix epoch)", () => {
    const md = buildMarkdown({ createdAt: 0, updatedAt: 0 });
    const result = parseMarkdownMemory(md);
    expect(result!.createdAt).toBe(0);
    expect(result!.updatedAt).toBe(0);
  });

  it("falls back to Date.now() when timestamps are absent", () => {
    // Build frontmatter without created_at and updated_at
    const md = [
      "---",
      'id: "mem-1"',
      'category: "project"',
      'tier: "medium"',
      'summary: "Test"',
      "stale: false",
      "---",
      "",
      "content",
    ].join("\n");
    const result = parseMarkdownMemory(md);
    // Should use Date.now() which is close to current time
    expect(result!.createdAt).toBeGreaterThan(0);
    expect(result!.updatedAt).toBeGreaterThan(0);
  });

  // ─── Category / Tier validation (FIX 1.10) ────────────────

  it("resolves category alias 'userfeedback' to 'feedback'", () => {
    const md = buildMarkdown({ category: "userfeedback" });
    const result = parseMarkdownMemory(md);
    expect(result!.category).toBe("feedback");
  });

  it("falls back to 'project' for unknown category", () => {
    const md = buildMarkdown({ category: "nonexistent" });
    const result = parseMarkdownMemory(md);
    expect(result!.category).toBe("project");
  });

  it("falls back to 'medium' for unknown tier", () => {
    const md = buildMarkdown({ tier: "ultra" });
    const result = parseMarkdownMemory(md);
    expect(result!.tier).toBe("medium");
  });

  // ─── Malformed input ──────────────────────────────────────

  it("returns null for content without frontmatter", () => {
    const result = parseMarkdownMemory("Just plain text without frontmatter");
    expect(result).toBeNull();
  });

  it("returns null for missing id field", () => {
    const md = [
      "---",
      'category: "project"',
      'tier: "medium"',
      "---",
      "",
      "content",
    ].join("\n");
    const result = parseMarkdownMemory(md);
    expect(result).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseMarkdownMemory("")).toBeNull();
  });

  // ─── Content body edge cases ──────────────────────────────

  it("parses multi-line content body", () => {
    const content = "Line 1\nLine 2\nLine 3 with `code`";
    const md = buildMarkdown({ content });
    const result = parseMarkdownMemory(md);
    expect(result!.content).toBe(content);
  });

  it("trims leading/trailing whitespace in content body", () => {
    const content = "  indented content  ";
    const md = buildMarkdown({ content });
    const result = parseMarkdownMemory(md);
    // parseMarkdownMemory trims body
    expect(result!.content).toBe("indented content");
  });

  // ─── Summary falls back to content ────────────────────────

  it("uses first 150 chars of content as summary when summary field missing", () => {
    const md = [
      "---",
      'id: "mem-1"',
      'category: "project"',
      'tier: "medium"',
      "created_at: 1700000000000",
      "updated_at: 1700000000000",
      "stale: false",
      "---",
      "",
      "This is a long content body that should be used as the summary fallback",
    ].join("\n");
    const result = parseMarkdownMemory(md);
    expect(result!.summary).toBe("This is a long content body that should be used as the summary fallback");
  });

  // ─── Round-trip: construct → parse → verify → reconstruct → parse ──

  it("survives full round-trip (construct → parse → fields match)", () => {
    const original = {
      id: "roundtrip-001",
      category: "decision" as const,
      tier: "critical" as const,
      summary: 'Round-trip test with "quotes" and C:\\paths\\ and \\nescapes',
      tags: ["alpha", "beta", "gamma"],
      content: "Multi-line\ncontent body\nwith `code` and **markdown**",
      stale: false,
      createdAt: 1700000000000,
      updatedAt: 1700000000000,
      sourceSession: "sess-roundtrip",
      sourceFile: "src/test.ts",
    };

    // Build markdown
    const md = buildMarkdown(original);

    // Parse back
    const result = parseMarkdownMemory(md);

    // Verify all fields
    expect(result).not.toBeNull();
    expect(result!.id).toBe(original.id);
    expect(result!.category).toBe(original.category);
    expect(result!.tier).toBe(original.tier);
    expect(result!.summary).toBe(original.summary);
    expect(result!.tags).toEqual(original.tags);
    expect(result!.content).toBe(original.content);
    expect(result!.stale).toBe(original.stale);
    expect(result!.createdAt).toBe(original.createdAt);
    expect(result!.updatedAt).toBe(original.updatedAt);
    expect(result!.sourceSession).toBe(original.sourceSession);
    expect(result!.sourceFile).toBe(original.sourceFile);
  });
});
