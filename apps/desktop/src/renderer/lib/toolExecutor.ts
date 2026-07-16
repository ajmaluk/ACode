/**
 * Tool Executor — Tool dependency analysis, batching, and cost tracking.
 *
 * This module provides:
 * 1. Tool dependency definitions for parallelization analysis
 * 2. Tool call grouping for optimal parallel execution
 * 3. Session-scoped cost tracking
 *
 * Tool execution itself is handled inline in dalamAPI.ts.
 */

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
  raw: string;
}

export interface ToolDependency {
  tool: string;
  dependsOn: string[];
  readOnly: boolean;
}

// Tool dependency definitions — tools that can run in parallel
const TOOL_DEPENDENCIES: Record<string, ToolDependency> = {
  // Read-only tools — can run in parallel with other read-only tools
  read_file: { tool: "read_file", dependsOn: [], readOnly: true },
  list_dir: { tool: "list_dir", dependsOn: [], readOnly: true },
  grep_file: { tool: "grep_file", dependsOn: [], readOnly: true },
  search_files: { tool: "search_files", dependsOn: [], readOnly: true },
  git_status: { tool: "git_status", dependsOn: [], readOnly: true },
  git_log: { tool: "git_log", dependsOn: [], readOnly: true },
  git_branch: { tool: "git_branch", dependsOn: [], readOnly: true },
  git_diff_file: { tool: "git_diff_file", dependsOn: [], readOnly: true },
  clipboard_read: { tool: "clipboard_read", dependsOn: [], readOnly: true },
  system_info: { tool: "system_info", dependsOn: [], readOnly: true },
  memory_search: { tool: "memory_search", dependsOn: [], readOnly: true },
  memory_stats: { tool: "memory_stats", dependsOn: [], readOnly: true },
  memory_extract: { tool: "memory_extract", dependsOn: [], readOnly: true },
  memory_export: { tool: "memory_export", dependsOn: [], readOnly: true },
  memory_import: { tool: "memory_import", dependsOn: [], readOnly: true },
  question: { tool: "question", dependsOn: [], readOnly: true },
  get_env: { tool: "get_env", dependsOn: [], readOnly: true },
  bash: { tool: "bash", dependsOn: [], readOnly: false },
  shell: { tool: "shell", dependsOn: [], readOnly: false },
  execute: { tool: "execute", dependsOn: [], readOnly: false },
  grep: { tool: "grep", dependsOn: [], readOnly: true },
  search: { tool: "search", dependsOn: [], readOnly: true },
  webfetch: { tool: "webfetch", dependsOn: [], readOnly: true },
  websearch: { tool: "websearch", dependsOn: [], readOnly: true },
  create_file: { tool: "create_file", dependsOn: [], readOnly: false },
  git_create_branch: {
    tool: "git_create_branch",
    dependsOn: [],
    readOnly: false,
  },
  get_disk_space: { tool: "get_disk_space", dependsOn: [], readOnly: true },
  get_screen_info: { tool: "get_screen_info", dependsOn: [], readOnly: true },
  list_processes: { tool: "list_processes", dependsOn: [], readOnly: true },
  screenshot: { tool: "screenshot", dependsOn: [], readOnly: true },

  // Write tools — depend on all previous writes
  write_file: { tool: "write_file", dependsOn: [], readOnly: false },
  edit_file: { tool: "edit_file", dependsOn: [], readOnly: false },
  git_commit: {
    tool: "git_commit",
    dependsOn: ["write_file", "edit_file"],
    readOnly: false,
  },
  git_checkout: { tool: "git_checkout", dependsOn: [], readOnly: false },
  run_command: { tool: "run_command", dependsOn: [], readOnly: false },
  memory_save: { tool: "memory_save", dependsOn: [], readOnly: false },
  memory_delete: { tool: "memory_delete", dependsOn: [], readOnly: false },
  memory_maintain: { tool: "memory_maintain", dependsOn: [], readOnly: false },
  task: { tool: "task", dependsOn: [], readOnly: false },
  browser_navigate: {
    tool: "browser_navigate",
    dependsOn: [],
    readOnly: false,
  },
  browser_execute: { tool: "browser_execute", dependsOn: [], readOnly: false },
  run_preview: { tool: "run_preview", dependsOn: [], readOnly: false },
  create_task_plan: {
    tool: "create_task_plan",
    dependsOn: [],
    readOnly: false,
  },
  kill_process: { tool: "kill_process", dependsOn: [], readOnly: false },
  launch_app: { tool: "launch_app", dependsOn: [], readOnly: false },
  reveal_in_finder: {
    tool: "reveal_in_finder",
    dependsOn: [],
    readOnly: false,
  },
  open_panel: { tool: "open_panel", dependsOn: [], readOnly: false },
  clipboard_write: { tool: "clipboard_write", dependsOn: [], readOnly: false },
  notify: { tool: "notify", dependsOn: [], readOnly: false },
  open_url: { tool: "open_url", dependsOn: [], readOnly: false },
  set_theme: { tool: "set_theme", dependsOn: [], readOnly: false },
  toggle_theme: { tool: "toggle_theme", dependsOn: [], readOnly: false },
  set_view_mode: { tool: "set_view_mode", dependsOn: [], readOnly: false },
  toggle_view_mode: {
    tool: "toggle_view_mode",
    dependsOn: [],
    readOnly: false,
  },
  toggle_right_panel: {
    tool: "toggle_right_panel",
    dependsOn: [],
    readOnly: false,
  },
  toggle_bottom_panel: {
    tool: "toggle_bottom_panel",
    dependsOn: [],
    readOnly: false,
  },
  set_right_panel_tab: {
    tool: "set_right_panel_tab",
    dependsOn: [],
    readOnly: false,
  },
  set_bottom_panel_tab: {
    tool: "set_bottom_panel_tab",
    dependsOn: [],
    readOnly: false,
  },
  new_terminal: { tool: "new_terminal", dependsOn: [], readOnly: false },
  terminal_write: { tool: "terminal_write", dependsOn: [], readOnly: false },
  // MCP tools — read-only by default (tool name is dynamic)
  mcp_tool: { tool: "mcp_tool", dependsOn: [], readOnly: true },
};

