/**
 * Unit tests for session/restore invariants in the chat store.
 *
 * These tests verify that:
 * 1. confirmVersionRestore() clears pendingToolCalls, pendingActivities, _pendingChanges
 * 2. cancelVersionRestore() clears pendingToolCalls, pendingActivities, _pendingChanges
 * 3. saveVersion() strips diff/diffId from tool calls before persisting version snapshots
 */

import { describe, it, expect, beforeEach } from "vitest";
import { useChat } from "./useAppStore";

// Helper to set up a minimal chat state with transient tool artifacts
function setupChatState() {
  useChat.setState({
    // Must set session and activeSessionId for saveVersion to work
    session: {
      id: "test-session",
      workspacePath: "/test",
      model: "gpt-4o",
      mode: "build",
      startedAt: Date.now(),
      messages: [],
      status: "idle" as const,
    },
    activeSessionId: "test-session",
    messages: [
      {
        id: "msg-1",
        role: "assistant" as const,
        content: "Let me read that file.",
        timestamp: Date.now(),
        toolCalls: [
          {
            id: "tc-1",
            name: "read_file",
            args: { path: "/test/src/index.ts" },
            status: "completed" as const,
            diff: {
              diffId: "diff-1",
              filePath: "/test/src/index.ts",
              oldContent: "old",
              newContent: "new",
              hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [{ type: "remove", content: "old", oldLineNumber: 1 }, { type: "add", content: "new", newLineNumber: 1 }] }],
              createdAt: Date.now(),
            },
            diffId: "diff-1",
          },
          {
            id: "tc-2",
            name: "write_file",
            args: { path: "/test/src/new.ts", content: "new content" },
            status: "completed" as const,
            diff: {
              diffId: "diff-2",
              filePath: "/test/src/new.ts",
              oldContent: "",
              newContent: "new content",
              hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, lines: [{ type: "add", content: "new content", newLineNumber: 1 }] }],
              createdAt: Date.now(),
            },
            diffId: "diff-2",
          },
        ],
      },
    ],
    pendingToolCalls: [
      {
        id: "pending-tc-1",
        name: "write_file",
        args: { path: "/test/src/another.ts", content: "pending content" },
        status: "awaiting-approval" as const,
      },
    ],
    pendingActivities: [
      {
        id: "activity-1",
        type: "think",
        content: "Writing file...",
      } as const,
    ],
    _pendingChanges: [
      { path: "/test/src/another.ts", action: "modified" as const, additions: 5, deletions: 0 },
    ],
    restoredVersionId: "ver-123",
    preRestoreMessages: [
      {
        id: "msg-original",
        role: "user" as const,
        content: "Make some changes",
        timestamp: Date.now() - 10000,
      },
    ],
    sessionMessages: {
      "test-session": [
        {
          id: "msg-original",
          role: "user" as const,
          content: "Make some changes",
          timestamp: Date.now() - 10000,
        },
      ],
    },
    chatSessions: [
      {
        id: "test-session",
        workspacePath: "/test",
        workspaceName: "test",
        title: "Test session",
        agentName: "build",
        mode: "build" as const,
        model: "gpt-4o",
        startedAt: Date.now() - 10000,
        lastActivityAt: Date.now() - 10000,
        lastVisitedAt: Date.now() - 10000,
        messageCount: 1,
        status: "idle" as const,
        versionCount: 0,
      },
    ],
    sessionVersions: {},
    isStreaming: false,
  });
}

// Helper to check that transient tool state is fully cleared
function expectTransientStateCleared() {
  const state = useChat.getState();
  expect(state.pendingToolCalls).toEqual([]);
  expect(state.pendingActivities).toEqual([]);
  expect(state._pendingChanges).toEqual([]);
}

