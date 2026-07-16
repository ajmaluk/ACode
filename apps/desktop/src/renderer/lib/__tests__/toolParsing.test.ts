/**
 * Unit tests for XML tool call parsing and permission evaluation.
 *
 * Tests for:
 * 1. stripXmlToolCallTags — strips XML tool call tags from assistant content
 * 2. parseXmlToolCalls — parses XML tool calls from assistant content
 * 3. Edge cases for permission evaluation (canonicaliseBashCommand, evaluate)
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  evaluate,
  canonicaliseBashCommand,
  fromConfig,
  hasShellMetacharacters,
} from "../agents";
import {
  stripXmlToolCallTags,
  parseXmlToolCalls,
  stripInlineXml,
  resetStreamingState,
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
    const input =
      'Let me read that file.\n\n<read_file path="/src/index.ts">\nconst x = 1;\n</read_file>\n\nI found the content.';
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
    const input =
      'I\'ll do both tasks.\n<read_file path="/a.ts">content a</read_file>\n<read_file path="/b.ts">content b</read_file>\nDone with both.';
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
    const input =
      '<antml:function_calls><invoke name="bash"><parameter name="command">ls</parameter></invoke></antml:function_calls>';
    const result = stripXmlToolCallTags(input);
    expect(result).toBe("");
  });

  it("strips generic <function_calls> blocks", () => {
    const input =
      '<function_calls><invoke name="read_file"><parameter name="path">/x</parameter></invoke></function_calls>';
    const result = stripXmlToolCallTags(input);
    expect(result).toBe("");
  });

  it("strips incomplete XML tags at end of content (streaming partial)", () => {
    const input = 'Let me read the file.\n<read_file path="/src/index.ts"';
    const result = stripXmlToolCallTags(input);
    expect(result).toBe("Let me read the file.\n");
  });

  it("strips complete opening tag without closing pair (streaming artifact)", () => {
    const input = 'Let me read the file.\n<read_file path="/src/index.ts">';
    const result = stripXmlToolCallTags(input);
    expect(result).toBe("Let me read the file.\n");
  });

  it("strips opening tag in middle of streaming content (no closing tag yet)", () => {
    const input =
      'I will read the file.\n<read_file path="/src/index.ts">\nconst x = 1;\n';
    const result = stripXmlToolCallTags(input);
    expect(result).toBe("I will read the file.\n\nconst x = 1;\n");
  });

  it("preserves paired tags for XML_STRIP_RE (opening tag with matching closing)", () => {
    // When both opening AND closing tags are present, the whole block should be stripped
    const input =
      'Before\n<read_file path="/x.ts">\ncontent\n</read_file>\nAfter';
    const result = stripXmlToolCallTags(input);
    expect(result).toContain("Before");
    expect(result).toContain("After");
    expect(result).not.toContain("content");
    expect(result).not.toContain("<read_file");
  });

  it("strips opening tag mid-streaming when closing tag arrives in later delta", () => {
    // Simulates: delta 1 has the opening tag, delta 2 appends the closing tag
    // The opening tag should be stripped in both cases
    const delta1 = 'First step.\n<bash command="npm test">\nrunning tests...\n';
    const delta2 = delta1 + "</bash>\nDone.";
    const cleaned1 = stripXmlToolCallTags(delta1);
    const cleaned2 = stripXmlToolCallTags(delta2);
    // In delta1, the opening tag should be stripped but content remains
    expect(cleaned1).toBe("First step.\n\nrunning tests...\n");
    // In delta2, the full block including content is stripped
    expect(cleaned2).toBe("First step.\n\nDone.");
  });

  it("strips MCP opening tag without closing pair during streaming", () => {
    const input = 'Processing <mcp_fetch url="https://example.com">';
    const result = stripXmlToolCallTags(input);
    expect(result).toBe("Processing ");
  });

  it("strips multiple unpaired opening tags (parallel tool calls streaming)", () => {
    const input =
      '<read_file path="/a.ts">\ncontent a\n<read_file path="/b.ts">\ncontent b\n';
    const result = stripXmlToolCallTags(input);
    expect(result).toBe("\ncontent a\n\ncontent b\n");
  });

  it("strips model output tags like <thinking>, <reasoning>, <plan>", () => {
    const input =
      "<thinking>Let me think about this</thinking>The answer is 42.";
    const result = stripXmlToolCallTags(input);
    expect(result).toBe("The answer is 42.");
  });

  it("strips skill invocation blocks from Plan mode", () => {
    const input =
      '<skill_invocation><parameter name="skill">explain</parameter></skill_invocation>Check this out.';
    const result = stripXmlToolCallTags(input);
    expect(result).toBe("Check this out.");
  });

  it("strips structured planning tags", () => {
    const input =
      "<goal>Refactor the module</goal><step>Read the file</step>The plan is ready.";
    const result = stripXmlToolCallTags(input);
    expect(result).toBe("The plan is ready.");
  });

  it("cleans up excessive whitespace after stripping", () => {
    const input =
      'Before\n\n\n<read_file path="/x.ts">content</read_file>\n\n\nAfter';
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
    const input =
      'I ran <bash command="echo "hello world"">and got output</bash>Let me continue.';
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
    const input =
      '<read_file path="/src/index.ts">file content here</read_file>';
    const { toolCalls, cleanedContent } = parseXmlToolCalls(input);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].name).toBe("read_file");
    expect(toolCalls[0].args.path).toBe("/src/index.ts");
    expect(toolCalls[0].args.content).toBe("file content here");
    expect(cleanedContent).toBe("");
  });

  it("parses multiple tool calls from same content", () => {
    const input =
      '<read_file path="/a.ts">content a</read_file>\n<read_file path="/b.ts">content b</read_file>';
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
    const input = 'First\n<read_file path="/x.ts">content</read_file>\nLast';
    const { cleanedContent } = parseXmlToolCalls(input);
    expect(cleanedContent).toBe("First\n\nLast");
  });

  it("handles content with newlines between tags", () => {
    const input = 'Before\n\n<bash command="npm test"/>\n\nAfter';
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
    const input = "<unknown_tool>content</unknown_tool>";
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
    const denyFirst = [
      { permission: "bash", pattern: "*", action: "deny" as const },
      ...rules,
    ];
    expect(evaluate(denyFirst, "bash", "anything")).toBe("allow");
  });

  it("handles glob pattern with braces", () => {
    const rules = [
      { permission: "edit", pattern: "src/{a,b}.ts", action: "allow" as const },
    ];
    expect(evaluate(rules, "edit", "src/a.ts")).toBe("allow");
    expect(evaluate(rules, "edit", "src/b.ts")).toBe("allow");
    expect(evaluate(rules, "edit", "src/c.ts")).toBe("ask");
  });

  it("evaluates glob with wildcard in nested path", () => {
    const rules = [
      { permission: "read", pattern: "src/**/*.ts", action: "allow" as const },
    ];
    expect(evaluate(rules, "read", "src/components/Button.tsx")).toBe("ask"); // .tsx != .ts
    expect(evaluate(rules, "read", "src/components/utils.ts")).toBe("allow");
    expect(evaluate(rules, "read", "node_modules/pkg/index.ts")).toBe("ask"); // outside src
  });

  it("matches full path versus partial via glob", () => {
    const rules = [
      { permission: "edit", pattern: "*.ts", action: "allow" as const },
    ];
    // *.ts matches short paths but not paths with slashes (glob * doesn't cross /)
    expect(evaluate(rules, "edit", "index.ts")).toBe("allow");
    expect(evaluate(rules, "edit", "src/index.ts")).toBe("allow");
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
    expect(canonicaliseBashCommand("  git   status  --short  ")).toBe(
      "git status",
    );
  });

  it("handles very long commands without crashing", () => {
    const longArg = "a".repeat(10000);
    const cmd = `echo ${longArg}`;
    const result = canonicaliseBashCommand(cmd);
    expect(result).toBe("echo");
  });
});

