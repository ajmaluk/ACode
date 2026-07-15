/**
 * ============================================================
 * UNIT TESTS — parseLLMJson()
 * ============================================================
 *
 * Tests the parseLLMJson() function which parses structured JSON
 * responses from LLM outputs, handling common formatting issues
 * like markdown code fences, surrounding text, and nested brackets.
 *
 * All tests are synchronous — no mocks needed.
 * ============================================================
 */

import { describe, it, expect } from "vitest";
import { parseLLMJson } from "../memoryStore";

// ============================================================================
// CORE PARSING
// ============================================================================

describe("parseLLMJson - basic JSON parsing", () => {
  it("parses a plain JSON object", () => {
    const result = parseLLMJson<{ name: string; value: number }>(
      '{"name": "test", "value": 42}',
    );
    expect(result).not.toBeNull();
    expect(result).toHaveProperty("name", "test");
    expect(result).toHaveProperty("value", 42);
  });

  it("parses a plain JSON array", () => {
    const result = parseLLMJson<string[]>('["a", "b", "c"]');
    expect(result).not.toBeNull();
    expect(Array.isArray(result)).toBe(true);
    expect(result).toEqual(["a", "b", "c"]);
  });

  it("returns null for completely invalid input", () => {
    const result = parseLLMJson("this is not json at all");
    expect(result).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseLLMJson("")).toBeNull();
  });

  it("returns null for whitespace-only input", () => {
    expect(parseLLMJson("   \n   \t   ")).toBeNull();
  });
});

// ============================================================================
// MARKDOWN CODE FENCES
// ============================================================================

describe("parseLLMJson - markdown code fences", () => {
  it("parses JSON inside ```json ... ``` fences", () => {
    const result = parseLLMJson<{ key: string }>(
      "```json\n{\"key\": \"value\"}\n```",
    );
    expect(result).not.toBeNull();
    expect(result).toHaveProperty("key", "value");
  });

  it("parses JSON inside ``` ... ``` fences (no language)", () => {
    const result = parseLLMJson<{ a: number }>("```\n{\"a\": 1}\n```");
    expect(result).not.toBeNull();
    expect(result).toHaveProperty("a", 1);
  });

  it("parses JSON inside ```json fences with leading text", () => {
    const result = parseLLMJson<{ ok: boolean }>(
      'Here is the result:\n```json\n{"ok": true}\n```\nHope that helps.',
    );
    expect(result).not.toBeNull();
    expect(result).toHaveProperty("ok", true);
  });

  it("handles capital JSON marker", () => {
    const result = parseLLMJson<string[]>(
      "```JSON\n[\"item1\", \"item2\"]\n```",
    );
    expect(result).not.toBeNull();
    expect(result).toEqual(["item1", "item2"]);
  });

  it("handles JSON with spaces after ```json marker", () => {
    const result = parseLLMJson<{ msg: string }>(
      "```json   \n{\"msg\": \"hello\"}\n```",
    );
    expect(result).not.toBeNull();
    expect(result).toHaveProperty("msg", "hello");
  });
});

// ============================================================================
// EXTRACTION FROM SURROUNDING TEXT
// ============================================================================

describe("parseLLMJson - extraction from surrounding text", () => {
  it("extracts JSON array from text with surrounding explanation", () => {
    const result = parseLLMJson<string[]>(
      'The answer is: ["typescript", "react"]\n\nThis is because...',
    );
    expect(result).not.toBeNull();
    expect(Array.isArray(result)).toBe(true);
    expect(result).toEqual(["typescript", "react"]);
  });

  it("extracts JSON object from text with prefix", () => {
    const result = parseLLMJson<{ score: number }>(
      'Score: {"score": 95} based on analysis',
    );
    expect(result).not.toBeNull();
    expect(result).toHaveProperty("score", 95);
  });

  it("extracts the FIRST JSON array when multiple exist", () => {
    // Balanced bracket matching should find the first outermost balanced pair
    const result = parseLLMJson<string[]>(
      'First: ["a", "b"]\nSecond: ["c", "d"]',
    );
    expect(result).not.toBeNull();
    // Should find the first JSON array: ["a", "b"]
    expect(result).toEqual(["a", "b"]);
  });

  it("extracts the FIRST JSON object when both object and array exist", () => {
    const result = parseLLMJson<{ items: string[] }>(
      'Object: {"items": ["x", "y"]}\nArray: ["z"]',
    );
    expect(result).not.toBeNull();
    // Should find the object first (object check runs after array check fails)
    expect(result).toHaveProperty("items");
    expect((result as Record<string, unknown>).items).toEqual(["x", "y"]);
  });
});

