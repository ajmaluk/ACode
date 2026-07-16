/**
 * Integration tests for tool-result lifecycle through the store.
 *
 * These tests simulate the sequence of stream events that occur during
 * a typical agent interaction: message-start → tool-call → diff-proposed
 * → message-delta → message-end, and verify that the store correctly
 * manages pendingToolCalls, messages, and state transitions.
 *
 * Uses the Zustand store directly (via setState/getState) so no
 * Tauri API mocking is needed.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { useChat } from "../../store/useAppStore";
import type { StreamEvent } from "@dalam/shared-types";
import type { ToolCall } from "@dalam/shared-types";

// ─── Test Helpers ───────────────────────────────────────────

/**
 * Reset the chat store to a clean state with a minimal session set up.
 * This ensures each test starts from a known state.
 */
function resetStore() {
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
    sessionMessages: {},
    chatSessions: [],
    _pendingChanges: [],
    _safetyTimer: null,
    _sendInProgress: false,
    messageQueue: [],
    todos: [],
    taskPlan: null,
    taskPlanSummary: null,
    planApproval: null,
    chatHistory: [],
    chatHistoryIdx: -1,
    selectedModelId: "",
    activeAgentName: "build" as const,
    sessionAgentName: {},
    sessionVersions: {},
    compactionSummaries: {},
    _compactingSessions: new Set(),
    _abortControllers: new Map(),
    _autoRemoveTimers: new Set(),
    subAgents: [],
    _pendingVerification: null,
    doomLoopWarningCount: 0,
    _suppressSessionRestore: false,
    restoredVersionId: null,
    preRestoreMessages: null,
    pendingAttachments: [],
    agentMode: "build" as const,
    runtimeState: {
      phase: "idle",
      sessionId: null,
      currentMessageId: null,
      pendingToolCallIds: new Set<string>(),
      resolvedToolCallIds: new Set<string>(),
      toolCallStatuses: new Map<
        string,
        import("../../lib/agentRuntimeContract").ToolCallStatus
      >(),
      transitionLog: [],
    },
  });
}

/**
 * Set up minimal session state so appendStream can proceed without errors.
 */
function setupSession() {
  const sessionId = "test-session-" + Date.now();
  useChat.setState({
    session: {
      id: sessionId,
      workspacePath: "/test",
      model: "gpt-4o",
      mode: "build",
      startedAt: Date.now(),
      messages: [],
      status: "idle",
    },
    activeSessionId: sessionId,
    messages: [],
    sessionMessages: { [sessionId]: [] },
    isStreaming: true,
    streamingStartedAt: Date.now(),
    streamingContent: "",
    thinkingContent: "",
    chatSessions: [
      {
        id: sessionId,
        workspacePath: "/test",
        workspaceName: "test",
        title: "Test session",
        agentName: "build",
        mode: "build",
        model: "gpt-4o",
        startedAt: Date.now(),
        lastActivityAt: Date.now(),
        lastVisitedAt: Date.now(),
        messageCount: 0,
        status: "running",
        versionCount: 0,
      },
    ],
  });
  return sessionId;
}

// ─── Basic Message Flow Tests ───────────────────────────────

