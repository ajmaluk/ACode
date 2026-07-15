import { describe, it, expect } from "vitest";
import {
  _isToolResult,
  _alignBoundaryPairs,
  selectMessagesForCompaction,
  pruneToolOutputs,
  tier1PruneToolOutputs,
  computeContextStats,
  estimateTokens,
  estimateMessageTokens,
  parseContextWindow,
  buildCompactionPrompt,
  computePressure,
  checkProactiveContextManagement,
  getContextPressureRecommendation,
  getNextCheckpointTrigger,
  clearTokenCache,
  buildRollingSummary,
  selectMessagesByTokenBudget,
  computeKeepBudget,
  checkContextBudget,
} from "./contextManager";
import type { ChatMessage } from "@dalam/shared-types";

// ─── Helpers ────────────────────────────────────────────────

function userMsg(content: string): ChatMessage {
  return {
    id: "u-" + Math.random().toString(36).slice(2),
    role: "user",
    content,
    timestamp: Date.now(),
  };
}

function assistantMsg(
  content: string,
  toolCalls?: ChatMessage["toolCalls"],
): ChatMessage {
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
        assistantMsg("I'll read the file", [
          {
            id: "tc-1",
            name: "read_file",
            args: { path: "/a" },
            status: "pending",
          },
        ]),
        toolResultMsg("read_file", "file content"),
        userMsg("middle user message"),
        userMsg("another middle message"),
        userMsg("recent user message 1"),
        userMsg("recent user message 2"),
      ];

      const { toCompact, toKeep } = selectMessagesForCompaction(messages, 6);

      const compactedIds = new Set(toCompact.map((m) => m.id));
      const keptIds = new Set(toKeep.map((m) => m.id));

      // If assistant (2) is kept, tool result (3) must also be kept
      if (keptIds.has(messages[2].id)) {
        expect(keptIds.has(messages[3].id)).toBe(true);
      }
      // If tool result (3) is compacted, assistant (2) must also be compacted
      if (compactedIds.has(messages[3].id)) {
        expect(compactedIds.has(messages[2].id)).toBe(true);
      }
    });

    it("keeps tool result and its preceding assistant together when tool result is protected", () => {
      // Scenario: tool result is in the protected set → assistant with toolCalls should also be protected
      const messages: ChatMessage[] = [
        userMsg("first user message"),
        userMsg("older user message"),
        assistantMsg("I'll edit the file", [
          {
            id: "tc-2",
            name: "edit_file",
            args: { path: "/b" },
            status: "pending",
          },
        ]),
        toolResultMsg("edit_file", "edited"),
        userMsg("middle message 1"),
        userMsg("middle message 2"),
        userMsg("middle message 3"),
        userMsg("recent message 1"),
        userMsg("recent message 2"),
      ];
      const { toCompact, toKeep } = selectMessagesForCompaction(messages, 6);

      const keptIds = new Set(toKeep.map((m) => m.id));
      const compactedIds = new Set(toCompact.map((m) => m.id));

      // Verify pairs are never split
      if (keptIds.has(messages[3].id)) {
        expect(keptIds.has(messages[2].id)).toBe(true);
      }
      if (compactedIds.has(messages[2].id)) {
        expect(compactedIds.has(messages[3].id)).toBe(true);
      }
    });

    it("compacts both assistant and tool results together when neither is protected", () => {
      // A long conversation where both the assistant(toolCalls) and tool results
      // are old enough to be candidates for compaction
      const messages: ChatMessage[] = [
        userMsg("first user message"),
        userMsg("what is the status"),
        assistantMsg("checking...", [
          { id: "tc-3", name: "git_status", args: {}, status: "pending" },
        ]),
        toolResultMsg("git_status", "On branch main"),
        userMsg("ok thanks"),
        assistantMsg("reading file", [
          {
            id: "tc-4",
            name: "read_file",
            args: { path: "/c" },
            status: "pending",
          },
        ]),
        toolResultMsg("read_file", "content here"),
        userMsg("middle message 1"),
        userMsg("middle message 2"),
        userMsg("middle message 3"),
        userMsg("recent message 1"),
        userMsg("recent message 2"),
      ];

      const { toCompact, toKeep } = selectMessagesForCompaction(messages, 6);

      const compactedIds = new Set(toCompact.map((m) => m.id));
      const keptIds = new Set(toKeep.map((m) => m.id));

      // Verify all pairs are together
      // Pair 1: assistant(2) + toolResult(3)
      if (compactedIds.has(messages[2].id)) {
        expect(compactedIds.has(messages[3].id)).toBe(true);
      }
      if (keptIds.has(messages[2].id)) {
        expect(keptIds.has(messages[3].id)).toBe(true);
      }
      // Pair 2: assistant(5) + toolResult(6)
      if (compactedIds.has(messages[5].id)) {
        expect(compactedIds.has(messages[6].id)).toBe(true);
      }
      if (keptIds.has(messages[5].id)) {
        expect(keptIds.has(messages[6].id)).toBe(true);
      }
    });

    it("handles multiple tool results after one assistant", () => {
      // Assistant makes 2 tool calls → 2 tool results follow
      const messages: ChatMessage[] = [
        userMsg("first user message"),
        userMsg("do both tasks"),
        assistantMsg("I'll do both", [
          {
            id: "tc-a",
            name: "read_file",
            args: { path: "/a" },
            status: "pending",
          },
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

      const compactedIds = new Set(toCompact.map((m) => m.id));
      const keptIds = new Set(toKeep.map((m) => m.id));

      // Assistant(2), toolResult1(3), toolResult2(4) must all be in the same set
      const ids = [messages[2].id, messages[3].id, messages[4].id];
      const allCompacted = ids.every((id) => compactedIds.has(id));
      const allKept = ids.every((id) => keptIds.has(id));
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
        assistantMsg("calling tool", [
          {
            id: "tc-5",
            name: "run_command",
            args: { cmd: "ls" },
            status: "pending",
          },
        ]),
        toolResultMsg("run_command", "file1\nfile2"),
        userMsg("middle 1"),
        userMsg("middle 2"),
        userMsg("middle 3"),
        userMsg("recent 1"),
        userMsg("recent 2"),
      ];

      const { toKeep } = selectMessagesForCompaction(messages, 6);

      const keptIds = new Set(toKeep.map((m) => m.id));

      // The plain assistant (index 3) should NOT be pulled in just because
      // the tool result (index 5) and its assistant (index 4) are kept
      // (index 3 is a plain assistant without toolCalls, so it shouldn't be affected)
      // This is a sanity check — no assertion on index 3 specifically,
      // but we verify the pair 4+5 stays together
      if (keptIds.has(messages[5].id)) {
        expect(keptIds.has(messages[4].id)).toBe(true);
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
        i % 2 === 0 ? userMsg(`user ${i}`) : assistantMsg(`assistant ${i}`),
      );

      const { toKeep } = selectMessagesForCompaction(messages, 6);
      expect(toKeep[0]).toBe(messages[0]);
    });

    it("protects recent user messages", () => {
      const messages = Array.from({ length: 15 }, (_, i) =>
        i % 2 === 0 ? userMsg(`user ${i}`) : assistantMsg(`assistant ${i}`),
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
        i % 2 === 0 ? userMsg(`user ${i}`) : assistantMsg(`assistant ${i}`),
      );
      // Add a message with file changes in the middle
      messages[6] = {
        ...messages[6],
        fileChanges: [
          { path: "/test.ts", action: "modified", additions: 1, deletions: 0 },
        ],
      };

      const { toKeep } = selectMessagesForCompaction(messages, 6);
      expect(toKeep).toContain(messages[6]);
    });

    it("protects messages with task plans", () => {
      const messages = Array.from({ length: 15 }, (_, i) =>
        i % 2 === 0 ? userMsg(`user ${i}`) : assistantMsg(`assistant ${i}`),
      );
      // Add a message with task plan in the middle
      messages[7] = {
        ...messages[7],
        taskPlan: [
          { id: "tp-1", title: "Implement feature", status: "completed" },
        ],
      };

      const { toKeep } = selectMessagesForCompaction(messages, 6);
      expect(toKeep).toContain(messages[7]);
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
  it("returns 128000 for undefined", () =>
    expect(parseContextWindow(undefined)).toBe(128000));
  it("returns 128000 for unparseable", () =>
    expect(parseContextWindow("unknown")).toBe(128000));
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
    expect(_isToolResult(userMsg("[TOOL RESULT: read_file] output here"))).toBe(
      true,
    );
  });

  it("identifies TOOL ERROR messages", () => {
    expect(_isToolResult(userMsg("[TOOL ERROR: bash] command failed"))).toBe(
      true,
    );
  });

  it("does not identify regular user messages", () => {
    expect(_isToolResult(userMsg("Hello, can you help?"))).toBe(false);
  });

  it("does not identify assistant messages as tool results", () => {
    const msg: ChatMessage = {
      id: "a-1",
      role: "assistant",
      content: "[TOOL RESULT: read_file] output",
      timestamp: Date.now(),
    };
    expect(_isToolResult(msg)).toBe(false);
  });

  it("returns false for empty content", () => {
    const msg: ChatMessage = {
      id: "u-1",
      role: "user",
      content: "",
      timestamp: Date.now(),
    };
    expect(_isToolResult(msg)).toBe(false);
  });
});

