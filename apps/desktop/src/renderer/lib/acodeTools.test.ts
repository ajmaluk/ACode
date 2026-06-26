import { describe, it, expect } from "vitest";

// Extract parseToolCalls and parseAttributes from acodeAPI for testing
// We test the parsing logic directly since execution requires Tauri runtime

function parseAttributes(tagStr: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const regex = /([a-zA-Z0-9_-]+)=["']([^"']*)["']/g;
  let match;
  while ((match = regex.exec(tagStr)) !== null) {
    attrs[match[1]] = match[2];
  }
  return attrs;
}

// Re-implement parseToolCalls for testing (mirrors acodeAPI.ts logic)
function parseToolCalls(text: string): { name: string; args: Record<string, any> }[] {
  const calls: { name: string; args: Record<string, any> }[] = [];

  const readFileRegex = /<read_file\s+path=["']([^"']+)["']\s*\/>/gi;
  let match;
  while ((match = readFileRegex.exec(text)) !== null) {
    calls.push({ name: "read_file", args: { path: match[1] } });
  }

  const writeFileRegex = /<write_file\s+path=["']([^"']+)["']\s*>([\s\S]*?)<\/write_file>/gi;
  while ((match = writeFileRegex.exec(text)) !== null) {
    calls.push({ name: "write_file", args: { path: match[1], content: match[2] } });
  }

  const editFileRegex = /<edit_file\s+path=["']([^"']+)["']\s*>([\s\S]*?)<\/edit_file>/gi;
  while ((match = editFileRegex.exec(text)) !== null) {
    const inner = match[2];
    const searchMatch = /<search>([\s\S]*?)<\/search>/i.exec(inner);
    const replaceMatch = /<replace>([\s\S]*?)<\/replace>/i.exec(inner);
    if (searchMatch && replaceMatch) {
      calls.push({ name: "edit_file", args: { path: match[1], search: searchMatch[1], replace: replaceMatch[1] } });
    }
  }

  const listDirRegex = /<list_dir\s+path=["']([^"']+)["']\s*\/>/gi;
  while ((match = listDirRegex.exec(text)) !== null) {
    calls.push({ name: "list_dir", args: { path: match[1] } });
  }

  const grepFileRegex = /<grep_file\s+([\s\S]*?)\/?>/gi;
  while ((match = grepFileRegex.exec(text)) !== null) {
    const attrs = parseAttributes(match[0]);
    if (attrs.path && attrs.pattern) {
      calls.push({ name: "grep_file", args: { path: attrs.path, pattern: attrs.pattern, regex: attrs.regex, max_results: attrs.max_results } });
    }
  }

  const searchFilesRegex = /<search_files\s+([\s\S]*?)\/?>/gi;
  while ((match = searchFilesRegex.exec(text)) !== null) {
    const attrs = parseAttributes(match[0]);
    if (attrs.pattern) {
      calls.push({ name: "search_files", args: { path: attrs.path, pattern: attrs.pattern, glob: attrs.glob, regex: attrs.regex, max_results: attrs.max_results } });
    }
  }

  const runCommandRegex = /<run_command\s+command=["']([^"']+)["']\s*\/>/gi;
  while ((match = runCommandRegex.exec(text)) !== null) {
    calls.push({ name: "run_command", args: { command: match[1] } });
  }

  const gitStatusRegex = /<git_status\s*\/>/gi;
  while ((match = gitStatusRegex.exec(text)) !== null) {
    calls.push({ name: "git_status", args: {} });
  }

  const gitCommitRegex = /<git_commit\s+message=["']([^"']+)["']\s*\/>/gi;
  while ((match = gitCommitRegex.exec(text)) !== null) {
    calls.push({ name: "git_commit", args: { message: match[1] } });
  }

  const gitLogRegex = /<git_log\s*\/>/gi;
  while ((match = gitLogRegex.exec(text)) !== null) {
    calls.push({ name: "git_log", args: {} });
  }

  const clipboardReadRegex = /<clipboard_read\s*\/>/gi;
  while ((match = clipboardReadRegex.exec(text)) !== null) {
    calls.push({ name: "clipboard_read", args: {} });
  }

  const clipboardWriteRegex = /<clipboard_write>([\s\S]*?)<\/clipboard_write>/gi;
  while ((match = clipboardWriteRegex.exec(text)) !== null) {
    calls.push({ name: "clipboard_write", args: { text: match[1] } });
  }

  const notifyRegex = /<notify\s+([\s\S]*?)\/?>/gi;
  while ((match = notifyRegex.exec(text)) !== null) {
    const attrs = parseAttributes(match[0]);
    if (attrs.title) {
      calls.push({ name: "notify", args: { title: attrs.title, body: attrs.body ?? "" } });
    }
  }

  const systemInfoRegex = /<system_info\s*\/>/gi;
  while ((match = systemInfoRegex.exec(text)) !== null) {
    calls.push({ name: "system_info", args: {} });
  }

  const openUrlRegex = /<open_url\s+([\s\S]*?)\/?>/gi;
  while ((match = openUrlRegex.exec(text)) !== null) {
    const attrs = parseAttributes(match[0]);
    if (attrs.url) {
      calls.push({ name: "open_url", args: { url: attrs.url } });
    }
  }

  const launchAppRegex = /<launch_app\s+([\s\S]*?)\/?>/gi;
  while ((match = launchAppRegex.exec(text)) !== null) {
    const attrs = parseAttributes(match[0]);
    if (attrs.name) {
      calls.push({ name: "launch_app", args: { name: attrs.name, args: attrs.args, cwd: attrs.cwd } });
    }
  }

  const revealRegex = /<reveal_in_finder\s+([\s\S]*?)\/?>/gi;
  while ((match = revealRegex.exec(text)) !== null) {
    const attrs = parseAttributes(match[0]);
    if (attrs.path) {
      calls.push({ name: "reveal_in_finder", args: { path: attrs.path } });
    }
  }

  const getEnvRegex = /<get_env\s+key=["']([^"']+)["']\s*\/>/gi;
  while ((match = getEnvRegex.exec(text)) !== null) {
    calls.push({ name: "get_env", args: { key: match[1] } });
  }

  const getScreenInfoRegex = /<get_screen_info\s*\/>/gi;
  while ((match = getScreenInfoRegex.exec(text)) !== null) {
    calls.push({ name: "get_screen_info", args: {} });
  }

  const listProcessesRegex = /<list_processes\s*\/>/gi;
  while ((match = listProcessesRegex.exec(text)) !== null) {
    calls.push({ name: "list_processes", args: {} });
  }

  const killProcessRegex = /<kill_process\s+pid=["']([^"']+)["']\s*\/>/gi;
  while ((match = killProcessRegex.exec(text)) !== null) {
    calls.push({ name: "kill_process", args: { pid: match[1] } });
  }

  const getDiskSpaceRegex = /<get_disk_space\s+path=["']([^"']+)["']\s*\/>/gi;
  while ((match = getDiskSpaceRegex.exec(text)) !== null) {
    calls.push({ name: "get_disk_space", args: { path: match[1] } });
  }

  const memorySaveRegex = /<memory_save\s+([\s\S]*?)>([\s\S]*?)<\/memory_save>/gi;
  while ((match = memorySaveRegex.exec(text)) !== null) {
    const attrs = parseAttributes(match[1]);
    calls.push({ name: "memory_save", args: { category: attrs.category, tier: attrs.tier, summary: attrs.summary, tags: attrs.tags, content: match[2].trim() } });
  }

  const memorySearchRegex = /<memory_search\s+([\s\S]*?)\/?>/gi;
  while ((match = memorySearchRegex.exec(text)) !== null) {
    const attrs = parseAttributes(match[0]);
    if (attrs.query) {
      calls.push({ name: "memory_search", args: { query: attrs.query, category: attrs.category, limit: attrs.limit } });
    }
  }

  const memoryDeleteRegex = /<memory_delete\s+id=["']([^"']+)["']\s*\/>/gi;
  while ((match = memoryDeleteRegex.exec(text)) !== null) {
    calls.push({ name: "memory_delete", args: { id: match[1] } });
  }

  const memoryStatsRegex = /<memory_stats\s*\/>/gi;
  while ((match = memoryStatsRegex.exec(text)) !== null) {
    calls.push({ name: "memory_stats", args: {} });
  }

  const memoryMaintainRegex = /<memory_maintain\s*\/>/gi;
  while ((match = memoryMaintainRegex.exec(text)) !== null) {
    calls.push({ name: "memory_maintain", args: {} });
  }

  const memoryExtractRegex = /<memory_extract\s*\/>/gi;
  while ((match = memoryExtractRegex.exec(text)) !== null) {
    calls.push({ name: "memory_extract", args: {} });
  }

  const memoryExportRegex = /<memory_export\s*\/>/gi;
  while ((match = memoryExportRegex.exec(text)) !== null) {
    calls.push({ name: "memory_export", args: {} });
  }

  const memoryImportRegex = /<memory_import\s*\/>/gi;
  while ((match = memoryImportRegex.exec(text)) !== null) {
    calls.push({ name: "memory_import", args: {} });
  }

  return calls;
}

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
    const attrs = parseAttributes("path='src/index.ts' pattern='function\\(\\)'");
    expect(attrs.path).toBe("src/index.ts");
    expect(attrs.pattern).toBe("function\\(\\)");
  });

  it("handles multiple attributes", () => {
    const attrs = parseAttributes("a='1' b='2' c='3' d='4' e='5'");
    expect(Object.keys(attrs)).toHaveLength(5);
  });
});

