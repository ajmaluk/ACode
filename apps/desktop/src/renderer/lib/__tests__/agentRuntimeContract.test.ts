/**
 * Tests for the Agent Runtime Contract state machine.
 *
 * Covers:
 * - Initial state creation
 * - Phase transitions (idle → streaming → tool-waiting-approval → ...)
 * - Invalid transitions that should no-op
 * - Event-specific state mutations (toolCallIds, resolvedIds, etc.)
 * - Helper functions: getPhaseLabel, canAcceptInput, isBusy, etc.
 */
import { describe, it, expect } from "vitest";
import {
  createInitialRuntimeState,
  agentReducer,
  getPhaseLabel,
  canAcceptInput,
  isBusy,
  getPendingToolCalls,
  getPendingApprovalCount,
  getPendingExecutionCount,
  type AgentRuntimeState,
} from "../agentRuntimeContract";

function emptyState(): AgentRuntimeState {
  return createInitialRuntimeState();
}

describe("createInitialRuntimeState", () => {
  it("creates idle state with empty collections", () => {
    const state = createInitialRuntimeState();
    expect(state.phase).toBe("idle");
    expect(state.sessionId).toBeNull();
    expect(state.currentMessageId).toBeNull();
    expect(state.pendingToolCallIds.size).toBe(0);
    expect(state.resolvedToolCallIds.size).toBe(0);
    expect(state.toolCallStatuses.size).toBe(0);
    expect(state.diffToToolCall.size).toBe(0);
    expect(state.pendingDiffToolCalls).toEqual([]);
    expect(state.transitionLog).toEqual([]);
  });
});

