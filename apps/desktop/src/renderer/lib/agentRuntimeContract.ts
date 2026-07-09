/**
 * ============================================================
 * DALAM AGENT RUNTIME CONTRACT — State Machine + Invariants
 * ============================================================
 *
 * Defines explicit agent phases and a pure reducer for state
 * transitions. Enforces invariants with dev-time assertions.
 *
 * Phases:
 *   idle → sending → streaming → tool-waiting-approval →
 *   tool-running → tool-results → (streaming or finalizing)
 *   idle → aborted (from any phase)
 *   finalizing → idle
 *
 * Invariants (dev assertions):
 *   - tool-call status must be "awaiting-approval" before resolution
 *   - tool-result must bind to toolCallId exactly once
 *   - message-end must not clear structures required for tool resolution
 * ============================================================
 */

// ─── Agent Phases ────────────────────────────────────────────

export type AgentPhase =
  | "idle"
  | "sending"
  | "streaming"
  | "streaming-pending-diffs"
  | "tool-waiting-approval"
  | "tool-running"
  | "tool-retrying"
  | "tool-timed-out"
  | "tool-results"
  | "finalizing"
  | "aborted";

// ─── Agent Events ────────────────────────────────────────────

export type AgentEvent =
  | { type: "SEND_PROMPT"; sessionId: string }
  | { type: "STREAM_START"; messageId: string }
  | { type: "TOOL_CALL"; toolCallId: string; toolName: string }
  | { type: "TOOL_APPROVAL_REQUESTED"; toolCallId: string }
  | { type: "TOOL_APPROVED"; toolCallId: string }
  | { type: "TOOL_DENIED"; toolCallId: string }
  | { type: "TOOL_RUNNING"; toolCallId: string }
  | { type: "TOOL_RESULT_RECEIVED"; toolCallId: string; success: boolean }
  | { type: "TOOL_TIMEOUT"; toolCallId: string }
  | { type: "TOOL_RETRY"; toolCallId: string; attempt: number }
  | { type: "STREAM_MESSAGE_END"; messageId: string; hasMoreTools: boolean }
  | { type: "DIFF_RESOLVED"; diffId: string }
  | { type: "FINALIZING"; messageId: string }
  | { type: "ABORT"; sessionId: string }
  | { type: "ERROR"; sessionId: string; error: string }
  | { type: "COMPLETE"; sessionId: string };

// ─── Phase Transitions ───────────────────────────────────────

/**
 * Valid phase transitions defined as a map.
 * Each phase lists which events are valid and the resulting phase.
 */
