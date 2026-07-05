/**
 * Tests for useAppStore.ts — monolithic store and helper exports.
 *
 * Covers:
 * - stripXmlToolCallTags: comprehensive XML tag stripping
 * - parseXmlToolCalls: XML tool call extraction
 * - useGit: Zustand store for git status
 * - useCommandPalette: Zustand store for command palette state
 */
import { describe, it, expect, beforeEach } from "vitest";
import { stripXmlToolCallTags, parseXmlToolCalls, useGit, useCommandPalette } from "../../store/useAppStore";

// ============================================================================
// stripXmlToolCallTags
// ============================================================================

describe("stripXmlToolCallTags", () => {
  it("returns unchanged content when no XML tags present", () => {
    const content = "Hello, world!";
    expect(stripXmlToolCallTags(content)).toBe("Hello, world!");
  });

  it("returns unchanged content when string is empty", () => {
    expect(stripXmlToolCallTags("")).toBe("");
  });

  it("strips self-closing tool tags", () => {
    const content = "Some text <read_file path=\"/src/index.ts\"/> more text";
    const result = stripXmlToolCallTags(content);
    expect(result).toBe("Some text  more text");
  });

  it("strips opening+closing tool tags with content", () => {
    const content = "Text <write_file path=\"test.txt\">file content</write_file> end";
    const result = stripXmlToolCallTags(content);
    expect(result).toBe("Text  end");
  });

  it("strips multiple tool tags", () => {
    const content = [
      "<read_file path=\"a.ts\"/>",
      "some content",
      "<write_file path=\"b.ts\">data</write_file>",
    ].join("\n");
    const result = stripXmlToolCallTags(content);
    expect(result).toBe("\nsome content\n");
  });

  it("strips orphan closing tags", () => {
    const content = "text </write_file> end";
    const result = stripXmlToolCallTags(content);
    expect(result).toBe("text  end");
  });

  it("strips MCP tool tags with server prefix", () => {
    const content = "text <mcp_server_tool arg=\"val\"/> end";
    const result = stripXmlToolCallTags(content);
    expect(result).toBe("text  end");
  });

  it("strips <thinking> tags and their content", () => {
    const content = "Before <thinking>deep thoughts</thinking> after";
    const result = stripXmlToolCallTags(content);
    expect(result).toBe("Before  after");
  });

  it("strips <reasoning> tags and content", () => {
    const content = "Text <reasoning>step by step</reasoning> end";
    const result = stripXmlToolCallTags(content);
    expect(result).toBe("Text  end");
  });

  it("strips nested think inside write_file content", () => {
    const content = "<write_file path=\"x.ts\">// <thinking>not real</thinking></write_file>";
    const result = stripXmlToolCallTags(content);
    expect(result).toBe("");
  });

  it("handles malformed question attribute tags", () => {
    const content = 'question question="What?" options="A,B" />';
    const result = stripXmlToolCallTags(content);
    expect(result).toBe("");
  });

  it("strips incomplete tags at end of content (streaming)", () => {
    const content = "Some text <run_command command=\"ls -la";
    const result = stripXmlToolCallTags(content);
    expect(result).toBe("Some text ");
  });

  it("strips <invoke> and <function_calls> blocks", () => {
    const content = "<invoke name=\"test\"><parameter>val</parameter></invoke>";
    const result = stripXmlToolCallTags(content);
    expect(result).toBe("");
  });

  it("strips <function_calls> blocks", () => {
    const content = "<function_calls><invoke name=\"tool\"></invoke></function_calls>";
    const result = stripXmlToolCallTags(content);
    expect(result).toBe("");
  });

  it("strips OpenAI internal channel tokens with content", () => {
    const content = "before <|channel|>leaked content<|end|> after";
    const result = stripXmlToolCallTags(content);
    expect(result).not.toContain("leaked content");
    expect(result).toContain("before");
    expect(result).toContain("after");
  });

  it("strips <|start|> and <|end|> blocks", () => {
    const content = "a<|start|>internal<|end|>b";
    const result = stripXmlToolCallTags(content);
    expect(result).not.toContain("internal");
  });

  it("strips standalone <|channel|> markers", () => {
    const content = "a<|channel|>b";
    const result = stripXmlToolCallTags(content);
    expect(result).toContain("a");
    expect(result).toContain("b");
  });

  it("strips skill invocation XML blocks", () => {
    const content = "<skill_invocation><parameter name=\"prompt\">do it</parameter></skill_invocation>";
    const result = stripXmlToolCallTags(content);
    expect(result).toBe("");
  });

  it("strips structured plan XML tags", () => {
    const content = "<goal>Fix bug</goal><steps><step>Read code</step></steps>";
    const result = stripXmlToolCallTags(content);
    expect(result).toBe("");
  });

  it("collapses 3+ newlines into 2 after tool tags are stripped", () => {
    // Note: newline collapsing only runs when XML tags are present (fast path)
    const content = "a\n\n\n\nb<read_file path=\"x.ts\"/>";
    const result = stripXmlToolCallTags(content);
    expect(result).toBe("a\n\nb");
  });

  it("returns empty string when only tool calls remain", () => {
    const content = "<read_file path=\"x.ts\"/>";
    const result = stripXmlToolCallTags(content);
    expect(result).toBe("");
  });

  it("returns empty string when only whitespace and stripped tags remain", () => {
    const content = "<read_file path=\"x.ts\"/>  \n  \n  ";
    const result = stripXmlToolCallTags(content);
    expect(result).toBe("");
  });

  it("strips bash tool calls", () => {
    const content = '<run_command command="npm test"/>';
    const result = stripXmlToolCallTags(content);
    expect(result).toBe("");
  });

  it("strips edit_file with search/replace content", () => {
    const content = '<edit_file path="file.ts"><search>old</search><replace>new</replace></edit_file>';
    const result = stripXmlToolCallTags(content);
    expect(result).toBe("");
  });

  it("preserves content between tags when tags are not recognized tool calls", () => {
    const content = "Here is some <b>bold</b> text";
    const result = stripXmlToolCallTags(content);
    expect(result).toBe("Here is some <b>bold</b> text");
  });

  it("handles content with no angle brackets efficiently", () => {
    const content = "This is plain text with no XML at all. Just normal characters.";
    const result = stripXmlToolCallTags(content);
    expect(result).toBe(content);
  });

  it("strips multiple different tool tags in sequence", () => {
    const content = [
      "Read this file:",
      '<read_file path="/src/index.ts"/>',
      "Then search:",
      '<grep_file path="/src/utils.ts" pattern="function"/>',
      "Then commit:",
      '<git_commit message="fix bug"/>',
    ].join("\n");
    const result = stripXmlToolCallTags(content);
    expect(result).toBe("Read this file:\n\nThen search:\n\nThen commit:\n");
  });

  it("strips memory tool tags", () => {
    const content = '<memory_save category="user" tier="high">Important fact</memory_save>';
    const result = stripXmlToolCallTags(content);
    expect(result).toBe("");
  });

  it("strips question tags", () => {
    const content = '<question question="Proceed?" options="Yes,No"/>';
    const result = stripXmlToolCallTags(content);
    expect(result).toBe("");
  });

  it("strips browser navigation tags", () => {
    const content = '<browser_navigate url="http://localhost:3000"/>';
    const result = stripXmlToolCallTags(content);
    expect(result).toBe("");
  });

  it("strips notify tags", () => {
    const content = '<notify title="Done" body="Task completed"/>';
    const result = stripXmlToolCallTags(content);
    expect(result).toBe("");
  });

  it("handles DeepSeek unicode tokens gracefully", () => {
    const content = "a\uFF5Cb\uFF5Cc";
    expect(() => stripXmlToolCallTags(content)).not.toThrow();
    expect(typeof stripXmlToolCallTags(content)).toBe("string");
  });
});