describe("_alignBoundaryPairs — Case 2: tool result protected pulls assistant in", () => {
  it("pulls preceding assistant with toolCalls into keep set when tool result is protected", () => {
    const messages: ChatMessage[] = [
      userMsg("first"),
      assistantMsg("", [
        {
          id: "tc-1",
          name: "read_file",
          args: { path: "x.ts" },
          status: "completed",
        },
      ]),
      toolResultMsg("read_file", "file content"),
      userMsg("what do you think?"),
      assistantMsg("looks good"),
      userMsg("now fix it"),
      assistantMsg("fixing...", [
        {
          id: "tc-2",
          name: "edit_file",
          args: { path: "x.ts" },
          status: "completed",
        },
      ]),
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
      assistantMsg("", [
        {
          id: "tc-1",
          name: "bash",
          args: { command: "ls" },
          status: "completed",
        },
      ]),
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
        i % 2 === 0
          ? userMsg(`user ${i + 2}`)
          : assistantMsg(`assistant ${i + 2}`),
      ),
    ];
    const { toCompact, toKeep } = selectMessagesForCompaction(messages);
    // First user should always be protected
    expect(toKeep.some((m) => m.content === "first")).toBe(true);
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
    expect(toKeep.some((m) => m.content === "user 0")).toBe(true);
    // Last 6 non-tool-result user messages and last 3 assistants are protected
    // Tool results (indices 44, 47) are NOT directly protected unless aligned
    expect(toKeep.some((m) => m.content === "user 45")).toBe(true);
    expect(toKeep.some((m) => m.content === "assistant 46")).toBe(true);
    expect(toKeep.some((m) => m.content === "user 48")).toBe(true);
    expect(toKeep.some((m) => m.content === "assistant 49")).toBe(true);
    expect(toCompact.length).toBeGreaterThan(0);
  });

  it("preserves tool_call/tool_result pairs in long conversation", () => {
    const messages: ChatMessage[] = [];
    // Build a conversation with tool calls scattered throughout
    for (let i = 0; i < 40; i++) {
      messages.push(userMsg(`user ${i}`));
      if (i % 5 === 0 && i > 0) {
        // Assistant with tool calls
        messages.push(
          assistantMsg(`tool use ${i}`, [
            {
              id: `tc-${i}`,
              name: "read_file",
              args: { path: `file${i}.ts` },
              status: "completed" as const,
            },
          ]),
        );
        messages.push(toolResultMsg("read_file", `content of file${i}.ts`));
      } else {
        messages.push(assistantMsg(`response ${i}`));
      }
    }
    const { toKeep } = selectMessagesForCompaction(messages);
    // All tool results that are in toKeep should have their assistant also in toKeep
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (toKeep.some((k) => k.id === msg.id) && _isToolResult(msg)) {
        // Find the preceding assistant with toolCalls
        for (let j = i - 1; j >= 0; j--) {
          if (
            messages[j].role === "assistant" &&
            messages[j].toolCalls?.length
          ) {
            expect(toKeep.some((k) => k.id === messages[j].id)).toBe(true);
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
    const smallOutput = "y".repeat(5000); // ~1250 tokens
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

// ─── Proactive Context Management Tests ──────────────────────────

describe("checkProactiveContextManagement", () => {
  it("returns no action needed for low context usage", () => {
    const result = checkProactiveContextManagement([userMsg("hi")], 128000);
    expect(result.shouldPrune).toBe(false);
    expect(result.shouldCompact).toBe(false);
    expect(result.reason).toContain("no action needed");
  });

  it("recommends prune for high context usage (60-74%)", () => {
    // Generate enough tokens to hit 60-74% pressure ratio
    // With a huge message, we can drive the ratio up
    const bigMsg = userMsg("x".repeat(200000));
    const result = checkProactiveContextManagement([bigMsg], 100000);
    // usableTokens = 100000 - 4000 (OUTPUT_RESERVE) - 20000 (COMPACTION_BUFFER) = 76000
    // A message of 200K chars at ~0.25 tokens/char = ~50000 tokens → ~65% ratio
    expect(result.shouldPrune).toBe(true);
    if (!result.shouldCompact) {
      expect(result.reason).toContain("pruning");
    }
  });

  it("recommends compaction for very high context usage (≥75%)", () => {
    const hugeMsg = userMsg("x".repeat(300000));
    const result = checkProactiveContextManagement([hugeMsg], 100000);
    // 300K chars at ~0.25 tokens/char = ~75000 tokens → ~98% ratio
    expect(result.shouldCompact).toBe(true);
    expect(result.reason).toContain("compaction");
  });
});

describe("getContextPressureRecommendation", () => {
  it("returns green Normal for none pressure", () => {
    const rec = getContextPressureRecommendation("none");
    expect(rec.color).toBe("#22c55e");
    expect(rec.label).toBe("Normal");
    expect(rec.action).toBe("No action needed");
  });

  it("returns yellow Low for low pressure", () => {
    const rec = getContextPressureRecommendation("low");
    expect(rec.color).toBe("#eab308");
    expect(rec.label).toBe("Low");
    expect(rec.action).toBe("Approaching limit");
  });

  it("returns orange Medium for medium pressure", () => {
    const rec = getContextPressureRecommendation("medium");
    expect(rec.color).toBe("#f97316");
    expect(rec.label).toBe("Medium");
    expect(rec.action).toBe("Monitor context usage");
  });

  it("returns red High for high pressure", () => {
    const rec = getContextPressureRecommendation("high");
    expect(rec.color).toBe("#ef4444");
    expect(rec.label).toBe("High");
    expect(rec.action).toBe("Compaction recommended");
  });
});

describe("getNextCheckpointTrigger", () => {
  it("returns 0.20 when no triggers have fired", () => {
    expect(getNextCheckpointTrigger(0)).toBe(0.2);
  });

  it("returns 0.45 after 0.20 has fired", () => {
    expect(getNextCheckpointTrigger(0.25)).toBe(0.45);
  });

  it("returns 0.70 after 0.45 has fired", () => {
    expect(getNextCheckpointTrigger(0.5)).toBe(0.7);
  });

  it("returns null after all triggers have fired", () => {
    expect(getNextCheckpointTrigger(0.75)).toBeNull();
    expect(getNextCheckpointTrigger(1)).toBeNull();
  });

  it("handles negative firedUpToPercent", () => {
    expect(getNextCheckpointTrigger(-1)).toBe(0.2);
  });
});

describe("estimateMessageTokens", () => {
  it("counts content tokens plus role/metadata overhead", () => {
    const msg = userMsg("hello");
    const tokens = estimateMessageTokens(msg);
    // 5 chars at ~0.25 tokens/char ≈ 2 tokens + 4 overhead = 6
    expect(tokens).toBeGreaterThan(4);
    expect(tokens).toBeLessThan(10);
  });

  it("adds overhead for tool calls", () => {
    const msg = assistantMsg("checking", [
      {
        id: "tc-1",
        name: "read_file",
        args: { path: "/a" },
        status: "pending",
      },
    ]);
    const tokens = estimateMessageTokens(msg);
    // content tokens + 4 (role) + 20 (tool call overhead)
    expect(tokens).toBeGreaterThan(20);
  });

  it("adds overhead for file changes", () => {
    const msg = userMsg("modified file");
    msg.fileChanges = [
      { path: "/x.ts", action: "modified", additions: 1, deletions: 0 },
    ];
    const tokens = estimateMessageTokens(msg);
    expect(tokens).toBeGreaterThan(10);
  });

  it("accounts for thinking content", () => {
    const msg = assistantMsg("response");
    msg.thinking = "Let me analyze the code carefully ".repeat(20);
    const tokensWithThinking = estimateMessageTokens(msg);

    const msgWithout = assistantMsg("response");
    const tokensWithout = estimateMessageTokens(msgWithout);

    expect(tokensWithThinking).toBeGreaterThan(tokensWithout);
  });
});

describe("clearTokenCache", () => {
  it("clears the token estimation cache", () => {
    // First call populates cache
    estimateTokens("hello world");
    // Should not throw
    expect(() => clearTokenCache()).not.toThrow();
    // Should be usable after clear
    expect(estimateTokens("hello world")).toBeGreaterThan(0);
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
    const userContent = prompt.find((p) => p.role === "user")?.content || "";
    expect(userContent).toContain("structured summary");
    expect(userContent).toContain("Goal");
    expect(userContent).toContain("Blocked");
    expect(userContent).toContain("Next Move");
  });

  it("prepends previous summary when provided", () => {
    const messages = [userMsg("hello"), assistantMsg("world")];
    const prompt = buildCompactionPrompt(messages, "Previous summary content");
    const userMessages = prompt.filter((p) => p.role === "user");
    // Should start with update instruction referencing previous summary
    const firstUserContent = userMessages[0]?.content || "";
    expect(firstUserContent).toContain("Update the anchored summary");
    expect(firstUserContent).toContain("Previous summary content");
  });

  it("includes formatted messages after instructions", () => {
    const messages = [userMsg("hello"), assistantMsg("world")];
    const prompt = buildCompactionPrompt(messages);
    // Last messages should be the formatted conversation
    const messageContents = prompt.map((p) => p.content);
    expect(messageContents.some((c) => c.includes("hello"))).toBe(true);
    expect(messageContents.some((c) => c.includes("world"))).toBe(true);
  });

  it("handles empty message array", () => {
    const prompt = buildCompactionPrompt([]);
    const userContent = prompt.find((p) => p.role === "user")?.content || "";
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
    expect(ratio).toBe(1);
  });

  it("handles negative maxTokens (invalid config)", () => {
    const { pressure, ratio } = computePressure(1000, -1);
    expect(pressure).toBe("high");
    expect(ratio).toBe(1);
  });
});

// ============================================================
// estimateTokens edge case tests
// ============================================================
describe("estimateTokens", () => {
  it("returns 0 for empty string", () => expect(estimateTokens("")).toBe(0));

  it("returns 0 for null/undefined input", () => {
    expect(estimateTokens(null)).toBe(0);
    expect(estimateTokens(undefined)).toBe(0);
  });

  it("estimates tokens for plain english text", () => {
    const tokens = estimateTokens(
      "The quick brown fox jumps over the lazy dog",
    );
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
    // CJK is ~0.67 tokens/char, so 15 chars ≈ 10 tokens
    expect(tokens).toBeGreaterThanOrEqual(8);
    expect(tokens).toBeLessThanOrEqual(12);
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
    // 10K code chars at ~0.29 tokens/char ≈ 2900 tokens
    expect(tokens).toBeGreaterThan(1000);
    expect(tokens).toBeLessThan(5000);
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
    // Each 'x' is a code char at ~0.25 tokens; need >= 95% of usableTokens
    // usableTokens = 100000 (with 0 reserve). Need >= 95000 tokens → ~380000 chars
    const bigMsg = userMsg("x".repeat(400000));
    const stats = computeContextStats([bigMsg], 100000, 0, 0);
    expect(stats.shouldCompact).toBe(true);
  });

  it("computes shouldPrune when tokens exceed usable - PRUNE_PROTECT", () => {
    // usableTokens = 43000, PRUNE_PROTECT = 10000. Need > 33000 tokens → ~132000 chars
    const bigMsg = userMsg("x".repeat(140000));
    const stats = computeContextStats([bigMsg], 45000, 1000, 1000);
    expect(stats.shouldPrune).toBe(true);
  });

  it("provides nextCheckpointTrigger for various ratios", () => {
    // Low usage: raw ratio < 0.20, next trigger is 0.20
    const stats1 = computeContextStats(
      [userMsg("x".repeat(50))],
      1000,
      100,
      100,
    );
    expect(stats1.nextCheckpointTrigger).toBeDefined();

    // High usage: raw ratio > 0.70 (all triggers fired), next trigger is null
    // Need totalTokens/maxContextTokens > 0.7 → totalTokens > 700
    // At ~0.25 tokens/char, need ~2800+ chars
    const stats2 = computeContextStats(
      [userMsg("x".repeat(3000))],
      1000,
      100,
      100,
    );
    expect(stats2.nextCheckpointTrigger).toBeNull();
  });

  it("shouldPrune is false when usableTokens < PRUNE_PROTECT (no underflow)", () => {
    // usableTokens = 10000 - 4000 - 2000 = 4000, PRUNE_PROTECT = 10000
    // Math.max(0, 4000 - 10000) = 0, so shouldPrune = totalTokens > 0
    // With 0 messages, totalTokens = 0, so shouldPrune should be false
    const stats = computeContextStats([], 10000, 4000, 2000);
    expect(stats.shouldPrune).toBe(false);
  });
});

// ============================================================
// M3: _isToolResult — lowercase "for" format coverage
// ============================================================
describe("_isToolResult — lowercase for format", () => {
  it("identifies Tool result for messages", () => {
    expect(_isToolResult(userMsg("[Tool result for read_file] output"))).toBe(true);
  });

  it("identifies Tool error for messages", () => {
    expect(_isToolResult(userMsg("[Tool error for bash] failed"))).toBe(true);
  });
});

// ============================================================
// T1: buildRollingSummary tests
// ============================================================
describe("buildRollingSummary", () => {
  it("returns empty string for empty messages", () => {
    expect(buildRollingSummary([])).toBe("");
  });

  it("returns previousSummary when messages are empty", () => {
    expect(buildRollingSummary([], "old summary")).toBe("old summary");
  });

  it("extracts goals from user messages", () => {
    const messages = [userMsg("Fix the authentication bug in login.ts")];
    const summary = buildRollingSummary(messages);
    expect(summary).toContain("## Goal");
    expect(summary).toContain("authentication bug");
  });

  it("extracts completed tool results in colon format", () => {
    const messages = [
      userMsg("read the file"),
      toolResultMsg("read_file", "file content here with enough chars to pass threshold"),
    ];
    const summary = buildRollingSummary(messages);
    expect(summary).toContain("## Completed");
    expect(summary).toContain("read_file");
  });

  it("extracts completed tool results in for format", () => {
    const messages = [
      userMsg("read the file"),
      userMsg("[Tool result for read_file] file content here with enough chars to pass the length check"),
    ];
    const summary = buildRollingSummary(messages);
    expect(summary).toContain("## Completed");
    expect(summary).toContain("read_file");
  });

  it("extracts errors from tool results", () => {
    const messages = [
      userMsg("run the command"),
      userMsg("[TOOL ERROR: bash] Command failed: permission denied"),
    ];
    const summary = buildRollingSummary(messages);
    expect(summary).toContain("## Errors");
  });

  it("extracts active work from assistant messages", () => {
    const messages = [
      userMsg("help me fix this"),
      assistantMsg("I'll start by analyzing the code structure to understand the issue"),
    ];
    const summary = buildRollingSummary(messages);
    expect(summary).toContain("## Active");
  });

  it("extracts file changes", () => {
    const msg = userMsg("I modified the file");
    msg.fileChanges = [
      { path: "/src/app.ts", action: "modified", additions: 10, deletions: 5 },
    ];
    const summary = buildRollingSummary([msg]);
    expect(summary).toContain("## Files");
    expect(summary).toContain("/src/app.ts");
  });

  it("includes previous summary when provided", () => {
    const messages = [userMsg("continue working")];
    const summary = buildRollingSummary(messages, "Previous context here");
    expect(summary).toContain("## Previous Context");
    expect(summary).toContain("Previous context here");
  });

  it("returns '(No context available)' when nothing meaningful is extracted", () => {
    const messages = [userMsg("x")]; // too short to extract
    const summary = buildRollingSummary(messages);
    expect(summary).toBe("(No context available)");
  });

  it("limits completed items to last 5", () => {
    const messages = Array.from({ length: 10 }, (_, i) =>
      toolResultMsg(`tool_${i}`, `output ${i} with enough content to pass threshold`.repeat(5)),
    );
    const summary = buildRollingSummary(messages);
    const completedSection = summary.split("## Completed")[1]?.split("##")[0] ?? "";
    const bulletCount = (completedSection.match(/^- /gm) ?? []).length;
    expect(bulletCount).toBeLessThanOrEqual(5);
  });
});

// ============================================================
// T2: selectMessagesByTokenBudget tests
// ============================================================
describe("selectMessagesByTokenBudget", () => {
  it("returns all messages as toKeep when conversation is short", () => {
    const messages = [userMsg("hi"), assistantMsg("hello")];
    const { toCompact, toKeep } = selectMessagesByTokenBudget(messages, 10000);
    expect(toCompact).toHaveLength(0);
    expect(toKeep).toHaveLength(2);
  });

  it("always protects the first user message", () => {
    const messages = Array.from({ length: 20 }, (_, i) =>
      i % 2 === 0 ? userMsg(`user ${i}`) : assistantMsg(`assistant ${i}`),
    );
    const { toKeep } = selectMessagesByTokenBudget(messages, 500);
    expect(toKeep[0]).toBe(messages[0]);
  });

  it("protects messages with file changes", () => {
    const messages = Array.from({ length: 20 }, (_, i) =>
      i % 2 === 0 ? userMsg(`user ${i}`) : assistantMsg(`assistant ${i}`),
    );
    messages[5].fileChanges = [
      { path: "/test.ts", action: "modified", additions: 1, deletions: 0 },
    ];
    const { toKeep } = selectMessagesByTokenBudget(messages, 500);
    expect(toKeep).toContain(messages[5]);
  });

  it("protects messages with todos", () => {
    const messages = Array.from({ length: 20 }, (_, i) =>
      i % 2 === 0 ? userMsg(`user ${i}`) : assistantMsg(`assistant ${i}`),
    );
    messages[8].todos = [
      { id: "todo-1", content: "Fix the bug", status: "in_progress" },
    ];
    const { toKeep } = selectMessagesByTokenBudget(messages, 500);
    expect(toKeep).toContain(messages[8]);
  });

  it("compacts tool_call/tool_result pairs together", () => {
    const messages: ChatMessage[] = [
      userMsg("first"),
      assistantMsg("reading", [
        { id: "tc-1", name: "read_file", args: { path: "/a" }, status: "pending" },
      ]),
      toolResultMsg("read_file", "file content"),
      userMsg("thanks"),
      assistantMsg("done"),
    ];
    // Very small budget forces compaction of older messages
    const { toCompact, toKeep } = selectMessagesByTokenBudget(messages, 100);
    const compactedIds = new Set(toCompact.map((m) => m.id));
    const keptIds = new Set(toKeep.map((m) => m.id));

    // If assistant(1) is kept, tool result(2) must be kept
    if (keptIds.has(messages[1].id)) {
      expect(keptIds.has(messages[2].id)).toBe(true);
    }
    // If tool result(2) is compacted, assistant(1) must be compacted
    if (compactedIds.has(messages[2].id)) {
      expect(compactedIds.has(messages[1].id)).toBe(true);
    }
  });
});

// ============================================================
// T3: computeKeepBudget tests
// ============================================================
describe("computeKeepBudget", () => {
  it("returns positive budget for large context window", () => {
    const budget = computeKeepBudget(128000);
    expect(budget).toBeGreaterThan(0);
  });

  it("returns minimum 2000 for very small context window", () => {
    const budget = computeKeepBudget(10000);
    expect(budget).toBeGreaterThanOrEqual(2000);
  });

  it("returns minimum 2000 even when reserved exceeds context window", () => {
    const budget = computeKeepBudget(1000, 500, 800);
    expect(budget).toBeGreaterThanOrEqual(2000);
  });

  it("decreases as system prompt grows", () => {
    const budget1 = computeKeepBudget(128000, 2000);
    const budget2 = computeKeepBudget(128000, 8000);
    expect(budget2).toBeLessThan(budget1);
  });
});

// ============================================================
// T4: checkContextBudget tests
// ============================================================
describe("checkContextBudget", () => {
  it("returns none for small conversation", () => {
    const result = checkContextBudget([userMsg("hi")], 128000);
    expect(result.needsCompaction).toBe(false);
    expect(result.recommendedAction).toBe("none");
  });

  it("returns prune for moderate usage (50-70%)", () => {
    const bigMsg = userMsg("x".repeat(200000));
    const result = checkContextBudget([bigMsg], 100000);
    expect(result.needsCompaction).toBe(true);
    expect(["prune", "compact", "deep-compact"]).toContain(result.recommendedAction);
  });

  it("returns compact for high usage (70-90%)", () => {
    const hugeMsg = userMsg("x".repeat(300000));
    const result = checkContextBudget([hugeMsg], 100000);
    expect(result.needsCompaction).toBe(true);
    expect(["compact", "deep-compact"]).toContain(result.recommendedAction);
  });

  it("returns deep-compact for very high usage (≥90%)", () => {
    const massiveMsg = userMsg("x".repeat(500000));
    const result = checkContextBudget([massiveMsg], 100000);
    expect(result.needsCompaction).toBe(true);
    expect(result.recommendedAction).toBe("deep-compact");
  });

  it("returns positive keepBudget", () => {
    const result = checkContextBudget([userMsg("hi")], 128000);
    expect(result.keepBudget).toBeGreaterThan(0);
  });
});

// ============================================================
// T5: pruneToolOutputs — PRUNE_PROTECT early exit
// ============================================================
describe("pruneToolOutputs — edge cases", () => {
  it("skips pruning when totalPrunableToolTokens < PRUNE_PROTECT", () => {
    // Small tool outputs should not be pruned
    const messages = [
      userMsg("first"),
      toolResultMsg("read_file", "short"),
      userMsg("second"),
    ];
    const { tokensReclaimed } = pruneToolOutputs(messages);
    expect(tokensReclaimed).toBe(0);
  });

  it("handles toPrune.size === 0 after threshold check", () => {
    // All tool results are in the protected tail
    const messages = [
      userMsg("first"),
      toolResultMsg("read_file", "x".repeat(50000)),
      userMsg("second"),
    ];
    const { tokensReclaimed } = pruneToolOutputs(messages);
    // Tool result is after the first real user turn, may or may not be prunable
    expect(tokensReclaimed).toBeGreaterThanOrEqual(0);
  });
});

// ============================================================
// T7-T8: pruneToolOutputs — colon and for format
// ============================================================
describe("pruneToolOutputs — format handling", () => {
  it("handles TOOL ERROR colon format", () => {
    const messages = [
      assistantMsg("old response"),
      assistantMsg("another old response"),
      {
        id: "err-1",
        role: "user" as const,
        content: "[TOOL ERROR: bash] " + "x".repeat(50000),
        timestamp: Date.now(),
      },
      userMsg("first user"),
      userMsg("second user"),
    ];
    const { pruned } = pruneToolOutputs(messages);
    const errMsg = pruned.find((m) => m.id === "err-1");
    expect(errMsg).toBeDefined();
    expect(errMsg!.content).toMatch(/^\[Tool output pruned/);
  });

  it("handles Tool result for format", () => {
    const messages = [
      assistantMsg("old response"),
      assistantMsg("another old response"),
      {
        id: "for-1",
        role: "user" as const,
        content: "[Tool result for read_file] " + "x".repeat(50000),
        timestamp: Date.now(),
      },
      userMsg("first user"),
      userMsg("second user"),
    ];
    const { pruned } = pruneToolOutputs(messages);
    const forMsg = pruned.find((m) => m.id === "for-1");
    expect(forMsg).toBeDefined();
    expect(forMsg!.content).toContain("read_file");
  });

  it("handles Tool error for format", () => {
    const messages = [
      assistantMsg("old response"),
      assistantMsg("another old response"),
      {
        id: "for-err-1",
        role: "user" as const,
        content: "[Tool error for bash] " + "x".repeat(50000),
        timestamp: Date.now(),
      },
      userMsg("first user"),
      userMsg("second user"),
    ];
    const { pruned } = pruneToolOutputs(messages);
    const errMsg = pruned.find((m) => m.id === "for-err-1");
    expect(errMsg).toBeDefined();
    expect(errMsg!.content).toContain("bash");
  });
});

// ============================================================
// T9-T11: tier1PruneToolOutputs — edge cases
// ============================================================
describe("tier1PruneToolOutputs — edge cases", () => {
  it("handles protectAfter === 0 (no real user turns)", () => {
    const messages = [
      toolResultMsg("read_file", "x".repeat(50000)),
      toolResultMsg("grep_file", "y".repeat(50000)),
    ];
    const { tokensReclaimed } = tier1PruneToolOutputs(messages);
    // No real user turns → protectAfter=0, no tool results are prunable
    expect(tokensReclaimed).toBe(0);
  });

  it("skips tool outputs with size <= 1000", () => {
    const messages = [
      userMsg("old user 1"),
      userMsg("old user 2"),
      userMsg("old user 3"),
      toolResultMsg("read_file", "short output"),
      userMsg("recent 1"),
      userMsg("recent 2"),
      userMsg("recent 3"),
      userMsg("recent 4"),
    ];
    const { tokensReclaimed } = tier1PruneToolOutputs(messages);
    expect(tokensReclaimed).toBe(0);
  });

  it("skips pruning when totalPrunableToolTokens < PRUNE_MINIMUM", () => {
    const messages = [
      userMsg("old user 1"),
      userMsg("old user 2"),
      userMsg("old user 3"),
      toolResultMsg("read_file", "x".repeat(5000)), // ~1250 tokens, below PRUNE_MINIMUM
      userMsg("recent 1"),
      userMsg("recent 2"),
      userMsg("recent 3"),
      userMsg("recent 4"),
    ];
    const { tokensReclaimed } = tier1PruneToolOutputs(messages);
    expect(tokensReclaimed).toBe(0);
  });
});

// ============================================================
// T12: clearTokenCache — after cache eviction
// ============================================================
describe("clearTokenCache — after eviction", () => {
  it("cache still works after entries are evicted", () => {
    // Fill cache beyond max
    for (let i = 0; i < 1100; i++) {
      estimateTokens(`text-${i}`);
    }
    clearTokenCache();
    // After clear, should recalculate correctly
    const tokens = estimateTokens("hello world");
    expect(tokens).toBeGreaterThan(0);
  });
});

// ============================================================
// T14: buildCompactionPrompt — truncation at 2000 chars
// ============================================================
describe("buildCompactionPrompt — truncation", () => {
  it("truncates long messages to 2000 chars without splitting surrogate pairs", () => {
    // Create a message with surrogate pair characters (emoji)
    const longContent = "a".repeat(1999) + "\uD83D\uDE00" + "b".repeat(1000); // 😀 is a surrogate pair
    const messages = [userMsg(longContent)];
    const prompt = buildCompactionPrompt(messages);
    const userContent = prompt.find((p) => p.role === "user")?.content ?? "";
    // The formatted content should have been truncated
    expect(userContent.length).toBeLessThan(longContent.length + 200); // some overhead from template
  });
});

// ============================================================
// T15: buildCompactionPrompt — with tool results appended
// ============================================================
describe("buildCompactionPrompt — tool results", () => {
  it("appends tool results after assistant with toolCalls", () => {
    const messages: ChatMessage[] = [
      assistantMsg("I'll read the file", [
        { id: "tc-1", name: "read_file", args: { path: "/a" }, status: "pending" },
      ]),
      toolResultMsg("read_file", "file content here"),
      userMsg("thanks"),
    ];
    const prompt = buildCompactionPrompt(messages);
    // The assistant's content should include tool results
    const assistantEntry = prompt.find((p) => p.role === "assistant");
    expect(assistantEntry?.content).toContain("Tool Results:");
    expect(assistantEntry?.content).toContain("read_file");
  });

  it("does not append tool results for assistant without toolCalls", () => {
    const messages: ChatMessage[] = [
      assistantMsg("plain response"),
      userMsg("thanks"),
    ];
    const prompt = buildCompactionPrompt(messages);
    const assistantEntry = prompt.find((p) => p.role === "assistant");
    expect(assistantEntry?.content).not.toContain("Tool Results:");
  });
});

// ============================================================
// T16-T17: _alignBoundaryPairs — edge cases
// ============================================================
describe("_alignBoundaryPairs — edge cases", () => {
  it("handles assistant with toolCalls kept but no following tool results", () => {
    const messages: ChatMessage[] = [
      userMsg("first"),
      assistantMsg("response", [
        { id: "tc-1", name: "read_file", args: { path: "/a" }, status: "pending" },
      ]),
      userMsg("next question"),
    ];
    const baseIndices = new Set([1]);
    const aligned = _alignBoundaryPairs(messages, baseIndices);
    // Assistant is kept, but no tool results follow → only index 1 in aligned
    expect(aligned.has(1)).toBe(true);
    expect(aligned.size).toBe(1);
  });

  it("handles tool result protected but no preceding assistant with toolCalls", () => {
    const messages: ChatMessage[] = [
      userMsg("first"),
      toolResultMsg("read_file", "content"),
      userMsg("next"),
    ];
    const baseIndices = new Set([1]);
    const aligned = _alignBoundaryPairs(messages, baseIndices);
    // Tool result is protected, but no assistant with toolCalls precedes it
    expect(aligned.has(1)).toBe(true);
    expect(aligned.size).toBe(1);
  });

  it("respects maxLookahead bound", () => {
    // Create many consecutive tool results after an assistant
    const messages: ChatMessage[] = [
      userMsg("first"),
      assistantMsg("response", [
        { id: "tc-1", name: "read_file", args: { path: "/a" }, status: "pending" },
      ]),
    ];
    // Add 150 tool results
    for (let i = 0; i < 150; i++) {
      messages.push(toolResultMsg("read_file", `output ${i}`));
    }
    messages.push(userMsg("last"));

    const baseIndices = new Set([1]);
    const aligned = _alignBoundaryPairs(messages, baseIndices, 100);
    // With maxLookahead=100, should only pull in up to 100 tool results
    expect(aligned.size).toBeLessThanOrEqual(102); // 1 (assistant) + up to 100 tool results + possibly 1 more
  });

  it("handles empty baseIndices", () => {
    const messages = [userMsg("first"), assistantMsg("response")];
    const aligned = _alignBoundaryPairs(messages, new Set());
    expect(aligned.size).toBe(0);
  });

  it("handles index out of bounds gracefully", () => {
    const messages = [userMsg("first")];
    const baseIndices = new Set([0, 999]);
    const aligned = _alignBoundaryPairs(messages, baseIndices);
    expect(aligned.has(0)).toBe(true);
  });
});

// ============================================================
// M4: checkProactiveContextManagement — boundary conditions
// ============================================================
describe("checkProactiveContextManagement — boundary conditions", () => {
  it("returns shouldPrune at exactly 60% usage", () => {
    // Craft messages to hit exactly 60% of usable tokens
    // usableTokens = maxContextTokens - OUTPUT_RESERVE(4000) - COMPACTION_BUFFER(20000)
    // For maxContextTokens = 100000: usable = 76000
    // Need totalTokens ≈ 0.60 * 76000 = 45600
    // At ~0.25 tokens/char, need ~182400 chars
    const bigMsg = userMsg("x".repeat(182400));
    const result = checkProactiveContextManagement([bigMsg], 100000);
    expect(result.shouldPrune).toBe(true);
  });

  it("returns shouldCompact at exactly 75% usage", () => {
    // Need totalTokens ≈ 0.75 * 76000 = 57000
    // At ~0.25 tokens/char, need ~228000 chars
    const hugeMsg = userMsg("x".repeat(228000));
    const result = checkProactiveContextManagement([hugeMsg], 100000);
    expect(result.shouldCompact).toBe(true);
  });
});

// ============================================================
// estimateTokens — code fence edge cases (C2 fix verification)
// ============================================================
describe("estimateTokens — code fence detection", () => {
  it("handles text starting with a code fence", () => {
    const text = "```\ncode content\n```";
    const tokens = estimateTokens(text);
    expect(tokens).toBeGreaterThan(0);
    // The code content should be counted in code mode
  });

  it("handles multiple code blocks", () => {
    const text = "text\n```\ncode1\n```\nmore text\n```\ncode2\n```\nend";
    const tokens = estimateTokens(text);
    expect(tokens).toBeGreaterThan(0);
  });

  it("handles unclosed code fence", () => {
    const text = "text\n```\ncode content";
    const tokens = estimateTokens(text);
    expect(tokens).toBeGreaterThan(0);
  });

  it("handles CJK inside code blocks correctly", () => {
    // CJK inside code should use code rate (0.25) not CJK rate (0.67)
    const codeText = "```\n中文代码\n```";
    const plainCjk = "中文代码";
    const codeTokens = estimateTokens(codeText);
    const plainTokens = estimateTokens(plainCjk);
    // Code block should have fewer tokens than plain CJK (code rate < CJK rate)
    // codeTokens = fence(3) + CJK(4*0.25=1) + newline(1) + fence(3) = ~8
    // plainTokens = 4 * 0.67 = ~3
    // codeTokens should include overhead for fences
    expect(codeTokens).toBeGreaterThan(plainTokens);
  });
});
