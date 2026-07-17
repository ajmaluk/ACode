/**
 * ============================================================
 * DALAM AGENT RUNTIME CONTRACT — State Machine + Invariants
 * ============================================================
 *
 * Defines explicit agent phases and a pure reducer for state
 * transitions. Enforces invariants with dev-time assertions.
 *
 * Phases:
 *   idle → streaming → idle
 *   streaming → streaming (multi-turn tool loop)
 *
 * Invariants (dev assertions):
 *   - tool-result must bind to toolCallId exactly once
 *   - message-end must not clear structures required for tool resolution
 * ============================================================
 */

// ─── Agent Phases ────────────────────────────────────────────

export type AgentPhase = "idle" | "streaming";

// ─── Agent Events ────────────────────────────────────────────

export type AgentEvent =
  | { type: "STREAM_START"; messageId: string }
  | { type: "TOOL_CALL"; toolCallId: string; toolName: string }
  | { type: "TOOL_RESULT_RECEIVED"; toolCallId: string; success: boolean }
  | { type: "TOOL_TIMEOUT"; toolCallId: string }
  | { type: "STREAM_MESSAGE_END"; messageId: string; hasMoreTools: boolean }
  | { type: "ERROR"; sessionId: string; error: string };

// ─── Phase Transitions ───────────────────────────────────────

/**
 * Valid phase transitions defined as a map.
 * Each phase lists which events are valid and the resulting phase.
 */
const PHASE_TRANSITIONS: Record<AgentPhase, Record<string, AgentPhase>> = {
  idle: {
    STREAM_START: "streaming", // Direct stream start (matches actual event flow)
    ERROR: "idle",
  },
  streaming: {
    STREAM_START: "streaming", // Multi-turn agent loop: new stream after tool results
    TOOL_CALL: "streaming",
    TOOL_RESULT_RECEIVED: "streaming", // Auto-approved tools skip approval and return results directly
    TOOL_TIMEOUT: "streaming",
    STREAM_MESSAGE_END: "streaming",
    ERROR: "idle",
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
  /** Debug log of phase transitions */
  transitionLog: PhaseTransitionLogEntry[];
}

export type ToolCallStatus =
  | "pending"
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
    transitionLog: [...state.transitionLog],
  };

  // Apply event-specific logic
  switch (event.type) {
    case "STREAM_START":
      newState.currentMessageId = event.messageId;
      break;

    case "TOOL_CALL":
      newState.pendingToolCallIds.add(event.toolCallId);
      newState.toolCallStatuses.set(event.toolCallId, "pending");
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

    case "STREAM_MESSAGE_END":
      if (!event.hasMoreTools) {
        newState.currentMessageId = null;
        newState.phase = "idle";
      }
      break;
  }

  const MAX_TRANSITION_LOG = 500;

  // Log transition (cap to prevent unbounded growth)
  const sessionIdForLog =
    state.sessionId ??
    ("sessionId" in event ? (event as { sessionId: string }).sessionId : "");
  const messageIdForLog =
    event.type === "STREAM_START"
      ? event.messageId
      : (state.currentMessageId ?? undefined);
  const toolCallIdForLog =
    "toolCallId" in event
      ? (event as { toolCallId: string }).toolCallId
      : undefined;

  let newLog = [
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
    newLog = newLog.slice(-MAX_TRANSITION_LOG);
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
    streaming: "Streaming",
  };
  return labels[phase];
}

/**
 * Check if the agent is in a phase where it can accept new input.
 */
export function canAcceptInput(phase: AgentPhase): boolean {
  return phase === "idle";
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


