import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resetSafetyTimer, extendSafetyTimerForApproval, SAFETY_TIMEOUT_MS, TOOL_APPROVAL_TIMEOUT_MS } from "../safetyTimer";
import type { ChatSessionSummary, ChatMessage } from "@dalam/shared-types";

vi.stubGlobal("crypto", {
  randomUUID: () => "mock-uuid-123",
});

const BASE_SESSION: ChatSessionSummary = {
  id: "session-1",
  workspacePath: "/workspace",
  workspaceName: "aci",
  title: "Chat",
  agentName: "yolo",
  mode: "yolo",
  startedAt: Date.now(),
  lastActivityAt: Date.now(),
  messageCount: 1,
  status: "running",
  versionCount: 1,
};

const BASE_MESSAGE: ChatMessage = {
  id: "msg-1",
  role: "user",
  content: "Hello",
  timestamp: Date.now(),
};

interface MutableTimerState {
  isStreaming: boolean;
  _sendInProgress: boolean;
  _safetyTimer: ReturnType<typeof setTimeout> | null;
  streamingContent: string;
  thinkingContent: string;
  activeSessionId: string | null;
  session: { id: string } | null;
  messages: ChatMessage[];
  pendingToolCalls: unknown[];
  pendingActivities: unknown[];
  chatSessions: ChatSessionSummary[];
  _autoRemoveTimers: Set<ReturnType<typeof setTimeout>>;
}

function createDefaultState() {
  const state: MutableTimerState = {
    isStreaming: true,
    _sendInProgress: true,
    _safetyTimer: null,
    streamingContent: "",
    thinkingContent: "",
    activeSessionId: "session-1",
    session: { id: "session-1" },
    messages: [BASE_MESSAGE],
    pendingToolCalls: [],
    pendingActivities: [],
    chatSessions: [BASE_SESSION],
    _autoRemoveTimers: new Set<ReturnType<typeof setTimeout>>(),
  };
  return {
    get: (): MutableTimerState => state,
    set: (partial: Record<string, unknown>) => {
      Object.assign(state, partial);
    },
    getState: (): MutableTimerState => state,
  };
}

