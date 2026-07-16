import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  canRunInParallel,
  groupToolCallsForExecution,
  recordToolCost,
  clearSessionToolCosts,
  getSessionToolCosts,
  type ToolCall,
} from "./toolExecutor";

describe("toolExecutor", () => {
  describe("canRunInParallel", () => {
    it("allows two read-only tools to run in parallel", () => {
      const t1: ToolCall = { name: "read_file", args: { path: "/a" }, raw: "" };
      const t2: ToolCall = { name: "list_dir", args: { path: "/b" }, raw: "" };
      expect(canRunInParallel(t1, t2)).toBe(true);
    });

    it("prevents write tools from running in parallel", () => {
      const t1: ToolCall = {
        name: "write_file",
        args: { path: "/a" },
        raw: "",
      };
      const t2: ToolCall = { name: "edit_file", args: { path: "/b" }, raw: "" };
      expect(canRunInParallel(t1, t2)).toBe(false);
    });

    it("prevents read+write from running in parallel", () => {
      const t1: ToolCall = { name: "read_file", args: { path: "/a" }, raw: "" };
      const t2: ToolCall = {
        name: "write_file",
        args: { path: "/b" },
        raw: "",
      };
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

    it("separates read and write tools with flush", () => {
      const tools: ToolCall[] = [
        { name: "read_file", args: { path: "/a" }, raw: "" },
        { name: "write_file", args: { path: "/b", content: "test" }, raw: "" },
        { name: "read_file", args: { path: "/c" }, raw: "" },
      ];
      const batches = groupToolCallsForExecution(tools);
      // With next-fit: read_file accumulates until a write tool flushes it.
      // Sequence: read_file /a -> write_file (flushes reads) -> read_file /c (new batch)
      expect(batches.length).toBe(3);
      expect(batches[0].length).toBe(1); // read_file /a
      expect(batches[0][0].args.path).toBe("/a");
      expect(batches[1].length).toBe(1); // write_file /b
      expect(batches[1][0].args.path).toBe("/b");
      expect(batches[2].length).toBe(1); // read_file /c
      expect(batches[2][0].args.path).toBe("/c");
    });
  });

  describe("cost tracking", () => {
    beforeEach(() => {
      clearSessionToolCosts("test-session");
    });

    it("records tool cost", () => {
      recordToolCost({
        toolCallId: "call-1",
        sessionId: "test-session",
        name: "read_file",
        durationMs: 100,
        retries: 0,
        success: true,
        timestamp: Date.now(),
      });

      const stats = getSessionToolCosts("test-session");
      expect(stats.totalCalls).toBe(1);
      expect(stats.totalDurationMs).toBe(100);
      expect(stats.byTool.read_file.calls).toBe(1);
    });

    it("aggregates multiple costs", () => {
      recordToolCost({
        toolCallId: "c1",
        sessionId: "test-session",
        name: "read_file",
        durationMs: 100,
        retries: 0,
        success: true,
        timestamp: Date.now(),
      });
      recordToolCost({
        toolCallId: "c2",
        sessionId: "test-session",
        name: "read_file",
        durationMs: 200,
        retries: 1,
        success: true,
        timestamp: Date.now(),
      });
      recordToolCost({
        toolCallId: "c3",
        sessionId: "test-session",
        name: "write_file",
        durationMs: 50,
        retries: 0,
        success: true,
        timestamp: Date.now(),
      });

      const stats = getSessionToolCosts("test-session");
      expect(stats.totalCalls).toBe(3);
      expect(stats.totalDurationMs).toBe(350);
      expect(stats.totalRetries).toBe(1);
      expect(stats.byTool.read_file.calls).toBe(2);
      expect(stats.byTool.write_file.calls).toBe(1);
    });

    it("clears session costs", () => {
      recordToolCost({
        toolCallId: "c1",
        sessionId: "test-session",
        name: "read_file",
        durationMs: 100,
        retries: 0,
        success: true,
        timestamp: Date.now(),
      });
      clearSessionToolCosts("test-session");

      const stats = getSessionToolCosts("test-session");
      expect(stats.totalCalls).toBe(0);
    });

    it("returns empty stats for unknown session", () => {
      const stats = getSessionToolCosts("nonexistent-session");
      expect(stats.totalCalls).toBe(0);
      expect(stats.totalDurationMs).toBe(0);
      expect(stats.byTool).toEqual({});
    });

    it("caps at 500 entries per session", () => {
      for (let i = 0; i < 510; i++) {
        recordToolCost({
          toolCallId: `c${i}`,
          sessionId: "cap-test",
          name: "read_file",
          durationMs: 1,
          retries: 0,
          success: true,
          timestamp: Date.now(),
        });
      }

      const stats = getSessionToolCosts("cap-test");
      expect(stats.totalCalls).toBe(500);
    });
  });
});