// ============================================================================
// BRACKET BALANCING WITH NESTED DATA
// ============================================================================

describe("parseLLMJson - balanced brackets", () => {
  it("handles nested objects inside arrays", () => {
    const result = parseLLMJson<Array<{ id: number; name: string }>>(
      '[{"id": 1, "name": "a"}, {"id": 2, "name": "b"}]',
    );
    expect(result).not.toBeNull();
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(2);
    expect(result![0]).toHaveProperty("id", 1);
    expect(result![1]).toHaveProperty("name", "b");
  });

  it("handles brackets inside string values", () => {
    // Brackets inside strings should NOT confuse the bracket matcher
    const result = parseLLMJson<{ summary: string }>(
      '{"summary": "The value is [important] and {nested} too"}',
    );
    expect(result).not.toBeNull();
    expect(result).toHaveProperty("summary", "The value is [important] and {nested} too");
  });

  it("handles deeply nested structures", () => {
    const result = parseLLMJson<{ level1: { level2: { level3: string } } }>(
      '{"level1": {"level2": {"level3": "deep"}}}',
    );
    expect(result).not.toBeNull();
    expect((result as Record<string, unknown>).level1).toBeDefined();
  });
});

// ============================================================================
// EDGE CASES
// ============================================================================

describe("parseLLMJson - edge cases", () => {
  it("handles strings with escaped quotes", () => {
    const result = parseLLMJson<{ text: string }>(
      '{"text": "He said \\"hello\\" to me"}',
    );
    expect(result).not.toBeNull();
    expect(result).toHaveProperty("text", 'He said "hello" to me');
  });

  it("handles strings with backslashes and newlines", () => {
    const result = parseLLMJson<{ path: string; desc: string }>(
      '{"path": "C:\\\\Users\\\\test", "desc": "Line 1\\nLine 2"}',
    );
    expect(result).not.toBeNull();
    expect(result).toHaveProperty("path", "C:\\Users\\test");
    expect(result).toHaveProperty("desc", "Line 1\nLine 2");
  });

  it("handles JSON with null values", () => {
    const result = parseLLMJson<{ a: unknown }>('{"a": null}');
    expect(result).not.toBeNull();
    expect(result).toHaveProperty("a", null);
  });

  it("handles JSON with boolean values", () => {
    const result = parseLLMJson<{ flag: boolean }>('{"flag": false}');
    expect(result).not.toBeNull();
    expect(result).toHaveProperty("flag", false);
  });

  it("handles JSON with numeric values", () => {
    const result = parseLLMJson<{ count: number }>('{"count": 0}');
    expect(result).not.toBeNull();
    expect(result).toHaveProperty("count", 0);
  });

  it("handles JSON with negative numbers", () => {
    const result = parseLLMJson<{ val: number }>('{"val": -42}');
    expect(result).not.toBeNull();
    expect(result).toHaveProperty("val", -42);
  });

  it("handles JSON with floating point numbers", () => {
    const result = parseLLMJson<{ pi: number }>('{"pi": 3.14159}');
    expect(result).not.toBeNull();
    expect(result).toHaveProperty("pi", 3.14159);
  });

  it("handles JSON with empty objects", () => {
    expect(parseLLMJson("{}")).not.toBeNull();
    expect(parseLLMJson<Record<string, unknown>>("{}")).toEqual({});
  });

  it("handles JSON with empty arrays", () => {
    expect(parseLLMJson("[]")).not.toBeNull();
    expect(parseLLMJson<unknown[]>("[]")).toEqual([]);
  });

  it("handles array of primitives", () => {
    const result = parseLLMJson<unknown[]>('[1, "two", true, null]');
    expect(result).not.toBeNull();
    expect(result).toEqual([1, "two", true, null]);
  });

  it("handles text after the JSON block (ignores tailing text)", () => {
    // The function extracts the JSON block from surrounding text
    const result = parseLLMJson<{ answer: string }>(
      '{"answer": "yes"} There are more details here...',
    );
    expect(result).not.toBeNull();
    expect(result).toHaveProperty("answer", "yes");
  });
});

// ============================================================================
// MALFORMED / TRICKY INPUTS
// ============================================================================

