import { describe, it, expect } from "vitest";
import { stripXmlToolCallTags } from "../../store/useAppStore";

describe("stripXmlToolCallTags", () => {
  it("returns unchanged content when no XML tags present", () => {
    const content = "Hello, world!";
    expect(stripXmlToolCallTags(content)).toBe("Hello, world!");
  });

  it("returns unchanged content when string is empty", () => {
    expect(stripXmlToolCallTags("")).toBe("");
  });

  it("strips self-closing tool tags", () => {
    const content = 'Some text <read_file path="/src/index.ts"/> more text';
    const result = stripXmlToolCallTags(content);
    expect(result).toBe("Some text  more text");
  });

  it("strips opening+closing tool tags with content", () => {
    const content =
      'Text <write_file path="test.txt">file content</write_file> end';
    const result = stripXmlToolCallTags(content);
    expect(result).toBe("Text  end");
  });

  it("strips multiple tool tags", () => {
    const content = [
      '<read_file path="a.ts"/>',
      "some content",
      '<write_file path="b.ts">data</write_file>',
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
    const content = 'text <mcp_server_tool arg="val"/> end';
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
    const content =
      '<write_file path="x.ts">// <thinking>not real</thinking></write_file>';
    const result = stripXmlToolCallTags(content);
    expect(result).toBe("");
  });

  it("handles malformed question attribute tags", () => {
    const content = 'question question="What?" options="A,B" />';
    const result = stripXmlToolCallTags(content);
    expect(result).toBe("");
  });

  it("strips incomplete tags at end of content (streaming)", () => {
    const content = 'Some text <run_command command="ls -la';
    const result = stripXmlToolCallTags(content);
    expect(result).toBe("Some text ");
  });

  it("strips <invoke> and <function_calls> blocks", () => {
    const content = '<invoke name="test"><parameter>val</parameter></invoke>';
    const result = stripXmlToolCallTags(content);
    expect(result).toBe("");
  });

  it("strips <function_calls> blocks", () => {
    const content =
      '<function_calls><invoke name="tool"></invoke></function_calls>';
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
    const content =
      '<skill_invocation><parameter name="prompt">do it</parameter></skill_invocation>';
    const result = stripXmlToolCallTags(content);
    expect(result).toBe("");
  });

  it("strips structured plan XML tags", () => {
    const content = "<goal>Fix bug</goal><steps><step>Read code</step></steps>";
    const result = stripXmlToolCallTags(content);
    expect(result).toBe("");
  });

  it("collapses 3+ newlines into 2 after tool tags are stripped", () => {
    const content = 'a\n\n\n\nb<read_file path="x.ts"/>';
    const result = stripXmlToolCallTags(content);
    expect(result).toBe("a\n\nb");
  });

  it("returns empty string when only tool calls remain", () => {
    const content = '<read_file path="x.ts"/>';
    const result = stripXmlToolCallTags(content);
    expect(result).toBe("");
  });

  it("returns empty string when only whitespace and stripped tags remain", () => {
    const content = '<read_file path="x.ts"/>  \n  \n  ';
    const result = stripXmlToolCallTags(content);
    expect(result).toBe("");
  });

  it("strips bash tool calls", () => {
    const content = '<run_command command="npm test"/>';
    const result = stripXmlToolCallTags(content);
    expect(result).toBe("");
  });

  it("strips edit_file with search/replace content", () => {
    const content =
      '<edit_file path="file.ts"><search>old</search><replace>new</replace></edit_file>';
    const result = stripXmlToolCallTags(content);
    expect(result).toBe("");
  });

  it("preserves content between tags when tags are not recognized tool calls", () => {
    const content = "Here is some <b>bold</b> text";
    const result = stripXmlToolCallTags(content);
    expect(result).toBe("Here is some <b>bold</b> text");
  });

  it("handles content with no angle brackets efficiently", () => {
    const content =
      "This is plain text with no XML at all. Just normal characters.";
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
    const content =
      '<memory_save category="user" tier="high">Important fact</memory_save>';
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