// Tool call cost tracking
export interface ToolCostRecord {
  toolCallId: string;
  sessionId: string;
  name: string;
  durationMs: number;
  retries: number;
  success: boolean;
  timestamp: number;
}

const _toolCosts: Map<string, ToolCostRecord[]> = new Map();
const MAX_COSTS_PER_SESSION = 500;
const MAX_SESSIONS = 50;

export function recordToolCost(record: ToolCostRecord): void {
  const sessionCosts = _toolCosts.get(record.sessionId) ?? [];
  sessionCosts.push(record);
  if (sessionCosts.length > MAX_COSTS_PER_SESSION) {
    sessionCosts.splice(0, sessionCosts.length - MAX_COSTS_PER_SESSION);
  }
  _toolCosts.set(record.sessionId, sessionCosts);
  if (_toolCosts.size > MAX_SESSIONS) {
    const firstKey = _toolCosts.keys().next().value;
    if (firstKey !== undefined) _toolCosts.delete(firstKey);
  }
}

export function clearSessionToolCosts(sessionId: string): void {
  _toolCosts.delete(sessionId);
}

export function getSessionToolCosts(sessionId: string): {
  totalCalls: number;
  totalDurationMs: number;
  totalRetries: number;
  byTool: Record<string, { calls: number; durationMs: number }>;
} {
  const costs = _toolCosts.get(sessionId) ?? [];
  const byTool: Record<string, { calls: number; durationMs: number }> = {};

  for (const cost of costs) {
    if (!byTool[cost.name]) {
      byTool[cost.name] = { calls: 0, durationMs: 0 };
    }
    byTool[cost.name].calls++;
    byTool[cost.name].durationMs += cost.durationMs;
  }

  return {
    totalCalls: costs.length,
    totalDurationMs: costs.reduce((sum, c) => sum + c.durationMs, 0),
    totalRetries: costs.reduce((sum, c) => sum + c.retries, 0),
    byTool,
  };
}

/**
 * Check if two tool calls can run in parallel.
 */
export function canRunInParallel(tool1: ToolCall, tool2: ToolCall): boolean {
  const dep1 = TOOL_DEPENDENCIES[tool1.name];
  const dep2 = TOOL_DEPENDENCIES[tool2.name];

  // If either tool is unknown, don't parallelize
  if (!dep1 || !dep2) return false;

  // If both are read-only, they can run in parallel
  if (dep1.readOnly && dep2.readOnly) return true;

  // If either is a write tool, they can't run in parallel
  // (to avoid race conditions)
  return false;
}

/**
 * Group tool calls into parallel batches.
 * Returns an array of batches, where each batch can be executed in parallel.
 * Uses a next-fit approach: accumulate read tools together, flush on write tools.
 * FIX M-4: Replaced suboptimal first-fit bin packing with next-fit approach.
 */
export function groupToolCallsForExecution(
  toolCalls: ToolCall[],
): ToolCall[][] {
  if (toolCalls.length === 0) return [];
  if (toolCalls.length === 1) return [[toolCalls[0]]];

  const batches: ToolCall[][] = [];
  let currentReadBatch: ToolCall[] = [];

  function flushReadBatch() {
    if (currentReadBatch.length > 0) {
      batches.push(currentReadBatch);
      currentReadBatch = [];
    }
  }

  for (const tc of toolCalls) {
    const dep = TOOL_DEPENDENCIES[tc.name];
    if (dep?.readOnly) {
      currentReadBatch.push(tc);
    } else {
      // Write tool (or unknown) — flush reads first, then this tool gets its own batch
      flushReadBatch();
      batches.push([tc]);
    }
  }

  // Flush remaining reads
  flushReadBatch();
  return batches;
}

