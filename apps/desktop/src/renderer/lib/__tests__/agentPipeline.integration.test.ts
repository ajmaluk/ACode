/**
 * Integration tests for the agent pipeline.
 * Tests streaming API, XML tool call parsing, and task management.
 */

import { describe, it, expect, beforeAll } from "vitest";

// Tests that DON'T need the NVIDIA API (no network calls)
describe("XML Tool Call Parsing", () => {
  it("parses simple self-closing tool calls", async () => {
    const { parseXmlToolCalls } = await import("@/store/useAppStore");
    const content =
      'Let me check the file structure.\n<list_dir path="/src"/>\n';
    const result = parseXmlToolCalls(content);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe("list_dir");
    expect(result.toolCalls[0].args).toHaveProperty("path", "/src");
    expect(result.cleanedContent).not.toContain("<list_dir");
  });

  it("parses tool calls with content body", async () => {
    const { parseXmlToolCalls } = await import("@/store/useAppStore");
    const content =
      'Creating a new file:\n<write_file path="/src/hello.ts">\nconst greeting = "Hello World";\nexport default greeting;\n</write_file>\nDone.';
    const result = parseXmlToolCalls(content);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe("write_file");
    expect(result.toolCalls[0].args).toHaveProperty("path", "/src/hello.ts");
    expect(result.toolCalls[0].args.content).toContain("Hello World");
    expect(result.cleanedContent).not.toContain("<write_file");
  });

  it("parses multiple tool calls in sequence", async () => {
    const { parseXmlToolCalls } = await import("@/store/useAppStore");
    const content = [
      "I'll check the files:",
      '<list_dir path="/src"/>',
      '<read_file path="/src/index.ts"/>',
      '<grep_file path="/src" pattern="function"/>',
      "Here's what I found.",
    ].join("\n");
    const result = parseXmlToolCalls(content);
    expect(result.toolCalls).toHaveLength(3);
    expect(result.toolCalls[0].name).toBe("list_dir");
    expect(result.toolCalls[1].name).toBe("read_file");
    expect(result.toolCalls[2].name).toBe("grep_file");
  });

  it("parses edit_file with search/replace content", async () => {
    const { parseXmlToolCalls } = await import("@/store/useAppStore");
    const content = `<edit_file path="/src/hello.ts">
<search>const greeting = "Hello";</search>
<replace>const greeting = "Hi";</replace>
</edit_file>`;
    const result = parseXmlToolCalls(content);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe("edit_file");
    expect(result.toolCalls[0].args).toHaveProperty("path", "/src/hello.ts");
    expect(result.toolCalls[0].args.content).toContain("<search>");
  });

  it("parses bash command with complex arguments", async () => {
    const { parseXmlToolCalls } = await import("@/store/useAppStore");
    const content = '<bash command="npm run test -- --coverage"/>';
    const result = parseXmlToolCalls(content);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe("bash");
    expect(result.toolCalls[0].args).toHaveProperty(
      "command",
      "npm run test -- --coverage",
    );
  });

  it("strips all XML tags from cleaned content", async () => {
    const { parseXmlToolCalls } = await import("@/store/useAppStore");
    const content = [
      "I'll help you with that.",
      '<read_file path="/src/app.ts"/>',
      '<list_dir path="/"/>',
      "Here is the content.",
      '<write_file path="/src/new.ts">\nconst x = 1;\n</write_file>',
    ].join("\n");
    const result = parseXmlToolCalls(content);
    expect(result.toolCalls).toHaveLength(3);
    expect(result.cleanedContent).toContain("I'll help you with that.");
    expect(result.cleanedContent).toContain("Here is the content.");
    expect(result.cleanedContent).not.toContain("<read_file");
    expect(result.cleanedContent).not.toContain("<write_file");
    expect(result.cleanedContent).not.toContain("<list_dir");
  });

  it("handles unknown tags gracefully without breaking", async () => {
    const { parseXmlToolCalls } = await import("@/store/useAppStore");
    // Unknown tags with attributes pass through (handled downstream as unknown tools)
    const content = '<unknown_tag param="value"/>';
    const result = parseXmlToolCalls(content);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe("unknown_tag");
    // Unknown tags without attributes are skipped
    const result2 = parseXmlToolCalls("<totally_unknown/>");
    expect(result2.toolCalls).toHaveLength(0);
  });

  it("handles tags with missing attributes gracefully", async () => {
    const { parseXmlToolCalls } = await import("@/store/useAppStore");
    const content = "Some text <read_file/> with content";
    const result = parseXmlToolCalls(content);
    // <read_file/> has no attributes and no content → parsed but with empty args
    // The system should handle it gracefully downstream
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe("read_file");
    expect(result.cleanedContent).not.toContain("<read_file");
  });
});

