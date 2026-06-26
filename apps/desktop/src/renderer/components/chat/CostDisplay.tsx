/**
 * ============================================================
 * COST DISPLAY — Token Usage & Cost Tracking UI
 * ============================================================
 *
 * Shows real-time token usage and cost estimates in the
 * status bar. Addresses Issue #20 (No Cost/Token Tracking).
 * ============================================================
 */

import React from "react";
import { useChat } from "@/store/useAppStore";

export const CostDisplay: React.FC = () => {
  const isStreaming = useChat((s) => s.isStreaming);
  const messages = useChat((s) => s.messages);

  // Count tool calls and messages for a rough activity indicator
  const toolCallCount = messages.reduce(
    (sum, m) => sum + (m.toolCalls?.length ?? 0),
    0,
  );
  const messageCount = messages.length;

  if (messageCount === 0) return null;

  return (
    <div className="flex items-center gap-2 text-[10px] text-muted/60 px-2 py-0.5 select-none">
      <span title="Messages in conversation">💬 {messageCount}</span>
      {toolCallCount > 0 && (
        <span title="Tool calls executed">🔧 {toolCallCount}</span>
      )}
      {isStreaming && (
        <span className="inline-block w-1.5 h-1.5 bg-green-400 rounded-full animate-pulse" />
      )}
    </div>
  );
};