describe("parseLLMJson - malformed inputs", () => {
  it("returns null for truncated JSON (no closing brace)", () => {
    const result = parseLLMJson('{"key": "value"');
    expect(result).toBeNull();
  });

  it("returns null for truncated JSON (no closing bracket)", () => {
    const result = parseLLMJson('["item1", "item2"');
    expect(result).toBeNull();
  });

  it("returns null for single character input", () => {
    expect(parseLLMJson("{")).toBeNull();
    expect(parseLLMJson("[")).toBeNull();
  });

  it("returns null for a standalone string without JSON structure", () => {
    expect(parseLLMJson('"just a string"')).toBeNull();
  });

  it("returns null for a number without JSON structure", () => {
    expect(parseLLMJson("42")).toBeNull();
  });

  it("handles input with only code fences and no JSON", () => {
    const result = parseLLMJson("```json\n```");
    expect(result).toBeNull();
  });
});

// ============================================================================
// TYPE-SPECIFIC PARSING
// ============================================================================

describe("parseLLMJson - type-specific", () => {
  it("parses into typed object with generic", () => {
    interface User {
      id: number;
      name: string;
      roles: string[];
    }
    const result = parseLLMJson<User>(
      '{"id": 1, "name": "Alice", "roles": ["admin", "user"]}',
    );
    expect(result).not.toBeNull();
    expect(result!.id).toBe(1);
    expect(result!.name).toBe("Alice");
    expect(result!.roles).toEqual(["admin", "user"]);
  });

  it("parses array of typed objects", () => {
    interface Item {
      id: number;
      label: string;
    }
    const result = parseLLMJson<Item[]>(
      '[{"id": 1, "label": "First"}, {"id": 2, "label": "Second"}]',
    );
    expect(result).not.toBeNull();
    expect(result).toHaveLength(2);
    expect(result![0].label).toBe("First");
    expect(result![1].id).toBe(2);
  });

  it("returns correct type for nested objects", () => {
    const result = parseLLMJson<{ metadata: { created: string; version: number } }>(
      '{"metadata": {"created": "2024-01-01", "version": 2}}',
    );
    expect(result).not.toBeNull();
    expect(result!.metadata.created).toBe("2024-01-01");
    expect(result!.metadata.version).toBe(2);
  });
});

// ============================================================================
// REGRESSION TESTS
// ============================================================================

describe("parseLLMJson - regression tests", () => {
  it("handles LLM output with trailing explanation after JSON array", () => {
    // Common pattern: LLM returns JSON followed by text
    const result = parseLLMJson<Array<{ task: string }>>(
      '[{"task": "fix bug"}]\n\nThis represents the extracted memory.',
    );
    expect(result).not.toBeNull();
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(1);
    expect(result![0]).toHaveProperty("task", "fix bug");
  });

  it("handles LLM output with leading explanation before JSON object", () => {
    const result = parseLLMJson<{ reason: string; action: string }>(
      'Based on analysis: {"reason": "high priority", "action": "fix now"}',
    );
    expect(result).not.toBeNull();
    expect(result).toHaveProperty("reason", "high priority");
    expect(result).toHaveProperty("action", "fix now");
  });

  it("handles multiple JSON blocks in text (picks first valid bracket pair)", () => {
    // When text has multiple JSON blocks, pick the first outermost pair
    const result = parseLLMJson<{ a: number }>(
      'First: {"a": 1} Second: {"b": 2}',
    );
    expect(result).not.toBeNull();
    expect(result).toHaveProperty("a", 1);
    // Should NOT have 'b' since it picks the first JSON object
    expect(result).not.toHaveProperty("b");
  });

  it("handles single-quote in text (not valid JSON but doesn't crash)", () => {
    // Single quotes are not valid JSON, but the function should handle gracefully
    const result = parseLLMJson("{'key': 'value'}");
    expect(result).toBeNull(); // Not valid JSON
  });

  it("handles unicode characters in JSON", () => {
    const result = parseLLMJson<{ text: string }>(
      '{"text": "café ñoño 你好 🎉"}',
    );
    expect(result).not.toBeNull();
    expect(result).toHaveProperty("text", "café ñoño 你好 🎉");
  });

  it("does not get confused by brackets in markdown link syntax", () => {
    // Text containing [link](url) patterns should not confuse bracket matching
    const result = parseLLMJson<{ url: string }>(
      'See [link](example.com) and the result: {"url": "example.com"}',
    );
    expect(result).not.toBeNull();
    expect(result).toHaveProperty("url", "example.com");
  });
});
