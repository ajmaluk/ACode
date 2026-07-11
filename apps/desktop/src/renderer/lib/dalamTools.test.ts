import { describe, it, expect } from "vitest";
import {
  parseAttributes,
  parseToolCalls,
  extractToolCallsFromCodeBlocks,
  JUNK_DIRS,
} from "./dalamAPI";

describe("parseAttributes", () => {
  it("parses single-quoted attributes", () => {
    const attrs = parseAttributes("path='test.ts' pattern='hello'");
    expect(attrs.path).toBe("test.ts");
    expect(attrs.pattern).toBe("hello");
  });

  it("parses double-quoted attributes", () => {
    const attrs = parseAttributes('path="test.ts" pattern="hello"');
    expect(attrs.path).toBe("test.ts");
    expect(attrs.pattern).toBe("hello");
  });

  it("handles empty string", () => {
    const attrs = parseAttributes("");
    expect(Object.keys(attrs)).toHaveLength(0);
  });

  it("handles no attributes", () => {
    const attrs = parseAttributes("<tag>");
    expect(Object.keys(attrs)).toHaveLength(0);
  });

  it("handles special characters in values", () => {
    const attrs = parseAttributes(
      "path='src/index.ts' pattern='function\\(\\)'",
    );
    expect(attrs.path).toBe("src/index.ts");
    expect(attrs.pattern).toBe("function\\(\\)");
  });

  it("handles multiple attributes", () => {
    const attrs = parseAttributes("a='1' b='2' c='3' d='4' e='5'");
    expect(Object.keys(attrs)).toHaveLength(5);
  });

  it("handles nested quotes of the opposite type", () => {
    const attrs = parseAttributes(
      "command=\"echo 'hello'\" pattern='foo \"bar\"'",
    );
    expect(attrs.command).toBe("echo 'hello'");
    expect(attrs.pattern).toBe('foo "bar"');
  });
});