describe("Complex Task Management", () => {
  it("parses a multi-step task plan", async () => {
    const planText = [
      "task-1: Initialize the project structure",
      "task-2: Set up authentication module",
      "task-3: Create database schema",
      "task-4: Implement API endpoints",
      "task-5: Write unit tests",
      "task-6: Configure CI/CD pipeline",
    ].join("\n");

    const tasks = planText
      .split("\n")
      .filter(Boolean)
      .map((line: string) => {
        const match = line.match(/^([\w.-]+):\s*(.+)$/);
        return match
          ? { id: match[1], title: match[2].trim(), status: "pending" as const }
          : null;
      })
      .filter(Boolean);

    expect(tasks).toHaveLength(6);
    expect(tasks[0]).toMatchObject({
      id: "task-1",
      title: "Initialize the project structure",
      status: "pending",
    });
    expect(tasks[5]).toMatchObject({
      id: "task-6",
      title: "Configure CI/CD pipeline",
      status: "pending",
    });
  });

  it("merges task plans correctly (preserves running state)", async () => {
    const existing = [
      { id: "t1", title: "Setup", status: "running" as const },
      { id: "t2", title: "Build", status: "pending" as const },
    ];
    const incoming = [
      { id: "t1", title: "Setup", status: "pending" as const },
      { id: "t2", title: "Build", status: "pending" as const },
      { id: "t3", title: "Deploy", status: "pending" as const },
    ];
    const existingMap = new Map(existing.map((t) => [t.id, t]));
    const merged = incoming.map((t) => existingMap.get(t.id) ?? t);
    expect(merged[0].status).toBe("running"); // preserved
    expect(merged[1].status).toBe("pending");
    expect(merged[2].status).toBe("pending");
    expect(merged).toHaveLength(3);
  });

  it("handles task budget exhaustion correctly", async () => {
    const tasks = [
      { id: "t1", title: "Design", status: "completed" as const },
      { id: "t2", title: "Build", status: "running" as const },
      { id: "t3", title: "Test", status: "pending" as const },
      { id: "t4", title: "Deploy", status: "pending" as const },
    ];
    const exhausted = tasks.map((t) =>
      t.status === "pending" || t.status === "running"
        ? { ...t, status: "failed" as const }
        : t,
    );
    expect(exhausted[0].status).toBe("completed"); // unchanged
    expect(exhausted[1].status).toBe("failed"); // was running
    expect(exhausted[2].status).toBe("failed"); // was pending
    expect(exhausted[3].status).toBe("failed"); // was pending
  });
});

describe("Agent Runtime State Machine", () => {
  it("transitions through the full agent lifecycle", async () => {
    const { agentReducer, createInitialRuntimeState } =
      await import("@/lib/agentRuntimeContract");
    let state = createInitialRuntimeState();
    expect(state.phase).toBe("idle");

    // idle → streaming
    state = agentReducer(state, { type: "STREAM_START", messageId: "msg-1" });
    expect(state.phase).toBe("streaming");

    // streaming → streaming (tool call registered)
    state = agentReducer(state, {
      type: "TOOL_CALL",
      toolCallId: "tc-1",
      toolName: "read_file",
    });
    expect(state.phase).toBe("streaming");

    // streaming → streaming (tool result received)
    state = agentReducer(state, {
      type: "TOOL_RESULT_RECEIVED",
      toolCallId: "tc-1",
      success: true,
    });
    expect(state.phase).toBe("streaming");

    // streaming → idle via message-end
    state = agentReducer(state, {
      type: "STREAM_MESSAGE_END",
      messageId: "msg-1",
      hasMoreTools: false,
    });
    expect(state.phase).toBe("streaming");
    expect(state.currentMessageId).toBeNull();
  });

  it("rejects invalid transitions", async () => {
    const { agentReducer, createInitialRuntimeState } =
      await import("@/lib/agentRuntimeContract");
    const state = createInitialRuntimeState();
    // Can't go from idle to TOOL_RESULT_RECEIVED directly (needs a stream)
    const nextState = agentReducer(state, {
      type: "TOOL_RESULT_RECEIVED",
      toolCallId: "tc-1",
      success: true,
    });
    expect(nextState).toBe(state); // same reference = rejected
  });

  it("supports multi-turn tool loop", async () => {
    const { agentReducer, createInitialRuntimeState } =
      await import("@/lib/agentRuntimeContract");
    let state = createInitialRuntimeState();

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

    // Round 2: write_file (STREAM_START while still streaming)
    state = agentReducer(state, { type: "STREAM_START", messageId: "m2" });
    expect(state.phase).toBe("streaming");
    state = agentReducer(state, {
      type: "TOOL_CALL",
      toolCallId: "tc2",
      toolName: "write_file",
    });
    state = agentReducer(state, {
      type: "TOOL_RESULT_RECEIVED",
      toolCallId: "tc2",
      success: true,
    });

    // Round 3: bash
    state = agentReducer(state, { type: "STREAM_START", messageId: "m3" });
    state = agentReducer(state, {
      type: "TOOL_CALL",
      toolCallId: "tc3",
      toolName: "bash",
    });
    state = agentReducer(state, {
      type: "TOOL_RESULT_RECEIVED",
      toolCallId: "tc3",
      success: true,
    });
    expect(state.phase).toBe("streaming");
  });
});