const PHASE_TRANSITIONS: Record<AgentPhase, Record<string, AgentPhase>> = {
  idle: {
    STREAM_START: "streaming", // Direct stream start (matches actual event flow)
    SEND_PROMPT: "sending",
    ERROR: "idle",
    ABORT: "aborted",
  },
  sending: {
    STREAM_START: "streaming",
    ERROR: "idle",
    ABORT: "aborted",
  },
  streaming: {
    STREAM_START: "streaming", // Multi-turn agent loop: new stream after tool results
    TOOL_CALL: "streaming",
    TOOL_APPROVAL_REQUESTED: "tool-waiting-approval",
    STREAM_MESSAGE_END: "streaming", // Reducer may override to streaming-pending-diffs via phase assignment
    FINALIZING: "finalizing",
    ERROR: "idle",
    ABORT: "aborted",
  },
  "streaming-pending-diffs": {
    DIFF_RESOLVED: "streaming-pending-diffs", // Reducer may override to idle when no remaining diffs
    STREAM_START: "streaming",
    TOOL_CALL: "streaming",
    TOOL_APPROVAL_REQUESTED: "tool-waiting-approval",
    FINALIZING: "finalizing",
    ERROR: "idle",
    ABORT: "aborted",
  },
  "tool-waiting-approval": {
    // STREAM_START intentionally omitted here — during tool approval the agent
    // loop is paused for user input, so a new stream shouldn't arrive. If it
    // does (race condition), it's better to drop and log than silently accept.
    TOOL_APPROVED: "tool-running",
    TOOL_DENIED: "tool-results",
    TOOL_RESULT_RECEIVED: "tool-results",
    ERROR: "idle",
    ABORT: "aborted",
  },
  "tool-running": {
    TOOL_RESULT_RECEIVED: "tool-results",
    TOOL_TIMEOUT: "tool-timed-out",
    TOOL_RETRY: "tool-retrying",
    ERROR: "idle",
    ABORT: "aborted",
  },
  "tool-retrying": {
    TOOL_RUNNING: "tool-running",
    TOOL_RESULT_RECEIVED: "tool-results",
    TOOL_TIMEOUT: "tool-timed-out",
    TOOL_RETRY: "tool-retrying",
    ERROR: "idle",
    ABORT: "aborted",
  },
  "tool-timed-out": {
    TOOL_RETRY: "tool-retrying",
    STREAM_MESSAGE_END: "idle",
    ERROR: "idle",
    ABORT: "aborted",
  },
  "tool-results": {
    STREAM_START: "streaming", // New stream after processing tool results
    TOOL_CALL: "streaming",
    TOOL_APPROVAL_REQUESTED: "tool-waiting-approval",
    STREAM_MESSAGE_END: "streaming",
    FINALIZING: "finalizing",
    ERROR: "idle",
    ABORT: "aborted",
  },
  finalizing: {
    COMPLETE: "idle",
    ABORT: "aborted",
    ERROR: "idle",
  },
  aborted: {
    STREAM_START: "streaming", // Can restart after abort
    SEND_PROMPT: "sending",
    COMPLETE: "idle",
  },
};

// ─── Agent State ─────────────────────────────────────────────

export interface AgentRuntimeState {
  phase: AgentPhase;
  sessionId: string | null;
  currentMessageId: string | null;
  pendingToolCallIds: Set<string>;
  resolvedToolCallIds: Set<string>;
  /** Map from toolCallId to its current status */
  toolCallStatuses: Map<string, ToolCallStatus>;
  /** Map from diffId to toolCallId for deterministic binding */
  diffToToolCall: Map<string, string>;
  /** Tool call IDs that have pending diffs awaiting resolution */
  pendingDiffToolCalls: string[];
  /** Debug log of phase transitions */
  transitionLog: PhaseTransitionLogEntry[];
}

export type ToolCallStatus =
  | "pending"
  | "awaiting-approval"
  | "approved"
  | "denied"
  | "running"
  | "completed"
  | "error";

export interface PhaseTransitionLogEntry {
  timestamp: number;
  from: AgentPhase;
  to: AgentPhase;
  event: string;
  sessionId: string;
  messageId?: string;
  toolCallId?: string;
}

// ─── Initial State ───────────────────────────────────────────

export function createInitialRuntimeState(): AgentRuntimeState {
  return {
    phase: "idle",
    sessionId: null,
    currentMessageId: null,
    pendingToolCallIds: new Set(),
    resolvedToolCallIds: new Set(),
    toolCallStatuses: new Map(),
    diffToToolCall: new Map(),
    pendingDiffToolCalls: [],
    transitionLog: [],
  };
}

// ─── Reducer ─────────────────────────────────────────────────

/**
 * Pure reducer for agent state transitions.
 * Does NOT modify state in place — returns a new state object.
 *
 * Enforces invariants:
 *   - Cannot transition to invalid phase from current phase
 *   - tool-call must be awaiting-approval before resolution
 *   - tool-result must bind to an existing pending toolCallId
 *   - message-end must not clear pending tool calls with diffs attached
 */