// ============================================================================
// parseXmlToolCalls
// ============================================================================

describe("parseXmlToolCalls", () => {
  it("extracts a single self-closing tool call", () => {
    const content = 'Some text <read_file path="/src/index.ts"/> more';
    const result = parseXmlToolCalls(content);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe("read_file");
    expect(result.toolCalls[0].args.path).toBe("/src/index.ts");
    expect(result.cleanedContent).not.toContain("<read_file");
  });

  it("extracts a tool call with content body", () => {
    const content = '<write_file path="test.txt">file content here</write_file>';
    const result = parseXmlToolCalls(content);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe("write_file");
    expect(result.toolCalls[0].args.path).toBe("test.txt");
    expect(result.toolCalls[0].args.content).toBe("file content here");
  });

  it("extracts multiple tool calls", () => {
    const content = [
      '<read_file path="a.ts"/>',
      '<read_file path="b.ts"/>',
    ].join("\n");
    const result = parseXmlToolCalls(content);
    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls[0].args.path).toBe("a.ts");
    expect(result.toolCalls[1].args.path).toBe("b.ts");
  });

  it("extracts edit_file and captures search/replace as content body", () => {
    const content = '<edit_file path="file.ts"><search>old code</search><replace>new code</replace></edit_file>';
    const result = parseXmlToolCalls(content);
    // edit_file is parsed as 1 tool call; <search>/<replace> are inner content
    expect(result.toolCalls.length).toBeGreaterThanOrEqual(1);
    const editCall = result.toolCalls.find(tc => tc.name === "edit_file");
    expect(editCall).toBeDefined();
    expect(editCall!.args.path).toBe("file.ts");
    expect(editCall!.args.content).toContain("old code");
    expect(editCall!.args.content).toContain("new code");
  });

  it("maps shell to bash via TAG_TO_TOOL", () => {
    const content = '<shell command="ls"/>';
    const result = parseXmlToolCalls(content);
    expect(result.toolCalls.length).toBeGreaterThanOrEqual(1);
    expect(result.toolCalls[0].name).toBe("bash");
  });

  it("returns empty tool calls for plain text", () => {
    const content = "Just a normal message.";
    const result = parseXmlToolCalls(content);
    expect(result.toolCalls).toHaveLength(0);
  });

  it("returns cleaned content without XML tags", () => {
    const content = 'Hello <read_file path="x.ts"/> world';
    const result = parseXmlToolCalls(content);
    expect(result.cleanedContent).not.toContain("<read_file");
    expect(result.cleanedContent).toContain("Hello");
    expect(result.cleanedContent).toContain("world");
  });

  it("assigns unique IDs to each tool call", () => {
    const content = '<read_file path="a.ts"/><read_file path="b.ts"/>';
    const result = parseXmlToolCalls(content);
    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls[0].id).not.toBe(result.toolCalls[1].id);
  });

  it("sets status to completed for all parsed calls", () => {
    const content = '<read_file path="x.ts"/>';
    const result = parseXmlToolCalls(content);
    expect(result.toolCalls[0].status).toBe("completed");
  });

  it("extracts git_commit with message attribute", () => {
    const content = '<git_commit message="fix: resolve bug"/>';
    const result = parseXmlToolCalls(content);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe("git_commit");
    expect(result.toolCalls[0].args.message).toBe("fix: resolve bug");
  });

  it("handles tool calls with multiple attributes", () => {
    const content = '<grep_file path="/src" pattern="TODO" regex="false" max_results="20"/>';
    const result = parseXmlToolCalls(content);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].args.path).toBe("/src");
    expect(result.toolCalls[0].args.pattern).toBe("TODO");
  });

  it("handles mixed content with text and tool calls", () => {
    const content = "First, let me read the file.\n<read_file path=\"index.ts\"/>\nNow I can see the contents.";
    const result = parseXmlToolCalls(content);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.cleanedContent).toContain("First");
    expect(result.cleanedContent).toContain("Now I can see the contents");
  });

  it("handles empty content", () => {
    const result = parseXmlToolCalls("");
    expect(result.toolCalls).toHaveLength(0);
    expect(result.cleanedContent).toBe("");
  });
});