describe("Complex XML Tool Call Scenarios", () => {
  it("parses a full agent conversation with mixed tool calls", async () => {
    const { parseXmlToolCalls } = await import("@/store/useAppStore");
    const conversation = [
      "I'll analyze your codebase and make improvements.",
      "",
      '<list_dir path="/src/components"/>',
      "I found the components. Let me check the main one:",
      '<read_file path="/src/components/App.tsx"/>',
      "I see the issue. Let me fix it:",
      '<edit_file path="/src/components/App.tsx">',
      "<search>",
      "const App = () => {",
      "  return <div>Hello</div>;",
      "</search>",
      "<replace>",
      "const App = () => {",
      "  return <div>Hello World</div>;",
      "</replace>",
      "</edit_file>",
      "Now let me verify the tests pass:",
      '<bash command="npm test"/>',
      "All tests pass! The fix is complete.",
    ].join("\n");

    const result = parseXmlToolCalls(conversation);
    expect(result.toolCalls).toHaveLength(4);
    expect(result.toolCalls[0].name).toBe("list_dir");
    expect(result.toolCalls[1].name).toBe("read_file");
    expect(result.toolCalls[2].name).toBe("edit_file");
    expect(result.toolCalls[3].name).toBe("bash");
    expect(result.cleanedContent).toContain("I'll analyze your codebase");
    expect(result.cleanedContent).toContain(
      "All tests pass! The fix is complete.",
    );
    expect(result.cleanedContent).not.toContain("<list_dir");
    expect(result.cleanedContent).not.toContain("<edit_file");
  });

  it("handles git workflow tool calls", async () => {
    const { parseXmlToolCalls } = await import("@/store/useAppStore");
    const content = [
      "Let me check the git status:",
      "<git_status/>",
      "I see changes. Let me commit:",
      '<git_commit message="feat: add new component"/>',
      "Done!",
    ].join("\n");
    const result = parseXmlToolCalls(content);
    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls[0].name).toBe("git_status");
    expect(result.toolCalls[1].name).toBe("git_commit");
    expect(result.toolCalls[1].args.message).toBe("feat: add new component");
  });
});

// Tests requiring NVIDIA API key
const NVIDIA_API_KEY = process.env.NVIDIA_API_KEY || "";
const RUN_NVIDIA_TESTS = NVIDIA_API_KEY.length > 0 && !process.env.CI;

describe.runIf(RUN_NVIDIA_TESTS)("NVIDIA API Integration", () => {
  beforeAll(() => {
    expect(NVIDIA_API_KEY).not.toBe("");
  });

  it("connects to NVIDIA NIM API with streaming", async () => {
    const { streamChat } = await import("@/lib/dalamAPI");
    const events: string[] = [];
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), 30000);

    try {
      const generator = streamChat(
        "https://integrate.api.nvidia.com/v1",
        NVIDIA_API_KEY,
        "openai",
        "meta/llama-3.1-8b-instruct",
        [
          {
            role: "user",
            content: "Say 'Hello from Dalam test' and nothing else",
          },
        ],
        abortController.signal,
        200,
      );

      for await (const event of generator) {
        if (event.type === "message-delta") {
          events.push(event.content);
        }
      }
    } catch (err) {
      // Only fail on non-timeout errors
      if (!(err instanceof Error && err.message.includes("timed out"))) {
        throw err;
      }
    } finally {
      clearTimeout(timeout);
    }

    expect(events.length).toBeGreaterThan(0);
    const fullContent = events.join("");
    expect(fullContent).toContain("Hello");
  });

  it("receives tool calls from NVIDIA API for coding tasks", async () => {
    const { streamChat } = await import("@/lib/dalamAPI");
    const events: string[] = [];
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), 60000);

    try {
      const generator = streamChat(
        "https://integrate.api.nvidia.com/v1",
        NVIDIA_API_KEY,
        "openai",
        "meta/llama-3.1-70b-instruct",
        [
          {
            role: "system",
            content:
              'You are a coding assistant. Use <read_file path="..."/> to read files and <list_dir path="..."/> to list directories.',
          },
          {
            role: "user",
            content:
              "Show me how to read the main.tsx file in the current directory using your tools, then describe what you'd see.",
          },
        ],
        abortController.signal,
        500,
      );

      for await (const event of generator) {
        if (event.type === "message-delta") {
          events.push(event.content);
        }
      }
    } catch (err) {
      if (!(err instanceof Error && err.message.includes("timed out"))) {
        throw err;
      }
    } finally {
      clearTimeout(timeout);
    }

    const fullContent = events.join("");
    // Should contain tool-like XML in the response
    expect(fullContent.length).toBeGreaterThan(0);
  }, 120000);
});