describe("basic message flow", () => {
  beforeEach(resetStore);

  it("message-start clears streaming state and sets isStreaming", () => {
    setupSession();
    const event: StreamEvent = { type: "message-start", messageId: "msg-1" };
    useChat.getState().appendStream(event);

    const state = useChat.getState();
    expect(state.isStreaming).toBe(true);
    // streamingContent should be cleared when no unresolved tool calls
    expect(state.streamingContent).toBe("");
  });

  it("message-delta appends content to streamingContent", () => {
    setupSession();
    useChat
      .getState()
      .appendStream({ type: "message-start", messageId: "msg-1" });
    useChat
      .getState()
      .appendStream({
        type: "message-delta",
        messageId: "msg-1",
        content: "Hello",
      });
    useChat
      .getState()
      .appendStream({
        type: "message-delta",
        messageId: "msg-1",
        content: " World",
      });

    expect(useChat.getState().streamingContent).toBe("Hello World");
  });

  it("message-delta trims content beyond 200K chars", () => {
    setupSession();
    useChat
      .getState()
      .appendStream({ type: "message-start", messageId: "msg-1" });
    const largeChunk = "x".repeat(150000);
    useChat
      .getState()
      .appendStream({
        type: "message-delta",
        messageId: "msg-1",
        content: largeChunk,
      });
    // Second chunk pushes total past 200K
    useChat
      .getState()
      .appendStream({
        type: "message-delta",
        messageId: "msg-1",
        content: largeChunk,
      });

    expect(useChat.getState().streamingContent.length).toBeLessThanOrEqual(
      200000,
    );
  });

  it("message-end creates final assistant message and clears streaming state", () => {
    setupSession();
    const sid = useChat.getState().activeSessionId!;

    useChat
      .getState()
      .appendStream({ type: "message-start", messageId: "msg-1" });
    useChat
      .getState()
      .appendStream({
        type: "message-delta",
        messageId: "msg-1",
        content: "Hello world",
      });
    useChat
      .getState()
      .appendStream({ type: "message-end", messageId: "msg-1" });

    const state = useChat.getState();
    // Streaming state should be cleared
    expect(state.isStreaming).toBe(false);
    // Message should be in messages array
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].role).toBe("assistant");
    expect(state.messages[0].content).toBe("Hello world");
    // Should be persisted to sessionMessages
    const sessionMsgs = state.sessionMessages[sid];
    expect(sessionMsgs).toHaveLength(1);
    expect(sessionMsgs[0].id).toBe("msg-1");
  });
});

// ─── Tool Call Flow Tests ────────────────────────────────────

describe("tool call lifecycle", () => {
  beforeEach(resetStore);

  it("tool-call event adds to pendingToolCalls", () => {
    setupSession();
    useChat
      .getState()
      .appendStream({ type: "message-start", messageId: "msg-1" });

    const tcEvent: StreamEvent = {
      type: "tool-call",
      toolCall: {
        id: "tc-1",
        name: "read_file",
        args: { path: "/src/index.ts" },
        status: "pending",
      },
    };
    useChat.getState().appendStream(tcEvent);

    const state = useChat.getState();
    expect(state.pendingToolCalls).toHaveLength(1);
    expect(state.pendingToolCalls[0].name).toBe("read_file");
    expect(state.pendingToolCalls[0].status).toBe("completed");
  });

  it("tool-call with awaiting-approval status stays pending for user decision", () => {
    setupSession();
    useChat
      .getState()
      .appendStream({ type: "message-start", messageId: "msg-1" });

    const tcEvent: StreamEvent = {
      type: "tool-call",
      toolCall: {
        id: "tc-2",
        name: "write_file",
        args: { path: "/src/new.ts", content: "new content" },
        status: "awaiting-approval",
      },
    };
    useChat.getState().appendStream(tcEvent);

    const state = useChat.getState();
    expect(state.pendingToolCalls).toHaveLength(1);
    expect(state.pendingToolCalls[0].status).toBe("awaiting-approval");
  });

  it("tool-call after message-delta appends to pendingToolCalls (streaming continues)", () => {
    setupSession();
    useChat
      .getState()
      .appendStream({ type: "message-start", messageId: "msg-1" });
    useChat
      .getState()
      .appendStream({
        type: "message-delta",
        messageId: "msg-1",
        content: "Let me check",
      });

    const tcEvent: StreamEvent = {
      type: "tool-call",
      toolCall: {
        id: "tc-3",
        name: "bash",
        args: { command: "ls" },
        status: "pending",
      },
    };
    useChat.getState().appendStream(tcEvent);

    const state = useChat.getState();
    expect(state.streamingContent).toBe("Let me check");
    expect(state.pendingToolCalls).toHaveLength(1);
    expect(state.pendingToolCalls[0].name).toBe("bash");
  });
});