describe("phase transitions", () => {
  // ── Happy path: full agent lifecycle ──
  it("transitions: idle → streaming → tool-waiting-approval → tool-running → tool-results → idle", () => {
    let state = emptyState();

    // idle → streaming
    state = agentReducer(state, { type: "STREAM_START", messageId: "msg-1" });
    expect(state.phase).toBe("streaming");
    expect(state.currentMessageId).toBe("msg-1");

    // streaming → streaming (tool call detected)
    state = agentReducer(state, { type: "TOOL_CALL", toolCallId: "tc-1", toolName: "read_file" });
    expect(state.phase).toBe("streaming");
    expect(state.pendingToolCallIds.has("tc-1")).toBe(true);
    expect(state.toolCallStatuses.get("tc-1")).toBe("pending");

    // streaming → tool-waiting-approval
    state = agentReducer(state, { type: "TOOL_APPROVAL_REQUESTED", toolCallId: "tc-1" });
    expect(state.phase).toBe("tool-waiting-approval");
    expect(state.toolCallStatuses.get("tc-1")).toBe("awaiting-approval");

    // tool-waiting-approval → tool-running
    state = agentReducer(state, { type: "TOOL_APPROVED", toolCallId: "tc-1" });
    expect(state.phase).toBe("tool-running");
    expect(state.toolCallStatuses.get("tc-1")).toBe("approved");

    // tool-running → tool-results
    state = agentReducer(state, { type: "TOOL_RESULT_RECEIVED", toolCallId: "tc-1", success: true });
    expect(state.phase).toBe("tool-results");
    expect(state.toolCallStatuses.get("tc-1")).toBe("completed");
    expect(state.resolvedToolCallIds.has("tc-1")).toBe(true);

    // tool-results → streaming (new message from agent loop)
    state = agentReducer(state, { type: "STREAM_START", messageId: "msg-2" });
    expect(state.phase).toBe("streaming");
    expect(state.currentMessageId).toBe("msg-2");
  });

  // ── Abort from any phase ──
  it("can abort from any phase", () => {
    const phases = ["idle", "sending", "streaming", "tool-waiting-approval", "tool-running", "tool-results", "finalizing"];
    for (const phase of phases) {
      let state = emptyState();
      // Force transition to the target phase
      if (phase === "sending") {
        state = agentReducer(state, { type: "SEND_PROMPT", sessionId: "s-1" });
      } else if (phase === "streaming") {
        state = agentReducer(state, { type: "STREAM_START", messageId: "m-1" });
      } else if (phase === "tool-waiting-approval") {
        state = agentReducer(state, { type: "STREAM_START", messageId: "m-1" });
        state = agentReducer(state, { type: "TOOL_CALL", toolCallId: "tc-1", toolName: "test" });
        state = agentReducer(state, { type: "TOOL_APPROVAL_REQUESTED", toolCallId: "tc-1" });
      } else if (phase === "tool-running") {
        state = agentReducer(state, { type: "STREAM_START", messageId: "m-1" });
        state = agentReducer(state, { type: "TOOL_CALL", toolCallId: "tc-1", toolName: "test" });
        state = agentReducer(state, { type: "TOOL_APPROVAL_REQUESTED", toolCallId: "tc-1" });
        state = agentReducer(state, { type: "TOOL_APPROVED", toolCallId: "tc-1" });
      } else if (phase === "tool-results") {
        state = agentReducer(state, { type: "STREAM_START", messageId: "m-1" });
        state = agentReducer(state, { type: "TOOL_CALL", toolCallId: "tc-1", toolName: "test" });
        state = agentReducer(state, { type: "TOOL_APPROVAL_REQUESTED", toolCallId: "tc-1" });
        state = agentReducer(state, { type: "TOOL_APPROVED", toolCallId: "tc-1" });
        state = agentReducer(state, { type: "TOOL_RESULT_RECEIVED", toolCallId: "tc-1", success: true });
      } else if (phase === "finalizing") {
        state = agentReducer(state, { type: "STREAM_START", messageId: "m-1" });
        state = agentReducer(state, { type: "FINALIZING", messageId: "m-1" });
      }
      expect(state.phase).toBe(phase);

      state = agentReducer(state, { type: "ABORT", sessionId: "s-1" });
      expect(state.phase).toBe("aborted");
      expect(state.pendingToolCallIds.size).toBe(0);
    }
  });

  // ── Invalid transitions no-op ──
  it("invalid transitions return the same state reference", () => {
    const state = emptyState();
    // From idle, SEND_PROMPT is valid, but TOOL_RESULT_RECEIVED is not
    const result = agentReducer(state, { type: "TOOL_RESULT_RECEIVED", toolCallId: "tc-1", success: true });
    expect(result.phase).toBe("idle");
  });
});

describe("SEND_PROMPT", () => {
  it("sets sessionId and clears collections", () => {
    let state = emptyState();
    state.pendingToolCallIds.add("stale-tc");
    state.toolCallStatuses.set("stale-tc", "pending");
    state.pendingDiffToolCalls = ["stale-diff"];

    state = agentReducer(state, { type: "SEND_PROMPT", sessionId: "s-1" });
    expect(state.phase).toBe("sending");
    expect(state.sessionId).toBe("s-1");
    expect(state.pendingToolCallIds.size).toBe(0);
    expect(state.toolCallStatuses.size).toBe(0);
    expect(state.pendingDiffToolCalls).toEqual([]);
  });
});

