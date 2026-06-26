import { describe, it, expect } from "vitest";
import {
  estimateTokens,
  computePressure,
  computeContextStats,
  selectMessagesForCompaction,
  pruneToolOutputs,
  parseContextWindow,
} from "./contextManager";
import type { ChatMessage } from "@dalam/shared-types";

function msg(role: "user" | "assistant", content: string, extra?: Partial<ChatMessage>): ChatMessage {
  return { id: `m-${Math.random()}`, role, content, timestamp: Date.now(), ...extra };
}

describe("contextManager", () => {
  describe("estimateTokens", () => {
    it("returns 0 for empty string", () => {
      expect(estimateTokens("")).toBe(0);
    });

    it("returns 0 for null/undefined", () => {
      expect(estimateTokens(null as any)).toBe(0);
      expect(estimateTokens(undefined as any)).toBe(0);
    });

    it("estimates ~4 chars per token for ASCII", () => {
      const tokens = estimateTokens("hello world");
      expect(tokens).toBeGreaterThan(0);
      expect(tokens).toBeLessThan(11);
    });

    it("handles CJK characters", () => {
      const tokens = estimateTokens("你好世界");
      expect(tokens).toBe(3);
    });

    it("handles mixed content", () => {
      const tokens = estimateTokens("Hello 世界! 🌍");
      expect(tokens).toBeGreaterThan(0);
    });

    it("handles code blocks", () => {
      const code = "```typescript\nconst x = 1;\n```";
      const tokens = estimateTokens(code);
      expect(tokens).toBeGreaterThan(0);
    });

    it("handles very long strings", () => {
      const long = "a".repeat(100000);
      const tokens = estimateTokens(long);
      expect(tokens).toBeGreaterThan(0);
    });

    it("handles whitespace-only strings", () => {
      const tokens = estimateTokens("   \n\n  ");
      expect(tokens).toBeGreaterThan(0);
    });
  });

  describe("computePressure", () => {
    it("returns 'none' below 50%", () => {
      const result = computePressure(40000, 128000);
      expect(result.pressure).toBe("none");
    });

    it("returns 'low' at 50-70%", () => {
      const result = computePressure(80000, 128000);
      expect(result.pressure).toBe("low");
    });

    it("returns 'medium' at 70-85%", () => {
      const result = computePressure(100000, 128000);
      expect(result.pressure).toBe("medium");
    });

    it("returns 'high' above 85%", () => {
      const result = computePressure(110000, 128000);
      expect(result.pressure).toBe("high");
    });

    it("handles zero tokens", () => {
      const result = computePressure(0, 128000);
      expect(result.pressure).toBe("none");
      expect(result.ratio).toBe(0);
    });

    it("handles exact boundaries", () => {
      expect(computePressure(64000, 128000).pressure).toBe("low");
      expect(computePressure(89600, 128000).pressure).toBe("medium");
      expect(computePressure(108800, 128000).pressure).toBe("high");
    });

    it("handles over 100%", () => {
      const result = computePressure(200000, 128000);
      expect(result.pressure).toBe("high");
      expect(result.ratio).toBeGreaterThan(1);
    });

    it("handles zero max tokens", () => {
      const result = computePressure(100, 0);
      expect(result.ratio).toBe(Infinity);
    });
  });

  describe("selectMessagesForCompaction", () => {
    it("returns empty toCompact for short conversations", () => {
      const messages = [msg("user", "hi"), msg("assistant", "hello")];
      const { toCompact, toKeep } = selectMessagesForCompaction(messages, 6);
      expect(toCompact).toHaveLength(0);
      expect(toKeep).toHaveLength(2);
    });

    it("returns empty toCompact for empty array", () => {
      const { toCompact, toKeep } = selectMessagesForCompaction([], 6);
      expect(toCompact).toHaveLength(0);
      expect(toKeep).toHaveLength(0);
    });

    it("returns empty toCompact for single message", () => {
      const { toCompact, toKeep } = selectMessagesForCompaction([msg("user", "hi")], 6);
      expect(toCompact).toHaveLength(0);
      expect(toKeep).toHaveLength(1);
    });

    it("splits correctly for long conversations", () => {
      const messages = Array.from({ length: 20 }, (_, i) =>
        msg(i % 2 === 0 ? "user" : "assistant", `message ${i}`)
      );
      const { toCompact, toKeep } = selectMessagesForCompaction(messages, 6);
      expect(toKeep.length).toBeGreaterThanOrEqual(6);
      expect(toKeep.length + toCompact.length).toBe(20);
      expect(toCompact.length).toBeGreaterThan(0);
    });

    it("preserves first user message", () => {
      const messages = [
        msg("user", "first message"),
        ...Array.from({ length: 15 }, (_, i) => msg("assistant", `msg ${i}`)),
      ];
      const { toKeep } = selectMessagesForCompaction(messages, 6);
      expect(toKeep[0].content).toBe("first message");
    });

    it("preserves messages with file changes", () => {
      const messages = [
        msg("user", "old message"),
        msg("assistant", "response", { fileChanges: [{ path: "test.ts", action: "modified", additions: 1, deletions: 0 }] }),
        ...Array.from({ length: 10 }, (_, i) => msg(i % 2 === 0 ? "user" : "assistant", `msg ${i}`)),
      ];
      const { toKeep } = selectMessagesForCompaction(messages, 6);
      const hasFileChange = toKeep.some(m => m.fileChanges && m.fileChanges.length > 0);
      expect(hasFileChange).toBe(true);
    });

    it("preserves messages with todos", () => {
      const messages = [
        msg("user", "old message"),
        msg("assistant", "response", { todos: [{ id: "1", content: "task", status: "pending" }] }),
        ...Array.from({ length: 10 }, (_, i) => msg(i % 2 === 0 ? "user" : "assistant", `msg ${i}`)),
      ];
      const { toKeep } = selectMessagesForCompaction(messages, 6);
      const hasTodo = toKeep.some(m => m.todos && m.todos.length > 0);
      expect(hasTodo).toBe(true);
    });

    it("handles all tool result messages", () => {
      const messages = Array.from({ length: 10 }, (_, i) =>
        msg("user", `[TOOL RESULT: ls]\noutput ${i}`)
      );
      const { toCompact, toKeep } = selectMessagesForCompaction(messages, 6);
      expect(toKeep.length + toCompact.length).toBe(10);
    });
  });

  describe("pruneToolOutputs", () => {
    it("does nothing when tool outputs are small", () => {
      const messages = [msg("user", "[TOOL RESULT: ls]\nfile1.ts")];
      const { pruned, tokensReclaimed } = pruneToolOutputs(messages);
      expect(tokensReclaimed).toBe(0);
      expect(pruned[0].content).toBe(messages[0].content);
    });

    it("prunes old tool outputs", () => {
      const bigOutput = "x".repeat(200000);
      const messages = [
        msg("user", `[TOOL RESULT: read_file]\n${bigOutput}`),
        msg("user", "do something"),
        msg("assistant", "ok"),
      ];
      const { pruned, tokensReclaimed } = pruneToolOutputs(messages);
      expect(tokensReclaimed).toBeGreaterThan(0);
      expect(pruned[0].content).toContain("pruned");
    });

    it("protects recent user turns", () => {
      const bigOutput = "x".repeat(200000);
      const messages = [
        msg("user", `[TOOL RESULT: read_file]\n${bigOutput}`),
        msg("user", "actual question"),
        msg("assistant", "answer"),
      ];
      const { pruned } = pruneToolOutputs(messages);
      expect(pruned[1].content).toBe("actual question");
    });

    it("handles empty messages array", () => {
      const { pruned, tokensReclaimed } = pruneToolOutputs([]);
      expect(pruned).toHaveLength(0);
      expect(tokensReclaimed).toBe(0);
    });

    it("handles no tool result messages", () => {
      const messages = [
        msg("user", "hello"),
        msg("assistant", "world"),
      ];
      const { pruned, tokensReclaimed } = pruneToolOutputs(messages);
      expect(tokensReclaimed).toBe(0);
      expect(pruned).toHaveLength(2);
    });

    it("handles TOOL ERROR prefix", () => {
      const bigOutput = "x".repeat(200000);
      const messages = [
        msg("user", `[TOOL ERROR: read_file]\n${bigOutput}`),
        msg("user", "next question"),
      ];
      const { pruned, tokensReclaimed } = pruneToolOutputs(messages);
      expect(tokensReclaimed).toBeGreaterThan(0);
      expect(pruned[1].content).toBe("next question");
    });

    it("preserves assistant messages", () => {
      const bigOutput = "x".repeat(200000);
      const messages = [
        msg("user", `[TOOL RESULT: read_file]\n${bigOutput}`),
        msg("assistant", "analysis of the file"),
      ];
      const { pruned } = pruneToolOutputs(messages);
      expect(pruned[1].content).toBe("analysis of the file");
    });
  });

  describe("parseContextWindow", () => {
    it("parses '128k'", () => expect(parseContextWindow("128k")).toBe(128000));
    it("parses '200k'", () => expect(parseContextWindow("200k")).toBe(200000));
    it("parses '1m'", () => expect(parseContextWindow("1m")).toBe(1000000));
    it("parses plain number", () => expect(parseContextWindow("32000")).toBe(32000));
    it("defaults for undefined", () => expect(parseContextWindow(undefined)).toBe(128000));
    it("defaults for unparseable", () => expect(parseContextWindow("unknown")).toBe(128000));
    it("handles '1.5m'", () => expect(parseContextWindow("1.5m")).toBe(1500000));
    it("handles '256K' uppercase", () => expect(parseContextWindow("256K")).toBe(256000));
    it("handles empty string", () => expect(parseContextWindow("")).toBe(128000));
    it("handles '0'", () => expect(parseContextWindow("0")).toBe(0));
  });

  describe("computeContextStats", () => {
    it("computes stats for empty messages", () => {
      const stats = computeContextStats([], 128000);
      expect(stats.totalTokens).toBe(0);
      expect(stats.needsCompaction).toBe(false);
    });

    it("computes stats for normal conversation", () => {
      const messages = Array.from({ length: 10 }, (_, i) =>
        msg(i % 2 === 0 ? "user" : "assistant", `message ${i}`)
      );
      const stats = computeContextStats(messages, 128000);
      expect(stats.totalTokens).toBeGreaterThan(0);
      expect(stats.messageCount).toBe(10);
    });

    it("detects high pressure", () => {
      const messages = [msg("user", "x".repeat(500000))];
      const stats = computeContextStats(messages, 128000);
      expect(stats.pressure).toBe("high");
      expect(stats.needsCompaction).toBe(true);
    });
  });
});
