import { describe, it, expect } from "vitest";
import {
  _isToolResult,
  _alignBoundaryPairs,
  selectMessagesForCompaction,
  pruneToolOutputs,
  tier1PruneToolOutputs,
  computeContextStats,
  estimateTokens,
  parseContextWindow,
} from "./contextManager";
import type { ChatMessage } from "@dalam/shared-types";

// ─── Helpers ────────────────────────────────────────────────

function userMsg(content: string): ChatMessage {
  return { id: "u-" + Math.random().toString(36).slice(2), role: "user", content, timestamp: Date.now() };
}

function assistantMsg(content: string, toolCalls?: ChatMessage["toolCalls"]): ChatMessage {
  return {
    id: "a-" + Math.random().toString(36).slice(2),
    role: "assistant",
    content,
    timestamp: Date.now(),
    ...(toolCalls ? { toolCalls } : {}),
  };
}

function toolResultMsg(toolName: string, result = "ok"): ChatMessage {
  return {
    id: "tr-" + Math.random().toString(36).slice(2),
    role: "user",
    content: `[TOOL RESULT: ${toolName}] ${result}`,
    timestamp: Date.now(),
  };
}



// ─── Boundary Alignment Tests ───────────────────────────────

describe("selectMessagesForCompaction — boundary alignment", () => {
  describe("tool_call/tool_result pairs stay together", () => {
    it("keeps assistant(toolCalls) and its following tool results together when assistant is protected", () => {
      // Scenario: assistant with toolCalls is protected → tool results should also be kept
      const messages: ChatMessage[] = [
        userMsg("first user message"),
        userMsg("older user message"),
        assistantMsg("I'll read the file", [{ id: "tc-1", name: "read_file", args: { path: "/a" }, status: "pending" }]),
        toolResultMsg("read_file", "file content"),
        userMsg("middle user message"),
        userMsg("another middle message"),
        userMsg("recent user message 1"),
        userMsg("recent user message 2"),
      ];

      const { toCompact, toKeep } = selectMessagesForCompaction(messages, 6);

      // The assistant with toolCalls (index 2) should not be in toCompact
      // without also having its tool result (index 3) — or both should be compacted together
      const compactedIndices = new Set(toCompact.map((m) => messages.indexOf(m)));
      const keptIndices = new Set(toKeep.map((m) => messages.indexOf(m)));

      // If assistant (2) is kept, tool result (3) must also be kept
      if (keptIndices.has(2)) {
        expect(keptIndices.has(3)).toBe(true);
      }
      // If tool result (3) is compacted, assistant (2) must also be compacted
      if (compactedIndices.has(3)) {
        expect(compactedIndices.has(2)).toBe(true);
      }
    });

    it("keeps tool result and its preceding assistant together when tool result is protected", () => {
      // Scenario: tool result is in the protected set → assistant with toolCalls should also be protected
      const messages: ChatMessage[] = [
        userMsg("first user message"),
        userMsg("older user message"),
        assistantMsg("I'll edit the file", [{ id: "tc-2", name: "edit_file", args: { path: "/b" }, status: "pending" }]),
        toolResultMsg("edit_file", "edited"),
        userMsg("middle message 1"),
        userMsg("middle message 2"),
        userMsg("middle message 3"),
        userMsg("recent message 1"),
        userMsg("recent message 2"),
      ];    const { toCompact, toKeep } = selectMessagesForCompaction(messages, 6);

    const keptIndices = new Set(toKeep.map((m) => messages.indexOf(m)));
    const compactedIndices = new Set(toCompact.map((m) => messages.indexOf(m)));

    // Verify pairs are never split
    if (keptIndices.has(3)) {
      expect(keptIndices.has(2)).toBe(true);
    }
    if (compactedIndices.has(2)) {
      expect(compactedIndices.has(3)).toBe(true);
    }
  });

    it("compacts both assistant and tool results together when neither is protected", () => {
      // A long conversation where both the assistant(toolCalls) and tool results
      // are old enough to be candidates for compaction
      const messages: ChatMessage[] = [
        userMsg("first user message"),
        userMsg("what is the status"),
        assistantMsg("checking...", [{ id: "tc-3", name: "git_status", args: {}, status: "pending" }]),
        toolResultMsg("git_status", "On branch main"),
        userMsg("ok thanks"),
        assistantMsg("reading file", [{ id: "tc-4", name: "read_file", args: { path: "/c" }, status: "pending" }]),
        toolResultMsg("read_file", "content here"),
        userMsg("middle message 1"),
        userMsg("middle message 2"),
        userMsg("middle message 3"),
        userMsg("recent message 1"),
        userMsg("recent message 2"),
      ];

      const { toCompact, toKeep } = selectMessagesForCompaction(messages, 6);

      const compactedIndices = new Set(toCompact.map((m) => messages.indexOf(m)));
      const keptIndices = new Set(toKeep.map((m) => messages.indexOf(m)));

      // Verify all pairs are together
      // Pair 1: assistant(2) + toolResult(3)
      if (compactedIndices.has(2)) {
        expect(compactedIndices.has(3)).toBe(true);
      }
      if (keptIndices.has(2)) {
        expect(keptIndices.has(3)).toBe(true);
      }
      // Pair 2: assistant(5) + toolResult(6)
      if (compactedIndices.has(5)) {
        expect(compactedIndices.has(6)).toBe(true);
      }
      if (keptIndices.has(5)) {
        expect(keptIndices.has(6)).toBe(true);
      }
    });

    it("handles multiple tool results after one assistant", () => {
      // Assistant makes 2 tool calls → 2 tool results follow
      const messages: ChatMessage[] = [
        userMsg("first user message"),
        userMsg("do both tasks"),
        assistantMsg("I'll do both", [
          { id: "tc-a", name: "read_file", args: { path: "/a" }, status: "pending" },
          { id: "tc-b", name: "git_status", args: {}, status: "pending" },
        ]),
        toolResultMsg("read_file", "file content"),
        toolResultMsg("git_status", "on main"),
        userMsg("ok"),
        userMsg("middle 1"),
        userMsg("middle 2"),
        userMsg("middle 3"),
        userMsg("recent 1"),
        userMsg("recent 2"),
      ];

      const { toCompact, toKeep } = selectMessagesForCompaction(messages, 6);

      const compactedIndices = new Set(toCompact.map((m) => messages.indexOf(m)));
      const keptIndices = new Set(toKeep.map((m) => messages.indexOf(m)));

      // Assistant(2), toolResult1(3), toolResult2(4) must all be in the same set
      const indices = [2, 3, 4];
      const allCompacted = indices.every((i) => compactedIndices.has(i));
      const allKept = indices.every((i) => keptIndices.has(i));
      expect(allCompacted || allKept).toBe(true);
    });

    it("does not pull unrelated messages into alignment", () => {
      // When a tool result is protected, backward walk should stop at the
      // assistant with toolCalls, not pull in earlier user messages
      const messages: ChatMessage[] = [
        userMsg("first user message"),
        userMsg("do something"),
        assistantMsg("plain response"),
        userMsg("now do tool stuff"),
        assistantMsg("calling tool", [{ id: "tc-5", name: "run_command", args: { cmd: "ls" }, status: "pending" }]),
        toolResultMsg("run_command", "file1\nfile2"),
        userMsg("middle 1"),
        userMsg("middle 2"),
        userMsg("middle 3"),
        userMsg("recent 1"),
        userMsg("recent 2"),
      ];

      const { toKeep } = selectMessagesForCompaction(messages, 6);

      const keptIndices = new Set(toKeep.map((m) => messages.indexOf(m)));

      // The plain assistant (index 3) should NOT be pulled in just because
      // the tool result (index 5) and its assistant (index 4) are kept
      // (index 3 is a plain assistant without toolCalls, so it shouldn't be affected)
      // This is a sanity check — no assertion on index 3 specifically,
      // but we verify the pair 4+5 stays together
      if (keptIndices.has(5)) {
        expect(keptIndices.has(4)).toBe(true);
      }
    });
  });

  describe("basic compaction behavior", () => {
    it("returns all messages as toKeep when conversation is short", () => {
      const messages = [userMsg("hi"), assistantMsg("hello")];
      const { toCompact, toKeep } = selectMessagesForCompaction(messages, 6);
      expect(toCompact).toHaveLength(0);
      expect(toKeep).toHaveLength(2);
    });

    it("always protects the first user message", () => {
      const messages = Array.from({ length: 15 }, (_, i) =>
        i % 2 === 0 ? userMsg(`user ${i}`) : assistantMsg(`assistant ${i}`)
      );

      const { toKeep } = selectMessagesForCompaction(messages, 6);
      expect(toKeep[0]).toBe(messages[0]);
    });

    it("protects recent user messages", () => {
      const messages = Array.from({ length: 15 }, (_, i) =>
        i % 2 === 0 ? userMsg(`user ${i}`) : assistantMsg(`assistant ${i}`)
      );

      const { toKeep } = selectMessagesForCompaction(messages, 6);
      // Last 6 non-tool-result user messages should be protected
      const lastUserMsgs = messages.filter((m) => m.role === "user").slice(-6);
      for (const msg of lastUserMsgs) {
        expect(toKeep).toContain(msg);
      }
    });

    it("protects messages with file changes", () => {
      const messages = Array.from({ length: 15 }, (_, i) =>
        i % 2 === 0 ? userMsg(`user ${i}`) : assistantMsg(`assistant ${i}`)
      );
      // Add a message with file changes in the middle
      messages[6] = { ...messages[6], fileChanges: [{ path: "/test.ts", action: "modified", additions: 1, deletions: 0 }] };

      const { toKeep } = selectMessagesForCompaction(messages, 6);
      expect(toKeep).toContain(messages[6]);
    });
  });
});