describe("TOOL_APPROVED / TOOL_DENIED invariants", () => {
  it("TOOL_APPROVED throws if tool was not awaiting-approval", () => {
    let state = emptyState();
    state = agentReducer(state, { type: "STREAM_START", messageId: "m-1" });
    state = agentReducer(state, { type: "TOOL_CALL", toolCallId: "tc-1", toolName: "test" });
    state = agentReducer(state, { type: "TOOL_APPROVAL_REQUESTED", toolCallId: "tc-1" });
    // tc-1 is now "awaiting-approval". Approve a different toolCallId that doesn't exist.
    expect(() => {
      agentReducer(state, { type: "TOOL_APPROVED", toolCallId: "tc-2" });
    }).toThrow(/INVARIANT VIOLATION/);
  });

  it("TOOL_DENIED transitions to tool-results and marks resolved", () => {
    let state = emptyState();
    state = agentReducer(state, { type: "STREAM_START", messageId: "m-1" });
    state = agentReducer(state, { type: "TOOL_CALL", toolCallId: "tc-1", toolName: "test" });
    state = agentReducer(state, { type: "TOOL_APPROVAL_REQUESTED", toolCallId: "tc-1" });

    state = agentReducer(state, { type: "TOOL_DENIED", toolCallId: "tc-1" });
    expect(state.phase).toBe("tool-results");
    expect(state.toolCallStatuses.get("tc-1")).toBe("denied");
    expect(state.resolvedToolCallIds.has("tc-1")).toBe(true);
  });
});

describe("TOOL_TIMEOUT / TOOL_RETRY", () => {
  it("TOOL_TIMEOUT requires tool to be running", () => {
    let state = emptyState();
    state = agentReducer(state, { type: "STREAM_START", messageId: "m-1" });
    state = agentReducer(state, { type: "TOOL_CALL", toolCallId: "tc-1", toolName: "test" });
    state = agentReducer(state, { type: "TOOL_APPROVAL_REQUESTED", toolCallId: "tc-1" });
    state = agentReducer(state, { type: "TOOL_APPROVED", toolCallId: "tc-1" });

    // timeout when "approved" (should be "running" first)
    expect(() => {
      agentReducer(state, { type: "TOOL_TIMEOUT", toolCallId: "tc-1" });
    }).toThrow(/INVARIANT VIOLATION/);
  });

  it("TOOL_RETRY resets tool status for re-execution", () => {
    let state = emptyState();
    state = agentReducer(state, { type: "STREAM_START", messageId: "m-1" });
    state = agentReducer(state, { type: "TOOL_CALL", toolCallId: "tc-1", toolName: "test" });
    state = agentReducer(state, { type: "TOOL_APPROVAL_REQUESTED", toolCallId: "tc-1" });
    state = agentReducer(state, { type: "TOOL_APPROVED", toolCallId: "tc-1" });
    // tc-1 is now "approved" (phase: tool-running). TOOL_RETRY from "tool-running" is valid.
    state = agentReducer(state, { type: "TOOL_RETRY", toolCallId: "tc-1", attempt: 1 });
    expect(state.phase).toBe("tool-retrying");
    expect(state.toolCallStatuses.get("tc-1")).toBe("pending");
  });
});

describe("STREAM_MESSAGE_END with pending diffs", () => {
  it("transitions to streaming-pending-diffs when tools have unresolved diffs", () => {
    let state = emptyState();
    state = agentReducer(state, { type: "STREAM_START", messageId: "m-1" });
    state = agentReducer(state, { type: "TOOL_CALL", toolCallId: "tc-1", toolName: "write_file" });
    state.diffToToolCall.set("diff-1", "tc-1");

    state = agentReducer(state, { type: "STREAM_MESSAGE_END", messageId: "m-1", hasMoreTools: false });
    expect(state.phase).toBe("streaming-pending-diffs");
    expect(state.pendingDiffToolCalls).toContain("tc-1");
  });

  it("DIFF_RESOLVED transitions back to idle when all diffs resolved", () => {
    let state = emptyState();
    state = agentReducer(state, { type: "STREAM_START", messageId: "m-1" });
    state = agentReducer(state, { type: "TOOL_CALL", toolCallId: "tc-1", toolName: "write_file" });
    state.diffToToolCall.set("diff-1", "tc-1");

    state = agentReducer(state, { type: "STREAM_MESSAGE_END", messageId: "m-1", hasMoreTools: false });
    expect(state.phase).toBe("streaming-pending-diffs");

    state = agentReducer(state, { type: "DIFF_RESOLVED", diffId: "diff-1" });
    expect(state.phase).toBe("idle");
    expect(state.pendingDiffToolCalls).toEqual([]);
  });
});

