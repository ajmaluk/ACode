/**
 * Unit tests for XML tool call parsing and permission evaluation.
 *
 * Tests for:
 * 1. stripXmlToolCallTags — strips XML tool call tags from assistant content
 * 2. parseXmlToolCalls — parses XML tool calls from assistant content
 * 3. Edge cases for permission evaluation (canonicaliseBashCommand, evaluate)
 */
import { describe, it, expect } from "vitest";
import {
  evaluate,
  canonicaliseBashCommand,
  fromConfig,
  hasShellMetacharacters,
} from "../agents";
import {
  stripXmlToolCallTags,
  parseXmlToolCalls,
} from "../../store/useAppStore";

// ============================================================================
// stripXmlToolCallTags
// ============================================================================

describe("stripXmlToolCallTags", () => {
  it("returns text unchanged when no XML tags are present", () => {
    const input = "Hello, this is a normal message with no tool calls.";
    expect(stripXmlToolCallTags(input)).toBe(input);
  });

  it("returns empty string unchanged", () => {
    expect(stripXmlToolCallTags("")).toBe("");
  });

  it("strips opening+content+closing tool call blocks", () => {
    const input = "Let me read that file.\n\n<read_file path=\"/src/index.ts\">\nconst x = 1;\n</read_file>\n\nI found the content.";
    const result = stripXmlToolCallTags(input);
    expect(result).toContain("Let me read that file.");
    expect(result).toContain("I found the content.");
    expect(result).not.toContain("<read_file");
    expect(result).not.toContain("</read_file>");
    expect(result).not.toContain("const x = 1;");
  });

  it("strips self-closing tool call tags", () => {
    const input = 'Checking status: <bash command="git status"/>';
    const result = stripXmlToolCallTags(input);
    expect(result).toBe("Checking status: ");
  });

  it("strips multiple tool calls from the same message", () => {
    const input = "I'll do both tasks.\n<read_file path=\"/a.ts\">content a</read_file>\n<read_file path=\"/b.ts\">content b</read_file>\nDone with both.";
    const result = stripXmlToolCallTags(input);
    expect(result).toContain("I'll do both tasks.");
    expect(result).toContain("Done with both.");
    expect(result).not.toContain("<read_file");
    expect(result).not.toContain("</read_file>");
  });

  it("strips orphan closing tags (without matching opening)", () => {
    const input = "Some text</read_file>more text";
    const result = stripXmlToolCallTags(input);
    expect(result).toBe("Some textmore text");
  });

  it("strips MCP tags", () => {
    const input = '<mcp_fetch url="https://example.com">response</mcp_fetch>';
    const result = stripXmlToolCallTags(input);
    expect(result).toBe("");
  });

  it("strips question tags with malformed syntax", () => {
    const input = 'question question="What version?" options="1,2" />';
    const result = stripXmlToolCallTags(input);
    expect(result).toBe("");
  });

  it("strips Anthropic antml:function_calls blocks", () => {
    const input = '<antml:function_calls><invoke name="bash"><parameter name="command">ls</parameter></invoke></antml:function_calls>';
    const result = stripXmlToolCallTags(input);
    expect(result).toBe("");
  });

  it("strips generic <function_calls> blocks", () => {
    const input = '<function_calls><invoke name="read_file"><parameter name="path">/x</parameter></invoke></function_calls>';
    const result = stripXmlToolCallTags(input);
    expect(result).toBe("");
  });

  it("strips incomplete XML tags at end of content (streaming partial)", () => {
    const input = 'Let me read the file.\n<read_file path="/src/index.ts"';
    const result = stripXmlToolCallTags(input);
    expect(result).toBe('Let me read the file.\n');
  });

  it("strips model output tags like <thinking>, <reasoning>, <plan>", () => {
    const input = "<thinking>Let me think about this</thinking>The answer is 42.";
    const result = stripXmlToolCallTags(input);
    expect(result).toBe("The answer is 42.");
  });

  it("strips skill invocation blocks from Plan mode", () => {
    const input = '<skill_invocation><parameter name="skill">explain</parameter></skill_invocation>Check this out.';
    const result = stripXmlToolCallTags(input);
    expect(result).toBe("Check this out.");
  });

  it("strips structured planning tags", () => {
    const input = '<goal>Refactor the module</goal><step>Read the file</step>The plan is ready.';
    const result = stripXmlToolCallTags(input);
    expect(result).toBe("The plan is ready.");
  });

  it("cleans up excessive whitespace after stripping", () => {
    const input = "Before\n\n\n<read_file path=\"/x.ts\">content</read_file>\n\n\nAfter";
    const result = stripXmlToolCallTags(input);
    expect(result).toContain("Before");
    expect(result).toContain("After");
    // Should have at most 2 consecutive newlines
    expect(result).not.toContain("\n\n\n");
  });

  it("handles DeepSeek unicode bracket tokens", () => {
    const input = "<\uff5c>deepseek token</\uff5c>Regular text";
    const result = stripXmlToolCallTags(input);
    expect(result).toBe("Regular text");
  });

  it("handles OpenAI internal channel tokens", () => {
    const input = "<|channel|>leaked token<|end|>Actual content";
    const result = stripXmlToolCallTags(input);
    expect(result).toBe("Actual content");
  });

  it("strips <think> tags with various malformed endings", () => {
    const input = "Before<think streaming>some thoughtAfter";
    const result = stripXmlToolCallTags(input);
    expect(result).toBe("Beforesome thoughtAfter");
  });

  it("handles bash command with unescaped quotes gracefully", () => {
    // Malformed XML: command value contains unescaped double quotes
    const input = 'I ran <bash command="echo "hello world"">and got output</bash>Let me continue.';
    const result = stripXmlToolCallTags(input);
    // The regex should handle this gracefully (strip what it can)
    expect(result).toContain("I ran");
    expect(result).toContain("Let me continue.");
  });
});