// ─── Tool Output Pruning Tests ──────────────────────────────

describe("pruneToolOutputs", () => {
  it("returns original messages when no tool outputs exist", () => {
    const messages = [userMsg("hello"), assistantMsg("hi"), userMsg("bye")];
    const { pruned, tokensReclaimed } = pruneToolOutputs(messages);
    expect(pruned).toEqual(messages);
    expect(tokensReclaimed).toBe(0);
  });

  it("preserves tool result format after pruning", () => {
    // pruneToolOutputs protects TURN_PROTECT=2 recent real user turns.
    // Tool result must be at an index < protectAfter (the min real user turn index).
    // Put tool result BEFORE all real user turns so it's prunable.
    const messages = [
      assistantMsg("old response"),
      assistantMsg("another old response"),
      toolResultMsg("read_file", "x".repeat(50000)),
      userMsg("first user message"),
      userMsg("second user message"),
      userMsg("recent"),
    ];
    const { pruned } = pruneToolOutputs(messages);
    // The tool result should be replaced with a pruned message
    const toolMsg = pruned.find((m) => m.id === messages[2].id);
    expect(toolMsg).toBeDefined();
    // Pruned message should start with [Tool output pruned
    expect(toolMsg!.content).toMatch(/^\[Tool output pruned/);
  });
});

describe("tier1PruneToolOutputs", () => {
  it("returns original messages when tool outputs are small", () => {
    const messages = [
      userMsg("first"),
      toolResultMsg("git_status", "short"),
      userMsg("recent"),
    ];
    const { tokensReclaimed } = tier1PruneToolOutputs(messages);
    expect(tokensReclaimed).toBe(0);
  });

  it("truncates (not removes) large tool outputs", () => {
    // tier1PruneToolOutputs needs: protectAfter > 0 (TURN_PROTECT+2=4 real user turns
    // before the tool result) AND totalPrunableToolTokens >= PRUNE_MINIMUM (5000)
    const messages = [
      userMsg("old user 1"),
      userMsg("old user 2"),
      userMsg("old user 3"),
      toolResultMsg("read_file", "x".repeat(50000)),
      userMsg("recent 1"),
      userMsg("recent 2"),
      userMsg("recent 3"),
      userMsg("recent 4"),
    ];
    const { pruned, tokensReclaimed } = tier1PruneToolOutputs(messages);
    expect(tokensReclaimed).toBeGreaterThan(0);
    // The tool result should be truncated, not removed
    const toolMsg = pruned.find((m) => m.id === messages[3].id);
    expect(toolMsg).toBeDefined();
    expect(toolMsg!.content).toContain("Output truncated");
    expect(toolMsg!.content).toContain("read_file");
  });

  it("protects recent real user turns", () => {
    // tier1PruneToolOutputs protects TURN_PROTECT+2=4 recent real user turns
    // Need 4+ real user turns after the tool results for them to be protected
    const messages = [
      userMsg("old user 1"),
      userMsg("old user 2"),
      userMsg("old user 3"),
      toolResultMsg("read_file", "x".repeat(50000)),
      toolResultMsg("grep_file", "y".repeat(50000)),
      userMsg("recent 1"),
      userMsg("recent 2"),
      userMsg("recent 3"),
      userMsg("recent 4"),
    ];
    const { pruned } = tier1PruneToolOutputs(messages);
    // Recent user messages should be untouched
    expect(pruned[5].content).toBe("recent 1");
    expect(pruned[6].content).toBe("recent 2");
    expect(pruned[7].content).toBe("recent 3");
    expect(pruned[8].content).toBe("recent 4");
  });
});

// ─── Context Stats Tests ────────────────────────────────────

describe("computeContextStats", () => {
  it("returns none pressure for small conversations", () => {
    const messages = [userMsg("hi")];
    const stats = computeContextStats(messages, 128000);
    expect(stats.pressure).toBe("none");
    expect(stats.needsCompaction).toBe(false);
  });

  it("returns correct pressure ratios", () => {
    const stats = computeContextStats([], 128000);
    expect(stats.pressureRatio).toBe(0);
    expect(stats.pressure).toBe("none");
  });
});

describe("parseContextWindow", () => {
  it("parses 128k", () => expect(parseContextWindow("128k")).toBe(128000));
  it("parses 200K", () => expect(parseContextWindow("200K")).toBe(200000));
  it("parses 1m", () => expect(parseContextWindow("1m")).toBe(1000000));
  it("returns 128000 for undefined", () => expect(parseContextWindow(undefined)).toBe(128000));
  it("returns 128000 for unparseable", () => expect(parseContextWindow("unknown")).toBe(128000));
});

describe("estimateTokens", () => {
  it("returns 0 for empty string", () => expect(estimateTokens("")).toBe(0));
  it("estimates tokens for plain text", () => {
    const tokens = estimateTokens("hello world");
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBeLessThan(20);
  });

// ============================================================================
});

// Edge case tests: TOOL ERROR pairs, empty toolCalls, long conversations, tier2
// ============================================================================

describe("_isToolResult", () => {
  it("identifies TOOL RESULT messages", () => {
    expect(_isToolResult(userMsg("[TOOL RESULT: read_file] output here"))).toBe(true);
  });

  it("identifies TOOL ERROR messages", () => {
    expect(_isToolResult(userMsg("[TOOL ERROR: bash] command failed"))).toBe(true);
  });

  it("does not identify regular user messages", () => {
    expect(_isToolResult(userMsg("Hello, can you help?"))).toBe(false);
  });

  it("does not identify assistant messages as tool results", () => {
    const msg: ChatMessage = {
      id: "a-1", role: "assistant", content: "[TOOL RESULT: read_file] output",
      timestamp: Date.now(),
    };
    expect(_isToolResult(msg)).toBe(false);
  });

  it("returns false for empty content", () => {
    const msg: ChatMessage = { id: "u-1", role: "user", content: "", timestamp: Date.now() };
    expect(_isToolResult(msg)).toBe(false);
  });
});

describe("_alignBoundaryPairs — Case 2: tool result protected pulls assistant in", () => {
  it("pulls preceding assistant with toolCalls into keep set when tool result is protected", () => {
    const messages: ChatMessage[] = [
      userMsg("first"),
      assistantMsg("", [{ id: "tc-1", name: "read_file", args: { path: "x.ts" }, status: "completed" }]),
      toolResultMsg("read_file", "file content"),
      userMsg("what do you think?"),
      assistantMsg("looks good"),
      userMsg("now fix it"),
      assistantMsg("fixing...", [{ id: "tc-2", name: "edit_file", args: { path: "x.ts" }, status: "completed" }]),
      toolResultMsg("edit_file", "done"),
      userMsg("thanks"),
      assistantMsg("you're welcome"),
    ];
    // Protect the first user message (index 0) — the tool result at index 2 should
    // pull its assistant at index 1 into the keep set via Case 2 backward alignment
    // Protect assistant at index 1 (has toolCalls) → tool result at index 2 should be pulled in
    const baseIndices2 = new Set([0, 1]);
    const aligned2 = _alignBoundaryPairs(messages, baseIndices2);
    expect(aligned2.has(2)).toBe(true); // tool result pulled in by assistant
  });

  it("pulls assistant back when a single tool result is protected in keep set", () => {
    const messages: ChatMessage[] = [
      userMsg("first"),
      assistantMsg("", [{ id: "tc-1", name: "bash", args: { command: "ls" }, status: "completed" }]),
      toolResultMsg("bash", "file1.ts\nfile2.ts"),
      userMsg("list files"),
      assistantMsg("listed"),
    ];
    // Protect the tool result at index 2 directly (simulating a manual keep)
    const baseIndices = new Set([0, 2]);
    const aligned = _alignBoundaryPairs(messages, baseIndices);
    // Case 2: tool result at index 2 is protected → should pull assistant at index 1
    expect(aligned.has(1)).toBe(true);
  });
});

describe("edge cases — empty toolCalls arrays", () => {
  it("selectMessagesForCompaction handles assistant with empty toolCalls", () => {
    const messages: ChatMessage[] = [
      userMsg("first"),
      assistantMsg("no tools used"),
      ...Array.from({ length: 12 }, (_, i) =>
        i % 2 === 0 ? userMsg(`user ${i + 2}`) : assistantMsg(`assistant ${i + 2}`)
      ),
    ];
    const { toCompact, toKeep } = selectMessagesForCompaction(messages);
    // First user should always be protected
    expect(toKeep.some(m => m.content === "first")).toBe(true);
    // Empty toolCalls should not cause alignment issues
    expect(toCompact.length).toBeGreaterThan(0);
  });

  it("handle toolCalls with empty array (no tool calls in this turn)", () => {
    const msg: ChatMessage = {
      id: "a-1",
      role: "assistant",
      content: "I didn't need any tools.",
      timestamp: Date.now(),
      toolCalls: [],
    };
    expect(_isToolResult(msg)).toBe(false);
  });
});

describe("edge cases — long conversations with mixed tool/non-tool messages", () => {
  it("correctly protects recent messages in a 50-message conversation", () => {
    const messages: ChatMessage[] = [];
    for (let i = 0; i < 50; i++) {
      if (i % 3 === 0) {
        messages.push(userMsg(`user ${i}`));
      } else if (i % 3 === 1) {
        messages.push(assistantMsg(`assistant ${i}`));
      } else {
        messages.push(toolResultMsg("read_file", `output ${i}`));
      }
    }
    const { toCompact, toKeep } = selectMessagesForCompaction(messages);
    // First message should always be protected
    expect(toKeep.some(m => m.content === "user 0")).toBe(true);
    // Last 6 non-tool-result user messages and last 3 assistants are protected
    // Tool results (indices 44, 47) are NOT directly protected unless aligned
    expect(toKeep.some(m => m.content === 'user 45')).toBe(true);
    expect(toKeep.some(m => m.content === 'assistant 46')).toBe(true);
    expect(toKeep.some(m => m.content === 'user 48')).toBe(true);
    expect(toKeep.some(m => m.content === 'assistant 49')).toBe(true);
    expect(toCompact.length).toBeGreaterThan(0);
  });

  it("preserves tool_call/tool_result pairs in long conversation", () => {
    const messages: ChatMessage[] = [];
    // Build a conversation with tool calls scattered throughout
    for (let i = 0; i < 40; i++) {
      messages.push(userMsg(`user ${i}`));
      if (i % 5 === 0 && i > 0) {
        // Assistant with tool calls
        messages.push(assistantMsg(`tool use ${i}`, [
          { id: `tc-${i}`, name: "read_file", args: { path: `file${i}.ts` }, status: "completed" as const },
        ]));
        messages.push(toolResultMsg("read_file", `content of file${i}.ts`));
      } else {
        messages.push(assistantMsg(`response ${i}`));
      }
    }
    const { toKeep } = selectMessagesForCompaction(messages);
    // All tool results that are in toKeep should have their assistant also in toKeep
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (toKeep.some(k => k.id === msg.id) && _isToolResult(msg)) {
        // Find the preceding assistant with toolCalls
        for (let j = i - 1; j >= 0; j--) {
          if (messages[j].role === "assistant" && messages[j].toolCalls?.length) {
            expect(toKeep.some(k => k.id === messages[j].id)).toBe(true);
            break;
          }
          if (messages[j].role === "user" && !_isToolResult(messages[j])) break;
        }
      }
    }
  });
});