describe("COMPLETE event", () => {
  it("resets state to clean idle", () => {
    let state = emptyState();
    // Must transition to streaming first — FINALIZING is not valid from idle
    state = agentReducer(state, { type: "STREAM_START", messageId: "m-1" });
    state = agentReducer(state, { type: "FINALIZING", messageId: "m-1" });
    expect(state.phase).toBe("finalizing");

    state = agentReducer(state, { type: "COMPLETE", sessionId: "s-1" });
    expect(state.phase).toBe("idle");
    expect(state.sessionId).toBeNull();
    expect(state.currentMessageId).toBeNull();
  });
});

describe("transition logging", () => {
  it("logs phase transitions with metadata", () => {
    let state = emptyState();
    state = agentReducer(state, { type: "SEND_PROMPT", sessionId: "s-1" });
    state = agentReducer(state, { type: "STREAM_START", messageId: "m-1" });
    state = agentReducer(state, { type: "TOOL_CALL", toolCallId: "tc-1", toolName: "test" });

    expect(state.transitionLog.length).toBe(3);
    expect(state.transitionLog[0].from).toBe("idle");
    expect(state.transitionLog[0].to).toBe("sending");
    expect(state.transitionLog[0].event).toBe("SEND_PROMPT");
    expect(state.transitionLog[1].to).toBe("streaming");
    expect(state.transitionLog[2].event).toBe("TOOL_CALL");
  });
});

describe("helper functions", () => {
  describe("getPhaseLabel", () => {
    it("returns human-readable labels", () => {
      expect(getPhaseLabel("idle")).toBe("Idle");
      expect(getPhaseLabel("streaming")).toBe("Streaming");
      expect(getPhaseLabel("tool-waiting-approval")).toBe("Waiting for approval");
      expect(getPhaseLabel("aborted")).toBe("Aborted");
    });
  });

  describe("canAcceptInput / isBusy", () => {
    it("only idle and aborted can accept input", () => {
      expect(canAcceptInput("idle")).toBe(true);
      expect(canAcceptInput("aborted")).toBe(true);
      expect(canAcceptInput("streaming")).toBe(false);
      expect(canAcceptInput("sending")).toBe(false);
      expect(canAcceptInput("tool-running")).toBe(false);
    });

    it("isBusy is the inverse of canAcceptInput", () => {
      expect(isBusy("idle")).toBe(false);
      expect(isBusy("streaming")).toBe(true);
    });
  });

  describe("getPendingToolCalls", () => {
    it("returns unresolved tool call IDs", () => {
      const state = emptyState();
      state.pendingToolCallIds.add("tc-1");
      state.pendingToolCallIds.add("tc-2");
      state.resolvedToolCallIds.add("tc-1");

      const pending = getPendingToolCalls(state);
      expect(pending).toEqual(["tc-2"]);
    });
  });

  describe("getPendingApprovalCount", () => {
    it("counts tool calls awaiting approval", () => {
      const state = emptyState();
      state.toolCallStatuses.set("tc-1", "awaiting-approval");
      state.toolCallStatuses.set("tc-2", "approved");
      state.toolCallStatuses.set("tc-3", "awaiting-approval");
      state.resolvedToolCallIds.add("tc-1"); // resolved, should not count

      expect(getPendingApprovalCount(state)).toBe(1); // only tc-3
    });
  });

  describe("getPendingExecutionCount", () => {
    it("counts approved but not yet executed tools", () => {
      const state = emptyState();
      state.toolCallStatuses.set("tc-1", "approved");
      state.toolCallStatuses.set("tc-2", "approved");
      state.toolCallStatuses.set("tc-3", "running");
      state.resolvedToolCallIds.add("tc-1"); // resolved, should not count

      expect(getPendingExecutionCount(state)).toBe(1); // only tc-2
    });
  });
});