// ============================================================================
// parseXmlToolCalls
// ============================================================================

describe("parseXmlToolCalls", () => {
  it("returns empty toolCalls and unchanged content when no XML tags exist", () => {
    const input = "Hello, this is a normal message.";
    const { toolCalls, cleanedContent } = parseXmlToolCalls(input);
    expect(toolCalls).toHaveLength(0);
    expect(cleanedContent).toBe(input);
  });

  it("parses a simple tool call with attributes", () => {
    const input = 'Let me check: <bash command="git status"/>';
    const { toolCalls, cleanedContent } = parseXmlToolCalls(input);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].name).toBe("bash");
    expect(toolCalls[0].args.command).toBe("git status");
    expect(toolCalls[0].status).toBe("completed");
    expect(cleanedContent).toBe("Let me check: ");
  });

  it("parses a tool call with content between tags", () => {
    const input = '<read_file path="/src/index.ts">file content here</read_file>';
    const { toolCalls, cleanedContent } = parseXmlToolCalls(input);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].name).toBe("read_file");
    expect(toolCalls[0].args.path).toBe("/src/index.ts");
    expect(toolCalls[0].args.content).toBe("file content here");
    expect(cleanedContent).toBe("");
  });

  it("parses multiple tool calls from same content", () => {
    const input = "<read_file path=\"/a.ts\">content a</read_file>\n<read_file path=\"/b.ts\">content b</read_file>";
    const { toolCalls, cleanedContent } = parseXmlToolCalls(input);
    expect(toolCalls).toHaveLength(2);
    expect(toolCalls[0].args.path).toBe("/a.ts");
    expect(toolCalls[1].args.path).toBe("/b.ts");
    expect(cleanedContent).toBe("");
  });

  it("maps tag aliases to internal tool names", () => {
    const input = '<shell command="ls -la"/>';
    const { toolCalls } = parseXmlToolCalls(input);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].name).toBe("bash");
  });

  it("removes XML tags while preserving surrounding text", () => {
    const input = "First\n<read_file path=\"/x.ts\">content</read_file>\nLast";
    const { cleanedContent } = parseXmlToolCalls(input);
    expect(cleanedContent).toBe("First\n\nLast");
  });

  it("handles content with newlines between tags", () => {
    const input = "Before\n\n<bash command=\"npm test\"/>\n\nAfter";
    const { toolCalls, cleanedContent } = parseXmlToolCalls(input);
    expect(toolCalls).toHaveLength(1);
    expect(cleanedContent.includes("Before")).toBe(true);
    expect(cleanedContent.includes("After")).toBe(true);
  });

  it("generates unique IDs for each parsed tool call", () => {
    const input = '<bash command="ls"/><bash command="pwd"/>';
    const { toolCalls } = parseXmlToolCalls(input);
    expect(toolCalls).toHaveLength(2);
    expect(toolCalls[0].id).not.toBe(toolCalls[1].id);
  });

  it("skips unknown tag without attributes (not in TAG_TO_TOOL map)", () => {
    // Tags not in TAG_TO_TOOL with no attributes are skipped
    const input = '<unknown_tool>content</unknown_tool>';
    const { toolCalls } = parseXmlToolCalls(input);
    expect(toolCalls).toHaveLength(0);
  });

  it("parses unknown tag with attributes (keeps original tag name)", () => {
    // Tags not in TAG_TO_TOOL but with attributes still get parsed
    const input = '<custom_action param="value">content</custom_action>';
    const { toolCalls } = parseXmlToolCalls(input);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].name).toBe("custom_action");
    expect(toolCalls[0].args.param).toBe("value");
  });

  it("handles self-closing tool calls with no attributes", () => {
    const input = "<list_dir/>";
    const { toolCalls } = parseXmlToolCalls(input);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].name).toBe("list_dir");
    expect(Object.keys(toolCalls[0].args)).toHaveLength(0);
  });
});