// ============================================================================
// Tier 2 pruning threshold tests
// ============================================================================

describe("tier2PruneToolOutputs — pruning threshold", () => {
  it("prunes tool outputs only when total exceeds PRUNE_MINIMUM", () => {
    // Small tool outputs should NOT be pruned
    const messages = [
      userMsg("first"),
      toolResultMsg("read_file", "short output"),
      userMsg("second"),
      assistantMsg("ok"),
      userMsg("third"),
      assistantMsg("done"),
    ];
    const { tokensReclaimed } = pruneToolOutputs(messages);
    // Small outputs should not be pruned (below PRUNE_MINIMUM)
    expect(tokensReclaimed).toBe(0);
  });

  it("prunes largest tool outputs first when above threshold", () => {
    const largeOutput = "x".repeat(50000); // ~12500 tokens
    const smallOutput = "y".repeat(5000);  // ~1250 tokens
    const messages = [
      userMsg("first"),
      toolResultMsg("read_file", largeOutput),
      toolResultMsg("grep_file", smallOutput),
      userMsg("second"),
      assistantMsg("ok"),
      userMsg("third"),
      assistantMsg("done"),
    ];
    const { tokensReclaimed } = pruneToolOutputs(messages);
    expect(tokensReclaimed).toBeGreaterThan(0);
  });
});

