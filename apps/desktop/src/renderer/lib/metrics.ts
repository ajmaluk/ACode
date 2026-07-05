/**
 * Lightweight Performance Metrics — tracks LLM calls, tool execution, and token usage.
 *
 * Access via the `metrics` singleton or the `/metrics` slash command.
 */

interface Counter {
  count: number;
  totalMs: number;
  errors: number;
}

interface ToolMetrics extends Counter {
  retries: number;
}

export const metrics = {
  llmCalls: { count: 0, totalMs: 0, errors: 0 } as Counter,
  toolCalls: new Map<string, ToolMetrics>(),
  tokenUsage: { input: 0, output: 0 },
  compactions: { count: 0, totalMs: 0, errors: 0 } as Counter,
  memoryExtractions: { count: 0, totalMs: 0, errors: 0, gated: 0 } as Counter & { gated: number },
};

/**
 * Record an LLM call.
 */
export function recordLlmCall(durationMs: number, error = false): void {
  metrics.llmCalls.count++;
  metrics.llmCalls.totalMs += durationMs;
  if (error) metrics.llmCalls.errors++;
}

/**
 * Record a tool call.
 */
export function recordToolCall(
  toolName: string,
  durationMs: number,
  retries = 0,
  error = false
): void {
  let tool = metrics.toolCalls.get(toolName);
  if (!tool) {
    tool = { count: 0, totalMs: 0, errors: 0, retries: 0 };
    metrics.toolCalls.set(toolName, tool);
  }
  tool.count++;
  tool.totalMs += durationMs;
  tool.retries += retries;
  if (error) tool.errors++;
}

/**
 * Record token usage.
 */
export function recordTokens(input: number, output: number): void {
  metrics.tokenUsage.input += input;
  metrics.tokenUsage.output += output;
}

/**
 * Format metrics as a human-readable string.
 */
export function formatMetrics(): string {
  const lines: string[] = ["=== Performance Metrics ==="];

  lines.push(
    `\nLLM Calls: ${metrics.llmCalls.count} | ` +
    `Avg: ${metrics.llmCalls.count > 0 ? Math.round(metrics.llmCalls.totalMs / metrics.llmCalls.count) : 0}ms | ` +
    `Errors: ${metrics.llmCalls.errors}`
  );

  lines.push(
    `Tokens: ${metrics.tokenUsage.input.toLocaleString()} in / ${metrics.tokenUsage.output.toLocaleString()} out`
  );

  if (metrics.toolCalls.size > 0) {
    lines.push("\nTool Calls:");
    const sorted = [...metrics.toolCalls.entries()].sort((a, b) => b[1].count - a[1].count);
    for (const [name, data] of sorted.slice(0, 15)) {
      lines.push(
        `  ${name}: ${data.count} calls | ` +
        `Avg: ${Math.round(data.totalMs / data.count)}ms | ` +
        `Retries: ${data.retries} | Errors: ${data.errors}`
      );
    }
  }

  if (metrics.compactions.count > 0) {
    lines.push(
      `\nCompactions: ${metrics.compactions.count} | ` +
      `Avg: ${Math.round(metrics.compactions.totalMs / metrics.compactions.count)}ms`
    );
  }

  return lines.join("\n");
}

/**
 * Reset all metrics.
 */
export function resetMetrics(): void {
  metrics.llmCalls = { count: 0, totalMs: 0, errors: 0 };
  metrics.toolCalls.clear();
  metrics.tokenUsage = { input: 0, output: 0 };
  metrics.compactions = { count: 0, totalMs: 0, errors: 0 };
  metrics.memoryExtractions = { count: 0, totalMs: 0, errors: 0, gated: 0 };
}
