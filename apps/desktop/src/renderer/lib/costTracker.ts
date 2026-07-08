/**
 * Cost Tracker — tracks token usage and costs per session.
 *
 * Parses usage from LLM API responses (both OpenAI and Anthropic formats)
 * and calculates costs based on configurable pricing.
 */

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface SessionCost {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  byModel: Record<string, { inputTokens: number; outputTokens: number; costUsd: number }>;
}

// Default pricing per 1M tokens (USD)
const DEFAULT_PRICING: Record<string, { input: number; output: number }> = {
  "gpt-4o": { input: 2.50, output: 10.00 },
  "gpt-4o-mini": { input: 0.15, output: 0.60 },
  "gpt-4-turbo": { input: 10.00, output: 30.00 },
  "claude-4-sonnet": { input: 3.00, output: 15.00 },
  "claude-4-opus": { input: 15.00, output: 75.00 },
  "claude-3-5-sonnet": { input: 3.00, output: 15.00 },
  "claude-3-5-haiku": { input: 0.80, output: 4.00 },
  "gemini-2.5-pro": { input: 1.25, output: 10.00 },
  "gemini-2.5-flash": { input: 0.15, output: 0.60 },
};

const _pricing = { ...DEFAULT_PRICING };

const _sessionCosts = new Map<string, SessionCost>();
const MAX_SESSION_COSTS = 50; // Cap to prevent unbounded memory growth

function getEmptyCost(): SessionCost {
  return { totalInputTokens: 0, totalOutputTokens: 0, totalCostUsd: 0, byModel: {} };
}

function getPrice(modelId: string): { input: number; output: number } {
  // Try exact match, then partial match
  if (_pricing[modelId]) return _pricing[modelId];
  const lower = modelId.toLowerCase();
  for (const [key, val] of Object.entries(_pricing)) {
    if (lower.includes(key) || key.includes(lower)) return val;
  }
  return { input: 3.00, output: 15.00 }; // Default fallback
}

/**
 * Record token usage for a session.
 */
export function recordTokenUsage(sessionId: string, modelId: string, usage: TokenUsage): void {
  let cost = _sessionCosts.get(sessionId);
  if (!cost) {
    cost = getEmptyCost();
    // Evict oldest entries if at cap
    if (_sessionCosts.size >= MAX_SESSION_COSTS) {
      const firstKey = _sessionCosts.keys().next().value;
      if (firstKey !== undefined) _sessionCosts.delete(firstKey);
    }
    _sessionCosts.set(sessionId, cost);
  }

  const prices = getPrice(modelId);
  const inputCost = (usage.inputTokens / 1_000_000) * prices.input;
  const outputCost = (usage.outputTokens / 1_000_000) * prices.output;
  const totalCost = inputCost + outputCost;

  cost.totalInputTokens += usage.inputTokens;
  cost.totalOutputTokens += usage.outputTokens;
  cost.totalCostUsd += totalCost;

  if (!cost.byModel[modelId]) {
    cost.byModel[modelId] = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
  }
  const m = cost.byModel[modelId];
  m.inputTokens += usage.inputTokens;
  m.outputTokens += usage.outputTokens;
  m.costUsd += totalCost;
}

/**
 * Parse token usage from an LLM API response chunk.
 * Returns usage if found, null otherwise.
 */
export function parseUsageFromChunk(chunk: unknown): TokenUsage | null {
  if (!chunk || typeof chunk !== "object") return null;
  const obj = chunk as Record<string, unknown>;

  // OpenAI format: { usage: { prompt_tokens, completion_tokens, total_tokens } }
  if (obj.usage && typeof obj.usage === "object") {
    const u = obj.usage as Record<string, number>;
    if (u.prompt_tokens !== undefined) {
      return {
        inputTokens: u.prompt_tokens ?? 0,
        outputTokens: u.completion_tokens ?? 0,
        totalTokens: u.total_tokens ?? (u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0),
      };
    }
    // Anthropic format: { usage: { input_tokens, output_tokens } }
    if (u.input_tokens !== undefined) {
      return {
        inputTokens: u.input_tokens ?? 0,
        outputTokens: u.output_tokens ?? 0,
        totalTokens: (u.input_tokens ?? 0) + (u.output_tokens ?? 0),
      };
    }
  }

  return null;
}

/**
 * Get cost summary for a session.
 */
export function getSessionCost(sessionId: string): SessionCost {
  return _sessionCosts.get(sessionId) ?? getEmptyCost();
}

/**
 * Format cost as a short string.
 */
export function formatCost(sessionId: string): string {
  const cost = getSessionCost(sessionId);
  const inputK = Math.round(cost.totalInputTokens / 1000);
  const outputK = Math.round(cost.totalOutputTokens / 1000);
  return `\u2191${inputK}K \u2193${outputK}K | $${cost.totalCostUsd.toFixed(2)}`;
}

/**
 * Get detailed cost breakdown.
 */
export function formatCostDetailed(sessionId: string): string {
  const cost = getSessionCost(sessionId);
  const lines = ["=== Token Usage & Cost ==="];

  lines.push(`Total: \u2191${cost.totalInputTokens.toLocaleString()} in / \u2193${cost.totalOutputTokens.toLocaleString()} out`);
  lines.push(`Cost: $${cost.totalCostUsd.toFixed(4)}`);

  if (Object.keys(cost.byModel).length > 0) {
    lines.push("\nBy Model:");
    for (const [model, data] of Object.entries(cost.byModel)) {
      lines.push(`  ${model}: ${data.inputTokens.toLocaleString()} in / ${data.outputTokens.toLocaleString()} out | $${data.costUsd.toFixed(4)}`);
    }
  }

  return lines.join("\n");
}

/**
 * Clear cost data for a session.
 */
export function clearSessionCost(sessionId: string): void {
  _sessionCosts.delete(sessionId);
}

/**
 * Update pricing for a model.
 */
export function setModelPricing(modelId: string, input: number, output: number): void {
  _pricing[modelId] = { input, output };
}

/**
 * Get current pricing for all models (for settings UI).
 */
export function getModelPricing(): Record<string, { input: number; output: number }> {
  return { ..._pricing };
}

/**
 * Load custom pricing overrides from a JSON record.
 */
export function loadPricingOverrides(overrides: Record<string, { input: number; output: number }>): void {
  for (const [model, price] of Object.entries(overrides)) {
    if (price.input > 0 && price.output > 0) {
      _pricing[model] = price;
    }
  }
}

/**
 * Reset pricing to defaults.
 */
export function resetPricing(): void {
  Object.keys(_pricing).forEach(k => delete _pricing[k]);
  Object.assign(_pricing, DEFAULT_PRICING);
}