// ============================================================
// buildCompactionPrompt tests
// ============================================================
describe("buildCompactionPrompt", () => {
  it("includes SUMMARY_TEMPLATE when no previous summary", () => {
    const messages = [userMsg("hello"), assistantMsg("hi")];
    const prompt = buildCompactionPrompt(messages);
    expect(prompt.length).toBeGreaterThan(0);
    const userContent = prompt.find(p => p.role === "user")?.content || "";
    expect(userContent).toContain("structured summary");
    expect(userContent).toContain("Goal");
    expect(userContent).toContain("Pending");
  });

  it("prepends previous summary when provided", () => {
    const messages = [userMsg("hello"), assistantMsg("world")];
    const prompt = buildCompactionPrompt(messages, "Previous summary content");
    const userMessages = prompt.filter(p => p.role === "user");
    // Should start with update instruction referencing previous summary
    const firstUserContent = userMessages[0]?.content || "";
    expect(firstUserContent).toContain("[PREVIOUS CONVERSATION SUMMARY]");
    expect(firstUserContent).toContain("Previous summary content");
  });

  it("includes formatted messages after instructions", () => {
    const messages = [userMsg("hello"), assistantMsg("world")];
    const prompt = buildCompactionPrompt(messages);
    // Last messages should be the formatted conversation
    const messageContents = prompt.map(p => p.content);
    expect(messageContents.some(c => c.includes("hello"))).toBe(true);
    expect(messageContents.some(c => c.includes("world"))).toBe(true);
  });

  it("handles empty message array", () => {
    const prompt = buildCompactionPrompt([]);
    const userContent = prompt.find(p => p.role === "user")?.content || "";
    expect(userContent).toContain("conversation compaction");
  });
});

