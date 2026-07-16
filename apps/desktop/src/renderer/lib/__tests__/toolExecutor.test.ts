/**
 * Tests for toolExecutor.ts — tool dependency analysis and batch execution grouping.
 *
 * These functions are used by sendPrompt's batch execution loop to group tool calls
 * into parallel batches. Testing them validates the dependency/batching logic that
 * the batch execution loop relies on.
 *
 * NOTE: The actual sendPrompt batch execution fixes (executedToolIds,
 * consecutiveToolErrors, totalToolCalls) are deeply embedded inside sendPrompt's
 * while-loop and cannot be tested as pure units. Integration tests for those
 * behaviors require mocking the stream/tool/store layers.
 *
 * All functions in this file are pure — no Tauri/HTTP/Store dependencies needed.
 */
import { describe, it, expect } from "vitest";
import {
  canRunInParallel,
  groupToolCallsForExecution,
  type ToolCall,
} from "../toolExecutor";

// ─── Fixtures ────────────────────────────────────────────────

function tc(name: string, args: Record<string, unknown> = {}): ToolCall {
  return { name, args, raw: "" };
}

// ============================================================================
// canRunInParallel
// ============================================================================

describe("canRunInParallel", () => {
  it("returns true for two read-only tools", () => {
    expect(canRunInParallel(tc("read_file"), tc("list_dir"))).toBe(true);
    expect(canRunInParallel(tc("grep_file"), tc("search_files"))).toBe(true);
    expect(canRunInParallel(tc("git_status"), tc("memory_search"))).toBe(true);
    expect(canRunInParallel(tc("webfetch"), tc("websearch"))).toBe(true);
  });

  it("returns true for two identical read-only tools", () => {
    expect(canRunInParallel(tc("read_file"), tc("read_file"))).toBe(true);
    expect(canRunInParallel(tc("list_dir"), tc("list_dir"))).toBe(true);
  });

  it("returns false for two write tools", () => {
    expect(canRunInParallel(tc("write_file"), tc("edit_file"))).toBe(false);
    expect(canRunInParallel(tc("run_command"), tc("bash"))).toBe(false);
    expect(canRunInParallel(tc("write_file"), tc("write_file"))).toBe(false);
  });

  it("returns false for read-only + write tool", () => {
    expect(canRunInParallel(tc("read_file"), tc("write_file"))).toBe(false);
    expect(canRunInParallel(tc("write_file"), tc("read_file"))).toBe(false);
    expect(canRunInParallel(tc("list_dir"), tc("run_command"))).toBe(false);
    expect(canRunInParallel(tc("search_files"), tc("git_commit"))).toBe(false);
  });

  it("returns false for unknown tools", () => {
    expect(
      canRunInParallel(
        tc("nonexistent_tool"),
        tc("another_unknown_tool"),
      ),
    ).toBe(false);
    expect(canRunInParallel(tc("read_file"), tc("unknown_tool"))).toBe(false);
    expect(canRunInParallel(tc("unknown_tool"), tc("read_file"))).toBe(false);
  });

  it("returns false when either tool has no dependency definition", () => {
    const emptyName = tc("");
    expect(canRunInParallel(emptyName, tc("read_file"))).toBe(false);
    expect(canRunInParallel(tc("read_file"), emptyName)).toBe(false);
  });

  // git_checkout is readOnly: false
  it("does not parallelize write tools even with empty deps list", () => {
    expect(canRunInParallel(tc("git_checkout"), tc("run_command"))).toBe(false);
    expect(canRunInParallel(tc("bash"), tc("git_checkout"))).toBe(false);
  });
});

// ============================================================================
// groupToolCallsForExecution
// ============================================================================

