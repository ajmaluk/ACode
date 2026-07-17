/**
 * Tests for executeSubAgentTask — the sub-agent loop.
 *
 * Covers:
 *   1. Tool failure counting (Fix #1) — consecutiveToolErrors breaks after 3 failures
 *   2. Abort race guard (Fix #2) — pre-aborted signal exits early
 *   3. subResult cleanup (Fix #3) — XML tool tags stripped from accumulated output
 *   4. Dead try/catch removal (Fix #4) — errors flow without sync wrapper
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { executeSubAgentTask } from "../dalamAPI";

// ─── Controllable mocks @tauri-apps/plugin-http ──────────────
// corsFetch tries @tauri-apps/plugin-http first. Mock it to throw ReferenceError
// so corsFetch falls through to global fetch (which we stub per-test).
const mockTauriFetch = vi.hoisted(() =>
  vi.fn().mockRejectedValue(
    new ReferenceError("window.__TAURI__ not available — falling back to browser fetch"),
  ),
);

vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: mockTauriFetch,
}));

// ─── Controllable mocks for @tauri-apps/plugin-fs ────────────
// Use controllable mock functions so different tests can set different behavior.
// vi.mock is hoisted, so define these at module level.
const mockReadTextFile = vi.fn();
const mockReadFile = vi.fn();

vi.mock("@tauri-apps/plugin-fs", () => ({
  readTextFile: mockReadTextFile,
  readFile: mockReadFile,
}));

// ─── SSE Helpers ─────────────────────────────────────────────

function sseData(chunk: Record<string, unknown>): string {
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

/** Create a fresh SSE streaming Response each call. */
function freshSSEResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

// ─── Setup ───────────────────────────────────────────────────

beforeEach(() => {
  localStorage.clear();

  // Set up a valid provider in localStorage so getActiveProvider() works
  localStorage.setItem(
    "dalam.settings.v1",
    JSON.stringify({
      selectedProvider: "test-provider",
      selectedModel: "gpt-4o",
    }),
  );
  localStorage.setItem(
    "dalam.provider.test-provider",
    JSON.stringify({
      baseUrl: "https://api.test.com/v1",
      apiKey: "sk-test-key",
      apiFormat: "openai",
    }),
  );

  // Default: fs functions resolve successfully
  mockReadTextFile.mockResolvedValue("mock file content");
  mockReadFile.mockResolvedValue(new Uint8Array([109, 111, 99, 107])); // "mock"
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

// ============================================================================
// Fix #2: Abort race guard
// ============================================================================

describe("abort race guard (Fix #2)", () => {
  it("returns early when signal is pre-aborted", async () => {
    const ac = new AbortController();
    ac.abort();

    const emit = vi.fn();
    const result = await executeSubAgentTask(
      { prompt: "test task" },
      "parent-session",
      "/workspace",
      emit,
      ac.signal,
    );

    // Structured task wrapper (OpenCode-style) with error state when aborted pre-start
    expect(result).toContain('<task');
    expect(result).toContain('state="error"');
    expect(result).toMatch(/Sub-agent (completed with no output|failed)/);

    // Should have emitted sub-agent-start and sub-agent-end
    const startEvents = emit.mock.calls.filter(
      (args: unknown[]) => (args[0] as { type: string }).type === "sub-agent-start",
    );
    expect(startEvents).toHaveLength(1);

    const endEvents = emit.mock.calls.filter(
      (args: unknown[]) => (args[0] as { type: string }).type === "sub-agent-end",
    );
    expect(endEvents).toHaveLength(1);

    // With aborted signal and no subResult, status should be "failed"
    expect((endEvents[0][0] as { status: string }).status).toBe("failed");
  });
});

// ============================================================================
// Fix #3: subResult cleanup
// ============================================================================

describe("subResult cleanup (Fix #3)", () => {
  it("accumulates clean text when stream yields no tool calls", async () => {
    // Return a fresh SSE response on each call to fetch
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() =>
        Promise.resolve(
          freshSSEResponse([
            sseData({
              id: "chatcmpl-1",
              object: "chat.completion.chunk",
              choices: [
                {
                  index: 0,
                  delta: {
                    content: "Hello from sub-agent. I found the answer.",
                  },
                  finish_reason: null,
                },
              ],
            }),
            sseData({
              id: "chatcmpl-1",
              object: "chat.completion.chunk",
              choices: [
                {
                  index: 0,
                  delta: {},
                  finish_reason: "stop",
                },
              ],
            }),
            "data: [DONE]\n\n",
          ]),
        ),
      ),
    );

    const emit = vi.fn();
    const ac = new AbortController();
    const result = await executeSubAgentTask(
      { prompt: "Find the answer" },
      "sess-2",
      "/ws",
      emit,
      ac.signal,
    );

    expect(result).toContain("Hello from sub-agent");
    expect(result).toContain("I found the answer");
    // Structured task wrapper for parent agent (OpenCode pattern)
    expect(result).toContain("<task");
    expect(result).toContain("<task_result>");
    expect(result).toContain("task_id=");
    // Must not contain tool-call XML (read_file etc.) in the result body
    expect(result).not.toMatch(/<read_file|<write_file|<run_command/);
  });

  it("strips XML tool tags from accumulated output", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn()
        // First iteration: text with tool call
        .mockImplementationOnce(() =>
          Promise.resolve(
            freshSSEResponse([
              sseData({
                id: "cmpl-1",
                object: "chat.completion.chunk",
                choices: [
                  {
                    index: 0,
                    delta: {
                      content:
                        'Let me check:<read_file path="/test/file.ts"/>There it is.',
                    },
                    finish_reason: "stop",
                  },
                ],
              }),
              "data: [DONE]\n\n",
            ]),
          ),
        )
        // Second iteration: final answer (no tools)
        .mockImplementationOnce(() =>
          Promise.resolve(
            freshSSEResponse([
              sseData({
                id: "cmpl-2",
                object: "chat.completion.chunk",
                choices: [
                  {
                    index: 0,
                    delta: { content: "Here is the result." },
                    finish_reason: "stop",
                  },
                ],
              }),
              "data: [DONE]\n\n",
            ]),
          ),
        ),
    );

    const emit = vi.fn();
    const ac = new AbortController();
    const result = await executeSubAgentTask(
      { prompt: "Read the file" },
      "sess-3",
      "/ws",
      emit,
      ac.signal,
    );

    // Text from both iterations should be present
    expect(result).toContain("Let me check");
    expect(result).toContain("There it is.");
    expect(result).toContain("Here is the result.");

    // XML tool tags should be stripped from the task result body
    expect(result).not.toContain("<read_file");
    expect(result).toContain("<task_result>");
  });
});