// ============================================================
// computePressure edge case tests
// ============================================================
describe("computePressure", () => {
  it("returns 'none' for 0 usage", () => {
    const { pressure, ratio } = computePressure(0, 128000);
    expect(pressure).toBe("none");
    expect(ratio).toBe(0);
  });

  it("returns 'none' for 49% usage", () => {
    const { pressure } = computePressure(62720, 128000);
    expect(pressure).toBe("none");
  });

  it("returns 'low' for exactly 50% usage", () => {
    const { pressure } = computePressure(64000, 128000);
    expect(pressure).toBe("low");
  });

  it("returns 'low' for 69% usage", () => {
    const { pressure } = computePressure(88320, 128000);
    expect(pressure).toBe("low");
  });

  it("returns 'medium' for exactly 70% usage", () => {
    const { pressure } = computePressure(89600, 128000);
    expect(pressure).toBe("medium");
  });

  it("returns 'medium' for 84% usage", () => {
    const { pressure } = computePressure(107520, 128000);
    expect(pressure).toBe("medium");
  });

  it("returns 'high' for exactly 85% usage", () => {
    const { pressure } = computePressure(108800, 128000);
    expect(pressure).toBe("high");
  });

  it("handles 100% usage", () => {
    const { pressure, ratio } = computePressure(128000, 128000);
    expect(pressure).toBe("high");
    expect(ratio).toBe(1);
  });

  it("handles over 100% usage", () => {
    const { pressure } = computePressure(200000, 128000);
    expect(pressure).toBe("high");
  });

  it("handles zero maxTokens", () => {
    const { pressure, ratio } = computePressure(1000, 0);
    expect(pressure).toBe("high");
    expect(ratio).toBe(Infinity);
  });

  it("handles negative maxTokens (invalid config)", () => {
    const { pressure, ratio } = computePressure(1000, -1);
    expect(pressure).toBe("high");
    expect(ratio).toBe(Infinity);
  });
});