describe("groupToolCallsForExecution", () => {
  // ── Edge Cases ──

  it("returns empty array for empty input", () => {
    expect(groupToolCallsForExecution([])).toEqual([]);
  });

  it("returns single batch for single tool", () => {
    const result = groupToolCallsForExecution([tc("read_file")]);
    expect(result).toHaveLength(1);
    expect(result[0]).toHaveLength(1);
    expect(result[0][0].name).toBe("read_file");
  });

  // ── All Read-Only ──

  it("groups all read-only tools into a single batch", () => {
    const tools = [
      tc("read_file"),
      tc("list_dir"),
      tc("grep_file"),
      tc("search_files"),
      tc("git_status"),
      tc("memory_search"),
    ];
    const result = groupToolCallsForExecution(tools);
    // All should be in one batch since they're all read-only
    expect(result).toHaveLength(1);
    expect(result[0]).toHaveLength(tools.length);
  });

  // ── Interleaved Read + Write ──

  it("separates write tools into their own batches", () => {
    const tools = [
      tc("read_file"),
      tc("write_file"),
      tc("list_dir"),
      tc("edit_file"),
      tc("grep_file"),
    ];
    const result = groupToolCallsForExecution(tools);
    // Expected batches:
    //   Batch 1: [read_file] (reads before first write)
    //   Batch 2: [write_file] (solo)
    //   Batch 3: [list_dir] (reads after first write, before second)
    //   Batch 4: [edit_file] (solo)
    //   Batch 5: [grep_file] (remaining reads)
    expect(result).toHaveLength(5);
    expect(result[0]).toHaveLength(1); // read_file
    expect(result[0][0].name).toBe("read_file");
    expect(result[1]).toHaveLength(1); // write_file
    expect(result[1][0].name).toBe("write_file");
    expect(result[2]).toHaveLength(1); // list_dir
    expect(result[2][0].name).toBe("list_dir");
    expect(result[3]).toHaveLength(1); // edit_file
    expect(result[3][0].name).toBe("edit_file");
    expect(result[4]).toHaveLength(1); // grep_file
    expect(result[4][0].name).toBe("grep_file");
  });

  it("groups consecutive reads into same batch", () => {
    const tools = [
      tc("read_file"),
      tc("list_dir"),
      tc("grep_file"),
      tc("write_file"),
      tc("search_files"),
      tc("git_status"),
    ];
    const result = groupToolCallsForExecution(tools);
    // Batches:
    //   1: [read_file, list_dir, grep_file] (3 reads before first write)
    //   2: [write_file] (solo)
    //   3: [search_files, git_status] (2 reads after write)
    expect(result).toHaveLength(3);
    expect(result[0]).toHaveLength(3); // 3 reads
    expect(result[1]).toHaveLength(1); // write_file
    expect(result[1][0].name).toBe("write_file");
    expect(result[2]).toHaveLength(2); // 2 reads
  });

  // ── Unknown tools ──

  it("treats unknown tools as write (solo batch)", () => {
    const tools = [
      tc("read_file"),
      tc("some_unknown_tool"),
      tc("list_dir"),
    ];
    const result = groupToolCallsForExecution(tools);
    // Batches:
    //   1: [read_file] (read before unknown)
    //   2: [some_unknown_tool] (unknown = write, solo)
    //   3: [list_dir] (read after unknown)
    expect(result).toHaveLength(3);
    expect(result[0]).toHaveLength(1);
    expect(result[0][0].name).toBe("read_file");
    expect(result[1]).toHaveLength(1);
    expect(result[1][0].name).toBe("some_unknown_tool");
    expect(result[2]).toHaveLength(1);
    expect(result[2][0].name).toBe("list_dir");
  });

  // ── All Write Tools ──

  it("puts each write tool in its own batch", () => {
    const tools = [
      tc("write_file"),
      tc("edit_file"),
      tc("run_command"),
      tc("bash"),
    ];
    const result = groupToolCallsForExecution(tools);
    expect(result).toHaveLength(4);
    for (const batch of result) {
      expect(batch).toHaveLength(1);
    }
  });

  // ── git_commit with dependency deps ──

  it("handles git_commit as write tool (solo batch)", () => {
    const result = groupToolCallsForExecution([
      tc("write_file"),
      tc("git_commit"),
    ]);
    expect(result).toHaveLength(2);
    expect(result[0][0].name).toBe("write_file");
    expect(result[1][0].name).toBe("git_commit");
  });

  // ── Preserves Tool Order Within Batches ──

  it("preserves tool order within read batches", () => {
    const tools = [
      tc("read_file", { path: "/a.ts" }),
      tc("list_dir", { path: "/src" }),
      tc("grep_file", { pattern: "foo" }),
    ];
    const result = groupToolCallsForExecution(tools);
    expect(result).toHaveLength(1);
    expect(result[0][0].args.path).toBe("/a.ts");
    expect(result[0][1].args.path).toBe("/src");
    expect(result[0][2].args.pattern).toBe("foo");
  });

  // ── Single element with unknown tool ──

  it("handles single unknown tool correctly", () => {
    const result = groupToolCallsForExecution([tc("unknown_xyz")]);
    expect(result).toHaveLength(1);
    expect(result[0]).toHaveLength(1);
    expect(result[0][0].name).toBe("unknown_xyz");
  });
});
