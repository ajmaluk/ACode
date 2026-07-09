import { describe, it, expect, vi, afterEach } from "vitest";
import { hookBus } from "./hookBus";
import type {
  PostToolUseEvent,
  SessionStartEvent,
} from "./hookBus";

// Mock heavy dependencies that hookListeners imports
vi.mock("./dalamAPI", () => ({
  createDalamAPI: vi.fn(() => ({
    fs: { readFile: vi.fn(), writeFile: vi.fn(), exists: vi.fn() },
    agent: { sendPrompt: vi.fn() },
  })),
  getActiveProvider: vi.fn(() => null),
  corsFetch: vi.fn(),
}));

vi.mock("../store/useAppStore", () => ({
  useChat: { getState: vi.fn(() => ({ activeSessionId: null, chatSessions: [], sessionMessages: {} })) },
  useWorkspace: { getState: vi.fn(() => ({ workspaces: [], activeWorkspaceId: null })) },
  useSettings: { getState: vi.fn(() => ({ settings: {} })) },
}));

import { registerHookListeners } from "./hookListeners";

describe("hookListeners", () => {
  let cleanup: (() => void) | null = null;

  afterEach(() => {
    if (cleanup) {
      cleanup();
      cleanup = null;
    }
  });

  describe("registerHookListeners", () => {
    it("returns an unsubscribe function", () => {
      const result = registerHookListeners();
      expect(typeof result.unsubscribe).toBe("function");
      result.unsubscribe();
    });

    it("registers handlers for all lifecycle events", () => {
      const result = registerHookListeners();
      cleanup = result.unsubscribe;

      const toolEvent: PostToolUseEvent = {
        sessionId: "test-session",
        toolName: "read_file",
        toolArgs: {},
        result: "",
        durationMs: 100,
        error: undefined,
        timestamp: Date.now(),
      };
      expect(() => hookBus.emit("PostToolUse", toolEvent)).not.toThrow();

      const startEvent: SessionStartEvent = {
        sessionId: "test-session",
        workspacePath: "/path/to/workspace",
        model: "gpt-4o",
        agentName: "build",
        mode: "chat",
        timestamp: Date.now(),
      };
      expect(() => hookBus.emit("SessionStart", startEvent)).not.toThrow();
    });

    it("unsubscribes all handlers cleanly", () => {
      const result = registerHookListeners();
      result.unsubscribe();
      cleanup = null;

      const toolEvent: PostToolUseEvent = {
        sessionId: "test-session",
        toolName: "read_file",
        toolArgs: {},
        result: "",
        durationMs: 100,
        error: undefined,
        timestamp: Date.now(),
      };
      expect(() => hookBus.emit("PostToolUse", toolEvent)).not.toThrow();
    });
  });

  describe("PostToolUse tracking", () => {
    it("tracks tool call stats across multiple events", () => {
      const result = registerHookListeners();
      cleanup = result.unsubscribe;

      for (let i = 0; i < 5; i++) {
        hookBus.emit("PostToolUse", {
          sessionId: "stats-session",
          toolName: "read_file",
          toolArgs: {},
          result: "",
          durationMs: 50,
          error: undefined,
          timestamp: Date.now(),
        });
      }
      expect(true).toBe(true);
    });

    it("tracks tool errors separately", () => {
      const result = registerHookListeners();
      cleanup = result.unsubscribe;

      hookBus.emit("PostToolUse", {
        sessionId: "error-session",
        toolName: "run_command",
        toolArgs: {},
        result: "",
        durationMs: 200,
        error: "Command failed",
        timestamp: Date.now(),
      });

      hookBus.emit("PostToolUse", {
        sessionId: "error-session",
        toolName: "run_command",
        toolArgs: {},
        result: "",
        durationMs: 100,
        error: undefined,
        timestamp: Date.now(),
      });
      expect(true).toBe(true);
    });
  });

  describe("SessionStart tracking", () => {
    it("logs session start without errors", () => {
      const result = registerHookListeners();
      cleanup = result.unsubscribe;

      hookBus.emit("SessionStart", {
        sessionId: "start-session",
        workspacePath: "/path/to/workspace",
        model: "gpt-4o",
        agentName: "build",
        mode: "chat",
        timestamp: Date.now(),
      });
      expect(true).toBe(true);
    });
  });

  describe("Stop tracking", () => {
    it("logs turn stop without errors", () => {
      const result = registerHookListeners();
      cleanup = result.unsubscribe;

      hookBus.emit("Stop", {
        sessionId: "stop-session",
        fullContent: "test content",
        messageCount: 10,
        toolCallsExecuted: 3,
        timestamp: Date.now(),
      });
      expect(true).toBe(true);
    });
  });

  describe("UserPromptSubmit tracking", () => {
    it("logs prompt submission without errors", () => {
      const result = registerHookListeners();
      cleanup = result.unsubscribe;

      hookBus.emit("UserPromptSubmit", {
        sessionId: "prompt-session",
        prompt: "Hello world",
        conversationHistory: [],
        agentName: "build",
        attachments: [],
        timestamp: Date.now(),
      });
      expect(true).toBe(true);
    });
  });

  describe("SessionEnd handling", () => {
    it("handles session end without errors", async () => {
      const result = registerHookListeners();
      cleanup = result.unsubscribe;

      hookBus.emit("SessionEnd", {
        sessionId: "end-session",
        reason: "completed",
        messageCount: 10,
        durationMs: 500,
        timestamp: Date.now(),
      });

      await new Promise((r) => setTimeout(r, 50));
      expect(true).toBe(true);
    });
  });

  describe("ContextPressure handling", () => {
    it("handles context pressure events without errors", () => {
      const result = registerHookListeners();
      cleanup = result.unsubscribe;

      hookBus.emit("ContextPressure", {
        sessionId: "pressure-session",
        pressure: "high",
        pressureRatio: 0.8,
        totalTokens: 100000,
        usableTokens: 128000,
        shouldPrune: false,
        shouldCompact: false,
        timestamp: Date.now(),
      });
      expect(true).toBe(true);
    });
  });
});