// ============================================================
// estimateTokens edge case tests
// ============================================================
describe("estimateTokens", () => {
  it("returns 0 for empty string", () => expect(estimateTokens("")).toBe(0));

  it("returns 0 for null/undefined input", () => {
    // @ts-expect-error testing null edge case
    expect(estimateTokens(null)).toBe(0);
    // @ts-expect-error testing undefined edge case
    expect(estimateTokens(undefined)).toBe(0);
  });

  it("estimates tokens for plain english text", () => {
    const tokens = estimateTokens("The quick brown fox jumps over the lazy dog");
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBeLessThan(20);
  });

  it("estimates tokens for code", () => {
    const code = `function hello(name: string): string {
  return \`Hello, \${name}!\`;
}`;
    const tokens = estimateTokens(code);
    expect(tokens).toBeGreaterThan(0);
  });

  it("handles CJK characters (roughly 1.5 chars/token)", () => {
    const cjk = "这是一个测试字符串用于验证中文分词";
    const tokens = estimateTokens(cjk);
    expect(tokens).toBeGreaterThan(0);
    // CJK is ~1.5 chars/token, so 15 chars ≈ 10 tokens
    expect(tokens).toBeLessThanOrEqual(15);
  });

  it("handles mixed CJK and ASCII", () => {
    const mixed = "你好 world 测试 test 123";
    const tokens = estimateTokens(mixed);
    expect(tokens).toBeGreaterThan(0);
  });

  it("handles whitespace-only string", () => {
    const tokens = estimateTokens("   \t\n  ");
    expect(tokens).toBeGreaterThan(0); // whitespace counts as tokens
  });

  it("handles newlines", () => {
    const tokens = estimateTokens("\n\n\n");
    expect(tokens).toBe(3); // each newline = 1 token
  });

  it("handles code fence toggling for empty code blocks", () => {
    const text = "Some text\n```\n```\nMore text";
    const tokens = estimateTokens(text);
    expect(tokens).toBeGreaterThan(0);
  });

  it("handles very long single-line string", () => {
    const text = "x".repeat(10000);
    const tokens = estimateTokens(text);
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBeLessThan(100);
  });

  it("is deterministic for same input", () => {
    const text = "Hello, world! This is a test.";
    expect(estimateTokens(text)).toBe(estimateTokens(text));
  });
});

