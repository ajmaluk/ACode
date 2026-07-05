import { describe, it, expect } from "vitest";
import {
  canRunInParallel,
  groupToolCallsForExecution,
  formatToolResults,
  getToolStats,
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
});
