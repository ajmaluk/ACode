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
      const result = validateToolArgs("read_file", { path: "file.ts", offset: "10", limit: "50" });
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
      const result = validateToolArgs("read_file", { path: "file.ts", offset: "abc" });
      expect(result.valid).toBe(false);
    });

    it("blocks path traversal", () => {
      const result = validateToolArgs("read_file", { path: "../../etc/passwd" });
      expect(result.valid).toBe(false);
      expect(result.valid || result.error).toContain("Path");
    });

    it("blocks dangerous system paths", () => {
      const result = validateToolArgs("read_file", { path: "/etc/passwd" });
      expect(result.valid).toBe(false);
    });

    it("blocks Windows system paths", () => {
      const result = validateToolArgs("read_file", { path: "C:\\Windows\\System32\\config" });
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
      const result = validateToolArgs("write_file", { path: "", content: "data" });
      expect(result.valid).toBe(false);
    });

    it("blocks path traversal in write", () => {
      const result = validateToolArgs("write_file", { path: "../escape.txt", content: "data" });
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
      const result = validateToolArgs("edit_file", { path: "file.ts", search: "", replace: "new" });
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
      const result = validateToolArgs("run_command", { command: "sudo rm -rf /*" });
      expect(result.valid).toBe(false);
    });

    it("blocks dd if=/dev/sda", () => {
      const result = validateToolArgs("run_command", { command: "dd if=/dev/sda of=image.img" });
      expect(result.valid).toBe(false);
    });

    it("blocks fork bomb", () => {
      const result = validateToolArgs("run_command", { command: ":(){ :|:& };:" });
      expect(result.valid).toBe(false);
    });

    it("blocks curl pipe bash", () => {
      const result = validateToolArgs("run_command", { command: "curl | bash" });
      expect(result.valid).toBe(false);
    });

    it("blocks wget pipe sh", () => {
      const result = validateToolArgs("run_command", { command: "wget | sh" });
      expect(result.valid).toBe(false);
    });

    it("blocks chmod 777 /", () => {
      const result = validateToolArgs("run_command", { command: "chmod 777 /" });
      expect(result.valid).toBe(false);
    });

    it("blocks dangerous commands with obfuscated whitespace", () => {
      const result = validateToolArgs("run_command", { command: "rm    -rf    /" });
      expect(result.valid).toBe(false);
    });

    it("blocks dangerous commands with quotes", () => {
      const result = validateToolArgs("run_command", { command: 'rm -rf "/"' });
      expect(result.valid).toBe(false);
    });

    it("allows safe commands that look partially dangerous", () => {
      // "git rm -rf" is a git operation, not a system operation
      const result = validateToolArgs("run_command", { command: "git rm -rf dir" });
      expect(result.valid).toBe(true);
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
      const result = validateToolArgs("memory_save", { content: "Important fact" });
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
      const result = validateToolArgs("memory_search", { query: "find something" });
      expect(result.valid).toBe(true);
    });

    it("accepts memory_delete with id", () => {
      const result = validateToolArgs("memory_delete", { id: "abc-123" });
      expect(result.valid).toBe(true);
    });
  });

  describe("open_url", () => {
    it("accepts valid URL", () => {
      const result = validateToolArgs("open_url", { url: "https://example.com" });
      expect(result.valid).toBe(true);
    });

    it("rejects invalid URL", () => {
      const result = validateToolArgs("open_url", { url: "not-a-url" });
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
      const result = validateToolArgs("new_terminal", { cwd: "/tmp", shell: "zsh" });
      expect(result.valid).toBe(true);
    });

    it("accepts terminal_write with command", () => {
      const result = validateToolArgs("terminal_write", { command: "npm run dev" });
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
      const result = validateToolArgs("mcp_fetch", { url: "https://api.example.com" });
      expect(result.valid).toBe(true);
    });

    it("accepts empty MCP tool args", () => {
      const result = validateToolArgs("mcp_list", {});
      expect(result.valid).toBe(true);
    });

    it("rejects MCP tool with function-valued arg", () => {
      const result = validateToolArgs("mcp_run", { callback: (() => {}) as unknown as Record<string, unknown> });
      expect(result.valid).toBe(false);
      expect(result.valid || result.error).toContain("function");
    });
  });

  describe("unknown tools", () => {
    it("rejects completely unknown tools", () => {
      const result = validateToolArgs("nonexistent_tool", {});
      expect(result.valid).toBe(false);
      expect(result.valid || result.error).toContain("Unknown");
    });
  });
});