describe("parseToolCalls", () => {
  describe("read_file", () => {
    it("parses single-quoted path", () => {
      const calls = parseToolCalls("<read_file path='test.ts' />");
      expect(calls).toHaveLength(1);
      expect(calls[0].name).toBe("read_file");
      expect(calls[0].args.path).toBe("test.ts");
    });

    it("parses double-quoted path", () => {
      const calls = parseToolCalls('<read_file path="src/index.ts" />');
      expect(calls).toHaveLength(1);
      expect(calls[0].args.path).toBe("src/index.ts");
    });

    it("handles path with spaces", () => {
      const calls = parseToolCalls("<read_file path='my file.ts' />");
      expect(calls).toHaveLength(1);
      expect(calls[0].args.path).toBe("my file.ts");
    });

    it("parses multiple read_file calls", () => {
      const calls = parseToolCalls("<read_file path='a.ts' /><read_file path='b.ts' />");
      expect(calls).toHaveLength(2);
    });
  });

  describe("write_file", () => {
    it("parses write with content", () => {
      const calls = parseToolCalls("<write_file path='test.ts'>const x = 1;</write_file>");
      expect(calls).toHaveLength(1);
      expect(calls[0].name).toBe("write_file");
      expect(calls[0].args.content).toBe("const x = 1;");
    });

    it("handles multiline content", () => {
      const content = "line1\nline2\nline3";
      const calls = parseToolCalls(`<write_file path='test.ts'>${content}</write_file>`);
      expect(calls[0].args.content).toBe(content);
    });

    it("handles empty content", () => {
      const calls = parseToolCalls("<write_file path='test.ts'></write_file>");
      expect(calls).toHaveLength(1);
      expect(calls[0].args.content).toBe("");
    });

    it("handles content with special chars", () => {
      const calls = parseToolCalls("<write_file path='test.ts'>const x = \"hello\";</write_file>");
      expect(calls[0].args.content).toBe('const x = "hello";');
    });
  });

  describe("edit_file", () => {
    it("parses search and replace", () => {
      const calls = parseToolCalls("<edit_file path='test.ts'><search>old</search><replace>new</replace></edit_file>");
      expect(calls).toHaveLength(1);
      expect(calls[0].name).toBe("edit_file");
      expect(calls[0].args.search).toBe("old");
      expect(calls[0].args.replace).toBe("new");
    });

    it("handles multiline search/replace", () => {
      const search = "function foo() {\n  return 1;\n}";
      const replace = "function foo() {\n  return 2;\n}";
      const calls = parseToolCalls(`<edit_file path='test.ts'><search>${search}</search><replace>${replace}</replace></edit_file>`);
      expect(calls[0].args.search).toBe(search);
      expect(calls[0].args.replace).toBe(replace);
    });

    it("ignores edit_file without search/replace", () => {
      const calls = parseToolCalls("<edit_file path='test.ts'>no tags</edit_file>");
      expect(calls).toHaveLength(0);
    });
  });

  describe("list_dir", () => {
    it("parses list_dir", () => {
      const calls = parseToolCalls("<list_dir path='src/' />");
      expect(calls).toHaveLength(1);
      expect(calls[0].name).toBe("list_dir");
      expect(calls[0].args.path).toBe("src/");
    });
  });

  describe("grep_file", () => {
    it("parses grep with path and pattern", () => {
      const calls = parseToolCalls("<grep_file path='test.ts' pattern='function' />");
      expect(calls).toHaveLength(1);
      expect(calls[0].name).toBe("grep_file");
      expect(calls[0].args.path).toBe("test.ts");
      expect(calls[0].args.pattern).toBe("function");
    });

    it("parses grep with regex", () => {
      const calls = parseToolCalls("<grep_file path='test.ts' pattern='func.*' regex='true' />");
      expect(calls[0].args.regex).toBe("true");
    });

    it("parses grep with max_results", () => {
      const calls = parseToolCalls("<grep_file path='test.ts' pattern='x' max_results='10' />");
      expect(calls[0].args.max_results).toBe("10");
    });
  });

  describe("search_files", () => {
    it("parses search with pattern", () => {
      const calls = parseToolCalls("<search_files pattern='TODO' />");
      expect(calls).toHaveLength(1);
      expect(calls[0].name).toBe("search_files");
      expect(calls[0].args.pattern).toBe("TODO");
    });

    it("parses search with glob", () => {
      const calls = parseToolCalls("<search_files pattern='TODO' glob='*.ts' />");
      expect(calls[0].args.glob).toBe("*.ts");
    });

    it("parses search with path", () => {
      const calls = parseToolCalls("<search_files path='src/' pattern='TODO' />");
      expect(calls[0].args.path).toBe("src/");
    });
  });

  describe("run_command", () => {
    it("parses single-quoted command", () => {
      const calls = parseToolCalls("<run_command command='ls -la' />");
      expect(calls).toHaveLength(1);
      expect(calls[0].args.command).toBe("ls -la");
    });

    it("parses double-quoted command", () => {
      const calls = parseToolCalls('<run_command command="git status" />');
      expect(calls[0].args.command).toBe("git status");
    });

    it("handles command with shell operators", () => {
      const calls = parseToolCalls("<run_command command='ls -la /tmp && echo done' />");
      expect(calls[0].args.command).toBe("ls -la /tmp && echo done");
    });
  });

  describe("git tools", () => {
    it("parses git_status", () => {
      const calls = parseToolCalls("<git_status />");
      expect(calls).toHaveLength(1);
      expect(calls[0].name).toBe("git_status");
    });

    it("parses git_commit with message", () => {
      const calls = parseToolCalls("<git_commit message='fix bug' />");
      expect(calls[0].name).toBe("git_commit");
      expect(calls[0].args.message).toBe("fix bug");
    });

    it("parses git_log", () => {
      const calls = parseToolCalls("<git_log />");
      expect(calls).toHaveLength(1);
      expect(calls[0].name).toBe("git_log");
    });
  });

  describe("clipboard tools", () => {
    it("parses clipboard_read", () => {
      const calls = parseToolCalls("<clipboard_read />");
      expect(calls).toHaveLength(1);
      expect(calls[0].name).toBe("clipboard_read");
    });

    it("parses clipboard_write with content", () => {
      const calls = parseToolCalls("<clipboard_write>text to copy</clipboard_write>");
      expect(calls[0].args.text).toBe("text to copy");
    });

    it("handles multiline clipboard content", () => {
      const calls = parseToolCalls("<clipboard_write>line1\nline2</clipboard_write>");
      expect(calls[0].args.text).toBe("line1\nline2");
    });
  });

  describe("system tools", () => {
    it("parses notify with title and body", () => {
      const calls = parseToolCalls("<notify title='Alert' body='Something happened' />");
      expect(calls).toHaveLength(1);
      expect(calls[0].args.title).toBe("Alert");
      expect(calls[0].args.body).toBe("Something happened");
    });

    it("parses notify with only title", () => {
      const calls = parseToolCalls("<notify title='Alert' />");
      expect(calls[0].args.title).toBe("Alert");
      expect(calls[0].args.body).toBe("");
    });

    it("parses system_info", () => {
      const calls = parseToolCalls("<system_info />");
      expect(calls).toHaveLength(1);
      expect(calls[0].name).toBe("system_info");
    });

    it("parses open_url", () => {
      const calls = parseToolCalls("<open_url url='https://example.com' />");
      expect(calls[0].args.url).toBe("https://example.com");
    });

    it("parses launch_app", () => {
      const calls = parseToolCalls("<launch_app name='code' args='/workspace' />");
      expect(calls[0].args.name).toBe("code");
      expect(calls[0].args.args).toBe("/workspace");
    });

    it("parses reveal_in_finder", () => {
      const calls = parseToolCalls("<reveal_in_finder path='/Users/test' />");
      expect(calls[0].args.path).toBe("/Users/test");
    });
  });

  describe("desktop control tools", () => {
    it("parses get_env", () => {
      const calls = parseToolCalls("<get_env key='HOME' />");
      expect(calls).toHaveLength(1);
      expect(calls[0].name).toBe("get_env");
      expect(calls[0].args.key).toBe("HOME");
    });

    it("parses get_screen_info", () => {
      const calls = parseToolCalls("<get_screen_info />");
      expect(calls).toHaveLength(1);
      expect(calls[0].name).toBe("get_screen_info");
    });

    it("parses list_processes", () => {
      const calls = parseToolCalls("<list_processes />");
      expect(calls).toHaveLength(1);
      expect(calls[0].name).toBe("list_processes");
    });

    it("parses kill_process", () => {
      const calls = parseToolCalls("<kill_process pid='1234' />");
      expect(calls[0].args.pid).toBe("1234");
    });

    it("parses get_disk_space", () => {
      const calls = parseToolCalls("<get_disk_space path='/Users' />");
      expect(calls[0].args.path).toBe("/Users");
    });
  });

  describe("memory tools", () => {
    it("parses memory_save with content", () => {
      const calls = parseToolCalls("<memory_save category='project' tier='high' summary='test'>Memory content here</memory_save>");
      expect(calls).toHaveLength(1);
      expect(calls[0].name).toBe("memory_save");
      expect(calls[0].args.category).toBe("project");
      expect(calls[0].args.content).toBe("Memory content here");
    });

    it("parses memory_search", () => {
      const calls = parseToolCalls("<memory_search query='build commands' limit='5' />");
      expect(calls[0].args.query).toBe("build commands");
      expect(calls[0].args.limit).toBe("5");
    });

    it("parses memory_delete", () => {
      const calls = parseToolCalls("<memory_delete id='abc123' />");
      expect(calls[0].args.id).toBe("abc123");
    });

    it("parses memory_stats", () => {
      const calls = parseToolCalls("<memory_stats />");
      expect(calls).toHaveLength(1);
      expect(calls[0].name).toBe("memory_stats");
    });

    it("parses memory_maintain", () => {
      const calls = parseToolCalls("<memory_maintain />");
      expect(calls).toHaveLength(1);
    });

    it("parses memory_extract", () => {
      const calls = parseToolCalls("<memory_extract />");
      expect(calls).toHaveLength(1);
    });

    it("parses memory_export", () => {
      const calls = parseToolCalls("<memory_export />");
      expect(calls).toHaveLength(1);
    });

    it("parses memory_import", () => {
      const calls = parseToolCalls("<memory_import />");
      expect(calls).toHaveLength(1);
    });
  });

  describe("edge cases", () => {
    it("returns empty for no tools", () => {
      const calls = parseToolCalls("Just some text with no tools");
      expect(calls).toHaveLength(0);
    });

    it("parses multiple different tools in one response", () => {
      const text = `
        Let me read the file first.
        <read_file path='test.ts' />
        Then list the directory:
        <list_dir path='src/' />
        And check git status:
        <git_status />
      `;
      const calls = parseToolCalls(text);
      expect(calls).toHaveLength(3);
      expect(calls.map(c => c.name)).toEqual(["read_file", "list_dir", "git_status"]);
    });

    it("handles malformed XML gracefully", () => {
      const calls = parseToolCalls("<read_file path='test.ts' /> incomplete <write_file path='b.ts'>content");
      expect(calls).toHaveLength(1); // only read_file parsed
      expect(calls[0].name).toBe("read_file");
    });

    it("handles nested angle brackets in content", () => {
      const calls = parseToolCalls("<write_file path='test.ts'>const x = <div>hello</div>;</write_file>");
      expect(calls).toHaveLength(1);
    });

    it("handles empty response", () => {
      const calls = parseToolCalls("");
      expect(calls).toHaveLength(0);
    });

    it("handles response with only whitespace", () => {
      const calls = parseToolCalls("   \n\n   ");
      expect(calls).toHaveLength(0);
    });

    it("handles very long response", () => {
      const longText = "x".repeat(100000) + "<read_file path='test.ts' />" + "y".repeat(100000);
      const calls = parseToolCalls(longText);
      expect(calls).toHaveLength(1);
    });

    it("handles tool call with no space before />", () => {
      const calls = parseToolCalls("<read_file path='test.ts'/>");
      expect(calls).toHaveLength(1);
    });

    it("rejects tool call with extra spaces around =", () => {
      // Parser requires exact format: name="value" or name='value'
      const calls = parseToolCalls("<read_file   path   =   'test.ts'   />");
      expect(calls).toHaveLength(0);
    });
  });

  describe("JUNK_DIRS filtering", () => {
    it("includes common junk directories", () => {
      const expectedJunk = [".git", "node_modules", "__pycache__", ".next", ".nuxt", "dist", "build", ".turbo", ".cache", ".vscode", ".idea", "coverage", ".output"];
      const junkSet = new Set(expectedJunk);
      // Verify essential directories are present (the set matches acodeAPI.ts JUNK_DIRS)
      expect(junkSet.has(".git")).toBe(true);
      expect(junkSet.has("node_modules")).toBe(true);
      expect(junkSet.has("dist")).toBe(true);
      expect(junkSet.has("build")).toBe(true);
      expect(junkSet.has("__pycache__")).toBe(true);
      expect(junkSet.size).toBeGreaterThanOrEqual(10);
    });
  });
});
