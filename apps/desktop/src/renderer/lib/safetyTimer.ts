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

export const SAFETY_TIMEOUT_MS = 120_000;
export const TOOL_APPROVAL_TIMEOUT_MS = 600_000;

/**
 * Minimal interface matching the subset of ChatState that the timer needs.
 * Avoids circular imports with useAppStore.
 */
interface TimerState {
  isStreaming: boolean;
  _sendInProgress: boolean;
  _safetyTimer: ReturnType<typeof setTimeout> | null;
  streamingContent: string;
  thinkingContent: string;
  activeSessionId: string | null;
  session: { id: string } | null;
  messages: ChatMessage[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pendingToolCalls: any[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pendingActivities: any[];
  chatSessions: ChatSessionSummary[];
}

/**
 * Reset the safety timer to 120s. Clears any existing timer first.
 * Called on every stream event to keep the agent loop alive.
 */
export function resetSafetyTimer(
  get: () => TimerState,
  set: (partial: Record<string, unknown>) => void,
) {
  const existing = get()._safetyTimer;
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    const state = get();
    if (!state.isStreaming) return;
    console.warn("[Chat] Safety timeout triggered — no stream events for 120s");
    const api = createDalamAPI();
    const sid = state.activeSessionId;
    if (sid) api.agent.cleanupStream(sid);
    const systemMsg: ChatMessage = {
      id: "msg-" + Math.random().toString(36).slice(2, 9),
      role: "system",
      content:
        "Stream timed out after 120 seconds of inactivity. The agent may have encountered an issue.",
      timestamp: Date.now(),
    };
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
              ? { ...cs, status: "completed" as const, lastActivityAt: Date.now() }
              : cs,
          )
        : state.chatSessions,
    });
  }, SAFETY_TIMEOUT_MS);
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
  const existing = get()._safetyTimer;
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    const state = get();
    if (!state.isStreaming) return;
    console.warn(
      "[Chat] Safety timeout triggered during tool approval — no events for 10min",
    );
    const api = createDalamAPI();
    const sid = state.activeSessionId;
    if (sid) api.agent.cleanupStream(sid);
    const systemMsg: ChatMessage = {
      id: "msg-" + Math.random().toString(36).slice(2, 9),
      role: "system",
      content:
        "Agent loop timed out — no activity for 10 minutes during tool approval.",
      timestamp: Date.now(),
    };
    set({
      isStreaming: false,
      _sendInProgress: false,
      streamingContent: "",
      thinkingContent: "",
      pendingToolCalls: [],
      pendingActivities: [],
      _safetyTimer: null,
      messages: [...state.messages, systemMsg],
    });
  }, TOOL_APPROVAL_TIMEOUT_MS);
  set({ _safetyTimer: timer });
}