// ─── Diff Proposed Flow Tests ────────────────────────────────

describe("diff-proposed binding", () => {
  beforeEach(resetStore);

  function makePendingTc(
    id: string,
    name: string,
    path: string,
    status: ToolCall["status"] = "awaiting-approval",
  ): ToolCall {
    return {
      id,
      name,
      args: { path },
      status,
    };
  }

  it("binds diff to tool call via Strategy 2 (filePath + edit tool name)", () => {
    setupSession();
    // Set up initial state with a pending write_file
    useChat.setState({
      pendingToolCalls: [
        makePendingTc("tc-write", "write_file", "/src/file.ts"),
      ],
    });

    const diffEvent: StreamEvent = {
      type: "diff-proposed",
      proposal: {
        diffId: "diff-1",
        filePath: "/src/file.ts",
        oldContent: "old",
        newContent: "new",
        hunks: [
          {
            oldStart: 1,
            oldLines: 1,
            newStart: 1,
            newLines: 1,
            lines: [
              { type: "remove", content: "old", oldLineNumber: 1 },
              { type: "add", content: "new", newLineNumber: 1 },
            ],
          },
        ],
        createdAt: Date.now(),
      },
    };
    useChat.getState().appendStream(diffEvent);

    // The pending tool call should now have diffId and diff attached
    const state = useChat.getState();
    const boundTc = state.pendingToolCalls.find((tc) => tc.id === "tc-write");
    expect(boundTc).toBeDefined();
    expect(boundTc!.diffId).toBe("diff-1");
    expect(boundTc!.diff).toBeDefined();
    expect(boundTc!.diff!.filePath).toBe("/src/file.ts");
  });

  it("binds diff to tool call via Strategy 3 (content hash matching for write_file)", () => {
    setupSession();
    useChat.setState({
      pendingToolCalls: [
        {
          id: "tc-write-2",
          name: "write_file",
          args: { path: "/src/new.ts", content: "new content here" },
          status: "awaiting-approval" as const,
        },
      ],
    });

    const diffEvent: StreamEvent = {
      type: "diff-proposed",
      proposal: {
        diffId: "diff-2",
        filePath: "/src/new.ts",
        oldContent: "",
        newContent: "new content here",
        hunks: [
          {
            oldStart: 0,
            oldLines: 0,
            newStart: 1,
            newLines: 1,
            lines: [
              { type: "add", content: "new content here", newLineNumber: 1 },
            ],
          },
        ],
        createdAt: Date.now(),
      },
    };
    useChat.getState().appendStream(diffEvent);

    const boundTc = useChat
      .getState()
      .pendingToolCalls.find((tc) => tc.id === "tc-write-2");
    expect(boundTc).toBeDefined();
    expect(boundTc!.diffId).toBe("diff-2");
  });

  it("binds diff to tool call via Strategy 4 (most recent pending edit with same filePath)", () => {
    setupSession();
    useChat.setState({
      pendingToolCalls: [
        makePendingTc("tc-old", "write_file", "/src/other.ts"),
        makePendingTc("tc-recent", "write_file", "/src/target.ts"),
      ],
    });

    const diffEvent: StreamEvent = {
      type: "diff-proposed",
      proposal: {
        diffId: "diff-3",
        filePath: "/src/target.ts",
        oldContent: "a",
        newContent: "b",
        hunks: [
          {
            oldStart: 1,
            oldLines: 1,
            newStart: 1,
            newLines: 1,
            lines: [
              { type: "remove", content: "a", oldLineNumber: 1 },
              { type: "add", content: "b", newLineNumber: 1 },
            ],
          },
        ],
        createdAt: Date.now(),
      },
    };
    useChat.getState().appendStream(diffEvent);

    const boundTc = useChat
      .getState()
      .pendingToolCalls.find((tc) => tc.id === "tc-recent");
    expect(boundTc).toBeDefined();
    expect(boundTc!.diffId).toBe("diff-3");
    // The other tool call should not be bound
    const otherTc = useChat
      .getState()
      .pendingToolCalls.find((tc) => tc.id === "tc-old");
    expect(otherTc!.diffId).toBeUndefined();
  });

  it("binds diff to already-completed tool calls in messages when not in pendingToolCalls", () => {
    setupSession();
    const sid = useChat.getState().activeSessionId!;
    // Set up a message with a completed tool call that has no diffId yet
    useChat.setState({
      messages: [
        {
          id: "msg-existing",
          role: "assistant" as const,
          content: "File written.",
          timestamp: Date.now(),
          toolCalls: [
            {
              id: "tc-completed",
              name: "write_file",
              args: { path: "/src/done.ts" },
              status: "completed" as const,
            },
          ],
        },
      ],
      sessionMessages: {
        [sid]: [
          {
            id: "msg-existing",
            role: "assistant" as const,
            content: "File written.",
            timestamp: Date.now(),
            toolCalls: [
              {
                id: "tc-completed",
                name: "write_file",
                args: { path: "/src/done.ts" },
                status: "completed" as const,
              },
            ],
          },
        ],
      },
    });

    const diffEvent: StreamEvent = {
      type: "diff-proposed",
      proposal: {
        diffId: "diff-4",
        filePath: "/src/done.ts",
        oldContent: "old",
        newContent: "new",
        hunks: [
          {
            oldStart: 1,
            oldLines: 1,
            newStart: 1,
            newLines: 1,
            lines: [
              { type: "remove", content: "old", oldLineNumber: 1 },
              { type: "add", content: "new", newLineNumber: 1 },
            ],
          },
        ],
        createdAt: Date.now(),
      },
    };
    useChat.getState().appendStream(diffEvent);

    // The completed tool call in the message should now have the diff
    const state = useChat.getState();
    const msg = state.messages.find((m) => m.id === "msg-existing");
    expect(msg).toBeDefined();
    expect(msg!.toolCalls).toBeDefined();
    const tc = msg!.toolCalls!.find((t) => t.id === "tc-completed");
    expect(tc).toBeDefined();
    expect(tc!.diffId).toBe("diff-4");
  });
});