export function agentReducer(
  state: AgentRuntimeState,
  event: AgentEvent,
  options: { debug?: boolean } = {},
): AgentRuntimeState {
  const { debug = false } = options;

  // Validate transition
  const allowedTransitions = PHASE_TRANSITIONS[state.phase];
  const nextPhase = allowedTransitions?.[event.type];

  if (!nextPhase) {
    if (typeof import.meta !== "undefined" && import.meta.env?.DEV) {
      console.warn(
        `[AgentRuntime] Invalid transition: ${state.phase} → ${event.type}`,
      );
    }
    return state; // No-op for invalid transitions
  }

  // Build new state
  const newState: AgentRuntimeState = {
    ...state,
    phase: nextPhase,
    pendingToolCallIds: new Set(state.pendingToolCallIds),
    resolvedToolCallIds: new Set(state.resolvedToolCallIds),
    toolCallStatuses: new Map(state.toolCallStatuses),
    diffToToolCall: new Map(state.diffToToolCall),
    pendingDiffToolCalls: [...state.pendingDiffToolCalls],
    transitionLog: [...state.transitionLog],
  };

  // Apply event-specific logic
  switch (event.type) {
    case "SEND_PROMPT":
      newState.sessionId = event.sessionId;
      newState.currentMessageId = null;
      newState.pendingToolCallIds.clear();
      newState.resolvedToolCallIds.clear();
      newState.toolCallStatuses.clear();
      newState.pendingDiffToolCalls = [];
      break;

    case "STREAM_START":
      newState.currentMessageId = event.messageId;
      break;

    case "TOOL_CALL":
      newState.pendingToolCallIds.add(event.toolCallId);
      newState.toolCallStatuses.set(event.toolCallId, "pending");
      break;

    case "TOOL_APPROVAL_REQUESTED":
      // Invariant: tool call must exist in pending set
      assert(
        newState.pendingToolCallIds.has(event.toolCallId),
        `[AgentRuntime] INVARIANT VIOLATION: toolCallId ${event.toolCallId} not in pending set when requesting approval`,
      );
      newState.toolCallStatuses.set(event.toolCallId, "awaiting-approval");
      break;

    case "TOOL_APPROVED":
      // Invariant: must be awaiting-approval before approval
      assert(
        newState.toolCallStatuses.get(event.toolCallId) === "awaiting-approval",
        `[AgentRuntime] INVARIANT VIOLATION: toolCallId ${event.toolCallId} status is "${newState.toolCallStatuses.get(event.toolCallId)}", expected "awaiting-approval"`,
      );
      newState.toolCallStatuses.set(event.toolCallId, "approved");
      break;

    case "TOOL_DENIED":
      assert(
        newState.toolCallStatuses.get(event.toolCallId) === "awaiting-approval",
        `[AgentRuntime] INVARIANT VIOLATION: denying toolCallId ${event.toolCallId} but status is "${newState.toolCallStatuses.get(event.toolCallId)}"`,
      );
      newState.toolCallStatuses.set(event.toolCallId, "denied");
      newState.resolvedToolCallIds.add(event.toolCallId);
      break;

    case "TOOL_RUNNING":
      assert(
        newState.toolCallStatuses.get(event.toolCallId) === "approved",
        `[AgentRuntime] INVARIANT VIOLATION: running toolCallId ${event.toolCallId} but status is "${newState.toolCallStatuses.get(event.toolCallId)}"`,
      );
      newState.toolCallStatuses.set(event.toolCallId, "running");
      break;

    case "TOOL_RESULT_RECEIVED":
      // Invariant: tool-result must bind to an existing pending toolCallId
      assert(
        newState.pendingToolCallIds.has(event.toolCallId) ||
          newState.toolCallStatuses.has(event.toolCallId),
        `[AgentRuntime] INVARIANT VIOLATION: toolCallId ${event.toolCallId} not in pending set when receiving result`,
      );
      // Invariant: tool-result must bind to toolCallId exactly once
      assert(
        !newState.resolvedToolCallIds.has(event.toolCallId),
        `[AgentRuntime] INVARIANT VIOLATION: toolCallId ${event.toolCallId} already resolved`,
      );
      newState.toolCallStatuses.set(
        event.toolCallId,
        event.success ? "completed" : "error",
      );
      newState.resolvedToolCallIds.add(event.toolCallId);
      break;

    case "TOOL_TIMEOUT":
      assert(
        newState.toolCallStatuses.get(event.toolCallId) === "running",
        `[AgentRuntime] INVARIANT VIOLATION: timeout for toolCallId ${event.toolCallId} but status is "${newState.toolCallStatuses.get(event.toolCallId)}"`,
      );
      newState.toolCallStatuses.set(event.toolCallId, "error");
      break;

    case "TOOL_RETRY":
      assert(
        newState.toolCallStatuses.get(event.toolCallId) === "running" ||
          newState.toolCallStatuses.get(event.toolCallId) === "error" ||
          newState.toolCallStatuses.get(event.toolCallId) === "pending" ||
          newState.toolCallStatuses.get(event.toolCallId) === "approved",
        `[AgentRuntime] INVARIANT VIOLATION: retry for toolCallId ${event.toolCallId} but status is "${newState.toolCallStatuses.get(event.toolCallId)}"`,
      );
      newState.toolCallStatuses.set(event.toolCallId, "pending");
      // Remove from resolved so it can be re-resolved
      newState.resolvedToolCallIds.delete(event.toolCallId);
      break;

    case "STREAM_MESSAGE_END": {
      // Invariant: message-end must not clear tool state required for resolution
      // Tools that have diffs attached must not be cleared
      const toolCallsWithDiffs = new Set(newState.diffToToolCall.values());
      const unresolvedWithDiffs = [...newState.pendingToolCallIds].filter(
        (id) =>
          toolCallsWithDiffs.has(id) && !newState.resolvedToolCallIds.has(id),
      );
      if (unresolvedWithDiffs.length > 0) {
        // Transition to streaming-pending-diffs so the agent is not stuck
        newState.phase = "streaming-pending-diffs";
        newState.pendingDiffToolCalls = unresolvedWithDiffs;
        break;
      }
      // Only clear if no more tools to process
      if (!event.hasMoreTools) {
        newState.currentMessageId = null;
        // Keep diffToToolCall for UI rendering — caller must clear separately
      }
      break;
    }

    case "DIFF_RESOLVED": {
      // Look up the toolCallId associated with this diffId
      const resolvedToolCallId = newState.diffToToolCall.get(event.diffId);
      // Remove the resolved tool call from pending list
      const remaining = resolvedToolCallId
        ? newState.pendingDiffToolCalls.filter(
            (id) => id !== resolvedToolCallId,
          )
        : newState.pendingDiffToolCalls;
      newState.pendingDiffToolCalls = remaining;
      // If all pending diffs resolved, transition back to idle
      if (
        remaining.length === 0 &&
        newState.phase === "streaming-pending-diffs"
      ) {
        newState.phase = "idle";
        newState.currentMessageId = null;
      }
      break;
    }

    case "FINALIZING":
      newState.currentMessageId = event.messageId;
      break;

    case "ABORT":
      newState.sessionId = event.sessionId;
      newState.currentMessageId = null;
      newState.pendingToolCallIds.clear();
      newState.resolvedToolCallIds.clear();
      newState.toolCallStatuses.clear();
      newState.diffToToolCall.clear();
      newState.pendingDiffToolCalls = [];
      break;

    case "COMPLETE":
      newState.sessionId = null;
      newState.currentMessageId = null;
      newState.pendingToolCallIds.clear();
      newState.resolvedToolCallIds.clear();
      newState.toolCallStatuses.clear();
      newState.diffToToolCall.clear();
      newState.pendingDiffToolCalls = [];
      break;
  }

  const MAX_TRANSITION_LOG = 500;

  // Log transition (cap to prevent unbounded growth)
  const sessionIdForLog =
    state.sessionId ??
    ("sessionId" in event ? (event as { sessionId: string }).sessionId : "");
  const messageIdForLog =
    event.type === "STREAM_START" || event.type === "FINALIZING"
      ? (event as { messageId: string }).messageId
      : (state.currentMessageId ?? undefined);
  const toolCallIdForLog =
    "toolCallId" in event
      ? (event as { toolCallId: string }).toolCallId
      : undefined;

  const newLog = [
    ...newState.transitionLog,
    {
      timestamp: Date.now(),
      from: state.phase,
      to: nextPhase,
      event: event.type,
      sessionId: sessionIdForLog,
      messageId: messageIdForLog,
      toolCallId: toolCallIdForLog,
    },
  ];

  // Keep only the last MAX_TRANSITION_LOG entries to prevent memory leak
  if (newLog.length > MAX_TRANSITION_LOG) {
    newLog.splice(0, newLog.length - MAX_TRANSITION_LOG);
  }
  newState.transitionLog = newLog;

  if (debug && import.meta.env.DEV) {
    console.log(
      `[AgentRuntime] ${state.sessionId?.slice(0, 8) ?? "?"} phase: ${state.phase} → ${nextPhase} (event: ${event.type})`,
    );
  }

  return newState;
}

