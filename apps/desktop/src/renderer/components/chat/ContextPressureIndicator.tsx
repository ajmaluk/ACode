/**
 * ContextPressureIndicator — Real-time context window pressure display.
 *
 * Shows a color-coded bar indicating context usage level:
 * - Green: <50% (Normal)
 * - Yellow: 50-70% (Low pressure)
 * - Orange: 70-85% (Medium pressure)
 * - Red: >85% (High pressure)
 *
 * Based on contextManager.ts pressure thresholds.
 */

import React, { useMemo } from "react";
import { useChat } from "@/store/useAppStore";
import {
  computeContextStats,
  getContextPressureRecommendation,
} from "@/lib/contextManager";

interface ContextPressureIndicatorProps {
  maxContextTokens?: number;
  showLabel?: boolean;
  showPercentage?: boolean;
  className?: string;
}

export function ContextPressureIndicator({
  maxContextTokens = 128000,
  showLabel = true,
  showPercentage = true,
  className = "",
}: ContextPressureIndicatorProps) {
  const { sessionMessages, activeSessionId } = useChat();

  const stats = useMemo(() => {
    const messages = activeSessionId
      ? sessionMessages[activeSessionId] || []
      : [];
    return computeContextStats(messages, maxContextTokens);
  }, [sessionMessages, activeSessionId, maxContextTokens]);

  const recommendation = useMemo(() => {
    return getContextPressureRecommendation(
      stats.pressure,
    );
  }, [stats.pressure]);

  // Format token counts for display
  const formatTokens = (n: number): string => {
    if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
    if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
    return n.toString();
  };

  const percentage = Math.min(100, Math.round(stats.pressureRatio * 100));

  return (
    <div className={`flex items-center gap-2 ${className}`}>
      {/* Progress bar */}
      <div className="relative h-1.5 flex-1 rounded-full bg-dalam-bg-tertiary overflow-hidden">
        <div
          className="absolute inset-y-0 left-0 rounded-full transition-all duration-300 ease-out"
          style={{
            width: `${percentage}%`,
            backgroundColor: recommendation.color,
          }}
        />
      </div>

      {/* Percentage */}
      {showPercentage && (
        <span
          className="text-[11px] font-medium tabular-nums min-w-[32px] text-right"
          style={{ color: recommendation.color }}
        >
          {percentage}%
        </span>
      )}

      {/* Label */}
      {showLabel && (
        <span className="text-[11px] text-dalam-text-muted">
          {recommendation.label}
        </span>
      )}

      {/* Token count (hidden on small screens) */}
      <span className="hidden sm:inline text-[10px] text-dalam-text-muted/60 tabular-nums">
        {formatTokens(stats.totalTokens)}/{formatTokens(stats.usableTokens)}
      </span>
    </div>
  );
}

/**
 * Compact version for the status bar.
 * Shows just the pressure bar with tooltip.
 */
export function ContextPressureBar({
  maxContextTokens = 128000,
  className = "",
}: {
  maxContextTokens?: number;
  className?: string;
}) {
  const { sessionMessages, activeSessionId } = useChat();

  const stats = useMemo(() => {
    const messages = activeSessionId
      ? sessionMessages[activeSessionId] || []
      : [];
    return computeContextStats(messages, maxContextTokens);
  }, [sessionMessages, activeSessionId, maxContextTokens]);

  const recommendation = useMemo(() => {
    return getContextPressureRecommendation(
      stats.pressure,
    );
  }, [stats.pressure]);

  const percentage = Math.min(100, Math.round(stats.pressureRatio * 100));

  return (
    <div
      className={`relative h-1 rounded-full bg-dalam-bg-tertiary overflow-hidden ${className}`}
      title={`Context: ${percentage}% — ${recommendation.action}`}
    >
      <div
        className="absolute inset-y-0 left-0 rounded-full transition-all duration-300 ease-out"
        style={{
          width: `${percentage}%`,
          backgroundColor: recommendation.color,
        }}
      />
    </div>
  );
}