// ============================================================================
// useGit (Zustand store)
// ============================================================================

describe("useGit store", () => {
  beforeEach(() => {
    useGit.setState({ status: null, loading: false, error: null });
  });

  it("initializes with default state", () => {
    const state = useGit.getState();
    expect(state.status).toBeNull();
    expect(state.loading).toBe(false);
    expect(state.error).toBeNull();
  });

  it("sets loading state", () => {
    useGit.setState({ loading: true });
    expect(useGit.getState().loading).toBe(true);
  });

  it("sets error state", () => {
    useGit.setState({ error: "not_initialized" });
    expect(useGit.getState().error).toBe("not_initialized");
  });

  it("sets git status", () => {
    const mockStatus = {
      branch: "main",
      added: ["file1.ts"],
      deleted: [],
      modified: [],
      untracked: [],
      ahead: 1,
      behind: 0,
    };
    useGit.setState({ status: mockStatus });
    expect(useGit.getState().status).toEqual(mockStatus);
    expect(useGit.getState().status!.branch).toBe("main");
  });

  it("resets loading and error when status is set", () => {
    useGit.setState({ loading: true, error: "some error" });
    useGit.setState({
      status: { branch: "main", added: [], deleted: [], modified: [], untracked: [], ahead: 0, behind: 0 },
      loading: false,
      error: null,
    });
    const state = useGit.getState();
    expect(state.status).not.toBeNull();
    expect(state.loading).toBe(false);
    expect(state.error).toBeNull();
  });

  it("preserves equality of state objects", () => {
    const state1 = useGit.getState();
    const state2 = useGit.getState();
    expect(state1).toBe(state2);
  });
});