// ============================================================================
// Fix #1: Tool failure counting
// ============================================================================

describe("tool failure counting (Fix #1)", () => {
  it("fails after 3 consecutive tool failures with no output progress", async () => {
    // Make fs functions throw so tool execution fails
    mockReadFile.mockRejectedValue(new Error("File not found"));
    mockReadTextFile.mockRejectedValue(new Error("File not found"));

    // Each call returns content with ONLY a tool call (no surrounding text)
    // so subResult stays empty and consecutiveToolErrors triggers
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() =>
        Promise.resolve(
          freshSSEResponse([
            sseData({
              id: "cmpl-fail",
              object: "chat.completion.chunk",
              choices: [
                {
                  index: 0,
                  delta: {
                    content: '<read_file path="/nonexistent/file.ts"/>',
                  },
                  finish_reason: "stop",
                },
              ],
            }),
            "data: [DONE]\n\n",
          ]),
        ),
      ),
    );

    const emit = vi.fn();
    const ac = new AbortController();
    const result = await executeSubAgentTask(
      { prompt: "Read the file" },
      "sess-4",
      "/ws",
      emit,
      ac.signal,
    );

    // The sub-agent should have failed due to consecutive tool errors
    // Find sub-agent-end events to verify status
    const endEvents = emit.mock.calls.filter(
      (args: unknown[]) =>
        (args[0] as { type: string }).type === "sub-agent-end",
    );

    // Should have one end event
    expect(endEvents.length).toBe(1);
    const endEvent = endEvents[0][0] as { status: string; error?: string };

    // Status should be "failed" due to consecutive tool errors
    expect(endEvent.status).toBe("failed");
    if (endEvent.error) {
      expect(endEvent.error).toContain("failed");
    }
  });
});

// ============================================================================
// Fix #4: Dead try/catch removal — error propagation
// ============================================================================

describe("dead try/catch removal (Fix #4)", () => {
  it("handles stream error and continues on next iteration after retries exhausted", async () => {
    // fetchWithRetry makes up to 3 attempts (initial + 2 retries).
    // The first 3 fetch calls fail (exhausting retries), then the 4th succeeds.
    // Call 4 happens in iteration 2 (sub-agent loop continues after error).
    let fetchAttempts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => {
        fetchAttempts++;
        if (fetchAttempts <= 3) {
          // First 3 calls fail → retries exhausted → error hits outer catch
          return Promise.reject(new Error("Network failure"));
        }
        // 4th call succeeds → second iteration recovers
        return Promise.resolve(
          freshSSEResponse([
            sseData({
              id: "cmpl-retry",
              object: "chat.completion.chunk",
              choices: [
                {
                  index: 0,
                  delta: { content: "Recovered after error." },
                  finish_reason: "stop",
                },
              ],
            }),
            "data: [DONE]\n\n",
          ]),
        );
      }),
    );

    const emit = vi.fn();
    const ac = new AbortController();
    const result = await executeSubAgentTask(
      { prompt: "test recovery" },
      "sess-6",
      "/ws",
      emit,
      ac.signal,
    );

    // Sub-agent should have recovered on the second iteration
    expect(result).toContain("Recovered after error");
  });
});
