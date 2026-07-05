import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  canRunInParallel,
  groupToolCallsForExecution,
  formatToolResults,
  getToolStats,
  executeToolWithRetry,
  executeToolBatch,
  executeToolCalls,
  type ToolCall,
  type ToolResult,
} from "./toolExecutor";

describe("toolExecutor", () => {
  describe("canRunInParallel", () => {
    it("allows two read-only tools to run in parallel", () => {
      const t1: ToolCall = { name: "read_file", args: { path: "/a" }, raw: "" };
      const t2: ToolCall = { name: "list_dir", args: { path: "/b" }, raw: "" };
      expect(canRunInParallel(t1, t2)).toBe(true);
    });

    it("prevents write tools from running in parallel", () => {
      const t1: ToolCall = { name: "write_file", args: { path: "/a" }, raw: "" };
      const t2: ToolCall = { name: "edit_file", args: { path: "/b" }, raw: "" };
      expect(canRunInParallel(t1, t2)).toBe(false);
    });

    it("prevents read+write from running in parallel", () => {
      const t1: ToolCall = { name: "read_file", args: { path: "/a" }, raw: "" };
      const t2: ToolCall = { name: "write_file", args: { path: "/b" }, raw: "" };
      expect(canRunInParallel(t1, t2)).toBe(false);
    });

    it("returns false for unknown tools", () => {
      const t1: ToolCall = { name: "unknown_tool", args: {}, raw: "" };
      const t2: ToolCall = { name: "read_file", args: { path: "/a" }, raw: "" };
      expect(canRunInParallel(t1, t2)).toBe(false);
    });
  });

  describe("groupToolCallsForExecution", () => {
    it("returns empty array for empty input", () => {
      expect(groupToolCallsForExecution([])).toEqual([]);
    });

    it("returns single batch for single tool", () => {
      const tc: ToolCall = { name: "read_file", args: { path: "/a" }, raw: "" };
      expect(groupToolCallsForExecution([tc])).toEqual([[tc]]);
    });

    it("groups read-only tools together", () => {
      const tools: ToolCall[] = [
        { name: "read_file", args: { path: "/a" }, raw: "" },
        { name: "list_dir", args: { path: "/b" }, raw: "" },
        { name: "grep_file", args: { path: "/c", pattern: "test" }, raw: "" },
      ];
      const batches = groupToolCallsForExecution(tools);
      expect(batches.length).toBe(1);
      expect(batches[0].length).toBe(3);
    });

    it("separates read and write tools", () => {
      const tools: ToolCall[] = [
        { name: "read_file", args: { path: "/a" }, raw: "" },
        { name: "write_file", args: { path: "/b", content: "test" }, raw: "" },
        { name: "read_file", args: { path: "/c" }, raw: "" },
      ];
      const batches = groupToolCallsForExecution(tools);
      expect(batches.length).toBe(3);
    });
  });

  describe("formatToolResults", () => {
    it("formats successful results", () => {
      const results: ToolResult[] = [
        { toolName: "read_file", result: "file content", success: true, durationMs: 100 },
      ];
      const formatted = formatToolResults(results);
      expect(formatted).toContain("read_file");
      expect(formatted).toContain("file content");
    });

    it("formats failed results", () => {
      const results: ToolResult[] = [
        { toolName: "write_file", result: "Error: permission denied", success: false, durationMs: 50 },
      ];
      const formatted = formatToolResults(results);
      expect(formatted).toContain("Error");
      expect(formatted).toContain("permission denied");
    });

    it("includes retry count", () => {
      const results: ToolResult[] = [
        { toolName: "run_command", result: "output", success: true, durationMs: 200, retries: 2 },
      ];
      const formatted = formatToolResults(results);
      expect(formatted).toContain("retried 2 times");
    });
  });

  describe("getToolStats", () => {
    it("calculates stats correctly", () => {
      const results: ToolResult[] = [
        { toolName: "a", result: "", success: true, durationMs: 100 },
        { toolName: "b", result: "", success: true, durationMs: 200, retries: 1 },
        { toolName: "c", result: "", success: false, durationMs: 50 },
      ];
      const stats = getToolStats(results);
      expect(stats.total).toBe(3);
      expect(stats.succeeded).toBe(2);
      expect(stats.failed).toBe(1);
      expect(stats.retried).toBe(1);
      expect(stats.totalDurationMs).toBe(350);
      expect(stats.avgDurationMs).toBe(Math.round(350 / 3));
    });

    it("handles empty results", () => {
      const stats = getToolStats([]);
      expect(stats.total).toBe(0);
      expect(stats.succeeded).toBe(0);
      expect(stats.failed).toBe(0);
      expect(stats.retried).toBe(0);
      expect(stats.avgDurationMs).toBe(0);
    });
  });

  describe("validateToolArgs integration", () => {
    const mockExecuteFn = vi.fn<(name: string, args: Record<string, unknown>) => Promise<string>>();

    beforeEach(() => {
      mockExecuteFn.mockReset();
      mockExecuteFn.mockResolvedValue("success");
    });

    describe("executeToolWithRetry", () => {
      it("passes valid read_file args through to executeFn", async () => {
        const tc: ToolCall = {
          name: "read_file",
          args: { path: "/workspace/file.ts" },
          raw: "",
        };
        const result = await executeToolWithRetry(tc, mockExecuteFn);
        expect(result.success).toBe(true);
        expect(mockExecuteFn).toHaveBeenCalledWith("read_file", { path: "/workspace/file.ts" });
      });

      it("passes validated (default-applied) write_file args to executeFn", async () => {
        const tc: ToolCall = {
          name: "write_file",
          args: { path: "/workspace/file.ts", content: "hello" },
          raw: "",
        };
        const result = await executeToolWithRetry(tc, mockExecuteFn);
        expect(result.success).toBe(true);
        // create_dirs should default to false via Zod transform
        expect(mockExecuteFn).toHaveBeenCalledWith("write_file", {
          path: "/workspace/file.ts",
          content: "hello",
          create_dirs: false,
        });
      });

      it("rejects missing required 'path' argument for read_file", async () => {
        const tc: ToolCall = {
          name: "read_file",
          args: {},
          raw: "",
        };
        const result = await executeToolWithRetry(tc, mockExecuteFn);
        expect(result.success).toBe(false);
        expect(result.result).toContain("requires a 'path' argument");
        // executeFn should NOT have been called
        expect(mockExecuteFn).not.toHaveBeenCalled();
      });

      it("rejects missing 'command' for run_command", async () => {
        const tc: ToolCall = {
          name: "run_command",
          args: {},
          raw: "",
        };
        const result = await executeToolWithRetry(tc, mockExecuteFn);
        expect(result.success).toBe(false);
        expect(result.result).toContain("requires a 'command' argument");
        expect(mockExecuteFn).not.toHaveBeenCalled();
      });

      it("rejects empty string required fields", async () => {
        const tc: ToolCall = {
          name: "read_file",
          args: { path: "" },
          raw: "",
        };
        const result = await executeToolWithRetry(tc, mockExecuteFn);
        expect(result.success).toBe(false);
        expect(result.result).toContain("requires a 'path' argument");
        expect(mockExecuteFn).not.toHaveBeenCalled();
      });

      it("rejects unknown tools", async () => {
        const tc: ToolCall = {
          name: "nonexistent_tool",
          args: {},
          raw: "",
        };
        const result = await executeToolWithRetry(tc, mockExecuteFn);
        expect(result.success).toBe(false);
        expect(result.result).toContain("Unknown tool");
        expect(mockExecuteFn).not.toHaveBeenCalled();
      });

      it("rejects dangerous path traversal (../)", async () => {
        const tc: ToolCall = {
          name: "read_file",
          args: { path: "/workspace/../../etc/passwd" },
          raw: "",
        };
        const result = await executeToolWithRetry(tc, mockExecuteFn);
        expect(result.success).toBe(false);
        expect(result.result).toContain("Path not allowed");
        expect(mockExecuteFn).not.toHaveBeenCalled();
      });

      it("rejects dangerous path to /etc/", async () => {
        const tc: ToolCall = {
          name: "read_file",
          args: { path: "/etc/passwd" },
          raw: "",
        };
        const result = await executeToolWithRetry(tc, mockExecuteFn);
        expect(result.success).toBe(false);
        expect(result.result).toContain("Path not allowed");
        expect(mockExecuteFn).not.toHaveBeenCalled();
      });

      it("rejects dangerous write_file to /etc/", async () => {
        const tc: ToolCall = {
          name: "write_file",
          args: { path: "/etc/hosts", content: "evil" },
          raw: "",
        };
        const result = await executeToolWithRetry(tc, mockExecuteFn);
        expect(result.success).toBe(false);
        expect(result.result).toContain("Path not allowed");
        expect(mockExecuteFn).not.toHaveBeenCalled();
      });

      it("rejects dangerous command 'rm -rf /'", async () => {
        const tc: ToolCall = {
          name: "run_command",
          args: { command: "rm -rf /" },
          raw: "",
        };
        const result = await executeToolWithRetry(tc, mockExecuteFn);
        expect(result.success).toBe(false);
        expect(result.result).toContain("Dangerous command blocked");
        expect(mockExecuteFn).not.toHaveBeenCalled();
      });

      it("rejects dangerous command with extra whitespace (normalization bypass)", async () => {
        const tc: ToolCall = {
          name: "run_command",
          args: { command: "  rm  -rf  /  " },
          raw: "",
        };
        const result = await executeToolWithRetry(tc, mockExecuteFn);
        expect(result.success).toBe(false);
        expect(result.result).toContain("Dangerous command blocked");
        expect(mockExecuteFn).not.toHaveBeenCalled();
      });

      it("rejects dangerous command embedded as substring", async () => {
        const tc: ToolCall = {
          name: "run_command",
          args: { command: "echo test && rm -rf /" },
          raw: "",
        };
        const result = await executeToolWithRetry(tc, mockExecuteFn);
        expect(result.success).toBe(false);
        expect(result.result).toContain("Dangerous command blocked");
        expect(mockExecuteFn).not.toHaveBeenCalled();
      });

      it("rejects invalid arg types (non-numeric offset)", async () => {
        const tc: ToolCall = {
          name: "read_file",
          args: { path: "/workspace/file.ts", offset: "not-a-number" },
          raw: "",
        };
        const result = await executeToolWithRetry(tc, mockExecuteFn);
        expect(result.success).toBe(false);
        expect(result.result).toContain("offset:");
        expect(mockExecuteFn).not.toHaveBeenCalled();
      });

      it("rejects edit_file with missing 'search' arg", async () => {
        const tc: ToolCall = {
          name: "edit_file",
          args: { path: "/workspace/file.ts" },
          raw: "",
        };
        const result = await executeToolWithRetry(tc, mockExecuteFn);
        expect(result.success).toBe(false);
        expect(result.result).toContain("edit_file:");
        expect(result.result).toContain("search");
        expect(mockExecuteFn).not.toHaveBeenCalled();
      });

      it("accepts MCP tools with valid args", async () => {
        const tc: ToolCall = {
          name: "mcp_github",
          args: { action: "list_issues", repo: "user/repo" },
          raw: "",
        };
        const result = await executeToolWithRetry(tc, mockExecuteFn);
        expect(result.success).toBe(true);
        expect(mockExecuteFn).toHaveBeenCalledWith("mcp_github", {
          action: "list_issues",
          repo: "user/repo",
        });
      });

      it("rejects MCP tools with non-object args", async () => {
        const tc: ToolCall = {
          name: "mcp_github",
          args: "invalid" as unknown as Record<string, unknown>,
          raw: "",
        };
        const result = await executeToolWithRetry(tc, mockExecuteFn);
        expect(result.success).toBe(false);
        expect(result.result).toContain("args must be a plain object");
        expect(mockExecuteFn).not.toHaveBeenCalled();
      });

      it("does not execute on validation failure but is still successful for valid tools after rejection", async () => {
        // First call: invalid
        const invalidTc: ToolCall = {
          name: "read_file",
          args: {},
          raw: "",
        };
        const invalidResult = await executeToolWithRetry(invalidTc, mockExecuteFn);
        expect(invalidResult.success).toBe(false);
        expect(mockExecuteFn).not.toHaveBeenCalled();

        // Second call: valid
        const validTc: ToolCall = {
          name: "read_file",
          args: { path: "/workspace/file.ts" },
          raw: "",
        };
        const validResult = await executeToolWithRetry(validTc, mockExecuteFn);
        expect(validResult.success).toBe(true);
        expect(mockExecuteFn).toHaveBeenCalledTimes(1);
      });
    });

    describe("executeToolBatch", () => {
      it("validates each tool in batch independently", async () => {
        const tc1: ToolCall = {
          name: "read_file",
          args: { path: "/workspace/a.ts" },
          raw: "",
        };
        const tc2: ToolCall = {
          name: "read_file",
          args: {}, // missing path
          raw: "",
        };
        const results = await executeToolBatch([tc1, tc2], mockExecuteFn);
        expect(results[0].success).toBe(true);
        expect(results[1].success).toBe(false);
        expect(results[1].result).toContain("requires a 'path' argument");
        // Only the valid tool should have been executed
        expect(mockExecuteFn).toHaveBeenCalledTimes(1);
        expect(mockExecuteFn).toHaveBeenCalledWith("read_file", { path: "/workspace/a.ts" });
      });
    });

    describe("executeToolCalls", () => {
      it("validates all tools across batches and skips execution on validation failure", async () => {
        const tools: ToolCall[] = [
          { name: "read_file", args: { path: "/workspace/a.ts" }, raw: "" },
          { name: "run_command", args: { command: "rm -rf /" }, raw: "" },
          { name: "list_dir", args: { path: "/workspace" }, raw: "" },
        ];
        const results = await executeToolCalls(tools, mockExecuteFn);
        // read_file and list_dir are read-only, so they batch together
        // run_command is a write tool, so it gets its own batch
        expect(results.length).toBe(3);
        expect(results[0].success).toBe(true); // read_file
        expect(results[1].success).toBe(false); // run_command (dangerous)
        expect(results[1].result).toContain("Dangerous command blocked");
        expect(results[2].success).toBe(true); // list_dir
        // Only valid tools should have executed
        expect(mockExecuteFn).toHaveBeenCalledTimes(2);
      });

      it("handles abort signal without executing tools", async () => {
        const abortController = new AbortController();
        abortController.abort();
        const tools: ToolCall[] = [
          { name: "read_file", args: { path: "/workspace/a.ts" }, raw: "" },
        ];
        const results = await executeToolCalls(tools, mockExecuteFn, undefined, abortController.signal);
        expect(results[0].success).toBe(false);
        expect(results[0].result).toContain("Aborted");
        expect(mockExecuteFn).not.toHaveBeenCalled();
      });
    });
  });
});