// ============================================================================
// useCommandPalette (Zustand store)
// ============================================================================

describe("useCommandPalette store", () => {
  beforeEach(() => {
    useCommandPalette.getState().setOpen(false);
  });

  it("initializes with closed state", () => {
    const state = useCommandPalette.getState();
    expect(state.open).toBe(false);
    expect(state.query).toBe("");
  });

  it("sets open to true", () => {
    useCommandPalette.getState().setOpen(true);
    expect(useCommandPalette.getState().open).toBe(true);
  });

  it("sets open to false and clears query", () => {
    useCommandPalette.getState().setQuery("test");
    useCommandPalette.getState().setOpen(false);
    const state = useCommandPalette.getState();
    expect(state.open).toBe(false);
    expect(state.query).toBe("");
  });

  it("sets query", () => {
    useCommandPalette.getState().setQuery("search term");
    expect(useCommandPalette.getState().query).toBe("search term");
  });

  it("toggles from closed to open", () => {
    useCommandPalette.getState().toggle();
    expect(useCommandPalette.getState().open).toBe(true);
  });

  it("toggles from open to closed", () => {
    useCommandPalette.getState().setOpen(true);
    useCommandPalette.getState().toggle();
    expect(useCommandPalette.getState().open).toBe(false);
  });

  it("clears query on toggle", () => {
    useCommandPalette.getState().setQuery("something");
    useCommandPalette.getState().toggle();
    expect(useCommandPalette.getState().query).toBe("");
  });

  it("preserves query when opening programmatically", () => {
    useCommandPalette.getState().setQuery("my-search");
    useCommandPalette.getState().setOpen(true);
    const state = useCommandPalette.getState();
    expect(state.query).toBe("my-search");
    expect(state.open).toBe(true);
  });
});
