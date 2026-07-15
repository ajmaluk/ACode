/**
 * Tool Executor — Improved tool execution with parallel support, retry, and per-tool timeout.
 *
 * This module provides:
 * 1. Parallel tool execution for independent tools
 * 2. Automatic retry with exponential backoff
 * 3. Tool dependency analysis
 * 4. Per-tool execution timeout
 * 5. Better error handling and recovery
 *
 * Based on Claude Code's approach to tool execution.
 */

import { validateToolArgs } from "./toolSchemas";
import { recordChange } from "./changeStack";

/** Async read of a file's text content, returning empty string on failure. */
async function readFileBeforeEdit(path: string): Promise<string> {
  try {
    const { readTextFile } = await import("@tauri-apps/plugin-fs");
    return await readTextFile(path);
  } catch (e) {
    if (import.meta.env.DEV) console.warn("[ToolExecutor] Failed to read file before edit:", e);
    return "";
  }
}

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
  raw: string;
}

export interface ToolResult {
  toolName: string;
  result: string;
  success: boolean;
  durationMs: number;
  retries?: number;
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
};

// Retry configuration
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 1000;
const RETRY_BACKOFF_FACTOR = 2;

// Tools that should be retried on failure
const RETRYABLE_ERRORS = [
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "HTTP 429",
  "HTTP 500",
  "HTTP 502",
  "HTTP 503",
  "network",
  "timeout",
];

/**
 * Per-tool timeouts in milliseconds.
 * Defines maximum execution time per tool before it is considered timed out.
 */
const TOOL_TIMEOUTS: Record<string, number> = {
  read_file: 15_000,
  write_file: 30_000,
  edit_file: 30_000,
  run_command: 120_000,
  grep_file: 30_000,
  search_files: 60_000,
  list_dir: 15_000,
  git_status: 15_000,
  git_log: 15_000,
  git_branch: 10_000,
  git_diff_file: 15_000,
  git_commit: 30_000,
  git_checkout: 15_000,
  git_create_branch: 10_000,
  clipboard_read: 5_000,
  clipboard_write: 5_000,
  notify: 5_000,
  system_info: 5_000,
  open_url: 5_000,
  launch_app: 15_000,
  reveal_in_finder: 5_000,
  memory_save: 10_000,
  memory_search: 10_000,
  memory_delete: 5_000,
  memory_stats: 5_000,
  memory_maintain: 30_000,
  memory_extract: 60_000,
  memory_export: 30_000,
  memory_import: 30_000,
  task: 300_000,
  mcp_tool: 60_000,
  question: 600_000,
  default: 30_000,
};

/**
 * Get the timeout for a specific tool.
 */
function getToolTimeout(toolName: string): number {
  return TOOL_TIMEOUTS[toolName] ?? TOOL_TIMEOUTS.default;
}

/**
 * Execute an async function with a timeout.
 * The promise is rejected if execution exceeds the specified timeout.
 * If an abortSignal is provided, the timeout is also cancelled on abort.
 */
async function executeWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  toolName: string,
  abortSignal?: AbortSignal,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout>;
  let settled = false;
  let rejectFn: ((err: Error) => void) | null = null;
  const abortHandler = () => {
    if (settled) return;
    settled = true;
    clearTimeout(timeoutId);
    rejectFn?.(new Error(`Tool "${toolName}" was aborted`));
  };
  const timeoutPromise = new Promise<T>((_, reject) => {
    rejectFn = reject;
    timeoutId = setTimeout(
      () => {
        if (settled) return;
        settled = true;
        reject(new Error(`Tool "${toolName}" timed out after ${timeoutMs}ms`));
      },
      timeoutMs,
    );
    if (abortSignal) {
      if (abortSignal.aborted) {
        settled = true;
        clearTimeout(timeoutId);
        reject(new Error(`Tool "${toolName}" was aborted`));
        return;
      }
      abortSignal.addEventListener("abort", abortHandler, { once: true });
    }
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    clearTimeout(timeoutId!);
    if (abortSignal) {
      try {
        abortSignal.removeEventListener("abort", abortHandler);
      } catch (e) {
        if (import.meta.env.DEV) console.warn("[ToolExecutor] Failed to remove abort listener:", e);
      }
    }
  });
}

