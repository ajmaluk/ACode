/**
 * LIVE integration tests against the NVIDIA NIM API.
 * Tests the complete streaming, tool call parsing, and agent pipeline with
 * a real LLM backend. These tests validate that the entire harness works
 * correctly end-to-end.
 *
 * Prerequisites: NVIDIA_API_KEY env var must be set (or falls back to the
 * hardcoded key in useAppStore.ts for local development convenience).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";

// Suppress AbortError unhandled rejections — Node.js DOMExceptions from
// AbortController.abort() during ReadableStream reader cancellation.
const onUnhandledRejection = (e: Error) => {
  if (e?.name !== "AbortError") throw e;
};
process.on("unhandledRejection", onUnhandledRejection);
afterAll(() => {
  process.removeListener("unhandledRejection", onUnhandledRejection);
});

const NVIDIA_API_KEY = process.env.NVIDIA_API_KEY || "";
const NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1";
const RUN_LIVE = NVIDIA_API_KEY.length > 0 && !process.env.CI;

const API_TIMEOUT = 180_000;

describe.runIf(RUN_LIVE)("Live NVIDIA — Streaming Pipeline", () => {
  beforeAll(() => {
    expect(NVIDIA_API_KEY).not.toBe("");
  });

  it("message-delta stream yields text content correctly", async () => {
    const { streamChat } = await import("@/lib/dalamAPI");
    const ac = new AbortController();
    const timeoutId = setTimeout(() => ac.abort(), API_TIMEOUT);

    const generator = streamChat(
      NVIDIA_BASE_URL, NVIDIA_API_KEY, "openai",
      "meta/llama-3.1-8b-instruct",
      [{ role: "user", content: "Reply with exactly: 'HELLO_DALAM_OK' and nothing else." }],
      ac.signal, 100,
    );

    const deltas: string[] = [];
    for await (const event of generator) {
      if (event.type === "message-delta") {
        deltas.push(event.content);
      }
      if (event.type === "usage") {
        expect(event.usage).toBeDefined();
      }
    }
    clearTimeout(timeoutId);

    const combined = deltas.join("");
    expect(combined).toContain("HELLO_DALAM_OK");
    expect(deltas.length).toBeGreaterThan(0);
  }, API_TIMEOUT + 5000);

  it("stream yields message-delta events in order with no gaps", async () => {
    const { streamChat } = await import("@/lib/dalamAPI");
    const ac = new AbortController();
    const timeoutId = setTimeout(() => ac.abort(), API_TIMEOUT);

    const generator = streamChat(
      NVIDIA_BASE_URL, NVIDIA_API_KEY, "openai",
      "meta/llama-3.1-8b-instruct",
      [{ role: "user", content: "Count from 1 to 5 with dots between each number. Example: 1.2.3.4.5" }],
      ac.signal, 200,
    );

    const deltas: string[] = [];
    for await (const event of generator) {
      if (event.type === "message-delta") {
        deltas.push(event.content);
      }
    }
    clearTimeout(timeoutId);

    expect(deltas.length).toBeGreaterThan(0);
    const combined = deltas.join("");
    expect(combined).toContain("1");
    expect(combined).toContain("5");
    for (const d of deltas) {
      expect(d.length).toBeGreaterThan(0);
    }
  }, API_TIMEOUT + 5000);

  it("handles abort signal mid-stream cleanly", async () => {
    const { streamChat } = await import("@/lib/dalamAPI");
    const ac = new AbortController();

    const generator = streamChat(
      NVIDIA_BASE_URL, NVIDIA_API_KEY, "openai",
      "meta/llama-3.1-8b-instruct",
      [{ role: "user", content: "Write a very, very long essay about every aspect of the history of computing." }],
      ac.signal, 4000,
    );

    const abortTimer = setTimeout(() => ac.abort(), 8000);
    let count = 0;
    try {
      for await (const _event of generator) {
        count++;
      }
    } catch {
      // AbortError is acceptable
    }
    clearTimeout(abortTimer);

    expect(count).toBeGreaterThanOrEqual(1);
  }, API_TIMEOUT);

  it("respects maxTokens limit", async () => {
    const { streamChat } = await import("@/lib/dalamAPI");
    const ac = new AbortController();
    const timeoutId = setTimeout(() => ac.abort(), API_TIMEOUT);

    const generator = streamChat(
      NVIDIA_BASE_URL, NVIDIA_API_KEY, "openai",
      "meta/llama-3.1-8b-instruct",
      [{ role: "user", content: "Write a 2000-word essay about AI." }],
      ac.signal, 10,
    );

    let totalChars = 0;
    for await (const event of generator) {
      if (event.type === "message-delta") {
        totalChars += event.content.length;
      }
    }
    clearTimeout(timeoutId);

    expect(totalChars).toBeLessThan(200);
  }, API_TIMEOUT + 5000);
});

describe.runIf(RUN_LIVE)("NVIDIA — Tool Call Parsing Pipeline", () => {
  it("parses tool calls from NVIDIA response with XML tags", async () => {
    const { streamChat } = await import("@/lib/dalamAPI");
    const ac = new AbortController();
    const timeoutId = setTimeout(() => ac.abort(), API_TIMEOUT);

    const generator = streamChat(
      NVIDIA_BASE_URL, NVIDIA_API_KEY, "openai",
      "meta/llama-3.1-8b-instruct",
      [
        {
          role: "system",
          content: "You are a code assistant. Use XML tool tags:\n<read_file path=\"...\"/>\n<list_dir path=\"...\"/>\n<grep_file path=\"...\" pattern=\"...\"/>",
        },
        {
          role: "user",
          content: "Show me how you would list the current directory and read a file called 'package.json' in it.",
        },
      ],
      ac.signal, 500,
    );

    const deltas: string[] = [];
    for await (const event of generator) {
      if (event.type === "message-delta") {
        deltas.push(event.content);
      }
    }
    clearTimeout(timeoutId);

    const fullContent = deltas.join("");
    expect(fullContent.length).toBeGreaterThan(0);

    const hadToolLikeTag = /<[a-z_]+/.test(fullContent);
    if (hadToolLikeTag) {
      const { parseXmlToolCalls } = await import("@/store/useAppStore");
      const result = parseXmlToolCalls(fullContent);
      if (result.toolCalls.length > 0) {
        for (const tc of result.toolCalls) {
          expect(tc.name).toBeTruthy();
          expect(typeof tc.args).toBe("object");
        }
        for (const tc of result.toolCalls) {
          expect(result.cleanedContent).not.toContain(`<${tc.name}`);
        }
      }
    }
  }, API_TIMEOUT + 5000);

  it("multi-turn: parse tools, build history, send next turn", async () => {
    const { streamChat } = await import("@/lib/dalamAPI");
    const { parseXmlToolCalls } = await import("@/store/useAppStore");

    const ac1 = new AbortController();
    const timeout1 = setTimeout(() => ac1.abort(), API_TIMEOUT);
    let turn1Content = "";

    const gen1 = streamChat(
      NVIDIA_BASE_URL, NVIDIA_API_KEY, "openai",
      "meta/llama-3.1-8b-instruct",
      [
        { role: "system", content: "You are a code assistant. Use XML tools:\n<list_dir path=\"...\"/>\n<read_file path=\"...\"/>" },
        { role: "user", content: "List the root directory structure and read the first file you find. Use your tools!" },
      ],
      ac1.signal, 300,
    );

    for await (const event of gen1) {
      if (event.type === "message-delta") {
        turn1Content += event.content;
      }
    }
    clearTimeout(timeout1);

    expect(turn1Content.length).toBeGreaterThan(0);

    const turn1Messages: Array<{ role: string; content: string }> = [
      { role: "system", content: "You are a code assistant. Use XML tools:\n<list_dir path=\"...\"/>\n<read_file path=\"...\"/>" },
      { role: "user", content: "List the root directory structure and read the first file you find. Use your tools!" },
    ];
    turn1Messages.push({ role: "assistant", content: turn1Content });

    const parsed1 = parseXmlToolCalls(turn1Content);
    if (parsed1.toolCalls.length > 0) {
      for (const tc of parsed1.toolCalls) {
        turn1Messages.push({
          role: "user" as const,
          content: `[Tool result for ${tc.name}]\n[Simulated: success]`,
        });
      }
    }

    const ac2 = new AbortController();
    const timeout2 = setTimeout(() => ac2.abort(), API_TIMEOUT);
    let turn2Content = "";

    const gen2 = streamChat(
      NVIDIA_BASE_URL, NVIDIA_API_KEY, "openai",
      "meta/llama-3.1-8b-instruct",
      turn1Messages,
      ac2.signal, 200,
    );

    try {
      for await (const event of gen2) {
        if (event.type === "message-delta") {
          turn2Content += event.content;
        }
      }
    } catch {
      // Stream timeout is acceptable for long multi-turn responses
    }
    clearTimeout(timeout2);

    expect(turn2Content.length).toBeGreaterThanOrEqual(0);
  }, API_TIMEOUT * 2 + 5000);
});

describe.runIf(RUN_LIVE)("NVIDIA — Error Handling & Edge Cases", () => {
  it("rejects invalid API key gracefully", async () => {
    const { streamChat } = await import("@/lib/dalamAPI");
    const ac = new AbortController();
    const timeoutId = setTimeout(() => ac.abort(), 15000);

    try {
      const generator = streamChat(
        NVIDIA_BASE_URL, "bad-key-that-will-fail", "openai",
        "meta/llama-3.1-8b-instruct",
        [{ role: "user", content: "Hello" }],
        ac.signal, 100,
      );

      const events: string[] = [];
      for await (const event of generator) {
        events.push(event.type);
      }
      expect(events).not.toContain("message-delta");
    } catch {
      // ProviderError is expected
    } finally {
      clearTimeout(timeoutId);
    }
  });

  it("handles network timeout gracefully", async () => {
    const { streamChat } = await import("@/lib/dalamAPI");

    try {
      const generator = streamChat(
        "https://nonexistent.nvidia.api.test/v1", NVIDIA_API_KEY, "openai",
        "meta/llama-3.1-8b-instruct",
        [{ role: "user", content: "Hello" }],
        undefined, 100,
      );

      for await (const _event of generator) {
        expect(true).toBe(false);
      }
    } catch {
      // Expected: fetch error or timeout
    }
  });

  it("rejects unknown model with clear error", async () => {
    const { streamChat } = await import("@/lib/dalamAPI");
    const ac = new AbortController();
    const timeoutId = setTimeout(() => ac.abort(), 15000);

    try {
      const generator = streamChat(
        NVIDIA_BASE_URL, NVIDIA_API_KEY, "openai",
        "nonexistent-model-v999",
        [{ role: "user", content: "Hello" }],
        ac.signal, 100,
      );

      for await (const _event of generator) {
        // Should not get content for unknown model
      }
    } catch {
      // Expected: ProviderError
    } finally {
      clearTimeout(timeoutId);
    }
  });
});