// ============================================================================
// stripInlineXml — streaming XML tag stripper
// ============================================================================
// Tests for the fast inline XML tag stripper used per message-delta.
// Includes stateful body-tag suppression across multiple streaming deltas.

describe("stripInlineXml", () => {
  beforeEach(() => {
    resetStreamingState();
  });

  // ── Basic functionality ───────────────────────────────────

  it("returns empty string unchanged", () => {
    expect(stripInlineXml("")).toBe("");
  });

  it("returns plain text without angle brackets unchanged", () => {
    const input = "Hello, this is a normal message with no tags.";
    expect(stripInlineXml(input)).toBe(input);
  });

  it("preserves plain text with angle brackets that are not XML tags", () => {
    const input = "a < b > c in some pseudo code";
    expect(stripInlineXml(input)).toBe(input);
  });

  // ── Self-closing tags ─────────────────────────────────────

  it("strips self-closing tool call tags", () => {
    const input = 'Checking: <bash command="git status"/>';
    expect(stripInlineXml(input)).toBe("Checking: ");
  });

  it("strips self-closing tag with no attributes", () => {
    const input = "Before <list_dir/> after";
    expect(stripInlineXml(input)).toBe("Before  after");
  });

  // ── Opening+closing pairs ─────────────────────────────────

  it("strips opening+closing tool call blocks", () => {
    const input =
      'Let me read that file.\n\n<read_file path="/src/index.ts">\nconst x = 1;\n</read_file>\n\nI found the content.';
    const result = stripInlineXml(input);
    expect(result).toContain("Let me read that file.");
    expect(result).toContain("I found the content.");
    expect(result).not.toContain("<read_file");
    expect(result).not.toContain("const x = 1;");
  });

  it("strips multiple tool call pairs in same delta", () => {
    const input = 'A<read_file path="/a.ts">a</read_file>B<read_file path="/b.ts">b</read_file>C';
    const result = stripInlineXml(input);
    expect(result).toBe("ABC");
  });

  // ── Opening tag without closing (streaming artifact) ───────

  it("strips complete opening tag without closing pair", () => {
    const input = 'Let me read.\n<read_file path="/src/index.ts">';
    expect(stripInlineXml(input)).toBe("Let me read.\n");
  });

  it("strips incomplete tag at end of content (split across SSE boundaries)", () => {
    const input = 'Let me read.\n<read_file path="/src/index.ts"';
    expect(stripInlineXml(input)).toBe("Let me read.\n");
  });

  it("strips multiple unpaired opening tags (parallel tool calls streaming)", () => {
    const input =
      '<read_file path="/a.ts">\ncontent a\n<read_file path="/b.ts">\ncontent b\n';
    const result = stripInlineXml(input);
    expect(result).toBe("\ncontent a\n\ncontent b\n");
  });

  // ── Model output tags ─────────────────────────────────────

  it("strips model output tags with content (thinking, reasoning)", () => {
    const input =
      "<thinking>Let me think about this</thinking>The answer is 42.";
    expect(stripInlineXml(input)).toBe("The answer is 42.");
  });

  it("strips orphan think/reasoning tags", () => {
    const input = "Before<think streaming>some thoughtAfter";
    const result = stripInlineXml(input);
    expect(result).toBe("Beforesome thoughtAfter");
  });

  // ── MCP tags ──────────────────────────────────────────────

  it("strips MCP tags with content", () => {
    const input = '<mcp_fetch url="https://example.com">response</mcp_fetch>';
    expect(stripInlineXml(input)).toBe("");
  });

  it("strips incomplete MCP tag at end (streaming)", () => {
    const input = 'Processing <mcp_fetch url="https://example.com">';
    expect(stripInlineXml(input)).toBe("Processing ");
  });

  // ── DeepSeek / OpenAI tokens ──────────────────────────────

  it("strips DeepSeek unicode bracket tokens", () => {
    const input = "<\uff5c>deepseek token</\uff5c>Regular text";
    expect(stripInlineXml(input)).toBe("Regular text");
  });

  it("strips OpenAI internal channel token markers", () => {
    // stripInlineXml strips the tag markers but not content between paired tokens
    const input = "<|channel|>leaked token<|end|>Actual content";
    expect(stripInlineXml(input)).toBe("leaked tokenActual content");
  });

  // ── Anthropic / function_calls tags ───────────────────────

  it("strips orphan antml and function_calls tag markers", () => {
    // stripInlineXml strips tag markers but not content between opening/closing tags
    const input = "Before<antml:function_calls>content</antml:function_calls>After";
    expect(stripInlineXml(input)).toBe("BeforecontentAfter");
  });

  // ── Body-tag suppression: single delta ────────────────────

  it("suppresses content inside write_file block in single delta", () => {
    const input = 'Before<write_file path="test.txt">file content here</write_file>After';
    expect(stripInlineXml(input)).toBe("BeforeAfter");
  });

  it("suppresses content inside edit_file block in single delta", () => {
    const input = 'Before<edit_file path="test.ts"><search>old</search><replace>new</replace></edit_file>After';
    expect(stripInlineXml(input)).toBe("BeforeAfter");
  });

  it("suppresses content inside memory_save block in single delta", () => {
    const input = 'Before<memory_save content="data">sensitive info</memory_save>After';
    expect(stripInlineXml(input)).toBe("BeforeAfter");
  });

  it("suppresses content inside clipboard_write block in single delta", () => {
    const input = 'Before<clipboard_write text="secret">password</clipboard_write>After';
    expect(stripInlineXml(input)).toBe("BeforeAfter");
  });

  it("suppresses content inside browser_execute block in single delta", () => {
    const input = 'Before<browser_execute script="alert(1)">script output</browser_execute>After';
    expect(stripInlineXml(input)).toBe("BeforeAfter");
  });

  it("does NOT suppress content inside non-body tags (read_file)", () => {
    const input = '<read_file path="/x.ts">file content</read_file>';
    // read_file is NOT in BODY_TAG_NAMES, so content should be stripped as a regular tag pair
    const result = stripInlineXml(input);
    expect(result).toBe("");
  });

  it("does NOT suppress content inside bash tags", () => {
    const input = '<bash command="ls">output here</bash>';
    const result = stripInlineXml(input);
    expect(result).toBe("");
  });

  // ── Body-tag suppression: multi-delta (stateful) ──────────

  it("delta1: suppresses content after opening body tag; preserves text before tag", () => {
    const delta1 = 'First step.\n<write_file path="test.txt">\nwriting data...\n';
    // stripInlineXml trims trailing whitespace on body-tag suppression
    const result = stripInlineXml(delta1);
    expect(result).toBe("First step.");
  });

  it("delta2: closing body tag arrives, content after tag passes through", () => {
    // First simulate delta1 to set up state
    stripInlineXml('<write_file path="test.txt">\nwriting data...\n');
    // Then simulate delta2 with closing tag
    const delta2 = '</write_file>\nDone writing.';
    expect(stripInlineXml(delta2)).toBe("\nDone writing.");
  });

  it("suppresses entire delta when in body tag (no closing tag yet)", () => {
    stripInlineXml('<write_file path="test.txt">');
    const delta2 = 'This entire content should be suppressed because we are inside the body tag.';
    expect(stripInlineXml(delta2)).toBe("");
  });

  it("handles edit_file body tag split across 3 deltas", () => {
    // Delta 1: opening tag
    const d1 = 'Editing file.\n<edit_file path="test.ts">';
    // stripInlineXml trims trailing whitespace on body-tag suppression
    expect(stripInlineXml(d1)).toBe("Editing file.");
    // Delta 2: body content (suppressed)
    expect(stripInlineXml("some edited content here\n")).toBe("");
    // Delta 3: closing tag + more text
    expect(stripInlineXml("</edit_file>\nDone editing.")).toBe("\nDone editing.");
  });

  it("handles memory_save body tag with newlines in body", () => {
    stripInlineXml('<memory_save category="project">');
    const body = "Important memory content\nwith multiple lines\nthat should be suppressed";
    expect(stripInlineXml(body)).toBe("");
    const closing = "</memory_save>\nMemory saved!";
    expect(stripInlineXml(closing)).toBe("\nMemory saved!");
  });

  it("handles clipboard_write body tag spanning two deltas", () => {
    const d1 = '<clipboard_write text="hello">copied content';
    expect(stripInlineXml(d1)).toBe("");
    const d2 = '</clipboard_write> Finished.';
    expect(stripInlineXml(d2)).toBe(" Finished.");
  });

  it("handles browser_execute body tag with script content", () => {
    stripInlineXml('<browser_execute script="console.log(1)">');
    expect(stripInlineXml("console output\nline2\n")).toBe("");
    expect(stripInlineXml("</browser_execute> done.")).toBe(" done.");
  });

  // ── Mixed scenarios: body + non-body tags ─────────────────

  it("body tag suppression doesn't interfere with non-body tag stripping", () => {
    // Non-body tags should still be stripped even when not inside a body tag
    const content = 'Check status: <git_status/> done.';
    expect(stripInlineXml(content)).toBe("Check status:  done.");
  });

  it("non-body tags before body tag are stripped, body content suppressed", () => {
    const delta = 'First:<git_status/> then <write_file path="x.txt">body here';
    const result = stripInlineXml(delta);
    // git_status should be stripped, and content after write_file opening should be suppressed
    // The result should be just the text before write_file opening
    expect(result).toContain("First:");
    expect(result).not.toContain("body here");
  });

  it("non-body tags after body tag are processed after body closes", () => {
    stripInlineXml('<write_file path="x.txt">');
    stripInlineXml("body content");
    // Closing tag followed by a self-closing tag
    const d3 = '</write_file> Result: <bash command="git status"/>';
    const result = stripInlineXml(d3);
    // bash tag should be stripped
    expect(result).toBe(" Result: ");
  });

  // ── Body tag with immediate close in same delta ───────────

  it("body tag with both open and close in same delta still suppresses", () => {
    const input = 'A<edit_file path="x.ts"><search>old</search><replace>new</replace></edit_file>B';
    expect(stripInlineXml(input)).toBe("AB");
  });

  // ── Edge cases ───────────────────────────────────────────

  it("handles body tag with no closing tag ever (resetStreamingState needed)", () => {
    stripInlineXml('<write_file path="orphan.txt">');
    // All subsequent deltas suppressed
    expect(stripInlineXml("content1")).toBe("");
    expect(stripInlineXml("content2")).toBe("");
    // Reset should clear the stuck state
    resetStreamingState();
    expect(stripInlineXml("fresh content after reset")).toBe("fresh content after reset");
  });

  it("handles body tag with attributes containing equals signs", () => {
    // Attributes with = inside values (URLs etc.)
    const input = '<write_file path="path/to/file?key=value&other=val">content</write_file>';
    expect(stripInlineXml(input)).toBe("");
  });

  it("passes through orphaned partial tool name suffixes without < (fast path short-circuit)", () => {
    // stripInlineXml is a fast streaming stripper — if no "<" is present, it
    // short-circuits and returns the content unchanged. Orphan suffixes like
    // "_navigate url=..." arrive in deltas that typically DO have "<" from
    // other content, but if they don't, the content passes through.
    const input = "Some text\n_navigate url=\"http://example.com\" \"/> \n";
    expect(stripInlineXml(input)).toBe(input);
  });

  it("passes through orphaned attribute values without < (fast path short-circuit)", () => {
    const input = "prefix\npath=\"/etc/passwd\" \"/> \nsuffix";
    expect(stripInlineXml(input)).toBe(input);
  });

  it("strips orphan suffix when < is present in the content", () => {
    // When there IS a "<" in the content, the ORPHAN_SUFFIX_RE runs.
    // Use a known tag name that triggers the full processing.
    const input = "Some text\n_navigate url=\"http://example.com\" \"/> \n<list_dir/>";
    const result = stripInlineXml(input);
    // The _navigate line should be stripped because < triggers the full processing
    expect(result).not.toContain("_navigate");
    // The known tag <list_dir/> should also be stripped
    expect(result).toBe("Some text");
  });

  it("non-body tags inside body tag content are suppressed along with body", () => {
    // If we're inside a body tag, everything is suppressed - nested tags don't matter
    stripInlineXml('<write_file path="x.ts">');
    const bodyWithNested = 'Some text <bash command="ls"/> more text';
    expect(stripInlineXml(bodyWithNested)).toBe("");
    resetStreamingState();
  });

  it("handles Unicode characters in body tag content", () => {
    stripInlineXml('<edit_file path="test.ts">');
    expect(stripInlineXml("Unicode: ñoño\n日本語\nemoji 🎉\n")).toBe("");
    expect(stripInlineXml("</edit_file>")).toBe("");
  });

  it("handles empty body tag content", () => {
    const input = '<write_file path="empty.txt"></write_file>';
    expect(stripInlineXml(input)).toBe("");
  });

  it("does not trigger body-tag suppression for names that partially match body tags", () => {
    // "write_file_extra" is NOT in BODY_TAG_NAMES (only "write_file" is) —
    // body-tag suppression should not activate. However, the opening tag
    // IS stripped by XML_OPENING_TAG_RE because "write_file" is a known
    // tag name prefix in the regex alternation. The closing tag is kept
    // because `>` doesn't immediately follow "write_file" in "</write_file_extra>".
    const input = '<write_file_extra param="val">content</write_file_extra>';
    const result = stripInlineXml(input);
    // Body-tag suppression didn't activate — content is not in a suppressed state
    // But the opening tag got stripped by the regex (write_file is a known prefix)
    expect(result).toBe("content</write_file_extra>");
  });

  // ── Consecutive body tags in sequence ─────────────────────

  it("handles two consecutive write_file body tags", () => {
    // First body tag
    stripInlineXml('<write_file path="a.txt">');
    stripInlineXml("content a");
    stripInlineXml("</write_file>");
    // Second body tag (after reset, state should be clean for new tag)
    // But _insideBodyTag is null now, so new body tag should start fresh
    const d = '<write_file path="b.txt">content b</write_file>';
    expect(stripInlineXml(d)).toBe("");
  });

  it("handles edit_file then write_file in sequence", () => {
    stripInlineXml('<edit_file path="a.ts">');
    stripInlineXml("edit content");
    stripInlineXml("</edit_file>");
    // State should be clean for next body tag
    const d = '<write_file path="b.ts">write content</write_file>';
    expect(stripInlineXml(d)).toBe("");
  });
});