/**
 * Check if an error is retryable.
 */
function isRetryableError(error: string): boolean {
  const lower = error.toLowerCase();
  return RETRYABLE_ERRORS.some((e) => lower.includes(e.toLowerCase()));
}

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
 */
export function groupToolCallsForExecution(
  toolCalls: ToolCall[],
): ToolCall[][] {
  if (toolCalls.length === 0) return [];
  if (toolCalls.length === 1) return [[toolCalls[0]]];

  // First-fit bin packing: try to add each tool to an existing compatible batch
  // This handles patterns like [read(A), write(B), read(C)] → [[read(A), read(C)], [write(B)]]
  const batches: ToolCall[][] = [[toolCalls[0]]];

  for (let i = 1; i < toolCalls.length; i++) {
    const current = toolCalls[i];
    let added = false;
    for (const batch of batches) {
      if (batch.every((tc) => canRunInParallel(tc, current))) {
        batch.push(current);
        added = true;
        break;
      }
    }
    if (!added) {
      batches.push([current]);
    }
  }

  return batches;
}

/**
 * Execute a tool call with retry support and per-tool timeout.
 */
export async function executeToolWithRetry(
  toolCall: ToolCall,
  executeFn: (name: string, args: Record<string, unknown>) => Promise<string>,
  emit?: (event: unknown) => void,
  abortSignal?: AbortSignal,
  sessionId?: string,
): Promise<ToolResult> {
  let lastError: string | null = null;
  let retries = 0;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const startTime = Date.now();
    // Check abort before each attempt
    if (abortSignal?.aborted) {
      return {
        toolName: toolCall.name,
        result: "Aborted by user.",
        success: false,
        durationMs: Date.now() - startTime,
        retries,
      };
    }

    try {
      // Validate args before execution
      const validated = validateToolArgs(toolCall.name, toolCall.args);
      if (!validated.valid) {
        throw new Error(validated.error);
      }

      // Read beforeContent BEFORE execution to capture the original file state
      let beforeContent = "";
      if (toolCall.name === "write_file" || toolCall.name === "edit_file") {
        const path = String(validated.args.path ?? toolCall.args.path ?? "");
        if (path) {
          beforeContent = await readFileBeforeEdit(path);
        }
      }

      // Execute with per-tool timeout and abort support
      const timeoutMs = getToolTimeout(toolCall.name);
      const result = await executeWithTimeout(
        executeFn(toolCall.name, validated.args),
        timeoutMs,
        toolCall.name,
        abortSignal,
      );
      const durationMs = Date.now() - startTime;

      // Record file changes for undo support (beforeContent was captured pre-execution)
      if (toolCall.name === "write_file" || toolCall.name === "edit_file") {
        const path = String(validated.args.path ?? toolCall.args.path ?? "");
        if (path) {
          const callId = `${toolCall.name}-${crypto.randomUUID().slice(0, 8)}`;
          const afterContent =
            toolCall.name === "write_file"
              ? String(toolCall.args.content ?? "")
              : result;
          recordChange({
            filePath: path,
            beforeContent,
            afterContent,
            toolCallId: callId,
            messageId: sessionId ?? "unknown",
          });
        }
      }

      recordToolCost({
        toolCallId: `${toolCall.name}-${crypto.randomUUID().slice(0, 8)}`,
        sessionId: sessionId ?? "unknown",
        name: toolCall.name,
        durationMs,
        retries,
        success: true,
        timestamp: Date.now(),
      });
      return {
        toolName: toolCall.name,
        result,
        success: true,
        durationMs,
        retries,
      };
    } catch (err) {
      lastError = (err as Error)?.message ?? String(err);

      // Check if we should retry
      if (attempt < MAX_RETRIES && isRetryableError(lastError)) {
        retries++;
        const delay = RETRY_DELAY_MS * Math.pow(RETRY_BACKOFF_FACTOR, attempt);
        emit?.({
          type: "tool-retry",
          toolName: toolCall.name,
          attempt: attempt + 1,
          maxRetries: MAX_RETRIES,
          delay,
          error: lastError,
        });
        // Race retry delay against abort signal to ensure timely cancellation
        if (abortSignal) {
          await new Promise<void>((resolve) => {
            if (abortSignal.aborted) return resolve();
            const timer = setTimeout(resolve, delay);
            abortSignal.addEventListener(
              "abort",
              () => {
                clearTimeout(timer);
                resolve();
              },
              { once: true },
            );
          });
        } else {
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
        continue;
      }

      // Non-retryable error or max retries exceeded
      const failDurationMs = Date.now() - startTime;
      recordToolCost({
        toolCallId: `${toolCall.name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        sessionId: sessionId ?? "unknown",
        name: toolCall.name,
        durationMs: failDurationMs,
        retries,
        success: false,
        timestamp: Date.now(),
      });
      return {
        toolName: toolCall.name,
        result: `Error: ${lastError}`,
        success: false,
        durationMs: failDurationMs,
        retries,
      };
    }
  }

  // This should never happen, but TypeScript needs it
  return {
    toolName: toolCall.name,
    result: `Error: ${lastError ?? "Unknown error"}`,
    success: false,
    durationMs: 0,
    retries,
  };
}

/**
 * Execute a batch of tool calls in parallel.
 */
export async function executeToolBatch(
  batch: ToolCall[],
  executeFn: (name: string, args: Record<string, unknown>) => Promise<string>,
  emit?: (event: unknown) => void,
  abortSignal?: AbortSignal,
  sessionId?: string,
): Promise<ToolResult[]> {
  const results = await Promise.all(
    batch.map((tc) =>
      executeToolWithRetry(tc, executeFn, emit, abortSignal, sessionId),
    ),
  );
  return results;
}

/**
 * Execute all tool calls with optimal parallelization.
 */
export async function executeToolCalls(
  toolCalls: ToolCall[],
  executeFn: (name: string, args: Record<string, unknown>) => Promise<string>,
  emit?: (event: unknown) => void,
  abortSignal?: AbortSignal,
  sessionId?: string,
): Promise<ToolResult[]> {
  const batches = groupToolCallsForExecution(toolCalls);
  const allResults: ToolResult[] = [];
  let abortedMidBatch = false;

  // Register abort listener for mid-batch cancellation (complements per-batch polling)
  const abortHandler = () => {
    abortedMidBatch = true;
  };
  if (abortSignal && !abortSignal.aborted) {
    abortSignal.addEventListener("abort", abortHandler, { once: true });
  }

  try {
    for (const batch of batches) {
      if (abortSignal?.aborted || abortedMidBatch) {
        for (const tc of batch) {
          allResults.push({
            toolName: tc.name,
            result: "Aborted by user.",
            success: false,
            durationMs: 0,
          });
        }
        continue;
      }

      const results = await executeToolBatch(
        batch,
        executeFn,
        emit,
        abortSignal,
        sessionId,
      );
      allResults.push(...results);
    }
  } finally {
    if (abortSignal && abortHandler) {
      try {
        abortSignal.removeEventListener("abort", abortHandler);
      } catch (e) {
        if (import.meta.env.DEV) console.warn("[ToolExecutor] Failed to remove batch abort listener:", e);
      }
    }
  }

  return allResults;
}

/**
 * Format tool results for inclusion in conversation history.
 */
export function formatToolResults(results: ToolResult[]): string {
  return results
    .map((r) => {
      if (r.success) {
        return `[Tool result for ${r.toolName}]${r.retries ? ` (retried ${r.retries} times)` : ""}\n${r.result || "(no output)"}`;
      } else {
        return `[Tool error for ${r.toolName}]${r.retries ? ` (retried ${r.retries} times)` : ""}\n${r.result}`;
      }
    })
    .join("\n\n");
}

/**
 * Get statistics about tool execution.
 */
export function getToolStats(results: ToolResult[]): {
  total: number;
  succeeded: number;
  failed: number;
  retried: number;
  totalDurationMs: number;
  avgDurationMs: number;
} {
  const succeeded = results.filter((r) => r.success).length;
  const failed = results.length - succeeded;
  const retried = results.filter((r) => (r.retries ?? 0) > 0).length;
  const totalDurationMs = results.reduce((sum, r) => sum + r.durationMs, 0);

  return {
    total: results.length,
    succeeded,
    failed,
    retried,
    totalDurationMs,
    avgDurationMs:
      results.length > 0 ? Math.round(totalDurationMs / results.length) : 0,
  };
}
