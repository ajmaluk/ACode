/**
 * Tests for the Cost Tracker module.
 *
 * Covers:
 * - parseUsageFromChunk (OpenAI + Anthropic formats)
 * - recordTokenUsage and getSessionCost
 * - formatCost and formatCostDetailed
 * - clearSessionCost and setModelPricing
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  parseUsageFromChunk,
  recordTokenUsage,
  getSessionCost,
  formatCost,
  formatCostDetailed,
  clearSessionCost,
  setModelPricing,
  type TokenUsage,
} from "../costTracker";

describe("parseUsageFromChunk", () => {
  it("returns null for null input", () => {
    expect(parseUsageFromChunk(null)).toBeNull();
  });

  it("returns null for undefined input", () => {
    expect(parseUsageFromChunk(undefined)).toBeNull();
  });

  it("returns null for non-object input", () => {
    expect(parseUsageFromChunk("string")).toBeNull();
    expect(parseUsageFromChunk(42)).toBeNull();
    expect(parseUsageFromChunk(true)).toBeNull();
  });

  it("parses OpenAI format (prompt_tokens, completion_tokens)", () => {
    const chunk = {
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    };
    const result = parseUsageFromChunk(chunk);
    expect(result).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
    });
  });

  it("parses OpenAI format with missing total_tokens (computes from sum)", () => {
    const chunk = { usage: { prompt_tokens: 100, completion_tokens: 50 } };
    const result = parseUsageFromChunk(chunk);
    expect(result).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
    });
  });

  it("parses Anthropic format (input_tokens, output_tokens)", () => {
    const chunk = { usage: { input_tokens: 200, output_tokens: 80 } };
    const result = parseUsageFromChunk(chunk);
    expect(result).toEqual({
      inputTokens: 200,
      outputTokens: 80,
      totalTokens: 280,
    });
  });

  it("prefers OpenAI format over Anthropic when both present", () => {
    const chunk = {
      usage: {
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
        input_tokens: 999,
        output_tokens: 999,
      },
    };
    const result = parseUsageFromChunk(chunk);
    // OpenAI format (prompt_tokens) takes precedence
    expect(result).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
    });
  });

  it("returns null when usage object has no recognized keys", () => {
    const chunk = { usage: { other_field: 42 } };
    expect(parseUsageFromChunk(chunk)).toBeNull();
  });

  it("returns null when usage exists but is not an object", () => {
    const chunk = { usage: "invalid" };
    expect(parseUsageFromChunk(chunk)).toBeNull();
  });

  it("handles nested chunk format { usage: { ... } }", () => {
    const chunk = {
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    };
    const result = parseUsageFromChunk(chunk);
    expect(result?.inputTokens).toBe(10);
    expect(result?.outputTokens).toBe(5);
  });

  it("handles zero values correctly", () => {
    const chunk = {
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
    const result = parseUsageFromChunk(chunk);
    expect(result).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    });
  });
});

describe("recordTokenUsage and getSessionCost", () => {
  beforeEach(() => {
    // Clear session costs before each test
    clearSessionCost("test-session");
  });

  it("records token usage and retrieves it", () => {
    const usage: TokenUsage = {
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
    };
    recordTokenUsage("test-session", "gpt-4o", usage);

    const cost = getSessionCost("test-session");
    expect(cost.totalInputTokens).toBe(100);
    expect(cost.totalOutputTokens).toBe(50);
    // gpt-4o: $2.50/1M input, $10.00/1M output
    expectedCost = (100 / 1_000_000) * 2.5 + (50 / 1_000_000) * 10.0;
    expect(cost.totalCostUsd).toBeCloseTo(expectedCost, 6);
  });

  it("accumulates multiple calls for same session", () => {
    recordTokenUsage("test-session", "gpt-4o", {
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
    });
    recordTokenUsage("test-session", "gpt-4o", {
      inputTokens: 200,
      outputTokens: 100,
      totalTokens: 300,
    });

    const cost = getSessionCost("test-session");
    expect(cost.totalInputTokens).toBe(300);
    expect(cost.totalOutputTokens).toBe(150);
  });

  it("tracks per-model breakdown", () => {
    recordTokenUsage("test-session", "gpt-4o", {
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
    });
    recordTokenUsage("test-session", "claude-3-5-sonnet", {
      inputTokens: 200,
      outputTokens: 80,
      totalTokens: 280,
    });

    const cost = getSessionCost("test-session");
    expect(Object.keys(cost.byModel)).toHaveLength(2);
    expect(cost.byModel["gpt-4o"].inputTokens).toBe(100);
    expect(cost.byModel["gpt-4o"].outputTokens).toBe(50);
    expect(cost.byModel["claude-3-5-sonnet"].inputTokens).toBe(200);
    expect(cost.byModel["claude-3-5-sonnet"].outputTokens).toBe(80);
  });

  it("returns empty cost for unknown session", () => {
    const cost = getSessionCost("nonexistent");
    expect(cost.totalInputTokens).toBe(0);
    expect(cost.totalOutputTokens).toBe(0);
    expect(cost.totalCostUsd).toBe(0);
    expect(cost.byModel).toEqual({});
  });

  it("clears session cost", () => {
    recordTokenUsage("test-session", "gpt-4o", {
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
    });
    clearSessionCost("test-session");

    const cost = getSessionCost("test-session");
    expect(cost.totalInputTokens).toBe(0);
  });
});

describe("formatCost", () => {
  beforeEach(() => {
    clearSessionCost("fmt-session");
  });

  it("formats cost string for a session with usage", () => {
    recordTokenUsage("fmt-session", "gpt-4o", {
      inputTokens: 1500,
      outputTokens: 500,
      totalTokens: 2000,
    });
    const formatted = formatCost("fmt-session");
    expect(formatted).toContain("↑2K");
    expect(formatted).toContain("↓1K");
    expect(formatted).toContain("$");
  });

  it("formats zero-cost session", () => {
    const formatted = formatCost("empty-session");
    expect(formatted).toContain("↑0K");
    expect(formatted).toContain("↓0K");
  });
});

describe("formatCostDetailed", () => {
  beforeEach(() => {
    clearSessionCost("det-session");
  });

  it("returns detailed cost breakdown", () => {
    recordTokenUsage("det-session", "gpt-4o", {
      inputTokens: 1000,
      outputTokens: 500,
      totalTokens: 1500,
    });
    const formatted = formatCostDetailed("det-session");
    expect(formatted).toContain("Total:");
    expect(formatted).toContain("in");
    expect(formatted).toContain("out");
    expect(formatted).toContain("Cost:");
    expect(formatted).toContain("By Model:");
    expect(formatted).toContain("gpt-4o");
  });

  it("omits 'By Model' section when no per-model data", () => {
    const formatted = formatCostDetailed("empty-det");
    expect(formatted).toContain("Total:");
    expect(formatted).not.toContain("By Model:");
  });
});

describe("setModelPricing", () => {
  beforeEach(() => {
    clearSessionCost("price-session");
  });

  it("allows overriding pricing for a model", () => {
    setModelPricing("custom-model", 1.0, 2.0);
    recordTokenUsage("price-session", "custom-model", {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      totalTokens: 2_000_000,
    });

    const cost = getSessionCost("price-session");
    expect(cost.totalCostUsd).toBeCloseTo(3.0, 4);
  });
});

// Helper for the expectedCost calculation
let expectedCost = 0;
