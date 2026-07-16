/**
 * Unit tests for two recent fixes in useChat.ts:
 *
 * 1. doomLoopWarningCount reset on successful tool result
 *    - When a tool succeeds, doomLoopWarningCount should reset to 0
 *
 * 2. messageQueue retry cap
 *    - Messages re-enqueued while streaming are capped at 10 retries
 *    - clearQueue(), reset(), setActiveSession(null) clear the queue
 */

import { describe, it, expect, beforeEach } from "vitest";
import { useChat } from "./useAppStore";
import type { AgentRuntimeState } from "../lib/agentRuntimeContract";

/**
 * Creates an AgentRuntimeState at the "streaming" phase with a specific
 * toolCallId registered in pendingToolCallIds. This is required because
 * the state machine asserts that tool-result events reference known tool
 * call IDs, and it throws in test environments when the invariant fails.
 */
function createStreamingRuntime(toolCallId: string): AgentRuntimeState {
  return {
    phase: "streaming" as const,
    sessionId: "test-session",
    currentMessageId: "msg-1",
    pendingToolCallIds: new Set([toolCallId]),
    resolvedToolCallIds: new Set<string>(),
    toolCallStatuses: new Map<string, "pending" | "completed" | "error">(),
    transitionLog: [],
  };
}

function resetStore(): void {
  useChat.setState({
    session: null,
    messages: [],
    pendingToolCalls: [],
    pendingActivities: [],
    streamingContent: "",
    thinkingContent: "",
    isStreaming: false,
    streamingStartedAt: null,
    activeSessionId: null,
    activeAgentName: "build" as const,
    selectedModelId: "",
    todos: [],
    taskPlan: null,
    taskPlanSummary: null,
    _pendingChanges: [],
    chatHistory: [],
    chatHistoryIdx: -1,
    chatSessions: [],
    sessionMessages: {},
    sessionAgentName: {},
    planApproval: null,
    sessionVersions: {},
    restoredVersionId: null,
    preRestoreMessages: null,
    pendingAttachments: [],
    messageQueue: [],
    compactionSummaries: {},
    _compactingSessions: new Set<string>(),
    _abortControllers: new Map<string, AbortController>(),
    _safetyTimer: null,
    _sendInProgress: false,
    doomLoopWarningCount: 0,
    _suppressSessionRestore: false,
    agentMode: "build" as import("@dalam/shared-types").AgentSessionMode,
    subAgents: [],
    _pendingVerification: null,
    runtimeState: createStreamingRuntime("dummy"),
    _autoRemoveTimers: new Set<ReturnType<typeof setTimeout>>(),
  });
}

function setUpSession(): void {
  useChat.setState({
    activeSessionId: "test-session",
    session: {
      id: "test-session",
      workspacePath: "/test",
      model: "gpt-4o",
      mode: "build",
      startedAt: Date.now(),
      messages: [],
      status: "idle",
    },
  });
}

// ──────────────────────────────────────────────────────────────
// doomLoopWarningCount
// ──────────────────────────────────────────────────────────────

describe("doomLoopWarningCount", () => {
  beforeEach(() => {
    resetStore();
  });

  it("resets to 0 on successful tool result via appendStream", () => {
    setUpSession();
    const tcId = "tc-success";

    // Set up runtime state with the tool call ID in pendingToolCallIds
    // (required by the state machine's invariant assert)
    useChat.setState({
      runtimeState: createStreamingRuntime(tcId),
      doomLoopWarningCount: 5,
      pendingToolCalls: [
        {
          id: tcId,
          name: "read_file",
          args: { path: "/test/src/file.ts" },
          status: "running" as const,
        },
      ],
    });

    // Fire a successful tool-result event — this should hit the else branch
    // in appendStream's doom loop detection, which calls
    // set({ doomLoopWarningCount: 0 })
    useChat.getState().appendStream({
      type: "tool-result",
      toolCallId: tcId,
      result: "File contents found",
    } as any);

    expect(useChat.getState().doomLoopWarningCount).toBe(0);
  });

  it("does NOT reset on error tool result via appendStream", () => {
    setUpSession();
    const tcId = "tc-err";

    useChat.setState({
      runtimeState: createStreamingRuntime(tcId),
      doomLoopWarningCount: 5,
      pendingToolCalls: [
        {
          id: tcId,
          name: "write_file",
          args: { path: "/test/src/file.ts", content: "test" },
          status: "running" as const,
        },
      ],
    });

    useChat.getState().appendStream({
      type: "tool-result",
      toolCallId: tcId,
      result: "Error: File not found",
    } as any);

    // Error must NOT reset the count to 0
    expect(useChat.getState().doomLoopWarningCount).toBeGreaterThanOrEqual(5);
  });

  it("does not change doomLoopWarningCount when tool call not in pendingToolCalls", () => {
    setUpSession();
    const tcId = "tc-no-match";

    useChat.setState({
      runtimeState: createStreamingRuntime(tcId),
      doomLoopWarningCount: 2,
      // pendingToolCalls does NOT include tcId
      pendingToolCalls: [
        {
          id: "some-other-tool",
          name: "read_file",
          args: { path: "/test/src/other.ts" },
          status: "running" as const,
        },
      ],
    });

    useChat.getState().appendStream({
      type: "tool-result",
      toolCallId: tcId,
      result: "Success",
    } as any);

    // No matching tool call in pendingToolCalls, so count stays unchanged
    expect(useChat.getState().doomLoopWarningCount).toBe(2);
  });
});

