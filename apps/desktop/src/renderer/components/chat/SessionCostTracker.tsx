/**
 * SessionCostTracker — Real-time LLM cost tracking display.
 *
 * Tracks and displays:
 * - Token usage (input/output)
 * - Estimated cost based on model pricing
 * - Cost per tool call
 *
 * Based on token counting from contextManager.ts.
 */

import React, { useMemo } from "react";
import { useChat } from "@/store/useAppStore";
import { estimateTokens } from "@/lib/contextManager";
import { DollarSign, Zap, Hash } from "lucide-react";

// Model pricing (per 1K tokens) — update as pricing changes
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  // Anthropic
  "claude-4-opus": { input: 0.015, output: 0.075 },
  "claude-4-sonnet": { input: 0.003, output: 0.015 },
  "claude-3-5-sonnet": { input: 0.003, output: 0.015 },
  "claude-3-5-haiku": { input: 0.0008, output: 0.004 },
  "claude-3-opus": { input: 0.015, output: 0.075 },
  "claude-3-haiku": { input: 0.00025, output: 0.00125 },
  // OpenAI
  "gpt-4o": { input: 0.0025, output: 0.01 },
  "gpt-4o-mini": { input: 0.00015, output: 0.0006 },
  "gpt-4-turbo": { input: 0.01, output: 0.03 },
  "gpt-4.1": { input: 0.002, output: 0.008 },
  "gpt-4.1-mini": { input: 0.0004, output: 0.0016 },
  "gpt-3.5-turbo": { input: 0.0005, output: 0.0015 },
  // Google
  "gemini-2.5-pro": { input: 0.00125, output: 0.01 },
  "gemini-2.5-flash": { input: 0.00015, output: 0.0006 },
  // Default fallback
  default: { input: 0.003, output: 0.015 },
};

interface SessionCostTrackerProps {
  modelId?: string;
  showBreakdown?: boolean;
  className?: string;
}

export function SessionCostTracker({
  modelId = "default",
  showBreakdown = false,
  className = "",
}: SessionCostTrackerProps) {
  const { sessionMessages, activeSessionId } = useChat();

  const costData = useMemo(() => {
    const messages = activeSessionId
      ? sessionMessages[activeSessionId] || []
      : [];
    let inputTokens = 0;
    let outputTokens = 0;
    let toolCallCount = 0;

    for (const msg of messages) {
      const tokens = estimateTokens(msg.content);

      if (msg.role === "user") {
        inputTokens += tokens;
      } else if (msg.role === "assistant") {
        outputTokens += tokens;
        if (msg.toolCalls?.length) {
          toolCallCount += msg.toolCalls.length;
        }
      }
    }

    // Get pricing for this model
    const pricing = MODEL_PRICING[modelId] || MODEL_PRICING["default"];

    // Calculate costs
    const inputCost = (inputTokens / 1000) * pricing.input;
    const outputCost = (outputTokens / 1000) * pricing.output;
    const totalCost = inputCost + outputCost;
    const costPerToolCall = toolCallCount > 0 ? totalCost / toolCallCount : 0;

    return {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      inputCost,
      outputCost,
      totalCost,
      toolCallCount,
      costPerToolCall,
    };
  }, [sessionMessages, activeSessionId, modelId]);

  // Format cost for display
  const formatCost = (cost: number): string => {
    if (cost < 0.01) return `$${(cost * 1000).toFixed(2)}m`;
    if (cost < 1) return `$${cost.toFixed(3)}`;
    return `$${cost.toFixed(2)}`;
  };

  // Format token count
  const formatTokens = (n: number): string => {
    if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
    if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
    return n.toString();
  };

  if (costData.totalTokens === 0) return null;

  return (
    <div
      className={`group relative flex items-center gap-3 text-[11px] text-dalam-text-muted ${className}`}
    >
      {/* Total cost */}
      <div className="flex items-center gap-1" title="Estimated total cost">
        <DollarSign className="w-3 h-3" />
        <span className="font-medium">{formatCost(costData.totalCost)}</span>
      </div>

      {/* Token count */}
      <div className="flex items-center gap-1" title="Total tokens">
        <Hash className="w-3 h-3" />
        <span>{formatTokens(costData.totalTokens)}</span>
      </div>

      {/* Tool calls */}
      {costData.toolCallCount > 0 && (
        <div className="flex items-center gap-1" title="Tool calls executed">
          <Zap className="w-3 h-3" />
          <span>{costData.toolCallCount}</span>
        </div>
      )}

      {/* Detailed breakdown (toggle) */}
      {showBreakdown && (
        <div className="hidden group-hover:block absolute bottom-full left-0 mb-2 p-2 bg-dalam-bg rounded shadow-lg border border-dalam-border text-[10px] whitespace-nowrap z-50">
          <div>
            Input: {formatTokens(costData.inputTokens)} (
            {formatCost(costData.inputCost)})
          </div>
          <div>
            Output: {formatTokens(costData.outputTokens)} (
            {formatCost(costData.outputCost)})
          </div>
          {costData.toolCallCount > 0 && (
            <div>Cost/tool: {formatCost(costData.costPerToolCall)}</div>
          )}
        </div>
      )}
    </div>
  );
}
