/**
 * ============================================================
 * DALAM SAFETY TIMER — Stream Inactivity Protection
 * ============================================================
 *
 * The safety timer fires if no stream events arrive within a timeout
 * window, catching hung/stuck agent loops. Two variants:
 *
 * - resetSafetyTimer(): 120s timeout, called on every stream event
 * - extendSafetyTimerForApproval(): 10min timeout, used during
 *   tool approval waits where the agent loop is blocked on user input.
 *
 * Both clear any existing timer before creating a new one, ensuring
 * only one timer is active at a time.
 * ============================================================
 */

import type { ChatMessage, ChatSessionSummary } from "@dalam/shared-types";
import { createDalamAPI } from "./dalamAPI";

export const SAFETY_TIMEOUT_MS = 300_000;
export const TOOL_APPROVAL_TIMEOUT_MS = 600_000;
export const CUMULATIVE_STREAM_TIMEOUT_MS = 1_800_000; // 30 minutes cumulative
export const CUMULATIVE_WARNING_MS = 1_500_000; // Warn at 25 minutes

/**
 * Minimal interface matching the subset of ChatState that the timer needs.
 * Avoids circular imports with useAppStore.
 */
export interface TimerState {
  isStreaming: boolean;
  _sendInProgress: boolean;
  _safetyTimer: ReturnType<typeof setTimeout> | null;
  streamingContent: string;
  thinkingContent: string;
  activeSessionId: string | null;
  session: { id: string } | null;
  messages: ChatMessage[];
  pendingToolCalls: Array<{ name: string; status?: string }>;
  pendingActivities: Array<{ type: string; [key: string]: unknown }>;
  chatSessions: ChatSessionSummary[];
  _autoRemoveTimers: Set<ReturnType<typeof setTimeout>>;
}

/**
 * Reset the safety timer. Clears any existing timer first.
 * @param mode - "normal" = 120s, "tool-approval" = 10min for user approval waits
 * Called on every stream event to keep the agent loop alive.
 */
export function resetSafetyTimer(
  get: () => TimerState,
  set: (partial: Record<string, unknown>) => void,
  mode: "normal" | "tool-approval" = "normal",
) {
  const existing = get()._safetyTimer;
  if (existing) clearTimeout(existing);
  const timeout =
    mode === "tool-approval" ? TOOL_APPROVAL_TIMEOUT_MS : SAFETY_TIMEOUT_MS;
  // Capture the streaming start time when this timer is created.
  // If a new stream starts, streamingStartedAt changes and this timer is stale.
  const timerCreatedAt = Date.now();
  const timer = setTimeout(() => {
    const state = get();
    if (!state.isStreaming) return;
    // Guard: if streaming was restarted (new stream) after this timer was created,
    // this timer is stale — don't kill the new stream.
    const streamStartedAt = (state as unknown as Record<string, unknown>)
      .streamingStartedAt as number | null;
    if (streamStartedAt && streamStartedAt > timerCreatedAt) return;
    console.warn(
      `[Chat] Safety timeout triggered (${mode}) — no stream events for ${timeout / 1000}s`,
    );
    const api = createDalamAPI();
    const sid = state.activeSessionId;
    if (sid) api.agent.cleanupStream(sid);
    const systemMsg: ChatMessage = {
      id: "msg-" + crypto.randomUUID(),
      role: "system",
      content:
        mode === "tool-approval"
          ? "Agent loop timed out — no activity for 10 minutes during tool approval."
          : "Stream timed out after 300 seconds of inactivity. The agent may have encountered an issue.",
      timestamp: Date.now(),
    };
    // Clear only auto-remove timers associated with the current session,
    // not all timers (which could include timers from other sessions/tools).
    set({
      isStreaming: false,
      _sendInProgress: false,
      streamingContent: "",
      thinkingContent: "",
      pendingToolCalls: [],
      pendingActivities: [],
      _safetyTimer: null,
      messages: [...state.messages, systemMsg],
      chatSessions: state.session
        ? state.chatSessions.map((cs) =>
            cs.id === state.session!.id
              ? {
                  ...cs,
                  status: "completed" as const,
                  lastActivityAt: Date.now(),
                }
              : cs,
          )
        : state.chatSessions,
    });
  }, timeout);
  set({ _safetyTimer: timer });
}

/**
 * Extend the safety timer to 10 minutes for tool approval waits.
 * During approval, the agent loop is blocked waiting for user input,
 * so we give much more time before declaring a timeout.
 */
export function extendSafetyTimerForApproval(
  get: () => TimerState,
  set: (partial: Record<string, unknown>) => void,
) {
  // Delegate to resetSafetyTimer with tool-approval mode to ensure consistent behavior
  resetSafetyTimer(get, set, "tool-approval");
}