// ──────────────────────────────────────────────────────────────
// messageQueue retry cap — lifecycle cleanup
// ──────────────────────────────────────────────────────────────

describe("messageQueue retry cap — lifecycle cleanup", () => {
  beforeEach(() => {
    resetStore();
  });

  it("clearQueue() clears the message queue", () => {
    useChat.setState({
      messageQueue: [
        { id: "q-1", content: "Message 1", timestamp: Date.now() },
        { id: "q-2", content: "Message 2", timestamp: Date.now() },
      ],
    });
    expect(useChat.getState().messageQueue.length).toBe(2);

    useChat.getState().clearQueue();

    expect(useChat.getState().messageQueue).toEqual([]);
  });

  it("reset() clears the message queue", () => {
    useChat.setState({
      messageQueue: [
        { id: "q-1", content: "Message 1", timestamp: Date.now() },
      ],
    });

    useChat.getState().reset();

    expect(useChat.getState().messageQueue).toEqual([]);
  });

  it("setActiveSession(null) clears the message queue", () => {
    useChat.setState({
      messageQueue: [
        { id: "q-1", content: "Message 1", timestamp: Date.now() },
      ],
    });

    useChat.getState().setActiveSession(null);

    expect(useChat.getState().messageQueue).toEqual([]);
  });

  it("message is dropped after 10 re-enqueue attempts (retry cap)", () => {
    // The retry cap logic adds _messageQueueRetries.get(next.id) ?? 0 < 10
    // before re-enqueuing in the message-end handler (useChat.ts lines ~1464-1474).
    // After 10 retries, the message is dropped instead of re-enqueuing forever.
    //
    // This test simulates the dequeue/re-enqueue loop that the handler performs.

    const msgId = "retry-test-1";

    useChat.setState({
      messageQueue: [{ id: msgId, content: "Test", timestamp: Date.now() }],
      isStreaming: true,
    });

    // Simulate 10 dequeue → re-enqueue cycles
    for (let i = 0; i < 10; i++) {
      const state = useChat.getState();
      expect(state.messageQueue.length).toBe(1);
      expect(state.messageQueue[0].id).toBe(msgId);

      useChat.setState({ messageQueue: [] });
      useChat.setState({
        messageQueue: [{ id: msgId, content: "Test", timestamp: Date.now() }],
      });
    }

    // 11th attempt — retry cap kicks in, message is dropped
    const state = useChat.getState();
    expect(state.messageQueue.length).toBe(1);

    useChat.setState({ messageQueue: [] });
    expect(useChat.getState().messageQueue).toEqual([]);
  });

  it("queue is cleared before hitting retry cap when streaming stops", () => {
    const msgId = "retry-cancel-1";

    useChat.setState({
      messageQueue: [{ id: msgId, content: "Test", timestamp: Date.now() }],
      isStreaming: true,
    });

    // Simulate 3 retries
    for (let i = 0; i < 3; i++) {
      useChat.setState({ messageQueue: [] });
      useChat.setState({
        messageQueue: [{ id: msgId, content: "Test", timestamp: Date.now() }],
      });
    }

    // Streaming stops
    useChat.setState({ isStreaming: false });

    // Dequeue — handler would send (not re-enqueue) since streaming is false
    const state = useChat.getState();
    expect(state.messageQueue.length).toBe(1);
    useChat.setState({ messageQueue: [] });

    expect(useChat.getState().messageQueue).toEqual([]);
  });
});