// ─── thinking Content Tests ─────────────────────────────────

describe("thinking content handling", () => {
  beforeEach(resetStore);

  it("thinking event sets thinkingContent", () => {
    setupSession();
    useChat
      .getState()
      .appendStream({ type: "message-start", messageId: "msg-1" });

    const thinkingEvent: StreamEvent = {
      type: "thinking",
      messageId: "msg-1",
      content: "Let me think about this carefully...",
    };
    useChat.getState().appendStream(thinkingEvent);

    expect(useChat.getState().thinkingContent).toBe(
      "Let me think about this carefully...",
    );
  });

  it("multiple thinking events accumulate", () => {
    setupSession();
    useChat
      .getState()
      .appendStream({ type: "message-start", messageId: "msg-1" });
    useChat
      .getState()
      .appendStream({
        type: "thinking",
        messageId: "msg-1",
        content: "First thought. ",
      });
    useChat
      .getState()
      .appendStream({
        type: "thinking",
        messageId: "msg-1",
        content: "Second thought.",
      });

    expect(useChat.getState().thinkingContent).toBe(
      "First thought. \nSecond thought.",
    );
  });
});

// ─── Status Event Tests ──────────────────────────────────────

describe("status event handling", () => {
  beforeEach(resetStore);

  it("status event updates session status", () => {
    setupSession();
    const before = useChat.getState().session;
    expect(before?.status).toBe("idle");

    useChat.getState().appendStream({ type: "status", status: "running" });

    const after = useChat.getState().session;
    expect(after?.status).toBe("running");
  });
});

// ─── Error Event Tests ───────────────────────────────────────