describe("parseToolCalls", () => {
  describe("read_file", () => {
    it("parses single-quoted path", async () => {
      const calls = await parseToolCalls("<read_file path='test.ts' />");
      expect(calls).toHaveLength(1);
      expect(calls[0].name).toBe("read_file");
      expect(calls[0].args.path).toBe("test.ts");
    });

    it("parses double-quoted path", async () => {
      const calls = await parseToolCalls('<read_file path="src/index.ts" />');
      expect(calls).toHaveLength(1);
      expect(calls[0].args.path).toBe("src/index.ts");
    });

    it("handles path with spaces", async () => {
      const calls = await parseToolCalls("<read_file path='my file.ts' />");
      expect(calls).toHaveLength(1);
      expect(calls[0].args.path).toBe("my file.ts");
    });

    it("parses multiple read_file calls", async () => {
      const calls = await parseToolCalls(
        "<read_file path='a.ts' /><read_file path='b.ts' />",
      );
      expect(calls).toHaveLength(2);
    });
  });

  describe("write_file", () => {
    it("parses write with content", async () => {
      const calls = await parseToolCalls(
        "<write_file path='test.ts'>const x = 1;</write_file>",
      );
      expect(calls).toHaveLength(1);
      expect(calls[0].name).toBe("write_file");
      expect(calls[0].args.content).toBe("const x = 1;");
    });

    it("handles multiline content", async () => {
      const content = "line1\nline2\nline3";
      const calls = await parseToolCalls(
        `<write_file path='test.ts'>${content}</write_file>`,
      );
      expect(calls[0].args.content).toBe(content);
    });

    it("handles empty content", async () => {
      const calls = await parseToolCalls("<write_file path='test.ts'></write_file>");
      expect(calls).toHaveLength(1);
      expect(calls[0].args.content).toBe("");
    });

    it("handles content with special chars", async () => {
      const calls = await parseToolCalls(
        "<write_file path='test.ts'>const x = \"hello\";</write_file>",
      );
      expect(calls[0].args.content).toBe('const x = "hello";');
    });
  });

  describe("edit_file", () => {
    it("parses search and replace", async () => {
      const calls = await parseToolCalls(
        "<edit_file path='test.ts'><search>old</search><replace>new</replace></edit_file>",
      );
      expect(calls).toHaveLength(1);
      expect(calls[0].name).toBe("edit_file");
      expect(calls[0].args.search).toBe("old");
      expect(calls[0].args.replace).toBe("new");
    });

    it("handles multiline search/replace", async () => {
      const search = "function foo() {\n  return 1;\n}";
      const replace = "function foo() {\n  return 2;\n}";
      const calls = await parseToolCalls(
        `<edit_file path='test.ts'><search>${search}</search><replace>${replace}</replace></edit_file>`,
      );
      expect(calls[0].args.search).toBe(search);
      expect(calls[0].args.replace).toBe(replace);
    });

    it("handles nested angle brackets in content", async () => {
      const calls = await parseToolCalls(
        "<write_file path='test.ts'>const x = <div>hello</div>;</write_file>",
      );
      expect(calls).toHaveLength(1);
    });
  });

  describe("list_dir", () => {
    it("parses list_dir", async () => {
      const calls = await parseToolCalls("<list_dir path='src/' />");
      expect(calls).toHaveLength(1);
      expect(calls[0].name).toBe("list_dir");
      expect(calls[0].args.path).toBe("src/");
    });
  });

  describe("grep_file", () => {
    it("parses grep with path and pattern", async () => {
      const calls = await parseToolCalls(
        "<grep_file path='test.ts' pattern='function' />",
      );
      expect(calls).toHaveLength(1);
      expect(calls[0].name).toBe("grep_file");
      expect(calls[0].args.path).toBe("test.ts");
      expect(calls[0].args.pattern).toBe("function");
    });

    it("parses grep with regex", async () => {
      const calls = await parseToolCalls(
        "<grep_file path='test.ts' pattern='func.*' regex='true' />",
      );
      expect(calls[0].args.regex).toBe("true");
    });

    it("parses grep with max_results", async () => {
      const calls = await parseToolCalls(
        "<grep_file path='test.ts' pattern='x' max_results='10' />",
      );
      expect(calls[0].args.max_results).toBe("10");
    });
  });

  describe("search_files", () => {
    it("parses search with pattern", async () => {
      const calls = await parseToolCalls("<search_files pattern='TODO' />");
      expect(calls).toHaveLength(1);
      expect(calls[0].name).toBe("search_files");
      expect(calls[0].args.pattern).toBe("TODO");
    });

    it("parses search with glob", async () => {
      const calls = await parseToolCalls(
        "<search_files pattern='TODO' glob='*.ts' />",
      );
      expect(calls[0].args.glob).toBe("*.ts");
    });

    it("parses search with path", async () => {
      const calls = await parseToolCalls(
        "<search_files path='src/' pattern='TODO' />",
      );
      expect(calls[0].args.path).toBe("src/");
    });
  });

  describe("run_command", () => {
    it("parses single-quoted command", async () => {
      const calls = await parseToolCalls("<run_command command='ls -la' />");
      expect(calls).toHaveLength(1);
      expect(calls[0].args.command).toBe("ls -la");
    });

    it("parses double-quoted command", async () => {
      const calls = await parseToolCalls('<run_command command="git status" />');
      expect(calls[0].args.command).toBe("git status");
    });

    it("handles command with shell operators", async () => {
      const calls = await parseToolCalls(
        "<run_command command='ls -la /tmp && echo done' />",
      );
      expect(calls[0].args.command).toBe("ls -la /tmp && echo done");
    });
  });

  describe("git tools", () => {
    it("parses git_status", async () => {
      const calls = await parseToolCalls("<git_status />");
      expect(calls).toHaveLength(1);
      expect(calls[0].name).toBe("git_status");
    });

    it("parses git_commit with message", async () => {
      const calls = await parseToolCalls("<git_commit message='fix bug' />");
      expect(calls[0].name).toBe("git_commit");
      expect(calls[0].args.message).toBe("fix bug");
    });

    it("parses git_log", async () => {
      const calls = await parseToolCalls("<git_log />");
      expect(calls).toHaveLength(1);
      expect(calls[0].name).toBe("git_log");
    });
  });

  describe("clipboard tools", () => {
    it("parses clipboard_read", async () => {
      const calls = await parseToolCalls("<clipboard_read />");
      expect(calls).toHaveLength(1);
      expect(calls[0].name).toBe("clipboard_read");
    });

    it("parses clipboard_write with content", async () => {
      const calls = await parseToolCalls(
        "<clipboard_write>text to copy</clipboard_write>",
      );
      expect(calls[0].args.text).toBe("text to copy");
    });

    it("handles multiline clipboard content", async () => {
      const calls = await parseToolCalls(
        "<clipboard_write>line1\nline2</clipboard_write>",
      );
      expect(calls[0].args.text).toBe("line1\nline2");
    });
  });

  describe("system tools", () => {
    it("parses notify with title and body", async () => {
      const calls = await parseToolCalls(
        "<notify title='Alert' body='Something happened' />",
      );
      expect(calls).toHaveLength(1);
      expect(calls[0].args.title).toBe("Alert");
      expect(calls[0].args.body).toBe("Something happened");
    });

    it("parses notify with only title", async () => {
      const calls = await parseToolCalls("<notify title='Alert' />");
      expect(calls[0].args.title).toBe("Alert");
      expect(calls[0].args.body).toBe("");
    });

    it("parses system_info", async () => {
      const calls = await parseToolCalls("<system_info />");
      expect(calls).toHaveLength(1);
      expect(calls[0].name).toBe("system_info");
    });

    it("parses open_url", async () => {
      const calls = await parseToolCalls("<open_url url='https://example.com' />");
      expect(calls[0].args.url).toBe("https://example.com");
    });

    it("parses launch_app", async () => {
      const calls = await parseToolCalls(
        "<launch_app name='code' args='/workspace' />",
      );
      expect(calls[0].args.name).toBe("code");
      expect(calls[0].args.args).toBe("/workspace");
    });

    it("parses reveal_in_finder", async () => {
      const calls = await parseToolCalls("<reveal_in_finder path='/Users/test' />");
      expect(calls[0].args.path).toBe("/Users/test");
    });
  });

  describe("desktop control tools", () => {
    it("parses get_env", async () => {
      const calls = await parseToolCalls("<get_env key='HOME' />");
      expect(calls).toHaveLength(1);
      expect(calls[0].name).toBe("get_env");
      expect(calls[0].args.key).toBe("HOME");
    });

    it("parses get_screen_info", async () => {
      const calls = await parseToolCalls("<get_screen_info />");
      expect(calls).toHaveLength(1);
      expect(calls[0].name).toBe("get_screen_info");
    });

    it("parses list_processes", async () => {
      const calls = await parseToolCalls("<list_processes />");
      expect(calls).toHaveLength(1);
      expect(calls[0].name).toBe("list_processes");
    });

    it("parses kill_process", async () => {
      const calls = await parseToolCalls("<kill_process pid='1234' />");
      expect(calls[0].args.pid).toBe("1234");
    });

    it("parses get_disk_space", async () => {
      const calls = await parseToolCalls("<get_disk_space path='/Users' />");
      expect(calls[0].args.path).toBe("/Users");
    });
  });

  describe("memory tools", () => {
    it("parses memory_save with content", async () => {
      const calls = await parseToolCalls(
        "<memory_save category='project' tier='high' summary='test'>Memory content here</memory_save>",
      );
      expect(calls).toHaveLength(1);
      expect(calls[0].name).toBe("memory_save");
      expect(calls[0].args.category).toBe("project");
      expect(calls[0].args.content).toBe("Memory content here");
    });

    it("parses memory_search", async () => {
      const calls = await parseToolCalls(
        "<memory_search query='build commands' limit='5' />",
      );
      expect(calls[0].args.query).toBe("build commands");
      expect(calls[0].args.limit).toBe("5");
    });

    it("parses memory_delete", async () => {
      const calls = await parseToolCalls("<memory_delete id='abc123' />");
      expect(calls[0].args.id).toBe("abc123");
    });

    it("parses memory_stats", async () => {
      const calls = await parseToolCalls("<memory_stats />");
      expect(calls).toHaveLength(1);
      expect(calls[0].name).toBe("memory_stats");
    });

    it("parses memory_maintain", async () => {
      const calls = await parseToolCalls("<memory_maintain />");
      expect(calls).toHaveLength(1);
    });

    it("parses memory_extract", async () => {
      const calls = await parseToolCalls("<memory_extract />");
      expect(calls).toHaveLength(1);
    });

    it("parses memory_export", async () => {
      const calls = await parseToolCalls("<memory_export />");
      expect(calls).toHaveLength(1);
    });

    it("parses memory_import", async () => {
      const calls = await parseToolCalls("<memory_import />");
      expect(calls).toHaveLength(1);
    });
  });

  describe("edge cases", () => {
    it("returns empty for no tools", async () => {
      const calls = await parseToolCalls("Just some text with no tools");
      expect(calls).toHaveLength(0);
    });

    it("parses multiple different tools in one response", async () => {
      const text = `
        Let me read the file first.
        <read_file path='test.ts' />
        Then list the directory:
        <list_dir path='src/' />
        And check git status:
        <git_status />
      `;
      const calls = await parseToolCalls(text);
      expect(calls).toHaveLength(3);
      expect(calls.map((c) => c.name)).toEqual([
        "read_file",
        "list_dir",
        "git_status",
      ]);
    });

    it("handles malformed XML gracefully", async () => {
      const calls = await parseToolCalls(
        "<read_file path='test.ts' /> incomplete <write_file path='b.ts'>content",
      );
      expect(calls).toHaveLength(1); // only read_file parsed
      expect(calls[0].name).toBe("read_file");
    });

    it("handles empty response", async () => {
      const calls = await parseToolCalls("");
      expect(calls).toHaveLength(0);
    });

    it("handles response with only whitespace", async () => {
      const calls = await parseToolCalls("   \n\n   ");
      expect(calls).toHaveLength(0);
    });

    it("handles very long response", async () => {
      const longText =
        "x".repeat(100000) +
        "<read_file path='test.ts' />" +
        "y".repeat(100000);
      const calls = await parseToolCalls(longText);
      expect(calls).toHaveLength(1);
    });

    it("handles tool call with no space before />", async () => {
      const calls = await parseToolCalls("<read_file path='test.ts'/>");
      expect(calls).toHaveLength(1);
    });

    it("rejects tool call with extra spaces around =", async () => {
      const calls = await parseToolCalls("<read_file   path   =   'test.ts'   />");
      expect(calls).toHaveLength(0);
    });
  });

  describe("JUNK_DIRS filtering", () => {
    it("includes common junk directories", () => {
      expect(JUNK_DIRS.has(".git")).toBe(true);
      expect(JUNK_DIRS.has("node_modules")).toBe(true);
      expect(JUNK_DIRS.has("dist")).toBe(true);
      expect(JUNK_DIRS.has("build")).toBe(true);
      expect(JUNK_DIRS.has("__pycache__")).toBe(true);
      expect(JUNK_DIRS.size).toBeGreaterThanOrEqual(10);
    });
  });

  describe("Non-self-closing tag support (Llama 3.3 compatibility)", () => {
    it("parses list_dir without self-closing slash", async () => {
      const calls = await parseToolCalls(
        "<list_dir path='/Users/test/project'> </list_dir>",
      );
      expect(calls).toHaveLength(1);
      expect(calls[0].name).toBe("list_dir");
      expect(calls[0].args.path).toBe("/Users/test/project");
    });

    it("parses read_file without self-closing slash", async () => {
      const calls = await parseToolCalls("<read_file path='test.ts'></read_file>");
      expect(calls).toHaveLength(1);
      expect(calls[0].name).toBe("read_file");
      expect(calls[0].args.path).toBe("test.ts");
    });

    it("parses git_status without self-closing slash", async () => {
      const calls = await parseToolCalls("<git_status></git_status>");
      expect(calls).toHaveLength(1);
      expect(calls[0].name).toBe("git_status");
    });

    it("parses run_command without self-closing slash", async () => {
      const calls = await parseToolCalls(
        "<run_command command='ls -la'></run_command>",
      );
      expect(calls).toHaveLength(1);
      expect(calls[0].name).toBe("run_command");
      expect(calls[0].args.command).toBe("ls -la");
    });
  });

  describe("Tool calls in code blocks (Llama 3.3 fix)", () => {
    it("extracts tool calls from xml code blocks", () => {
      const text =
        'I will list the files.\n\n```xml\n<list_dir path="/Users/test/project" />\n```\n\nDone.';
      const calls = extractToolCallsFromCodeBlocks(text);
      expect(calls).toHaveLength(1);
      expect(calls[0].name).toBe("list_dir");
      expect(calls[0].args.path).toBe("/Users/test/project");
    });

    it("extracts multiple tool calls from code blocks", () => {
      const text =
        'Let me check the files.\n\n```xml\n<read_file path="src/index.ts" />\n<list_dir path="src" />\n```\n';
      const calls = extractToolCallsFromCodeBlocks(text);
      expect(calls).toHaveLength(2);
      expect(calls[0].name).toBe("read_file");
      expect(calls[1].name).toBe("list_dir");
    });

    it("extracts tool calls from unlabeled code blocks", () => {
      const text =
        'Here is the command:\n\n```\n<run_command command="git status" />\n```\n';
      const calls = extractToolCallsFromCodeBlocks(text);
      expect(calls).toHaveLength(1);
      expect(calls[0].name).toBe("run_command");
      expect(calls[0].args.command).toBe("git status");
    });

    it("does not extract non-tool tags from code blocks", () => {
      const text = '```xml\n<div class="container">Hello</div>\n```';
      const calls = extractToolCallsFromCodeBlocks(text);
      expect(calls).toHaveLength(0);
    });
  });
});