// ============================================================================
// resetStreamingState
// ============================================================================

describe("resetStreamingState", () => {
  beforeEach(() => {
    resetStreamingState();
  });

  it("is idempotent when called multiple times", () => {
    expect(() => {
      resetStreamingState();
      resetStreamingState();
      resetStreamingState();
    }).not.toThrow();
  });

  it("clears body-tag state so new stream doesn't carry over stale state", () => {
    // Simulate being stuck inside a body tag
    stripInlineXml('<write_file path="x.txt">');
    expect(stripInlineXml("suppressed content")).toBe("");

    // Reset clears the stuck state
    resetStreamingState();

    // New content should no longer be suppressed
    expect(stripInlineXml("fresh content after reset")).toBe("fresh content after reset");
  });

  it("allows a new body tag to start fresh after previous stream ended", () => {
    // First stream: body tag in progress
    stripInlineXml('<edit_file path="a.ts">');
    stripInlineXml("content");
    // Stream ends with reset
    resetStreamingState();

    // Second stream: should not inherit state from first
    const d = '<edit_file path="b.ts">new content</edit_file>';
    expect(stripInlineXml(d)).toBe("");
  });

  it("doesn't interfere with normal non-body tag stripping after reset", () => {
    resetStreamingState();
    const input = 'Check: <git_status/>';
    expect(stripInlineXml(input)).toBe("Check: ");
  });

  it("clears state after incomplete body tag that never closes", () => {
    // Simulate: stream starts, body tag opens, stream disconnects without closing
    stripInlineXml('<write_file path="lost.txt">');
    stripInlineXml("lost content that should be suppressed");

    // Stream cleanup: reset state
    resetStreamingState();

    // Subsequent content should flow normally
    const recoveryMsg = "New message after stream recovery.";
    expect(stripInlineXml(recoveryMsg)).toBe(recoveryMsg);
  });

  it("allows body tag to work after multiple resets", () => {
    resetStreamingState();
    resetStreamingState();

    // Start a new body tag after resets
    stripInlineXml('<write_file path="x.txt">');
    expect(stripInlineXml("content")).toBe("");
    expect(stripInlineXml("</write_file> done")).toBe(" done");
  });

  it("is safe to call before any streaming has occurred", () => {
    expect(() => resetStreamingState()).not.toThrow();
    expect(stripInlineXml("normal text")).toBe("normal text");
  });

  it("maintains correct state across alternating resets and body tags", () => {
    // Stream 1
    stripInlineXml('<write_file path="a.txt">');
    stripInlineXml("content a");
    stripInlineXml("</write_file>");
    resetStreamingState();

    // Stream 2
    stripInlineXml('<edit_file path="b.ts">');
    stripInlineXml("content b");
    stripInlineXml("</edit_file>");
    resetStreamingState();

    // Clean state after both streams
    expect(stripInlineXml("clean message")).toBe("clean message");
  });

  // ── Session-keyed isolation ───────────────────────────────

  it("isolates body-tag state across different sessions", () => {
    // Session A starts a body tag
    stripInlineXml('<write_file path="a.txt">', "session-A");
    // Session B has no body tag — should process normally
    expect(stripInlineXml("Session B text", "session-B")).toBe("Session B text");
    // Session A content should be suppressed
    expect(stripInlineXml("Session A suppressed", "session-A")).toBe("");
    // Session B still unaffected
    expect(stripInlineXml("Session B more", "session-B")).toBe("Session B more");
    // Close Session A's body tag
    expect(stripInlineXml("</write_file> Session A done", "session-A")).toBe(" Session A done");
    // Session B still clean
    expect(stripInlineXml("Session B after", "session-B")).toBe("Session B after");
    // Clean up
    resetStreamingState("session-A");
    resetStreamingState("session-B");
  });

  it("handles concurrent body tags in different sessions without interference", () => {
    // Session A: write_file
    stripInlineXml('<write_file path="a.txt">', "session-A");
    // Session B: edit_file
    stripInlineXml('<edit_file path="b.ts">', "session-B");

    // Both should have content suppressed
    expect(stripInlineXml("A content", "session-A")).toBe("");
    expect(stripInlineXml("B content", "session-B")).toBe("");

    // Close Session B first
    expect(stripInlineXml("</edit_file> B done", "session-B")).toBe(" B done");
    // Session A still suppressed
    expect(stripInlineXml("A still inside", "session-A")).toBe("");

    // Close Session A
    expect(stripInlineXml("</write_file> A done", "session-A")).toBe(" A done");
    // Both sessions clean
    expect(stripInlineXml("clean up A", "session-A")).toBe("clean up A");
    expect(stripInlineXml("clean up B", "session-B")).toBe("clean up B");

    resetStreamingState("session-A");
    resetStreamingState("session-B");
  });

  it("resetStreamingState with sessionId only resets that session", () => {
    // Session A and B both in body tags
    stripInlineXml('<write_file path="a.txt">', "session-A");
    stripInlineXml('<edit_file path="b.ts">', "session-B");

    // Reset only Session A
    resetStreamingState("session-A");

    // Session A should be clean
    expect(stripInlineXml("A fresh text", "session-A")).toBe("A fresh text");
    // Session B still suppressed
    expect(stripInlineXml("B still inside", "session-B")).toBe("");

    // Clean up
    resetStreamingState("session-B");
  });

  it("default session and named session are independent", () => {
    // Default session (no sessionId) starts a body tag
    stripInlineXml('<write_file path="x.txt">');
    // Named session has clean state
    expect(stripInlineXml("named session text", "named-session")).toBe("named session text");
    // Default session suppressed
    expect(stripInlineXml("default suppressed", "_default")).toBe("");
    // Actually, without sessionId, it defaults to "_default"
    expect(stripInlineXml("also suppressed")).toBe("");
    // Close default and clean up
    expect(stripInlineXml("</write_file> done")).toBe(" done");
    resetStreamingState();
    resetStreamingState("named-session");
  });

  it("resetStreamingState without sessionId clears all sessions", () => {
    // Multiple sessions with state
    stripInlineXml('<write_file path="a.txt">', "session-A");
    stripInlineXml('<edit_file path="b.ts">', "session-B");

    // Global reset clears ALL sessions
    resetStreamingState();

    // Both should be clean
    expect(stripInlineXml("A after global reset", "session-A")).toBe("A after global reset");
    expect(stripInlineXml("B after global reset", "session-B")).toBe("B after global reset");
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