describe("error event handling", () => {
  beforeEach(resetStore);

  it("error event resets streaming state and adds error message", () => {
    setupSession();
    useChat
      .getState()
      .appendStream({ type: "message-start", messageId: "msg-1" });

    const errEvent: StreamEvent = {
      type: "error",
      error: "API connection failed",
    };
    useChat.getState().appendStream(errEvent);

    const state = useChat.getState();
    expect(state.isStreaming).toBe(false);
    expect(state.streamingContent).toBe("");
    // Should have an error message in the messages array
    const errMsg = state.messages.find((m) =>
      m.content.includes("API connection failed"),
    );
    expect(errMsg).toBeDefined();
    expect(errMsg!.role).toBe("assistant");
  });

  it("error event during streaming appends to existing messages", () => {
    setupSession();
    // Add a prior user message
    useChat.setState({
      messages: [
        {
          id: "user-msg-1",
          role: "user" as const,
          content: "Do something",
          timestamp: Date.now(),
        },
      ],
      isStreaming: true,
      streamingStartedAt: Date.now(),
    });

    useChat
      .getState()
      .appendStream({ type: "message-start", messageId: "msg-1" });
    useChat
      .getState()
      .appendStream({ type: "error", error: "Rate limit exceeded" });

    const state = useChat.getState();
    // Should have both the user message and the error message
    expect(state.messages.length).toBeGreaterThanOrEqual(2);
    expect(state.messages[0].role).toBe("user");
    expect(state.messages[state.messages.length - 1].role).toBe("assistant");
  });
});

// ─── Sub-Agent Event Tests ──────────────────────────────────

describe("sub-agent event handling", () => {
  beforeEach(resetStore);

  it("sub-agent-start adds a new sub-agent entry", () => {
    setupSession();
    const event: StreamEvent = {
      type: "sub-agent-start",
      subAgentId: "sa-1",
      prompt: "Find the bug",
      description: "Debug search",
      subagentType: "explore",
    };
    useChat.getState().appendStream(event);

    const state = useChat.getState();
    expect(state.subAgents).toHaveLength(1);
    expect(state.subAgents[0].id).toBe("sa-1");
    expect(state.subAgents[0].description).toBe("Debug search");
    expect(state.subAgents[0].status).toBe("running");
  });

  it("sub-agent-update appends content to the sub-agent", () => {
    setupSession();
    useChat.getState().appendStream({
      type: "sub-agent-start",
      subAgentId: "sa-2",
      prompt: "Check files",
      description: "File check",
      subagentType: "explore",
    });
    useChat.getState().appendStream({
      type: "sub-agent-update",
      subAgentId: "sa-2",
      content: "Found 3 files.",
    });

    const state = useChat.getState();
    const sa = state.subAgents.find((s) => s.id === "sa-2");
    expect(sa?.content).toBe("Found 3 files.");
  });

  it("sub-agent-end marks the sub-agent as completed", () => {
    setupSession();
    useChat.getState().appendStream({
      type: "sub-agent-start",
      subAgentId: "sa-3",
      prompt: "Fix bug",
      description: "Bug fix",
      subagentType: "general",
    });
    useChat.getState().appendStream({
      type: "sub-agent-end",
      subAgentId: "sa-3",
      status: "completed",
    });

    const state = useChat.getState();
    const sa = state.subAgents.find((s) => s.id === "sa-3");
    expect(sa?.status).toBe("completed");
    expect(sa?.completedAt).toBeDefined();
  });

  it("sub-agent-end with error marks as failed", () => {
    setupSession();
    useChat.getState().appendStream({
      type: "sub-agent-start",
      subAgentId: "sa-4",
      prompt: "Run test",
      description: "Test runner",
      subagentType: "general",
    });
    useChat.getState().appendStream({
      type: "sub-agent-end",
      subAgentId: "sa-4",
      status: "failed",
      error: "Test timeout",
    });

    const state = useChat.getState();
    const sa = state.subAgents.find((s) => s.id === "sa-4");
    expect(sa?.status).toBe("failed");
    expect(sa?.error).toBe("Test timeout");
  });
});