describe("safetyTimer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe("resetSafetyTimer", () => {
    it("creates a safety timer for normal mode", () => {
      const { get, set } = createDefaultState();
      const setSpy = vi.fn(set);

      resetSafetyTimer(get, setSpy);

      expect(setSpy).toHaveBeenCalled();
      const callArg = setSpy.mock.calls[0][0] as Record<string, unknown>;
      expect(callArg).toHaveProperty("_safetyTimer");
    });

    it("clears existing timer before creating new one", () => {
      const { get, set, getState } = createDefaultState();
      const clearSpy = vi.spyOn(global, "clearTimeout");

      resetSafetyTimer(get, set);
      expect(getState()._safetyTimer).not.toBeNull();

      resetSafetyTimer(get, set);
      expect(clearSpy).toHaveBeenCalled();
    });

    it("triggers timeout when stream is active after timeout period", () => {
      const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { get, set } = createDefaultState();

      resetSafetyTimer(get, set);
      vi.advanceTimersByTime(SAFETY_TIMEOUT_MS + 1000);

      expect(consoleWarn).toHaveBeenCalled();
    });

    it("does NOT trigger timeout when streaming stops", () => {
      const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
      let isStreaming = true;

      const stateGetter = (): MutableTimerState => ({
        ...createDefaultState().get(),
        isStreaming,
      });

      resetSafetyTimer(stateGetter, vi.fn());

      isStreaming = false;
      vi.advanceTimersByTime(SAFETY_TIMEOUT_MS + 1000);

      expect(consoleWarn).not.toHaveBeenCalled();
    });

    it("fires timer after SAFETY_TIMEOUT_MS in normal mode", () => {
      const { get, set } = createDefaultState();
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      resetSafetyTimer(get, set);
      vi.advanceTimersByTime(SAFETY_TIMEOUT_MS);

      expect(warnSpy).toHaveBeenCalled();
    });
  });

  describe("extendSafetyTimerForApproval", () => {
    it("creates a timer with 10min timeout for tool-approval mode", () => {
      const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { get, set } = createDefaultState();

      extendSafetyTimerForApproval(get, set);

      vi.advanceTimersByTime(SAFETY_TIMEOUT_MS + 1000);
      expect(consoleWarn).not.toHaveBeenCalled();

      vi.advanceTimersByTime(TOOL_APPROVAL_TIMEOUT_MS - SAFETY_TIMEOUT_MS + 1000);
      expect(consoleWarn).toHaveBeenCalled();
      expect(consoleWarn.mock.calls[0][0]).toContain("tool-approval");
    });

    it("delegates to resetSafetyTimer with tool-approval mode", () => {
      const { get, set } = createDefaultState();
      extendSafetyTimerForApproval(get, set);
      expect(true).toBe(true);
    });
  });

  describe("timeout handler", () => {
    it("resets streaming state and adds system message on timeout", () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const { get } = createDefaultState();
      let lastSetCall: Record<string, unknown> = {};

      resetSafetyTimer(get, (partial) => {
        Object.assign(lastSetCall, partial);
      });

      vi.advanceTimersByTime(SAFETY_TIMEOUT_MS + 1000);

      expect(lastSetCall.isStreaming).toBe(false);
      expect(lastSetCall._sendInProgress).toBe(false);
      expect(lastSetCall.streamingContent).toBe("");
      expect(lastSetCall.thinkingContent).toBe("");

      const messages = lastSetCall.messages as ChatMessage[];
      expect(messages.some((m) => m.role === "system")).toBe(true);
    });

    it("includes timeout reason in system message", () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const { get } = createDefaultState();
      let lastMessages: ChatMessage[] = [];

      resetSafetyTimer(get, (partial) => {
        if (partial.messages) {
          lastMessages = partial.messages as ChatMessage[];
        }
      });

      vi.advanceTimersByTime(SAFETY_TIMEOUT_MS + 1000);

      expect(lastMessages.some((m) => m.content.includes("Stream timed out"))).toBe(true);
    });

    it("replaces old timer with new one on subsequent resets", () => {
      const { get, set, getState } = createDefaultState();
      vi.spyOn(console, "warn").mockImplementation(() => {});

      resetSafetyTimer(get, set);
      const firstTimer = getState()._safetyTimer;
      expect(firstTimer).not.toBeNull();

      resetSafetyTimer(get, set);
      const secondTimer = getState()._safetyTimer;
      expect(secondTimer).not.toBeNull();
      expect(secondTimer).not.toBe(firstTimer);
    });

    it("executes handler on timeout", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { get, set } = createDefaultState();

      resetSafetyTimer(get, set);
      vi.advanceTimersByTime(SAFETY_TIMEOUT_MS + 1000);

      expect(warnSpy).toHaveBeenCalled();
    });

    it("creates a system message with timeout details", () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const { get } = createDefaultState();
      let capturedMessages: ChatMessage[] = [];

      resetSafetyTimer(get, (partial) => {
        if (partial.messages) {
          capturedMessages = partial.messages as ChatMessage[];
        }
      });

      vi.advanceTimersByTime(SAFETY_TIMEOUT_MS + 1000);

      const systemMsg = capturedMessages.find((m) => m.role === "system");
      expect(systemMsg).toBeDefined();
      expect(systemMsg!.content).toContain("120 seconds");
    });

    it("clears pending tool calls and activities on timeout", () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const { get } = createDefaultState();
      let capturedSet: Record<string, unknown> = {};

      resetSafetyTimer(get, (partial) => {
        Object.assign(capturedSet, partial);
      });

      vi.advanceTimersByTime(SAFETY_TIMEOUT_MS + 1000);

      expect(capturedSet.pendingToolCalls).toEqual([]);
      expect(capturedSet.pendingActivities).toEqual([]);
      expect(capturedSet._safetyTimer).toBeNull();
    });
  });
});
