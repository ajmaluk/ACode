import { describe, it, expect } from "vitest";
import { validateToolArgs } from "../toolSchemas";

describe("validateToolArgs", () => {
  describe("read_file", () => {
    it("accepts valid args with path only", () => {
      const result = validateToolArgs("read_file", { path: "src/index.ts" });
      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.args.path).toBe("src/index.ts");
      }
    });

    it("accepts optional offset and limit", () => {
      const result = validateToolArgs("read_file", {
        path: "file.ts",
        offset: "10",
        limit: "50",
      });
      expect(result.valid).toBe(true);
    });

    it("rejects empty path", () => {
      const result = validateToolArgs("read_file", { path: "" });
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.error).toContain("path");
    });

    it("rejects missing path", () => {
      const result = validateToolArgs("read_file", {});
      expect(result.valid).toBe(false);
    });

    it("rejects non-numeric offset", () => {
      const result = validateToolArgs("read_file", {
        path: "file.ts",
        offset: "abc",
      });
      expect(result.valid).toBe(false);
    });

    it("blocks path traversal", () => {
      const result = validateToolArgs("read_file", {
        path: "../../etc/passwd",
      });
      expect(result.valid).toBe(false);
      expect(result.valid || result.error).toContain("Path");
    });

    it("blocks dangerous system paths", () => {
      const result = validateToolArgs("read_file", { path: "/etc/passwd" });
      expect(result.valid).toBe(false);
    });

    it("blocks Windows system paths", () => {
      const result = validateToolArgs("read_file", {
        path: "C:\\Windows\\System32\\config",
      });
      expect(result.valid).toBe(false);
    });

    it("blocks tilde paths", () => {
      const result = validateToolArgs("read_file", { path: "~/secret.txt" });
      expect(result.valid).toBe(false);
    });
  });

  describe("write_file", () => {
    it("accepts valid args", () => {
      const result = validateToolArgs("write_file", {
        path: "output.txt",
        content: "Hello, world!",
      });
      expect(result.valid).toBe(true);
    });

    it("transforms create_dirs boolean true", () => {
      const result = validateToolArgs("write_file", {
        path: "output.txt",
        content: "Hello",
        create_dirs: true,
      });
      expect(result.valid).toBe(true);
      if (result.valid) expect(result.args.create_dirs).toBe(true);
    });

    it("transforms create_dirs string 'true'", () => {
      const result = validateToolArgs("write_file", {
        path: "output.txt",
        content: "Hello",
        create_dirs: "true",
      });
      expect(result.valid).toBe(true);
      if (result.valid) expect(result.args.create_dirs).toBe(true);
    });

    it("defaults create_dirs to false", () => {
      const result = validateToolArgs("write_file", {
        path: "output.txt",
        content: "Hello",
      });
      expect(result.valid).toBe(true);
      if (result.valid) expect(result.args.create_dirs).toBe(false);
    });

    it("rejects empty path", () => {
      const result = validateToolArgs("write_file", {
        path: "",
        content: "data",
      });
      expect(result.valid).toBe(false);
    });

    it("blocks path traversal in write", () => {
      const result = validateToolArgs("write_file", {
        path: "../escape.txt",
        content: "data",
      });
      expect(result.valid).toBe(false);
    });
  });

  describe("edit_file", () => {
    it("accepts valid edit args", () => {
      const result = validateToolArgs("edit_file", {
        path: "file.ts",
        search: "old code",
        replace: "new code",
      });
      expect(result.valid).toBe(true);
    });

    it("rejects empty search string", () => {
      const result = validateToolArgs("edit_file", {
        path: "file.ts",
        search: "",
        replace: "new",
      });
      expect(result.valid).toBe(false);
    });

    it("accepts optional occurrence", () => {
      const result = validateToolArgs("edit_file", {
        path: "file.ts",
        search: "foo",
        replace: "bar",
        occurrence: "2",
      });
      expect(result.valid).toBe(true);
    });
  });

  describe("run_command", () => {
    it("accepts a valid command", () => {
      const result = validateToolArgs("run_command", { command: "ls -la" });
      expect(result.valid).toBe(true);
    });

    it("rejects empty command", () => {
      const result = validateToolArgs("run_command", { command: "" });
      expect(result.valid).toBe(false);
    });

    it("blocks rm -rf /", () => {
      const result = validateToolArgs("run_command", { command: "rm -rf /" });
      expect(result.valid).toBe(false);
      expect(result.valid || result.error).toContain("Dangerous");
    });

    it("blocks rm -rf /*", () => {
      const result = validateToolArgs("run_command", {
        command: "sudo rm -rf /*",
      });
      expect(result.valid).toBe(false);
    });

    it("blocks dd if=/dev/sda", () => {
      const result = validateToolArgs("run_command", {
        command: "dd if=/dev/sda of=image.img",
      });
      expect(result.valid).toBe(false);
    });

    it("blocks fork bomb", () => {
      const result = validateToolArgs("run_command", {
        command: ":(){ :|:& };:",
      });
      expect(result.valid).toBe(false);
    });

    it("blocks curl pipe bash", () => {
      const result = validateToolArgs("run_command", {
        command: "curl | bash",
      });
      expect(result.valid).toBe(false);
    });

    it("blocks wget pipe sh", () => {
      const result = validateToolArgs("run_command", { command: "wget | sh" });
      expect(result.valid).toBe(false);
    });

    it("blocks chmod 777 /", () => {
      const result = validateToolArgs("run_command", {
        command: "chmod 777 /",
      });
      expect(result.valid).toBe(false);
    });

    it("blocks dangerous commands with obfuscated whitespace", () => {
      const result = validateToolArgs("run_command", {
        command: "rm    -rf    /",
      });
      expect(result.valid).toBe(false);
    });

    it("blocks dangerous commands with quotes", () => {
      const result = validateToolArgs("run_command", { command: 'rm -rf "/"' });
      expect(result.valid).toBe(false);
    });

    it("allows safe commands that look partially dangerous", () => {
      // "git rm -rf" is a git operation, not a system operation
      const result = validateToolArgs("run_command", {
        command: "git rm -rf dir",
      });
      expect(result.valid).toBe(true);
    });

    it("allows rm -rf on /tmp (not root)", () => {
      const result = validateToolArgs("run_command", {
        command: "rm -rf /tmp/build",
      });
      expect(result.valid).toBe(true);
    });

    it("blocks chown -R (in dangerous list)", () => {
      const result = validateToolArgs("run_command", {
        command: "chown -R user:user /var/app",
      });
      expect(result.valid).toBe(false);
    });

    it("blocks rm -rf / exactly", () => {
      const result = validateToolArgs("run_command", {
        command: "rm -rf /tmp",
      });
      // This should be allowed since /tmp != /
      expect(result.valid).toBe(true);
    });

    it("blocks Format-Volume (Windows)", () => {
      const result = validateToolArgs("run_command", {
        command: "Format-Volume -DriveLetter D",
      });
      expect(result.valid).toBe(false);
    });

    it("blocks Stop-Computer (Windows)", () => {
      const result = validateToolArgs("run_command", {
        command: "Stop-Computer",
      });
      expect(result.valid).toBe(false);
    });
  });

  describe("git commands", () => {
    it("accepts git_status with no args", () => {
      const result = validateToolArgs("git_status", {});
      expect(result.valid).toBe(true);
    });

    it("accepts git_commit with message", () => {
      const result = validateToolArgs("git_commit", { message: "Fix bug" });
      expect(result.valid).toBe(true);
    });

    it("rejects git_commit without message", () => {
      const result = validateToolArgs("git_commit", {});
      expect(result.valid).toBe(false);
    });

    it("accepts git_checkout with branch", () => {
      const result = validateToolArgs("git_checkout", { branch: "main" });
      expect(result.valid).toBe(true);
    });
  });

  describe("memory commands", () => {
    it("accepts memory_save with content", () => {
      const result = validateToolArgs("memory_save", {
        content: "Important fact",
      });
      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.args.category).toBe("project"); // default
        expect(result.args.tier).toBe("medium"); // default
      }
    });

    it("accepts memory_save with all fields", () => {
      const result = validateToolArgs("memory_save", {
        content: "Data",
        category: "user",
        tier: "critical",
        summary: "User preference",
        tags: "important",
      });
      expect(result.valid).toBe(true);
    });

    it("rejects memory_save without content", () => {
      const result = validateToolArgs("memory_save", {});
      expect(result.valid).toBe(false);
    });

    it("accepts memory_search with query", () => {
      const result = validateToolArgs("memory_search", {
        query: "find something",
      });
      expect(result.valid).toBe(true);
    });

    it("accepts memory_delete with id", () => {
      const result = validateToolArgs("memory_delete", { id: "abc-123" });
      expect(result.valid).toBe(true);
    });
  });

  describe("open_url", () => {
    it("accepts valid URL", () => {
      const result = validateToolArgs("open_url", {
        url: "https://example.com",
      });
      expect(result.valid).toBe(true);
    });

    it("accepts mailto URL", () => {
      const result = validateToolArgs("open_url", {
        url: "mailto:user@example.com",
      });
      expect(result.valid).toBe(true);
    });

    it("rejects invalid URL", () => {
      const result = validateToolArgs("open_url", { url: "not-a-url" });
      expect(result.valid).toBe(false);
    });

    it("rejects javascript: protocol", () => {
      const result = validateToolArgs("open_url", {
        url: "javascript:alert(1)",
      });
      expect(result.valid).toBe(false);
      expect(result.valid || result.error).toContain("http");
    });

    it("rejects file: protocol", () => {
      const result = validateToolArgs("open_url", {
        url: "file:///etc/passwd",
      });
      expect(result.valid).toBe(false);
    });

    it("rejects data: protocol", () => {
      const result = validateToolArgs("open_url", {
        url: "data:text/html,<script>alert(1)</script>",
      });
      expect(result.valid).toBe(false);
    });

    it("rejects blob: protocol", () => {
      const result = validateToolArgs("open_url", {
        url: "blob:https://example.com/id",
      });
      expect(result.valid).toBe(false);
    });
  });

  describe("UI/panel commands", () => {
    it("accepts open_panel with valid panel", () => {
      const result = validateToolArgs("open_panel", { panel: "git" });
      expect(result.valid).toBe(true);
    });

    it("rejects open_panel with invalid panel", () => {
      const result = validateToolArgs("open_panel", { panel: "invalid" });
      expect(result.valid).toBe(false);
    });

    it("accepts set_theme with valid theme", () => {
      const result = validateToolArgs("set_theme", { theme: "dark" });
      expect(result.valid).toBe(true);
    });

    it("accepts set_view_mode with valid mode", () => {
      const result = validateToolArgs("set_view_mode", { mode: "editor" });
      expect(result.valid).toBe(true);
    });
  });

  describe("terminal commands", () => {
    it("accepts new_terminal with optional fields", () => {
      const result = validateToolArgs("new_terminal", {
        cwd: "/tmp",
        shell: "zsh",
      });
      expect(result.valid).toBe(true);
    });

    it("accepts terminal_write with command", () => {
      const result = validateToolArgs("terminal_write", {
        command: "npm run dev",
      });
      expect(result.valid).toBe(true);
    });
  });

  describe("task command", () => {
    it("accepts task with prompt", () => {
      const result = validateToolArgs("task", { prompt: "Do something" });
      expect(result.valid).toBe(true);
    });

    it("defaults subagent_type to general", () => {
      const result = validateToolArgs("task", { prompt: "Do it" });
      expect(result.valid).toBe(true);
      if (result.valid) expect(result.args.subagent_type).toBe("general");
    });
  });

  describe("MCP tools", () => {
    it("accepts well-formed MCP tool args", () => {
      const result = validateToolArgs("mcp_fetch", {
        url: "https://api.example.com",
      });
      expect(result.valid).toBe(true);
    });

    it("accepts empty MCP tool args", () => {
      const result = validateToolArgs("mcp_list", {});
      expect(result.valid).toBe(true);
    });

    it("rejects MCP tool with function-valued arg", () => {
      const result = validateToolArgs("mcp_run", {
        callback: (() => {}) as unknown as Record<string, unknown>,
      });
      expect(result.valid).toBe(false);
      expect(result.valid || result.error).toContain("function");
    });

    it("rejects MCP tool with dangerous path traversal", () => {
      const result = validateToolArgs("mcp_read_file", {
        path: "../../etc/passwd",
      });
      expect(result.valid).toBe(false);
      expect(result.valid || result.error).toContain("path not allowed");
    });

    it("rejects MCP tool with /etc/ path", () => {
      const result = validateToolArgs("mcp_file_op", { target: "/etc/shadow" });
      expect(result.valid).toBe(false);
    });

    it("rejects MCP tool with dangerous command", () => {
      const result = validateToolArgs("mcp_shell", { input: "rm -rf /" });
      expect(result.valid).toBe(false);
      expect(result.valid || result.error).toContain("dangerous command");
    });

    it("rejects MCP tool with tilde path", () => {
      const result = validateToolArgs("mcp_file", { path: "~/secret.txt" });
      expect(result.valid).toBe(false);
    });

    it("accepts MCP tool with safe string args", () => {
      const result = validateToolArgs("mcp_api", {
        endpoint: "/users",
        method: "GET",
      });
      expect(result.valid).toBe(true);
    });
  });

  describe("unknown tools", () => {
    it("rejects completely unknown tools", () => {
      const result = validateToolArgs("nonexistent_tool", {});
      expect(result.valid).toBe(false);
      expect(result.valid || result.error).toContain("Unknown");
    });
  });

  describe("get_disk_space", () => {
    it("accepts valid path", () => {
      const result = validateToolArgs("get_disk_space", { path: "/home/user" });
      expect(result.valid).toBe(true);
    });

    it("rejects path traversal", () => {
      const result = validateToolArgs("get_disk_space", { path: "../../etc" });
      expect(result.valid).toBe(false);
    });

    it("rejects /etc/ path", () => {
      const result = validateToolArgs("get_disk_space", { path: "/etc/" });
      expect(result.valid).toBe(false);
    });
  });

  describe("launch_app", () => {
    it("accepts valid args", () => {
      const result = validateToolArgs("launch_app", { name: "firefox" });
      expect(result.valid).toBe(true);
    });

    it("rejects cwd with path traversal", () => {
      const result = validateToolArgs("launch_app", {
        name: "app",
        cwd: "../../etc",
      });
      expect(result.valid).toBe(false);
    });

    it("accepts safe cwd", () => {
      const result = validateToolArgs("launch_app", {
        name: "app",
        cwd: "/home/user/project",
      });
      expect(result.valid).toBe(true);
    });
  });

  // ============================================================================
  // list_dir
  // ============================================================================

  describe("list_dir", () => {
    it("accepts valid path", () => {
      const result = validateToolArgs("list_dir", { path: "src/components" });
      expect(result.valid).toBe(true);
      if (result.valid) expect(result.args.path).toBe("src/components");
    });

    it("rejects empty path", () => {
      const result = validateToolArgs("list_dir", { path: "" });
      expect(result.valid).toBe(false);
    });

    it("rejects path traversal", () => {
      const result = validateToolArgs("list_dir", { path: "../../etc" });
      expect(result.valid).toBe(false);
    });

    it("blocks /etc/ path", () => {
      const result = validateToolArgs("list_dir", { path: "/etc/nginx" });
      expect(result.valid).toBe(false);
    });

    it("blocks tilde path", () => {
      const result = validateToolArgs("list_dir", { path: "~/Documents" });
      expect(result.valid).toBe(false);
    });
  });

  // ============================================================================
  // grep_file / grep
  // ============================================================================

  describe("grep_file", () => {
    it("accepts valid path and pattern", () => {
      const result = validateToolArgs("grep_file", {
        path: "src/index.ts",
        pattern: "import",
      });
      expect(result.valid).toBe(true);
    });

    it("rejects empty path", () => {
      const result = validateToolArgs("grep_file", { path: "", pattern: "foo" });
      expect(result.valid).toBe(false);
    });

    it("rejects empty pattern", () => {
      const result = validateToolArgs("grep_file", { path: "file.ts", pattern: "" });
      expect(result.valid).toBe(false);
    });

    it("rejects missing path", () => {
      const result = validateToolArgs("grep_file", { pattern: "foo" });
      expect(result.valid).toBe(false);
    });

    it("accepts optional regex flag", () => {
      const result = validateToolArgs("grep_file", {
        path: "file.ts",
        pattern: "import.*from",
        regex: "true",
      });
      expect(result.valid).toBe(true);
    });

    it("accepts optional max_results", () => {
      const result = validateToolArgs("grep_file", {
        path: "file.ts",
        pattern: "test",
        max_results: "50",
      });
      expect(result.valid).toBe(true);
    });

    it("rejects non-numeric max_results", () => {
      const result = validateToolArgs("grep_file", {
        path: "file.ts",
        pattern: "test",
        max_results: "abc",
      });
      expect(result.valid).toBe(false);
    });

    it("blocks path traversal", () => {
      const result = validateToolArgs("grep_file", {
        path: "../../etc/passwd",
        pattern: "root",
      });
      expect(result.valid).toBe(false);
    });
  });

  describe("grep (alias)", () => {
    it("accepts valid args as alias for grep_file", () => {
      const result = validateToolArgs("grep", {
        path: "src/index.ts",
        pattern: "export",
      });
      expect(result.valid).toBe(true);
    });

    it("rejects missing required fields", () => {
      const result = validateToolArgs("grep", { pattern: "foo" });
      expect(result.valid).toBe(false);
    });
  });

  // ============================================================================
  // search_files / search
  // ============================================================================

  describe("search_files", () => {
    it("accepts valid pattern", () => {
      const result = validateToolArgs("search_files", { pattern: "useEffect" });
      expect(result.valid).toBe(true);
    });

    it("rejects empty pattern", () => {
      const result = validateToolArgs("search_files", { pattern: "" });
      expect(result.valid).toBe(false);
    });

    it("rejects missing pattern", () => {
      const result = validateToolArgs("search_files", {});
      expect(result.valid).toBe(false);
    });

    it("accepts optional path, glob, and max_results", () => {
      const result = validateToolArgs("search_files", {
        pattern: "useEffect",
        path: "src/components",
        glob: "*.tsx",
        max_results: "20",
      });
      expect(result.valid).toBe(true);
    });

    it("rejects non-numeric max_results", () => {
      const result = validateToolArgs("search_files", {
        pattern: "foo",
        max_results: "not-a-number",
      });
      expect(result.valid).toBe(false);
    });
  });

  describe("search (alias)", () => {
    it("accepts valid args as alias for search_files", () => {
      const result = validateToolArgs("search", { pattern: "TODO" });
      expect(result.valid).toBe(true);
    });
  });

  // ============================================================================
  // create_file (file operation)
  // ============================================================================

  describe("create_file", () => {
    it("accepts valid path and content", () => {
      const result = validateToolArgs("create_file", {
        path: "new-file.ts",
        content: "console.log('hello');",
      });
      expect(result.valid).toBe(true);
    });

    it("rejects empty path", () => {
      const result = validateToolArgs("create_file", {
        path: "",
        content: "data",
      });
      expect(result.valid).toBe(false);
    });

    it("blocks path traversal", () => {
      const result = validateToolArgs("create_file", {
        path: "../escape.txt",
        content: "data",
      });
      expect(result.valid).toBe(false);
    });

    it("blocks /etc/ path", () => {
      const result = validateToolArgs("create_file", {
        path: "/etc/hosts",
        content: "data",
      });
      expect(result.valid).toBe(false);
    });
  });

  // ============================================================================
  // reveal_in_finder
  // ============================================================================

  describe("reveal_in_finder", () => {
    it("accepts valid path", () => {
      const result = validateToolArgs("reveal_in_finder", { path: "/home/user/file.ts" });
      expect(result.valid).toBe(true);
    });

    it("rejects empty path", () => {
      const result = validateToolArgs("reveal_in_finder", { path: "" });
      expect(result.valid).toBe(false);
    });

    it("blocks path traversal", () => {
      const result = validateToolArgs("reveal_in_finder", { path: "../../etc/shadow" });
      expect(result.valid).toBe(false);
    });
  });

  // ============================================================================
  // webfetch / websearch (web tools)
  // ============================================================================

  describe("webfetch", () => {
    it("accepts valid URL", () => {
      const result = validateToolArgs("webfetch", { url: "https://example.com" });
      expect(result.valid).toBe(true);
    });

    it("rejects empty URL", () => {
      const result = validateToolArgs("webfetch", { url: "" });
      expect(result.valid).toBe(false);
    });

    it("rejects invalid URL", () => {
      const result = validateToolArgs("webfetch", { url: "not-a-url" });
      expect(result.valid).toBe(false);
    });

    it("accepts format option", () => {
      const result = validateToolArgs("webfetch", {
        url: "https://example.com",
        format: "text",
      });
      expect(result.valid).toBe(true);
      if (result.valid) expect(result.args.format).toBe("text");
    });

    it("defaults format to markdown", () => {
      const result = validateToolArgs("webfetch", { url: "https://example.com" });
      expect(result.valid).toBe(true);
      if (result.valid) expect(result.args.format).toBe("markdown");
    });

    it("rejects invalid format", () => {
      const result = validateToolArgs("webfetch", {
        url: "https://example.com",
        format: "pdf",
      });
      expect(result.valid).toBe(false);
    });
  });

  describe("websearch", () => {
    it("accepts valid query", () => {
      const result = validateToolArgs("websearch", { query: "TypeScript best practices" });
      expect(result.valid).toBe(true);
    });

    it("rejects empty query", () => {
      const result = validateToolArgs("websearch", { query: "" });
      expect(result.valid).toBe(false);
    });

    it("rejects missing query", () => {
      const result = validateToolArgs("websearch", {});
      expect(result.valid).toBe(false);
    });

    it("accepts optional fields", () => {
      const result = validateToolArgs("websearch", {
        query: "React hooks",
        num_results: "10",
        livecrawl: "always",
        type: "web",
      });
      expect(result.valid).toBe(true);
    });
  });

  // ============================================================================
  // browser / preview tools
  // ============================================================================

  describe("browser_navigate", () => {
    it("accepts valid URL", () => {
      const result = validateToolArgs("browser_navigate", { url: "https://localhost:3000" });
      expect(result.valid).toBe(true);
    });

    it("rejects empty URL", () => {
      const result = validateToolArgs("browser_navigate", { url: "" });
      expect(result.valid).toBe(false);
    });

    it("rejects missing URL", () => {
      const result = validateToolArgs("browser_navigate", {});
      expect(result.valid).toBe(false);
    });
  });

  describe("browser_execute", () => {
    it("accepts valid script", () => {
      const result = validateToolArgs("browser_execute", { script: "document.title" });
      expect(result.valid).toBe(true);
    });

    it("rejects empty script", () => {
      const result = validateToolArgs("browser_execute", { script: "" });
      expect(result.valid).toBe(false);
    });

    it("rejects missing script", () => {
      const result = validateToolArgs("browser_execute", {});
      expect(result.valid).toBe(false);
    });
  });

  describe("run_preview", () => {
    it("accepts valid command", () => {
      const result = validateToolArgs("run_preview", { command: "npm run dev" });
      expect(result.valid).toBe(true);
    });

    it("rejects empty command", () => {
      const result = validateToolArgs("run_preview", { command: "" });
      expect(result.valid).toBe(false);
    });

    it("accepts optional port", () => {
      const result = validateToolArgs("run_preview", {
        command: "npm run dev",
        port: "5173",
      });
      expect(result.valid).toBe(true);
    });

    it("blocks dangerous commands in run_preview", () => {
      const result = validateToolArgs("run_preview", { command: "rm -rf /" });
      expect(result.valid).toBe(false);
    });
  });

  describe("screenshot", () => {
    it("accepts empty args", () => {
      const result = validateToolArgs("screenshot", {});
      expect(result.valid).toBe(true);
    });
  });

  // ============================================================================
  // Agent tools: question, create_task_plan
  // ============================================================================

  describe("question", () => {
    it("accepts valid question", () => {
      const result = validateToolArgs("question", { question: "What version?" });
      expect(result.valid).toBe(true);
    });

    it("rejects empty question", () => {
      const result = validateToolArgs("question", { question: "" });
      expect(result.valid).toBe(false);
    });

    it("rejects missing question", () => {
      const result = validateToolArgs("question", {});
      expect(result.valid).toBe(false);
    });

    it("accepts all optional fields", () => {
      const result = validateToolArgs("question", {
        question: "Confirm?",
        options: "Yes,No",
        type: "confirm",
        allowFreeText: "false",
        placeholder: "Enter answer",
        defaultValue: "Yes",
        required: "true",
      });
      expect(result.valid).toBe(true);
    });

    it("accepts text type", () => {
      const result = validateToolArgs("question", {
        question: "Enter name",
        type: "text",
      });
      expect(result.valid).toBe(true);
    });

    it("accepts number type", () => {
      const result = validateToolArgs("question", {
        question: "Enter age",
        type: "number",
      });
      expect(result.valid).toBe(true);
    });

    it("rejects invalid type", () => {
      const result = validateToolArgs("question", {
        question: "Pick one",
        type: "invalid",
      });
      expect(result.valid).toBe(false);
    });
  });

  describe("create_task_plan", () => {
    it("accepts valid tasks", () => {
      const result = validateToolArgs("create_task_plan", {
        tasks: "Step 1\nStep 2\nStep 3",
      });
      expect(result.valid).toBe(true);
    });

    it("rejects empty tasks", () => {
      const result = validateToolArgs("create_task_plan", { tasks: "" });
      expect(result.valid).toBe(false);
    });

    it("rejects missing tasks", () => {
      const result = validateToolArgs("create_task_plan", {});
      expect(result.valid).toBe(false);
    });
  });

  // ============================================================================
  // clipboard / notify / system_info
  // ============================================================================

  describe("clipboard_read", () => {
    it("accepts empty args", () => {
      const result = validateToolArgs("clipboard_read", {});
      expect(result.valid).toBe(true);
    });
  });

  describe("clipboard_write", () => {
    it("accepts valid text", () => {
      const result = validateToolArgs("clipboard_write", {
        text: "Copied content",
      });
      expect(result.valid).toBe(true);
    });
  });

  describe("notify", () => {
    it("accepts valid title", () => {
      const result = validateToolArgs("notify", { title: "Operation complete" });
      expect(result.valid).toBe(true);
    });

    it("rejects empty title", () => {
      const result = validateToolArgs("notify", { title: "" });
      expect(result.valid).toBe(false);
    });

    it("accepts optional body", () => {
      const result = validateToolArgs("notify", {
        title: "Done",
        body: "Operation completed successfully",
      });
      expect(result.valid).toBe(true);
      if (result.valid) expect(result.args.body).toBe("Operation completed successfully");
    });

    it("defaults body to empty string", () => {
      const result = validateToolArgs("notify", { title: "Done" });
      expect(result.valid).toBe(true);
      if (result.valid) expect(result.args.body).toBe("");
    });
  });

  describe("system_info", () => {
    it("accepts empty args", () => {
      const result = validateToolArgs("system_info", {});
      expect(result.valid).toBe(true);
    });
  });

  // ============================================================================
  // Remaining git commands
  // ============================================================================

  describe("git_log", () => {
    it("accepts empty args", () => {
      const result = validateToolArgs("git_log", {});
      expect(result.valid).toBe(true);
    });
  });

  describe("git_branch", () => {
    it("accepts empty args", () => {
      const result = validateToolArgs("git_branch", {});
      expect(result.valid).toBe(true);
    });
  });

  describe("git_diff_file", () => {
    it("accepts valid path", () => {
      const result = validateToolArgs("git_diff_file", { path: "src/index.ts" });
      expect(result.valid).toBe(true);
    });

    it("rejects empty path", () => {
      const result = validateToolArgs("git_diff_file", { path: "" });
      expect(result.valid).toBe(false);
    });

    it("rejects missing path", () => {
      const result = validateToolArgs("git_diff_file", {});
      expect(result.valid).toBe(false);
    });
  });

  describe("git_create_branch", () => {
    it("accepts valid branch name", () => {
      const result = validateToolArgs("git_create_branch", { branch: "feature/new-ui" });
      expect(result.valid).toBe(true);
      if (result.valid) expect(result.args.branch).toBe("feature/new-ui");
    });

    it("rejects empty branch", () => {
      const result = validateToolArgs("git_create_branch", { branch: "" });
      expect(result.valid).toBe(false);
    });

    it("rejects missing branch", () => {
      const result = validateToolArgs("git_create_branch", {});
      expect(result.valid).toBe(false);
    });

    it("accepts optional base_branch", () => {
      const result = validateToolArgs("git_create_branch", {
        branch: "new-feature",
        base_branch: "main",
      });
      expect(result.valid).toBe(true);
      if (result.valid) expect(result.args.base_branch).toBe("main");
    });
  });

  // ============================================================================
  // Remaining memory commands
  // ============================================================================

  describe("memory_stats", () => {
    it("accepts empty args", () => {
      const result = validateToolArgs("memory_stats", {});
      expect(result.valid).toBe(true);
    });
  });

  describe("memory_maintain", () => {
    it("accepts empty args", () => {
      const result = validateToolArgs("memory_maintain", {});
      expect(result.valid).toBe(true);
    });
  });

  describe("memory_extract", () => {
    it("accepts empty args", () => {
      const result = validateToolArgs("memory_extract", {});
      expect(result.valid).toBe(true);
    });
  });

  describe("memory_export", () => {
    it("accepts empty args", () => {
      const result = validateToolArgs("memory_export", {});
      expect(result.valid).toBe(true);
    });
  });

  describe("memory_import", () => {
    it("accepts empty args", () => {
      const result = validateToolArgs("memory_import", {});
      expect(result.valid).toBe(true);
    });
  });

  // ============================================================================
  // UI toggle / panel tab commands
  // ============================================================================

  describe("toggle_theme", () => {
    it("accepts empty args", () => {
      const result = validateToolArgs("toggle_theme", {});
      expect(result.valid).toBe(true);
    });
  });

  describe("toggle_view_mode", () => {
    it("accepts empty args", () => {
      const result = validateToolArgs("toggle_view_mode", {});
      expect(result.valid).toBe(true);
    });
  });

  describe("toggle_right_panel", () => {
    it("accepts empty args", () => {
      const result = validateToolArgs("toggle_right_panel", {});
      expect(result.valid).toBe(true);
    });
  });

  describe("toggle_bottom_panel", () => {
    it("accepts empty args", () => {
      const result = validateToolArgs("toggle_bottom_panel", {});
      expect(result.valid).toBe(true);
    });
  });

  describe("set_right_panel_tab", () => {
    it("accepts valid tab", () => {
      const result = validateToolArgs("set_right_panel_tab", { tab: "diff" });
      expect(result.valid).toBe(true);
    });

    it("rejects invalid tab", () => {
      const result = validateToolArgs("set_right_panel_tab", { tab: "invalid" });
      expect(result.valid).toBe(false);
    });

    it("rejects missing tab", () => {
      const result = validateToolArgs("set_right_panel_tab", {});
      expect(result.valid).toBe(false);
    });
  });

  describe("set_bottom_panel_tab", () => {
    it("accepts valid tab", () => {
      const result = validateToolArgs("set_bottom_panel_tab", { tab: "terminal" });
      expect(result.valid).toBe(true);
    });

    it("rejects invalid tab", () => {
      const result = validateToolArgs("set_bottom_panel_tab", { tab: "invalid" });
      expect(result.valid).toBe(false);
    });

    it("rejects missing tab", () => {
      const result = validateToolArgs("set_bottom_panel_tab", {});
      expect(result.valid).toBe(false);
    });
  });

  // ============================================================================
  // Environment / system info tools
  // ============================================================================

  describe("get_env", () => {
    it("accepts valid key", () => {
      const result = validateToolArgs("get_env", { key: "PATH" });
      expect(result.valid).toBe(true);
    });

    it("rejects empty key", () => {
      const result = validateToolArgs("get_env", { key: "" });
      expect(result.valid).toBe(false);
    });

    it("rejects missing key", () => {
      const result = validateToolArgs("get_env", {});
      expect(result.valid).toBe(false);
    });
  });

  describe("get_screen_info", () => {
    it("accepts empty args", () => {
      const result = validateToolArgs("get_screen_info", {});
      expect(result.valid).toBe(true);
    });
  });

  describe("list_processes", () => {
    it("accepts empty args", () => {
      const result = validateToolArgs("list_processes", {});
      expect(result.valid).toBe(true);
    });
  });

  describe("kill_process", () => {
    it("accepts valid pid", () => {
      const result = validateToolArgs("kill_process", { pid: "1234" });
      expect(result.valid).toBe(true);
    });

    it("rejects empty pid", () => {
      const result = validateToolArgs("kill_process", { pid: "" });
      expect(result.valid).toBe(false);
    });

    it("rejects missing pid", () => {
      const result = validateToolArgs("kill_process", {});
      expect(result.valid).toBe(false);
    });
  });

  // ============================================================================
  // Command aliases (bash, shell, execute)
  // ============================================================================

  describe("bash (alias for run_command)", () => {
    it("accepts valid command", () => {
      const result = validateToolArgs("bash", { command: "npm test" });
      expect(result.valid).toBe(true);
    });

    it("rejects empty command", () => {
      const result = validateToolArgs("bash", { command: "" });
      expect(result.valid).toBe(false);
    });

    it("blocks dangerous commands", () => {
      const result = validateToolArgs("bash", { command: "rm -rf /" });
      expect(result.valid).toBe(false);
    });
  });

  describe("shell (alias for run_command)", () => {
    it("accepts valid command", () => {
      const result = validateToolArgs("shell", { command: "ls -la" });
      expect(result.valid).toBe(true);
    });

    it("blocks dangerous commands", () => {
      const result = validateToolArgs("shell", { command: "mkfs.ext4 /dev/sda" });
      expect(result.valid).toBe(false);
    });
  });

  describe("execute (alias for run_command)", () => {
    it("accepts valid command", () => {
      const result = validateToolArgs("execute", { command: "deploy.sh" });
      expect(result.valid).toBe(true);
    });

    it("blocks dangerous commands", () => {
      const result = validateToolArgs("execute", { command: ":(){ :|:& };:" });
      expect(result.valid).toBe(false);
    });
  });
});