// ─── Helper Functions ───────────────────────────────────────

/**
 * Assert a condition in development mode only.
 * Uses `import.meta.env.DEV` for Vite/Tauri compatibility (the project-wide
 * convention). In test environments, throws an Error to make invariants
 * testable. No-ops in production builds.
 */
function assert(condition: boolean, message: string): void {
  if (!condition) {
    const isDev = typeof import.meta !== "undefined" && import.meta.env?.DEV;
    const isTest = typeof process !== "undefined" && process.env?.VITEST;
    if (isDev || isTest) {
      throw new Error(`[AgentRuntimeContract] ${message}`);
    }
    console.warn(`[AgentRuntimeContract] ${message}`);
  }
}

/**
 * Get the current phase for display/debug purposes.
 */
export function getPhaseLabel(phase: AgentPhase): string {
  const labels: Record<AgentPhase, string> = {
    idle: "Idle",
    sending: "Sending…",
    streaming: "Streaming",
    "streaming-pending-diffs": "Waiting for diffs",
    "tool-waiting-approval": "Waiting for approval",
    "tool-running": "Executing tool",
    "tool-retrying": "Retrying tool",
    "tool-timed-out": "Tool timed out",
    "tool-results": "Processing results",
    finalizing: "Finalizing",
    aborted: "Aborted",
  };
  return labels[phase];
}

/**
 * Check if the agent is in a phase where it can accept new input.
 */
export function canAcceptInput(phase: AgentPhase): boolean {
  return phase === "idle" || phase === "aborted";
}

/**
 * Check if the agent is currently busy (streaming or executing tools).
 */
export function isBusy(phase: AgentPhase): boolean {
  return !canAcceptInput(phase);
}

/**
 * Get all pending (unresolved) tool call IDs from state.
 */
export function getPendingToolCalls(state: AgentRuntimeState): string[] {
  return [...state.pendingToolCallIds].filter(
    (id) => !state.resolvedToolCallIds.has(id),
  );
}

/**
 * Get the count of pending tool calls that still need user approval.
 */
export function getPendingApprovalCount(state: AgentRuntimeState): number {
  return [...state.toolCallStatuses.entries()].filter(
    ([id, status]) =>
      status === "awaiting-approval" && !state.resolvedToolCallIds.has(id),
  ).length;
}

/**
 * Get the count of tool calls waiting to execute (approved but not yet running).
 */
export function getPendingExecutionCount(state: AgentRuntimeState): number {
  return [...state.toolCallStatuses.entries()].filter(
    ([id, status]) =>
      status === "approved" && !state.resolvedToolCallIds.has(id),
  ).length;
}