describe("confirmVersionRestore", () => {
  beforeEach(() => {
    // Reset the store before each test
    useChat.setState({
      session: null,
      messages: [],
      pendingToolCalls: [],
      pendingActivities: [],
      _pendingChanges: [],
      preRestoreMessages: null,
      restoredVersionId: null,
      streamingContent: "",
      thinkingContent: "",
      isStreaming: false,
      streamingStartedAt: null,
      todos: [],
      taskPlan: null,
      taskPlanSummary: null,
      planApproval: null,
      _sendInProgress: false,
      messageQueue: [],
      _suppressSessionRestore: false,
      subAgents: [],
      doomLoopWarningCount: 0,
      chatSessions: [],
      sessionMessages: {},
      sessionVersions: {},
      compactionSummaries: {},
      pendingAttachments: [],
      _userSelectedAgent: false,
      chatHistory: [],
      chatHistoryIdx: -1,
      activeSessionId: null,
      selectedModelId: "",
      activeAgentName: "build" as const,
    });
  });

  it("clears pendingToolCalls, pendingActivities, and _pendingChanges when confirming a version restore", () => {
    setupChatState();

    // Verify transient state exists before calling confirmVersionRestore
    const before = useChat.getState();
    expect(before.pendingToolCalls.length).toBeGreaterThan(0);
    expect(before.pendingActivities.length).toBeGreaterThan(0);
    expect(before._pendingChanges.length).toBeGreaterThan(0);
    expect(before.restoredVersionId).not.toBeNull();
    expect(before.preRestoreMessages).not.toBeNull();

    // Execute the restore confirmation
    useChat.getState().confirmVersionRestore();

    // Verify transient state is cleared
    expectTransientStateCleared();
    expect(useChat.getState().restoredVersionId).toBeNull();
    expect(useChat.getState().preRestoreMessages).toBeNull();
  });

  it("preserves the restored messages in sessionMessages after confirmation", () => {
    setupChatState();

    useChat.getState().confirmVersionRestore();

    const state = useChat.getState();
    // The restored messages should be set as the session messages
    const restoredMessages = state.sessionMessages["test-session"];
    expect(restoredMessages).toBeDefined();
    // The messages array should contain the original pre-restore messages
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].content).toBe("Let me read that file.");
  });

  it("handles the else branch when no activeSessionId", () => {
    setupChatState();
    // Clear activeSessionId to test the else branch
    useChat.setState({ activeSessionId: null });

    useChat.getState().confirmVersionRestore();

    // Should still clear transient state even without active session
    expectTransientStateCleared();
  });
});

describe("cancelVersionRestore", () => {
  beforeEach(() => {
    useChat.setState({
      session: null,
      messages: [],
      pendingToolCalls: [],
      pendingActivities: [],
      _pendingChanges: [],
      preRestoreMessages: null,
      restoredVersionId: null,
      streamingContent: "",
      thinkingContent: "",
      isStreaming: false,
      streamingStartedAt: null,
      todos: [],
      taskPlan: null,
      taskPlanSummary: null,
      planApproval: null,
      _sendInProgress: false,
      messageQueue: [],
      _suppressSessionRestore: false,
      subAgents: [],
      doomLoopWarningCount: 0,
      chatSessions: [],
      sessionMessages: {},
      sessionVersions: {},
      compactionSummaries: {},
      pendingAttachments: [],
      _userSelectedAgent: false,
      chatHistory: [],
      chatHistoryIdx: -1,
      activeSessionId: null,
      selectedModelId: "",
      activeAgentName: "build" as const,
    });
  });

  it("clears pendingToolCalls, pendingActivities, and _pendingChanges when cancelling a version restore", () => {
    setupChatState();

    // Verify transient state exists
    const before = useChat.getState();
    expect(before.pendingToolCalls.length).toBeGreaterThan(0);
    expect(before.pendingActivities.length).toBeGreaterThan(0);
    expect(before._pendingChanges.length).toBeGreaterThan(0);
    expect(before.restoredVersionId).not.toBeNull();
    expect(before.preRestoreMessages).not.toBeNull();

    // Execute the cancel
    useChat.getState().cancelVersionRestore();

    // Verify transient state is cleared
    expectTransientStateCleared();
    expect(useChat.getState().restoredVersionId).toBeNull();
    expect(useChat.getState().preRestoreMessages).toBeNull();
  });

  it("restores preRestoreMessages as current messages after cancellation", () => {
    setupChatState();

    useChat.getState().cancelVersionRestore();

    const state = useChat.getState();
    // The preRestoreMessages should be restored as the current messages
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].content).toBe("Make some changes");
    expect(state.messages[0].role).toBe("user");
  });

  it("does nothing when preRestoreMessages is null", () => {
    setupChatState();
    useChat.setState({ preRestoreMessages: null });

    // Save the current messages before calling cancel
    const messagesBefore = useChat.getState().messages;

    // Should return early without modifying anything
    useChat.getState().cancelVersionRestore();

    const state = useChat.getState();
    // Messages should remain unchanged
    expect(state.messages).toEqual(messagesBefore);
  });

  it("does nothing when activeSessionId is null", () => {
    setupChatState();
    useChat.setState({ activeSessionId: null });

    // Should return early
    useChat.getState().cancelVersionRestore();

    // Messages should remain unchanged
    expect(useChat.getState().messages.length).toBeGreaterThan(0);
  });
});

