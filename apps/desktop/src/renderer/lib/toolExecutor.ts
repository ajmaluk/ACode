/**
 * Tool Executor — Improved tool execution with parallel support and retry.
 *
 * This module provides:
 * 1. Parallel tool execution for independent tools
 * 2. Automatic retry with exponential backoff
 * 3. Tool dependency analysis
 * 4. Better error handling and recovery
 *
 * Based on Claude Code's approach to tool execution.
 */

import { validateToolArgs } from "./toolSchemas";
import { recordChange } from "./changeStack";
import { readFileSync, writeFileSync } from "fs";

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

  // Write tools — depend on all previous writes
  write_file: { tool: "write_file", dependsOn: [], readOnly: false },
  edit_file: { tool: "edit_file", dependsOn: [], readOnly: false },
  git_commit: { tool: "git_commit", dependsOn: ["write_file", "edit_file"], readOnly: false },
  run_command: { tool: "run_command", dependsOn: [], readOnly: false },
  memory_save: { tool: "memory_save", dependsOn: [], readOnly: false },
  memory_delete: { tool: "memory_delete", dependsOn: [], readOnly: false },
  memory_maintain: { tool: "memory_maintain", dependsOn: [], readOnly: false },
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
 * Check if an error is retryable.
 */
function isRetryableError(error: string): boolean {
  const lower = error.toLowerCase();
  return RETRYABLE_ERRORS.some(e => lower.includes(e.toLowerCase()));
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

export function recordToolCost(record: ToolCostRecord): void {
  const sessionCosts = _toolCosts.get(record.sessionId) ?? [];
  sessionCosts.push(record);
  if (sessionCosts.length > MAX_COSTS_PER_SESSION) {
    sessionCosts.splice(0, sessionCosts.length - MAX_COSTS_PER_SESSION);
  }
  _toolCosts.set(record.sessionId, sessionCosts);
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
export function groupToolCallsForExecution(toolCalls: ToolCall[]): ToolCall[][] {
  if (toolCalls.length === 0) return [];
  if (toolCalls.length === 1) return [[toolCalls[0]]];

  const batches: ToolCall[][] = [];
  let currentBatch: ToolCall[] = [toolCalls[0]];

  for (let i = 1; i < toolCalls.length; i++) {
    const current = toolCalls[i];
    const canAddToBatch = currentBatch.every(tc => canRunInParallel(tc, current));

    if (canAddToBatch) {
      currentBatch.push(current);
    } else {
      batches.push(currentBatch);
      currentBatch = [current];
    }
  }

  batches.push(currentBatch);
  return batches;
}

/**
 * Execute a tool call with retry support.
 */
export async function executeToolWithRetry(
  toolCall: ToolCall,
  executeFn: (name: string, args: Record<string, unknown>) => Promise<string>,
  emit?: (event: unknown) => void,
  sessionId?: string
): Promise<ToolResult> {
  let lastError: string | null = null;
  let retries = 0;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const startTime = Date.now();

    try {
      // Validate args before execution
      const validated = validateToolArgs(toolCall.name, toolCall.args);
      if (!validated.valid) {
        throw new Error(validated.error);
      }
      const result = await executeFn(toolCall.name, validated.args);
      const durationMs = Date.now() - startTime;

      // Record file changes for undo support
      if (toolCall.name === "write_file" || toolCall.name === "edit_file") {
        const path = String(toolCall.args.path ?? "");
        if (path) {
          let beforeContent = "";
          try {
            beforeContent = readFileSync(path, "utf-8");
          } catch {
            beforeContent = "";
          }
          const callId = `${toolCall.name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          const afterContent = toolCall.name === "write_file"
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
        toolCallId: `${toolCall.name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
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
        await new Promise(resolve => setTimeout(resolve, delay));
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
  sessionId?: string
): Promise<ToolResult[]> {
  const results = await Promise.all(
    batch.map(tc => executeToolWithRetry(tc, executeFn, emit, sessionId))
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
  sessionId?: string
): Promise<ToolResult[]> {
  const batches = groupToolCallsForExecution(toolCalls);
  const allResults: ToolResult[] = [];

  for (const batch of batches) {
    // Check abort signal before each batch
    if (abortSignal?.aborted) {
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

    const results = await executeToolBatch(batch, executeFn, emit, sessionId);
    allResults.push(...results);
  }

  return allResults;
}

/**
 * Format tool results for inclusion in conversation history.
 */
export function formatToolResults(results: ToolResult[]): string {
  return results.map(r => {
    if (r.success) {
      return `[Tool result for ${r.toolName}]${r.retries ? ` (retried ${r.retries} times)` : ""}\n${r.result || "(no output)"}`;
    } else {
      return `[Tool error for ${r.toolName}]${r.retries ? ` (retried ${r.retries} times)` : ""}\n${r.result}`;
    }
  }).join("\n\n");
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
  const succeeded = results.filter(r => r.success).length;
  const failed = results.length - succeeded;
  const retried = results.filter(r => (r.retries ?? 0) > 0).length;
  const totalDurationMs = results.reduce((sum, r) => sum + r.durationMs, 0);

  return {
    total: results.length,
    succeeded,
    failed,
    retried,
    totalDurationMs,
    avgDurationMs: results.length > 0 ? Math.round(totalDurationMs / results.length) : 0,
  };
}