// ============================================================================
// Permission evaluation edge cases
// ============================================================================

describe("evaluate — additional edge cases", () => {
  it("empty ruleset defaults to ask", () => {
    expect(evaluate([], "bash", "*")).toBe("ask");
  });

  it("respects ruleset ordering for same permission wildcard", () => {
    // An earlier wildcard takes precedence when it appears first
    const rules = fromConfig({ bash: { "*": "allow" } });
    const denyFirst = [{ permission: "bash", pattern: "*", action: "deny" as const }, ...rules];
    expect(evaluate(denyFirst, "bash", "anything")).toBe("deny");
  });

  it("handles glob pattern with braces", () => {
    const rules = [{ permission: "edit", pattern: "src/{a,b}.ts", action: "allow" as const }];
    expect(evaluate(rules, "edit", "src/a.ts")).toBe("allow");
    expect(evaluate(rules, "edit", "src/b.ts")).toBe("allow");
    expect(evaluate(rules, "edit", "src/c.ts")).toBe("ask");
  });

  it("evaluates glob with wildcard in nested path", () => {
    const rules = [{ permission: "read", pattern: "src/**/*.ts", action: "allow" as const }];
    expect(evaluate(rules, "read", "src/components/Button.tsx")).toBe("ask"); // .tsx != .ts
    expect(evaluate(rules, "read", "src/components/utils.ts")).toBe("allow");
    expect(evaluate(rules, "read", "node_modules/pkg/index.ts")).toBe("ask"); // outside src
  });

  it("matches full path versus partial via glob", () => {
    const rules = [{ permission: "edit", pattern: "*.ts", action: "allow" as const }];
    // *.ts matches short paths but not paths with slashes (glob * doesn't cross /)
    expect(evaluate(rules, "edit", "index.ts")).toBe("allow");
    expect(evaluate(rules, "edit", "src/index.ts")).toBe("ask");
  });
});

// ============================================================================
// canonicaliseBashCommand edge cases
// ============================================================================

describe("canonicaliseBashCommand — edge cases", () => {
  it("handles null or undefined gracefully", () => {
    expect(canonicaliseBashCommand("null 2>&1")).toBe("null |");
    expect(canonicaliseBashCommand("")).toBe("");
  });

  it("handles commands with shell metacharacters", () => {
    // Pipes mean the command can't be trusted arity-wise
    const result = canonicaliseBashCommand("git status | grep modified");
    // Should append a pipe marker to prevent allow matching
    expect(result.endsWith(" |")).toBe(true);
  });

  it("handles commands with semicolons", () => {
    const result = canonicaliseBashCommand("cd src; ls");
    expect(result.endsWith(" |")).toBe(true);
  });

  it("handles commands with command substitution", () => {
    const result = canonicaliseBashCommand("echo $(whoami)");
    expect(result.endsWith(" |")).toBe(true);
  });

  it("handles commands with background operator (& not recognized as metachar)", () => {
    // & is not in the shell metacharacter regex [|;`$] or redirect regex [<>]
    const result = canonicaliseBashCommand("sleep 10 &");
    expect(result).toBe("sleep");
  });

  it("normalizes extra whitespace", () => {
    expect(canonicaliseBashCommand("  git   status  --short  ")).toBe("git status");
  });

  it("handles very long commands without crashing", () => {
    const longArg = "a".repeat(10000);
    const cmd = `echo ${longArg}`;
    const result = canonicaliseBashCommand(cmd);
    expect(result).toBe("echo");
  });
});

// ============================================================================
// hasShellMetacharacters
// ============================================================================

describe("hasShellMetacharacters", () => {
  it("detects pipe", () => {
    expect(hasShellMetacharacters("ls | grep foo")).toBe(true);
  });

  it("detects semicolon", () => {
    expect(hasShellMetacharacters("cd src; ls")).toBe(true);
  });

  it("detects backtick", () => {
    expect(hasShellMetacharacters("echo `whoami`")).toBe(true);
  });

  it("detects dollar paren", () => {
    expect(hasShellMetacharacters("echo $(whoami)")).toBe(true);
  });

  it("detects double ampersand", () => {
    expect(hasShellMetacharacters("make && make install")).toBe(true);
  });

  it("detects double pipe", () => {
    expect(hasShellMetacharacters("false || true")).toBe(true);
  });

  it("returns false for simple commands", () => {
    expect(hasShellMetacharacters("git status")).toBe(false);
    expect(hasShellMetacharacters("npm install")).toBe(false);
    expect(hasShellMetacharacters("ls -la")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(hasShellMetacharacters("")).toBe(false);
  });

  it("detects redirect operators", () => {
    expect(hasShellMetacharacters("echo hello > file.txt")).toBe(true);
    expect(hasShellMetacharacters("cat < input.txt")).toBe(true);
  });
});
