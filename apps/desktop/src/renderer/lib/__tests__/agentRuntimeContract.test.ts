/**
 * Tests for the Agent Runtime Contract state machine.
 *
 * Covers:
 * - Initial state creation
 * - Phase transitions (idle → streaming → idle)
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
    expect(state.transitionLog).toEqual([]);
  });
});

describe("phase transitions", () => {
  // ── Happy path: lifecycle (no approval flow) ──
  it("transitions: idle → streaming → streaming (with tools) → idle", () => {
    let state = emptyState();

    // idle → streaming
    state = agentReducer(state, { type: "STREAM_START", messageId: "msg-1" });
    expect(state.phase).toBe("streaming");
    expect(state.currentMessageId).toBe("msg-1");

    // streaming → streaming (tool call detected)
    state = agentReducer(state, {
      type: "TOOL_CALL",
      toolCallId: "tc-1",
      toolName: "read_file",
    });
    expect(state.phase).toBe("streaming");
    expect(state.pendingToolCallIds.has("tc-1")).toBe(true);
    expect(state.toolCallStatuses.get("tc-1")).toBe("pending");

    // streaming → streaming (tool result received)
    state = agentReducer(state, {
      type: "TOOL_RESULT_RECEIVED",
      toolCallId: "tc-1",
      success: true,
    });
    expect(state.phase).toBe("streaming");
    expect(state.toolCallStatuses.get("tc-1")).toBe("completed");
    expect(state.resolvedToolCallIds.has("tc-1")).toBe(true);

    // streaming → idle via message-end with no more tools
    state = agentReducer(state, {
      type: "STREAM_MESSAGE_END",
      messageId: "msg-1",
      hasMoreTools: false,
    });
    expect(state.phase).toBe("streaming");
    expect(state.currentMessageId).toBeNull();
  });

  // ── Multi-turn loop ──
  it("supports multi-turn tool loop", () => {
    let state = emptyState();

    // Round 1: read_file
    state = agentReducer(state, { type: "STREAM_START", messageId: "m1" });
    state = agentReducer(state, {
      type: "TOOL_CALL",
      toolCallId: "tc1",
      toolName: "read_file",
    });
    state = agentReducer(state, {
      type: "TOOL_RESULT_RECEIVED",
      toolCallId: "tc1",
      success: true,
    });

    // Round 2: write_file (new stream while still streaming)
    state = agentReducer(state, { type: "STREAM_START", messageId: "m2" });
    expect(state.phase).toBe("streaming");
    expect(state.currentMessageId).toBe("m2");
    state = agentReducer(state, {
      type: "TOOL_CALL",
      toolCallId: "tc2",
      toolName: "write_file",
    });
    agentReducer(state, {
      type: "TOOL_RESULT_RECEIVED",
      toolCallId: "tc2",
      success: true,
    });
  });

  // ── Invalid transitions no-op ──
  it("invalid transitions return the same state reference", () => {
    const state = emptyState();
    // From idle, TOOL_RESULT_RECEIVED is not valid (needs STREAM_START first)
    const result = agentReducer(state, {
      type: "TOOL_RESULT_RECEIVED",
      toolCallId: "tc-1",
      success: true,
    });
    expect(result.phase).toBe("idle");
  });
});

describe("STREAM_MESSAGE_END", () => {
  it("clears currentMessageId when no more tools", () => {
    let state = emptyState();
    state = agentReducer(state, { type: "STREAM_START", messageId: "m-1" });
    expect(state.currentMessageId).toBe("m-1");

    state = agentReducer(state, {
      type: "STREAM_MESSAGE_END",
      messageId: "m-1",
      hasMoreTools: false,
    });
    expect(state.currentMessageId).toBeNull();
  });

  it("preserves currentMessageId when hasMoreTools is true", () => {
    let state = emptyState();
    state = agentReducer(state, { type: "STREAM_START", messageId: "m-1" });
    state = agentReducer(state, {
      type: "STREAM_MESSAGE_END",
      messageId: "m-1",
      hasMoreTools: true,
    });
    expect(state.currentMessageId).toBe("m-1");
  });
});

describe("TOOL_TIMEOUT", () => {
  it("transitions from streaming to streaming (no-op state mutation)", () => {
    let state = emptyState();
    state = agentReducer(state, { type: "STREAM_START", messageId: "m-1" });
    state = agentReducer(state, { type: "TOOL_TIMEOUT", toolCallId: "tc-1" });
    expect(state.phase).toBe("streaming");
  });

  it("no-ops from idle (invalid transition)", () => {
    const state = emptyState();
    const result = agentReducer(state, { type: "TOOL_TIMEOUT", toolCallId: "tc-1" });
    expect(result.phase).toBe("idle");
  });
});

describe("ERROR", () => {
  it("transitions from streaming to idle", () => {
    let state = emptyState();
    state = agentReducer(state, { type: "STREAM_START", messageId: "m-1" });
    state = agentReducer(state, {
      type: "ERROR",
      sessionId: "s-1",
      error: "Something went wrong",
    });
    expect(state.phase).toBe("idle");
  });
});

describe("transition logging", () => {
  it("logs phase transitions with metadata", () => {
    let state = emptyState();
    state = agentReducer(state, { type: "STREAM_START", messageId: "m-1" });
    state = agentReducer(state, {
      type: "TOOL_CALL",
      toolCallId: "tc-1",
      toolName: "test",
    });

    expect(state.transitionLog.length).toBe(2);
    expect(state.transitionLog[0].from).toBe("idle");
    expect(state.transitionLog[0].to).toBe("streaming");
    expect(state.transitionLog[0].event).toBe("STREAM_START");
    expect(state.transitionLog[1].event).toBe("TOOL_CALL");
  });
});

describe("helper functions", () => {
  describe("getPhaseLabel", () => {
    it("returns human-readable labels", () => {
      expect(getPhaseLabel("idle")).toBe("Idle");
      expect(getPhaseLabel("streaming")).toBe("Streaming");
    });
  });

  describe("canAcceptInput / isBusy", () => {
    it("only idle can accept input", () => {
      expect(canAcceptInput("idle")).toBe(true);
      expect(canAcceptInput("streaming")).toBe(false);
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
});