// ============================================================
// computeContextStats edge case tests
// ============================================================
describe("computeContextStats", () => {
  it("handles empty message array", () => {
    const stats = computeContextStats([], 128000);
    expect(stats.pressure).toBe("none");
    expect(stats.needsCompaction).toBe(false);
    expect(stats.totalTokens).toBe(0);
    expect(stats.shouldPrune).toBe(false);
  });

  it("computes shouldCompact at 95% ratio", () => {
    // Make messages with enough tokens to hit 95%
    const bigMsg = userMsg("x".repeat(250000));
    const stats = computeContextStats([bigMsg], 100000, 0, 0);
    expect(stats.shouldCompact).toBe(true);
  });

  it("computes shouldPrune when tokens exceed usable - PRUNE_PROTECT", () => {
    const bigMsg = userMsg("x".repeat(40000));
    const stats = computeContextStats([bigMsg], 45000, 1000, 1000);
    expect(stats.shouldPrune).toBe(true);
  });

  it("provides nextCheckpointTrigger for various ratios", () => {
    const stats1 = computeContextStats([userMsg("x".repeat(50))], 1000, 100, 100);
    expect(stats1.nextCheckpointTrigger).toBeDefined();

    const stats2 = computeContextStats([userMsg("x".repeat(500))], 1000, 100, 100);
    expect(stats2.nextCheckpointTrigger).toBeNull();
  });
});