describe("saveVersion", () => {
  beforeEach(() => {
    useChat.setState({
      session: null,
      messages: [],
      pendingToolCalls: [],
      pendingActivities: [],
      _pendingChanges: [],
      preRestoreMessages: null,
      restoredVersionId: null,
      streamingContent: "",
      thinkingContent: "",
      isStreaming: false,
      streamingStartedAt: null,
      todos: [],
      taskPlan: null,
      taskPlanSummary: null,
      planApproval: null,
      _sendInProgress: false,
      messageQueue: [],
      _suppressSessionRestore: false,
      subAgents: [],
      doomLoopWarningCount: 0,
      chatSessions: [],
      sessionMessages: {},
      sessionVersions: {},
      compactionSummaries: {},
      pendingAttachments: [],
      _userSelectedAgent: false,
      chatHistory: [],
      chatHistoryIdx: -1,
      activeSessionId: null,
      selectedModelId: "",
      activeAgentName: "build" as const,
    });
  });

  it("strips diff and diffId from tool calls in saved version messages", () => {
    setupChatState();

    // Call saveVersion to create a version snapshot
    useChat.getState().saveVersion("test-session", "Test checkpoint");

    // Get the saved version
    const state = useChat.getState();
    const versions = state.sessionVersions["test-session"];
    expect(versions).toBeDefined();
    expect(versions.length).toBeGreaterThan(0);

    const savedVersion = versions[versions.length - 1];
    expect(savedVersion.label).toBe("Test checkpoint");

    // Verify the saved messages have no diff/diffId on tool calls
    for (const msg of savedVersion.messages) {
      if (msg.toolCalls) {
        for (const tc of msg.toolCalls) {
          // diff and diffId should be undefined (stripped)
          expect(tc.diff).toBeUndefined();
          expect(tc.diffId).toBeUndefined();
        }
      }
    }
  });

  it("preserves other tool call properties when stripping diff artifacts", () => {
    setupChatState();

    useChat.getState().saveVersion("test-session", "Preserve test");

    const state = useChat.getState();
    const versions = state.sessionVersions["test-session"];
    const savedVersion = versions[versions.length - 1];

    // Verify essential tool call properties are preserved
    const savedMsg = savedVersion.messages.find(m => m.toolCalls);
    expect(savedMsg).toBeDefined();

    for (const tc of savedMsg!.toolCalls!) {
      expect(tc.id).toBeDefined();
      expect(tc.name).toBeDefined();
      expect(tc.args).toBeDefined();
      expect(tc.status).toBeDefined();
    }
  });

  it("preserves messages without tool calls as-is", () => {
    setupChatState();
    // Add a message without tool calls
    const messages = [
      ...useChat.getState().messages,
      {
        id: "msg-plain",
        role: "user" as const,
        content: "This is a plain message without tool calls.",
        timestamp: Date.now(),
      },
    ];
    useChat.setState({ messages });

    useChat.getState().saveVersion("test-session", "Plain message test");

    const state = useChat.getState();
    const versions = state.sessionVersions["test-session"];
    const savedVersion = versions[versions.length - 1];

    // Verify both messages are in the saved version
    expect(savedVersion.messages.length).toBe(2);

    // Verify the plain message is preserved exactly
    const plainMsg = savedVersion.messages.find(m => m.id === "msg-plain");
    expect(plainMsg).toBeDefined();
    expect(plainMsg!.content).toBe("This is a plain message without tool calls.");
    expect(plainMsg!.role).toBe("user");
  });

  it("returns early when there are no messages", () => {
    // Set empty messages
    useChat.setState({
      messages: [],
      session: {
        id: "empty-session",
        workspacePath: "/test",
        model: "gpt-4o",
        mode: "build",
        startedAt: Date.now(),
        messages: [],
        status: "idle",
      },
      activeSessionId: "empty-session",
      sessionVersions: {},
    });

    // Should return early without creating a version
    useChat.getState().saveVersion("empty-session", "Should not appear");

    const versions = useChat.getState().sessionVersions["empty-session"];
    expect(versions).toBeUndefined();
  });
});
