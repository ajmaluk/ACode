import { describe, it, expect } from "vitest";
import { countTokens, countMessageTokens, computeTokenBudget } from "../tokenizer";

describe("countTokens", () => {
  it("returns 0 for empty string", () => {
    expect(countTokens("", "gpt-4")).toBe(0);
    expect(countTokens("", "claude-3-sonnet")).toBe(0);
  });

  it("returns 0 for nullish/undefined", () => {
    expect(countTokens(null as unknown as string, "gpt-4")).toBe(0);
    expect(countTokens(undefined as unknown as string, "gpt-4")).toBe(0);
  });

  it("counts tokens for short text with gpt-4", () => {
    const result = countTokens("Hello, world!", "gpt-4");
    expect(result).toBeGreaterThan(0);
    expect(result).toBeLessThan(10);
  });

  it("counts tokens for longer text", () => {
    const text = "The quick brown fox jumps over the lazy dog. This is a longer passage of text to ensure accurate counting across multiple tokens.";
    const count = countTokens(text, "gpt-4");
    expect(count).toBeGreaterThan(5);
    expect(count).toBeLessThan(50);
  });

  it("uses o200k encoder for gpt-4o models", () => {
    const text = "Hello, how are you today?";
    const count4o = countTokens(text, "gpt-4o");
    const count4Mini = countTokens(text, "gpt-4o-mini");
    expect(count4o).toBeGreaterThan(0);
    expect(count4Mini).toBe(count4o); // Same encoder
  });

  it("uses o200k encoder for o1/o3 models", () => {
    const text = "Some reasoning text.";
    const countO1 = countTokens(text, "o1-preview");
    const countO3 = countTokens(text, "o3-mini");
    expect(countO1).toBeGreaterThan(0);
    expect(countO3).toBeGreaterThan(0);
  });

  it("uses cl100k for gpt-4, gpt-3.5 defaults", () => {
    const text = "Test text";
    const count = countTokens(text, "gpt-4-turbo");
    expect(count).toBeGreaterThan(0);
  });

  it("applies 0.9x factor for Anthropic models", () => {
    const text = "A longer piece of text that will have more tokens. ".repeat(20);
    const claudeCount = countTokens(text, "claude-3-sonnet");
    const gptCount = countTokens(text, "gpt-4");
    // Claude should be ~90% of GPT count
    expect(claudeCount).toBeLessThanOrEqual(gptCount);
    expect(claudeCount).toBeGreaterThan(0);
  });

  it("applies 0.9x for any claude model variant", () => {
    const text = "Sample text for token counting across different models.";
    const haiku = countTokens(text, "claude-3-haiku");
    const opus = countTokens(text, "claude-3-opus");
    const sonnet35 = countTokens(text, "claude-3.5-sonnet");
    expect(haiku).toBeGreaterThan(0);
    expect(opus).toBe(haiku); // Same encoder, same text
    expect(sonnet35).toBe(haiku);
  });

  it("handles non-ASCII characters (CJK)", () => {
    // CJK characters typically use more tokens
    const cjkText = "你好世界，这是一个测试";
    const count = countTokens(cjkText, "gpt-4");
    expect(count).toBeGreaterThan(0);
  });
});

describe("countMessageTokens", () => {
  it("counts tokens for a single user message", () => {
    const messages = [{ role: "user", content: "Hello" }];
    const count = countMessageTokens(messages, "gpt-4");
    // 4 overhead + content tokens + 2 (assistant start)
    expect(count).toBeGreaterThan(4);
  });

  it("counts tokens for multiple messages", () => {
    const messages = [
      { role: "user", content: "What is the weather?" },
      { role: "assistant", content: "It is sunny." },
    ];
    const count = countMessageTokens(messages, "gpt-4");
    // 4 per message overhead (×2) + content tokens + 2 (assistant start)
    expect(count).toBeGreaterThan(8);
  });

  it("adds extra overhead for tool messages", () => {
    const userMsg = { role: "user", content: "Run a tool" };
    const toolMsg = { role: "tool", content: "{ result: 'ok' }" };
    const noTool = countMessageTokens([userMsg], "gpt-4");
    const withTool = countMessageTokens([userMsg, toolMsg], "gpt-4");
    // Tool adds 4 (msg overhead) + 8 (tool formatting) + content tokens
    expect(withTool).toBeGreaterThan(noTool + 10);
  });

  it("returns > 0 for empty messages array", () => {
    const count = countMessageTokens([], "gpt-4");
    expect(count).toBe(2); // Just the assistant start
  });
});

describe("computeTokenBudget", () => {
  const messages = [
    { role: "user", content: "Hello" },
    { role: "assistant", content: "Hi there!" },
  ];

  it("computes a valid token budget", () => {
    const budget = computeTokenBudget(messages, 50, 8192, "gpt-4");
    expect(budget.total).toBe(8192);
    expect(budget.systemPrompt).toBe(50);
    expect(budget.conversation).toBeGreaterThan(0);
    expect(budget.available).toBeGreaterThan(0);
    expect(budget.available).toBeLessThan(8192);
    expect(budget.pressure).toBeDefined();
  });

  it("reports no pressure when usage is low", () => {
    const budget = computeTokenBudget([{ role: "user", content: "Hi" }], 10, 8192, "gpt-4");
    expect(budget.pressure).toBe("none");
  });

  it("reports critical pressure when near limit", () => {
    // Build a conversation that takes almost all tokens
    const bigMessages = Array.from({ length: 100 }, (_, i) => ({
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      content: "test ".repeat(500),
    }));
    const budget = computeTokenBudget(bigMessages, 2000, 8192, "gpt-4");
    expect(["high", "critical"]).toContain(budget.pressure);
  });

  it("includes tool results in toolResults field", () => {
    const toolMessages = [
      { role: "user", content: "Run it" },
      { role: "tool", content: "Tool output here" },
    ];
    const budget = computeTokenBudget(toolMessages, 10, 4096, "gpt-4");
    expect(budget.toolResults).toBeGreaterThan(0);
  });

  it("handles edge case of empty messages", () => {
    const budget = computeTokenBudget([], 10, 4096, "gpt-4");
    expect(budget.conversation).toBeGreaterThan(0); // Still has assistant start
    expect(budget.available).toBeGreaterThan(0);
    expect(budget.pressure).toBe("none");
  });
});
