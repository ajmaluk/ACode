import { create } from "zustand";
import { logPermission } from "../lib/security";
import type {
  AgentSession, ChatMessage,
  ChatSessionSummary, FileAttachment, FileChange,
  PrimaryAgentName,
  StreamEvent, TerminalTab, TodoItem, ToolCall
} from "@dalam/shared-types";
import { createDalamAPI } from "@/lib/dalamAPI";
import type { SubAgentState } from "@dalam/shared-types";
import { startRecording, stopRecording, recordUserMessage, recordAssistantMessage } from "@/lib/trajectoryRecorder";
import { basename, joinPath } from "@/lib/pathUtils";
import { canonicaliseBashCommand } from "@/lib/agents";

import { computeContextStats, selectMessagesForCompaction, pruneToolOutputs, tier1PruneToolOutputs, buildCompactionPrompt, parseContextWindow, CTX } from "@/lib/contextManager";
import { agentReducer, createInitialRuntimeState, type AgentRuntimeState } from "@/lib/agentRuntimeContract";
import { parseXmlToolCalls, stripInlineXml, resetStreamingState, EDIT_TOOLS, BASH_TOOLS, READ_TOOLS } from "./xmlParser";
import { 
  savePersistedSessionSummaries, savePersistedMessages, savePersistedMessagesImmediate,
  savePersistedAgents, savePersistedVersions, savePersistedCompactionSummaries,
  loadPersistedSessionSummaries, loadPersistedMessages, loadPersistedAgents,
  loadPersistedVersions, loadPersistedCompactionSummaries, initWorkspaceMemory
} from "./persistence";
import { _toolCallResolvers, _pendingResolutions } from "./usePermission";
import { useSettings } from "./useSettings";
import { useModelProviders } from "./useModelProviders";
import { useDiffView } from "./useDiffView";
import { useWorkspace, saveWorkspaceData } from "./useWorkspace";
import { useAgents } from "./useAgents";
import { usePermission } from "./usePermission";
import { useQuestion } from "./useQuestion";
import { useTerminal } from "./useTerminal";
import { useUI } from "./useUI";

import { useToasts } from "@/components/ui/toastStore";

const devWarn = import.meta.env.DEV
  ? (...args: unknown[]) => console.warn(...args)
  : () => {};

function pushErrorToast(title: string, description: string) {
  try { useToasts.getState().push({ kind: "error", title, description, durationMs: 8000 }); } catch {}
}

function pushWarningToast(title: string, description: string) {
  try { useToasts.getState().push({ kind: "warning", title, description, durationMs: 8000 }); } catch {}
}

// Compaction throttle: avoid redundant computeContextStats + summarization calls
const _lastCompactionAttempt: Record<string, number> = {};
const COMPACTION_THROTTLE_MS = 30_000;
const COMPACTION_MIN_MESSAGES = 10;

// Two-tier compaction tracking (Hermes pre-emptive pattern)
// Tier 1: lightweight tool output pruning at 50% context usage (no LLM)
// Tier 2: full LLM summarization at 85% context usage
const _compactionTier: Record<string, number> = {}; // sessionId → last tier applied (0 = none, 1 = pruned, 2 = compacted)

// Anti-thrashing: track compaction effectiveness to skip ineffective compactions.
// Inspired by Hermes' ineffective compression detection: if savings are below
// a minimum threshold, skip future compactions for this session temporarily.
// Negative = ineffective (abs = original msg count); positive = compacted msg count
const _lastCompactionCounts: Record<string, number> = {};
const COMPACTION_MIN_SAVINGS_PERCENT = 5; // Minimum 5% reduction to consider compaction effective
const ANTI_THRASH_SKIP_MS = 60_000; // Skip compaction for 60s after ineffective attempt
const _antiThrashTimestamps: Record<string, number> = {}; // sessionId → timestamp of last skip
const MAX_COMPACTION_MAP_ENTRIES = 50; // Cap to prevent unbounded growth

function _pruneCompactionMaps(sessionId: string) {
  // Only prune when a new session is added that pushes us over the cap
  const count = Object.keys(_lastCompactionAttempt).length;
  if (count <= MAX_COMPACTION_MAP_ENTRIES) return;
  // Find and remove the oldest entry (smallest timestamp)
  let oldestKey = "";
  let oldestTime = Infinity;
  for (const [key, time] of Object.entries(_lastCompactionAttempt)) {
    if (time < oldestTime) { oldestTime = time; oldestKey = key; }
  }
  if (oldestKey && oldestKey !== sessionId) {
    delete _lastCompactionAttempt[oldestKey];
    delete _compactionTier[oldestKey];
    delete _lastCompactionCounts[oldestKey];
    delete _antiThrashTimestamps[oldestKey];
  }
}

// ============================================================================
// Safety Timer Helper — eliminates 3× duplicated timer logic in sendMessage/appendStream
// ============================================================================
const SAFETY_TIMEOUT_MS = 300_000;
const TOOL_APPROVAL_TIMEOUT_MS = 600_000; // 10 min during tool approval
const CUMULATIVE_STREAM_TIMEOUT_MS = 1_800_000; // 30 min cumulative
const CUMULATIVE_WARNING_MS = 1_500_000; // Warning at 25 min

function _createSafetyTimer(
  get: () => ChatState,
  set: (partial: Partial<ChatState> | ((s: ChatState) => Partial<ChatState>)) => void,
  mode: "normal" | "turn" | "tool-approval" = "normal"
): ReturnType<typeof setTimeout> {
  const timeout = mode === "tool-approval" ? TOOL_APPROVAL_TIMEOUT_MS : SAFETY_TIMEOUT_MS;
  return setTimeout(() => {
    const state = get();
    if (!state.isStreaming) return;
    pushErrorToast("Stream timed out", `No activity for ${timeout / 1000}s. The agent may have encountered an issue.`);
    devWarn(`[Chat] Safety timeout triggered (${mode}) — no stream events for ${timeout / 1000}s`);
    const api = createDalamAPI();
    const sid = state.activeSessionId;
    if (sid) api.agent.cleanupStream(sid);
    const systemMsg: ChatMessage = {
      id: "msg-" + crypto.randomUUID(),
      role: "system",
      content: mode === "tool-approval"
        ? "Agent loop timed out — no activity for 10 minutes during tool approval."
        : "Stream timed out after 300 seconds of inactivity. The agent may have encountered an issue.",
      timestamp: Date.now(),
    };
    // Clear any pending auto-remove timers to prevent orphaned callbacks
    get()._autoRemoveTimers.forEach((t) => clearTimeout(t));
    const activeSessionId = state.session?.id;
    const updatedSessions = activeSessionId
      ? state.chatSessions.map((cs) =>
          cs.id === activeSessionId
            ? { ...cs, status: "completed" as const, lastActivityAt: Date.now(), lastVisitedAt: Date.now() }
            : cs
        )
      : state.chatSessions;
    const updatedSessionMessages = sid
      ? { ...state.sessionMessages, [sid]: [...(state.sessionMessages[sid] ?? []), systemMsg] }
      : state.sessionMessages;
    set({
      isStreaming: false,
      streamingStartedAt: null,
      _sendInProgress: false,
      _autoRemoveTimers: new Set<ReturnType<typeof setTimeout>>(),
      streamingContent: "",
      thinkingContent: "",
      pendingToolCalls: [],
      pendingActivities: [],
      _safetyTimer: null,
      _pendingChanges: [],
      messages: [...state.messages, systemMsg],
      chatSessions: updatedSessions,
      sessionMessages: updatedSessionMessages,
    });
    savePersistedSessionSummaries(updatedSessions);
    savePersistedMessages(updatedSessionMessages);
  }, timeout);
}

// ============================================================================
// Doom Loop / Death Spiral Detection (inspired by Hermes ToolCallGuardrailController)
// Warns at doomLoopThreshold (configurable in Settings > General),
// hard-stops at 2× that value.
// ============================================================================
const DOOM_LOOP_THRESHOLD = 5; // fallback default if setting is unset
interface ToolCallRecord { name: string; args: string; }
const _toolCallHistory: Record<string, ToolCallRecord[]> = {};
const _toolFailureCounts: Record<string, Record<string, number>> = {};

// ============================================================================
// Context Overflow Detection (matches OpenCode's comprehensive patterns)
// ============================================================================
const CONTEXT_OVERFLOW_PATTERNS = [
  // OpenCode's patterns (from provider-error.ts)
  /prompt is too long/i,
  /input is too long for requested model/i,
  /exceeds the context window/i,
  /input token count.*exceeds the maximum/i,
  /tokens in request more than max tokens allowed/i,
  /maximum prompt length is \d+/i,
  /reduce the length of the messages/i,
  /maximum context length is \d+ tokens/i,
  /exceeds the limit of \d+/i,
  /exceeds the available context size/i,
  /greater than the context length/i,
  /context window exceeds limit/i,
  /exceeded model token limit/i,
  /context[_ ]length[_ ]exceeded/i,
  /request entity too large/i,
  /context length is only \d+ tokens/i,
  /input length.*exceeds.*context length/i,
  /prompt too long; exceeded (?:max )?context length/i,
  /too large for model with \d+ maximum context length/i,
  /model_context_window_exceeded/i,
  // Additional patterns
  /context[_ ]window/i,
  /prompt[_ ]is[_ ]too[_ ]long/i,
  /request[_ ]too[_ ]large/i,
  /content[_ ]too[_ ]large/i,
  /tokens[_ ]exceed/i,
  /input[_ ]is[_ ]too[_ ]long/i,
  /context[_ ]overflow/i,
  /max[_ ]context[_ ]tokens/i,
  /number[_ ]of[_ ]tokens.*exceed/i,
  /this[_ ]model.*maximum.*context/i,
  // HTTP 400/413 with no body (OpenCode pattern)
  /^4(00|13)\s*(status code)?\s*\(no body\)/i,
];

function _isContextOverflowError(errorMsg: string): boolean {
  return CONTEXT_OVERFLOW_PATTERNS.some((p) => p.test(errorMsg));
}

// ============================================================================
// Doom Loop Detection (must be declared AFTER _contextOverflowRetries/_contextBudgetFactor)
// ============================================================================

type DoomLoopResult = { message: string; severity: "warn" | "halt" };

const MAX_SESSIONS_IN_DOOM_MAPS = 20;
const _sessionRecency = new Map<string, true>();
function _touchDoomLoopSession(sessionId: string) {
  _sessionRecency.delete(sessionId);
  _sessionRecency.set(sessionId, true);
}
function _pruneDoomLoopMaps() {
  if (_sessionRecency.size <= MAX_SESSIONS_IN_DOOM_MAPS) return;
  const toRemove = _sessionRecency.size - MAX_SESSIONS_IN_DOOM_MAPS;
  const it = _sessionRecency.keys();
  for (let i = 0; i < toRemove; i++) {
    const next = it.next();
    if (next.done) break;
    const id = next.value;
    _sessionRecency.delete(id);
    delete _toolCallHistory[id];
    delete _toolFailureCounts[id];
  }
}

function _checkDoomLoop(sessionId: string, toolName: string, toolArgs: Record<string, unknown>): DoomLoopResult | null {
  const sig = `${toolName}:${JSON.stringify(toolArgs, Object.keys(toolArgs).sort())}`;
  _touchDoomLoopSession(sessionId);
  _pruneDoomLoopMaps();
  const failures = { ...(_toolFailureCounts[sessionId] ?? {}) };
  const currentCount = (failures[sig] ?? 0) + 1;
  failures[sig] = currentCount;
  // Cap to prevent unbounded growth
  const keys = Object.keys(failures);
  if (keys.length > 100) {
    const toRemove = keys.slice(0, keys.length - 50);
    for (const k of toRemove) delete failures[k];
  }
  _toolFailureCounts[sessionId] = failures;
  // Read threshold from user settings (configurable in Settings > General)
  const threshold = useSettings.getState().settings.doomLoopThreshold ?? DOOM_LOOP_THRESHOLD;
  const haltThreshold = threshold * 2;
  if (currentCount >= haltThreshold) {
    return { message: `Doom loop HALTED: tool "${toolName}" has failed ${currentCount} times consecutively with identical arguments. The agentic loop has been stopped.`, severity: "halt" };
  }
  if (currentCount >= threshold) {
    return { message: `Doom loop detected: tool "${toolName}" has failed ${currentCount} times consecutively with identical arguments. The agent appears stuck in a death spiral.`, severity: "warn" };
  }
  return null;
}

function _recordToolFailure(sessionId: string, toolName: string, toolArgs: Record<string, unknown>) {
  // Touch this session's recency slot BEFORE pruning
  _touchDoomLoopSession(sessionId);
  _pruneDoomLoopMaps();
  const history = [...(_toolCallHistory[sessionId] ?? [])];
  history.push({ name: toolName, args: JSON.stringify(toolArgs, Object.keys(toolArgs).sort()) });
  _toolCallHistory[sessionId] = history.slice(-50);
}

function _clearToolFailure(sessionId: string, toolName: string, toolArgs: Record<string, unknown>) {
  const sig = `${toolName}:${JSON.stringify(toolArgs, Object.keys(toolArgs).sort())}`;
  const failures = { ...(_toolFailureCounts[sessionId] ?? {}) };
  delete failures[sig];
  _toolFailureCounts[sessionId] = failures;
}

function _clearDoomLoopState(sessionId: string) {
  delete _toolCallHistory[sessionId];
  delete _toolFailureCounts[sessionId];
  _sessionRecency.delete(sessionId);
  delete _contextOverflowRetries[sessionId];
  delete _contextBudgetFactor[sessionId];
}

const _contextOverflowRetries: Record<string, number> = {};
const MAX_CONTEXT_OVERFLOW_RETRIES = 2;

// Context budget factor: reduced on each overflow retry to prevent infinite loops.
// Starts at 1.0 (full budget) and is reduced by CONTEXT_BUDGET_REDUCTION_PER_RETRY on each retry.
// Floors at MIN_CONTEXT_BUDGET_FACTOR to leave some minimal context for the model.
const _contextBudgetFactor: Record<string, number> = {};
const CONTEXT_BUDGET_REDUCTION_PER_RETRY = 0.2; // 20% reduction per retry
const MIN_CONTEXT_BUDGET_FACTOR = 0.3;

function _reduceContextBudget(sessionId: string): void {
  const current = _contextBudgetFactor[sessionId] ?? 1.0;
  _contextBudgetFactor[sessionId] = Math.max(MIN_CONTEXT_BUDGET_FACTOR, current - CONTEXT_BUDGET_REDUCTION_PER_RETRY);
}

function _clearContextOverflowRetries(sessionId: string) {
  delete _contextOverflowRetries[sessionId];
  delete _contextBudgetFactor[sessionId];
}

/**
 * Shared context overflow retry logic.
 * Returns true if retry was initiated, false otherwise.
 */
function _handleContextOverflowRetry(sessionId: string): boolean {
  const retryCount = _contextOverflowRetries[sessionId] ?? 0;
  if (retryCount >= MAX_CONTEXT_OVERFLOW_RETRIES) {
    delete _contextOverflowRetries[sessionId];
    // Surface actionable error instead of silent failure
    const errorMsg: ChatMessage = {
      id: "sys-" + crypto.randomUUID(),
      role: "system",
      content: `Context window overflow after ${MAX_CONTEXT_OVERFLOW_RETRIES} retries. Try starting a new session or using /compact manually.`,
      timestamp: Date.now(),
    };
    const store = useChat.getState();
    useChat.setState({ messages: [...store.messages, errorMsg], _sendInProgress: false });
    return false;
  }
  _contextOverflowRetries[sessionId] = retryCount + 1;
  // Reduce context budget on each retry to break overflow loops
  _reduceContextBudget(sessionId);
  const store = useChat.getState();
  const infoMsg: ChatMessage = { id: "sys-" + crypto.randomUUID(), role: "system", content: `Context window exceeded. Reducing budget and retrying... (attempt ${retryCount + 1}/${MAX_CONTEXT_OVERFLOW_RETRIES})`, timestamp: Date.now() };
  const infoSM = { ...store.sessionMessages, [sessionId]: [...(store.sessionMessages[sessionId] ?? []), infoMsg] };
  useChat.setState({ messages: [...store.messages, infoMsg], sessionMessages: infoSM });
  savePersistedMessages(infoSM);
  const lastUserMsg = [...store.messages].reverse().find((m) => m.role === "user");
  if (!lastUserMsg) return false;
  devWarn(`[Chat] Context overflow in session - compacting and retrying (attempt ${retryCount + 1}/${MAX_CONTEXT_OVERFLOW_RETRIES})`);

  // Check context before compaction
  const statsBefore = computeContextStats(store.messages);

  void store.compactSessionHistory(sessionId).then(() => {
    try {
    // Verify compaction was effective
    const currentStore = useChat.getState();
    const statsAfter = computeContextStats(currentStore.messages);
    const tokensReclaimed = statsBefore.totalTokens - statsAfter.totalTokens;

    if (tokensReclaimed < 1000) {
      // Compaction didn't reclaim enough — don't retry
      const failMsg: ChatMessage = {
        id: "sys-" + crypto.randomUUID(),
        role: "system",
        content: `Context overflow: compaction only reclaimed ${tokensReclaimed} tokens. Consider starting a new session.`,
        timestamp: Date.now(),
      };
      useChat.setState((s) => ({
        messages: [...s.messages, failMsg],
        isStreaming: false, streamingStartedAt: null, _sendInProgress: false, streamingContent: "", thinkingContent: "", pendingToolCalls: [], pendingActivities: [],
      }));
      return;
    }

    useChat.setState((s) => {
      const sid = s.activeSessionId;
      const result: Partial<ChatState> = { isStreaming: false, streamingStartedAt: null, _sendInProgress: false, streamingContent: "", thinkingContent: "", pendingToolCalls: [], pendingActivities: [] };
      if (sid) {
        const msgIds = new Set(s.messages.map((m) => m.id));
        result.sessionMessages = { ...s.sessionMessages, [sid]: (s.sessionMessages[sid] ?? []).filter((m) => msgIds.has(m.id)) };
      }
      return result;
    });
    const retryMsg = [...useChat.getState().messages].reverse().find((m) => m.role === "user");
    if (retryMsg) {
      const retrySid = sessionId;
      // Capture streaming content at time of check for race-free comparison
      const snapshotStreamingContent = useChat.getState().streamingContent;
      // Only auto-retry if user hasn't already manually retried (prevents double-send)
      setTimeout(() => {
        const state = useChat.getState();
        if (state.activeSessionId !== retrySid) return; // Session switched
        if (state._sendInProgress) return; // User already retried manually
        if (state.isStreaming) return; // Already streaming
        if (state.streamingContent !== snapshotStreamingContent) return; // Content changed
        void useChat.getState().sendMessage(retryMsg.content);
      }, 500);
    } else {
      const sysMsg: ChatMessage = {
        id: "sys-" + crypto.randomUUID(),
        role: "system",
        content: "Context compaction removed all messages. Please resend your request.",
        timestamp: Date.now(),
      };
      useChat.setState((s) => ({
        messages: [...s.messages, sysMsg],
        _sendInProgress: false,
      }));
    }
    } catch (thenErr) {
      devWarn("[Chat] Context overflow retry handler failed:", thenErr);
      useChat.setState({ isStreaming: false, streamingStartedAt: null, streamingContent: "", thinkingContent: "", pendingToolCalls: [], pendingActivities: [], _sendInProgress: false });
    }
  }).catch((compactErr) => {
    devWarn("[Chat] Compaction failed:", compactErr);
    useChat.setState({ isStreaming: false, streamingStartedAt: null, streamingContent: "", thinkingContent: "", pendingToolCalls: [], pendingActivities: [], _sendInProgress: false });
  });
  return true;
}

// Message queue retry tracking: prevent infinite re-enqueue when streaming never ends
const _messageQueueRetries = new Map<string, number>();

// Persist terminal state keyed by session ID (proper Map, not single cache)
const _terminalStateCache = new Map<string, { tabs: TerminalTab[]; activeTabId: string | null }>();
const MAX_TERMINAL_CACHE_SIZE = 20;
function _pruneTerminalCache(newSessionId: string) {
  if (_terminalStateCache.size < MAX_TERMINAL_CACHE_SIZE) return;
  if (_terminalStateCache.has(newSessionId)) return; // Don't prune just-used session
  const firstKey = _terminalStateCache.keys().next().value;
  if (firstKey !== undefined) _terminalStateCache.delete(firstKey);
}

export type TodoStatus = TodoItem["status"];

type TaskPlanItem = {
  id: string;
  title: string;
  status: "pending" | "running" | "completed" | "failed";
};

type PermissionKind = "bash" | "edit" | "mcp" | "read";

type ChatState = {
  session: AgentSession | null;
  messages: ChatMessage[];
  pendingToolCalls: import("@dalam/shared-types").ToolCall[];
  pendingActivities: import("@dalam/shared-types").PendingActivity[];
  streamingContent: string;
  thinkingContent: string;
  isStreaming: boolean;
  /** Timestamp (ms) when the current streaming response started. Used by WorkingTimer. */
  streamingStartedAt: number | null;
  activeAgentName: PrimaryAgentName;
  selectedModelId: string;
  todos: TodoItem[];
  taskPlan: TaskPlanItem[] | null;
  taskPlanSummary: string | null;
  _pendingChanges: FileChange[];
  chatHistory: import("@dalam/shared-types").ChatMessage[][];
  chatHistoryIdx: number;
  chatSessions: ChatSessionSummary[];
  activeSessionId: string | null;
  sessionMessages: Record<string, ChatMessage[]>;
  sessionAgentName: Record<string, PrimaryAgentName>;
  planApproval: { planContent: string; status: "pending" | "approved" | "rejected" } | null;
  sessionVersions: Record<string, import("@dalam/shared-types").ChatVersion[]>;
  restoredVersionId: string | null;
  preRestoreMessages: import("@dalam/shared-types").ChatMessage[] | null;
  pendingAttachments: FileAttachment[];
  /** Message queue — follow-up messages waiting to be sent */
  messageQueue: Array<{ id: string; content: string; attachments?: FileAttachment[]; timestamp: number }>;
  compactionSummaries: Record<string, string>;
  _compactingSessions: Set<string>;
  /** AbortControllers for cancellation propagation across streaming, tool exec, dream, compaction */
  _abortControllers: Map<string, AbortController>;
  _safetyTimer: ReturnType<typeof setTimeout> | null;
  _sendInProgress: boolean;
  /** Timers for auto-removing denied tools and completed sub-agents from UI */
  _autoRemoveTimers: Set<ReturnType<typeof setTimeout>>;
  doomLoopWarningCount: number;
  /** Active sub-agents spawned via the task tool */
  subAgents: SubAgentState[];
  /** Track if we need to run verification after plan execution completes */
  _pendingVerification: { workspacePath: string; planContent: string } | null;
  /** Recover stuck state flags (e.g., isStreaming=true without session) */
  _recoverStuckState: () => void;
  compactSessionHistory: (sessionId: string) => Promise<void>;
  setSelectedModel: (id: string) => Promise<void>;
  startSession: (workspacePath: string, mode: import("@dalam/shared-types").AgentSessionMode) => Promise<void>;
  sendMessage: (content: string) => Promise<void>;
  saveVersion: (sessionId: string, label: string) => void;
  restoreVersion: (sessionId: string, versionId: string) => void;
  deleteVersion: (sessionId: string, versionId: string) => void;
  cancelVersionRestore: () => void;
  confirmVersionRestore: () => void;
  abort: (sessionId: string) => Promise<void>;
  /** Cancel all ongoing operations for a session (streaming, tools, dream, compaction) */
  cancelSessionOperations: (sessionId: string) => void;
  appendStream: (event: StreamEvent) => void;
  setTodos: (todos: TodoItem[]) => void;
  updateTodo: (id: string, patch: Partial<TodoItem>) => void;
  resolveToolApproval: (toolCallId: string, decision: "approved" | "denied", result?: string) => Promise<void>;
  openFile: (path: string) => void;
  newChat: () => void;
  goBackChat: () => boolean;
  goForwardChat: () => boolean;
  _clearAutoRemoveTimers: () => void;
  reset: () => void;
  /** Set to true by newChat() to prevent async session restore from overwriting fresh state */
  _suppressSessionRestore: boolean;
  setActiveSession: (id: string | null) => void;
  renameSession: (id: string, title: string) => void;
  setSessionStatus: (id: string, status: ChatSessionSummary["status"]) => void;
  removeSession: (id: string) => void;
  approvePlan: () => void;
  rejectPlan: () => void;
  agentMode: import("@dalam/shared-types").AgentSessionMode;
  setAgentMode: (mode: import("@dalam/shared-types").AgentSessionMode) => void;
  addPendingAttachment: (file: FileAttachment) => void;
  removePendingAttachment: (id: string) => void;
  clearPendingAttachments: () => void;
  /** Message queue methods */
  addToQueue: (content: string, attachments?: FileAttachment[]) => void;
  removeFromQueue: (id: string) => void;
  reorderQueue: (fromIdx: number, toIdx: number) => void;
  editQueueItem: (id: string, content: string) => void;
  steerQueueItem: (id: string) => void;
  clearQueue: () => void;
  injectSystemMessage: (content: string) => void;
  verifyAfterPlanExecution: () => Promise<void>;
  archiveSession: (id: string) => Promise<void>;
  restoreSession: (id: string) => void;
  load: () => Promise<void>;
  /** Agent runtime state machine (tracks phase transitions) */
  runtimeState: AgentRuntimeState;
};

export const useChat = create<ChatState>((set, get) => ({
  session: null,
  messages: [],
  pendingToolCalls: [],
  pendingActivities: [],
  streamingContent: "",
  thinkingContent: "",
  isStreaming: false,
  streamingStartedAt: null,
  activeAgentName: "build" as PrimaryAgentName,
  selectedModelId: "",
  todos: [],
  taskPlan: null,
  taskPlanSummary: null,
  _pendingChanges: [],
  chatHistory: [],
  chatHistoryIdx: -1,
  chatSessions: loadPersistedSessionSummaries(),
  activeSessionId: null,
  sessionMessages: loadPersistedMessages(),
  sessionAgentName: loadPersistedAgents(),
  planApproval: null,
  sessionVersions: loadPersistedVersions(),
  restoredVersionId: null,
  preRestoreMessages: null,
  pendingAttachments: [],
  messageQueue: [],
  compactionSummaries: loadPersistedCompactionSummaries(),
  _compactingSessions: new Set<string>(),
  _abortControllers: new Map<string, AbortController>(),
  _safetyTimer: null,
  _sendInProgress: false,
  doomLoopWarningCount: 0,
  _suppressSessionRestore: false,
  agentMode: "build" as import("@dalam/shared-types").AgentSessionMode,
  subAgents: [],
  _pendingVerification: null,
  runtimeState: createInitialRuntimeState(),
  _autoRemoveTimers: new Set<ReturnType<typeof setTimeout>>(),
  _clearAutoRemoveTimers() {
    get()._autoRemoveTimers.forEach((timer) => clearTimeout(timer));
    get()._autoRemoveTimers.clear();
  },

  // State recovery: reset stuck flags on initialization
  _recoverStuckState() {
    const state = get();
    // If isStreaming is true but there's no active session, it's stuck
    if (state.isStreaming && !state.session) {
      set({ isStreaming: false, _sendInProgress: false, streamingContent: "", thinkingContent: "" });
    }
    // If _sendInProgress is true but not streaming, it's stuck (safety timeout already covers this)
  },

  async load() {
    try {
      const { idbGet, isIndexedDBAvailable } = await import("@/lib/storage");
      if (isIndexedDBAvailable()) {
        const s = await idbGet("sessions", "all") as { data: ChatSessionSummary[] } | null;
        const m = await idbGet("messages", "all") as { data: Record<string, ChatMessage[]> } | null;
        const v = await idbGet("versions", "all") as { data: Record<string, import("@dalam/shared-types").ChatVersion[]> } | null;
        const c = await idbGet("compaction", "all") as { data: Record<string, string> } | null;
        const patch: Partial<ChatState> = {};
        if (s?.data && s.data.length > 0) patch.chatSessions = s.data;
        if (m?.data && Object.keys(m.data).length > 0) patch.sessionMessages = m.data;
        if (v?.data && Object.keys(v.data).length > 0) patch.sessionVersions = v.data;
        if (c?.data && Object.keys(c.data).length > 0) patch.compactionSummaries = c.data;
        if (Object.keys(patch).length > 0) set(patch);
      }
    } catch (e) {
      // Fallback: localStorage data is already loaded at store creation time
      devWarn("IndexedDB unavailable, using localStorage defaults:", e);
    }
    // Recover any stuck state flags from previous sessions
    get()._recoverStuckState();
  },

  async setSelectedModel(id) {
    set({ selectedModelId: id });
    if (id) {
      const currentSettings = useSettings.getState().settings;
      if (currentSettings.selectedModel === id) {
        return;
      }
      const { providers } = useModelProviders.getState();
      let matchedProvider: string | undefined;
      for (const p of providers) {
        const m = p.models.find((m) => m.modelId === id);
        if (m) {
          matchedProvider = p.id;
          break;
        }
      }
      await useSettings.getState().updateSettings({
        selectedModel: id,
        ...(matchedProvider ? { selectedProvider: matchedProvider } : {}),
      });
    }
  },
  setTodos(todos) { set({ todos }); },
  updateTodo(id, patch) {
    set((s) => ({ todos: s.todos.map((t) => (t.id === id ? { ...t, ...patch } : t)) }));
  },

  openFile(path) {
    // Look up the actual FileChange from pending tool calls or message fileChanges
    const { pendingToolCalls, messages } = get();
    let change: FileChange | null = null;
    // Check pending tool calls for a diff
    for (const tc of pendingToolCalls) {
      if (tc.diff && tc.diff.filePath === path) {
        change = { path, action: "modified", additions: tc.diff.hunks.reduce((n, h) => n + h.newLines, 0), deletions: tc.diff.hunks.reduce((n, h) => n + h.oldLines, 0) };
        break;
      }
    }
    // Check message fileChanges
    if (!change) {
      for (let i = messages.length - 1; i >= 0; i--) {
        const fc = messages[i].fileChanges;
        if (fc) {
          const found = fc.find((c) => c.path === path);
          if (found) { change = found; break; }
        }
      }
    }
    if (!change) {
      change = { path, action: "modified", additions: 0, deletions: 0 };
    }
    useDiffView.getState().openFile(change);
    useDiffView.getState().setOpen(true);
  },

  async startSession(workspacePath, mode) {
    const api = createDalamAPI();
    if (workspacePath) {
      await initWorkspaceMemory(api, workspacePath);
    }
    const model = useSettings.getState().settings.selectedModel;
    const { sessionId } = await api.agent.startSession({ workspacePath, model, mode });
    const now = Date.now();
    const activeAgentName = useAgents.getState().activeAgentName;
    // Reset user agent selection flag for the new session
    const wsName =
      useWorkspace.getState().workspaces.find((w) => w.path === workspacePath)?.name ??
      basename(workspacePath) ??
      workspacePath;
    const summary: ChatSessionSummary = {
      id: sessionId,
      workspacePath,
      workspaceName: wsName,
      title: "New task",
      agentName: activeAgentName,
      mode,
      model,
      startedAt: now,
      lastActivityAt: now,
      lastVisitedAt: now,
      messageCount: 0,
      status: "idle",
      versionCount: 0,
    };
    set({
      session: {
        id: sessionId,
        workspacePath,
        model,
        mode,
        startedAt: now,
        messages: [],
        status: "idle",
      },
      messages: [],
      pendingToolCalls: [],
      pendingActivities: [],
        _pendingVerification: null,
      todos: [],
      taskPlan: null,
      taskPlanSummary: null,
      streamingContent: "",
      thinkingContent: "",
      _pendingChanges: [],
      chatSessions: [
        ...get().chatSessions.filter((s) => s.id !== sessionId),
        summary,
      ],
      activeSessionId: sessionId,
      sessionMessages: { ...get().sessionMessages, [sessionId]: [] },
      sessionAgentName: { ...get().sessionAgentName, [sessionId]: activeAgentName },
      subAgents: [],
      _suppressSessionRestore: false,
    });
    savePersistedSessionSummaries(get().chatSessions);
    savePersistedMessages(get().sessionMessages);
    savePersistedAgents(get().sessionAgentName);
    void startRecording(sessionId, workspacePath).catch((err) => devWarn("[Recording] startRecording failed:", err));
  },

  async abort(sessionId) {
    const api = createDalamAPI();
    // Cancel all ongoing operations for this session (dream, compaction, tools)
    get().cancelSessionOperations(sessionId);
    // Clear safety timer on abort
    const currentTimer = get()._safetyTimer;
    if (currentTimer) clearTimeout(currentTimer);
    // Clear all auto-remove timers to prevent leaked timers firing on stale state
    get()._clearAutoRemoveTimers();
    try {
      await api.agent.abort(sessionId);
    } finally {
      // Cleanup stream AFTER abort completes to avoid race with final stream events
      api.agent.cleanupStream(sessionId);
      // Guard against race with newChat — if session was already cleared,
      // don't overwrite the fresh state with stale abort data
      // Clear module-level tool resolution maps to prevent orphaned entries
      // from waitForToolApproval that survive the session lifecycle.
      _pendingResolutions.clear();
      _toolCallResolvers.clear();
      _messageQueueRetries.clear();
      const currentSession = get().session;
      const isStillOurSession = currentSession && currentSession.id === sessionId;
      if (isStillOurSession) {
        set({
          isStreaming: false,
          streamingStartedAt: null,
          _sendInProgress: false,
          streamingContent: "",
          thinkingContent: "",
          pendingToolCalls: [],
          pendingActivities: [],
          pendingAttachments: [],
          _pendingChanges: [],
          _safetyTimer: null,
          _pendingVerification: null,
          subAgents: [],
          messageQueue: [],
          taskPlan: null,
          taskPlanSummary: null,
          planApproval: null,
          chatSessions: get().chatSessions.map((s) =>
            s.id === sessionId ? { ...s, status: "aborted" as const, lastActivityAt: Date.now(), lastVisitedAt: Date.now() } : s
          ),
          session: { ...currentSession, status: "aborted" },
        });
        savePersistedSessionSummaries(get().chatSessions);
      } else {
        // Session was cleared by newChat — still reset _sendInProgress so user can send
        set({ _sendInProgress: false });
      }
    }
  },

  /**
   * Cancel all ongoing operations for a session.
   * Aborts streaming, tool execution, dream cycle, and compaction.
   */
  cancelSessionOperations(sessionId: string) {
    // Abort first (idempotent, safe to call even if entry is later removed by
    // another in-flight update), then remove the entry via a functional set()
    // updater so we never mutate the live Map that other closures may still
    // hold a reference to — consistent with the pattern used for compaction's
    // AbortController lifecycle below.
    const controller = get()._abortControllers.get(sessionId);
    if (controller) {
      controller.abort();
    }
    set((s) => {
      if (!s._abortControllers.has(sessionId)) return {};
      const next = new Map(s._abortControllers);
      next.delete(sessionId);
      return { _abortControllers: next };
    });
  },

  async sendMessage(content) {
    // If viewing history, exit history mode first (restore to latest messages)
    const historyIdx = get().chatHistoryIdx;
    if (historyIdx >= 0) {
      const { chatHistory } = get();
      const latestMessages = chatHistory[chatHistory.length - 1] ?? [];
      set({ chatHistoryIdx: -1, messages: latestMessages });
    }

    // Atomic check-and-set to prevent race condition from rapid double-clicks
    let sendBlocked = false;
    set((s) => {
      if (s.isStreaming || s._sendInProgress) {
        sendBlocked = true;
        return s; // No state change
      }
      return { _sendInProgress: true };
    });
    if (sendBlocked) return;

    // Safety timeout: if _sendInProgress gets stuck true (e.g., unhandled exception), reset after 30s
    const sendInProgressSafety = setTimeout(() => {
      const s = get();
      if (s._sendInProgress && !s.isStreaming) {
        devWarn("[useChat] _sendInProgress safety timeout — resetting stuck state");
        set({ _sendInProgress: false });
      }
    }, 30_000);

    let { session } = get();
    if (!session) {
      const targetWs = useWorkspace.getState().activeWorkspaceId
        ? useWorkspace.getState().workspaces.find(
            (w) => w.id === useWorkspace.getState().activeWorkspaceId
          )?.path
        : undefined;
      try {
        const sessionMode = get().agentMode || "build" as import("@dalam/shared-types").AgentSessionMode;
        await get().startSession(targetWs ?? "", sessionMode);
      } catch (err) {
        if (import.meta.env.DEV) console.error("Failed to start session:", err);
        set({ _sendInProgress: false, _suppressSessionRestore: false });
        return;
      }
      // Re-check isStreaming after await to prevent race condition with concurrent sendMessage calls
      if (get().isStreaming) { set({ _sendInProgress: false }); return; }
      session = get().session;
      if (!session) { set({ _sendInProgress: false }); return; }
    }
    const { messages } = get();
    const api = createDalamAPI();
    // Ensure stream listener is registered for the current session
    api.agent.cleanupStream(session.id);
    api.agent.onStreamEvent(session.id, (event) => {
      try { get().appendStream(event); } catch (e) {
        if (import.meta.env.DEV) console.error("[Chat] appendStream error:", e);
      }
    });

    const { pendingAttachments } = get();
    const userMsg: ChatMessage = {
      id: "msg-" + crypto.randomUUID(),
      role: "user",
      content,
      timestamp: Date.now(),
      ...(pendingAttachments.length > 0 ? { attachments: pendingAttachments } : {}),
    };
    resetStreamingState(session.id);
    set((s) => ({
      messages: [...s.messages, userMsg],
      isStreaming: true,
      streamingStartedAt: Date.now(),
      streamingContent: "",
      thinkingContent: "",
      pendingToolCalls: [],
      pendingActivities: [],
      pendingAttachments: [],
      restoredVersionId: null,
      preRestoreMessages: null,
      // Mark first pending task as "running" when agent starts working
      taskPlan: (() => {
        const tp = s.taskPlan;
        if (!tp || tp.length === 0) return s.taskPlan;
        const firstPendingIdx = tp.findIndex(t => t.status === "pending");
        return tp.map((t, i) =>
          t.status === "pending" && i === firstPendingIdx
            ? { ...t, status: "running" as const }
            : t
        );
      })(),
      chatSessions: s.chatSessions.map((cs) =>
        cs.id === (session?.id ?? "")
          ? {
              ...cs,
              status: "running",
              lastActivityAt: Date.now(),
              messageCount: messages.length + 1,
              preview: content.length > 60 ? content.slice(0, 57) + "…" : content,
              title:
                cs.title && cs.title !== "New task"
                  ? cs.title
                  : content.length > 50
                    ? content.slice(0, 47) + "…"
                    : content,
          }
          : cs
      ),
      sessionMessages: session?.id ? { ...s.sessionMessages, [session.id]: [...(s.sessionMessages[session.id] ?? []), userMsg] } : s.sessionMessages,
    }));
    // Record user message in trajectory
    recordUserMessage(session.id, content);
        // Save version AFTER user message is added so the snapshot includes it
    get().saveVersion(session.id, content.length > 60 ? content.slice(0, 57) + "…" : content);

    // Safety timeout: fires 120s after the LAST stream event (reset on each event in appendStream).
    // This catches truly hung streams without killing active multi-turn agent loops.
    // Clear any previous safety timer to prevent it from killing a new streaming session.
    const prevTimer = get()._safetyTimer;
    if (prevTimer) clearTimeout(prevTimer);
    const safetyTimer = _createSafetyTimer(get, set, "normal");
    set({ _safetyTimer: safetyTimer });
    // Capture sessionId for stale-closure prevention in async error handlers
    const sendSessionId = session.id;

    try {
      const agentName = useAgents.getState().activeAgentName;
      await api.agent.sendPrompt(session.id, content, get().messages, agentName, pendingAttachments);
    } catch (err: unknown) {
      // Re-read timer from state (not local ref) — appendStream may have replaced it
      const timer = get()._safetyTimer;
      if (timer) clearTimeout(timer);
      set({ _safetyTimer: null });
      const msg = err instanceof Error ? err.message : "Unknown error";
      const sessionId = get().activeSessionId;
      // Context overflow auto-compaction: handle errors thrown before streaming starts
      if (sendSessionId && _isContextOverflowError(msg)) {
        if (_handleContextOverflowRetry(sendSessionId)) {
          // Clear flags so user can interact while compaction runs async
          clearTimeout(sendInProgressSafety);
          set({ isStreaming: false, _sendInProgress: false, streamingContent: "", thinkingContent: "" });
          return;
        }
      }
      // Standard error handling (non-overflow errors)
      const { isStreaming } = get();
      // If appendStream already handled the error (streaming ended), skip duplicate error message
      // but only if there's already an error message in the store (avoid silent failure)
      if (!isStreaming) {
        const lastMsg = get().messages[get().messages.length - 1];
        if (lastMsg?.role === "assistant" || lastMsg?.role === "system") {
          set({ _sendInProgress: false });
          return;
        }
      }
      const errorMsg: ChatMessage = {
        id: "err-" + crypto.randomUUID(),
        role: "assistant",
        content: `**Error**: ${msg}\n\nCheck your provider settings and try again.`,
        timestamp: Date.now(),
      };
      if (!sessionId) { set({ _sendInProgress: false }); return; }
      set((s) => {
        const timer = s._safetyTimer;
        if (timer) clearTimeout(timer);
        const liveSessionMessages = { ...s.sessionMessages, [sessionId]: [...(s.sessionMessages[sessionId] ?? []), errorMsg] };
        return {
          isStreaming: false,
          streamingStartedAt: null,
          streamingContent: "",
          thinkingContent: "",
          pendingToolCalls: [],
          pendingActivities: [],
          _safetyTimer: null,
          messages: [...s.messages, errorMsg],
          sessionMessages: liveSessionMessages,
          chatSessions: s.session
            ? s.chatSessions.map((cs) =>
                cs.id === (s.session?.id ?? "")
                  ? { ...cs, status: "error", lastActivityAt: Date.now() }
                  : cs
              )
            : s.chatSessions,
        };
      });
      const liveState = get();
      savePersistedMessages(liveState.sessionMessages);
      savePersistedSessionSummaries(liveState.chatSessions);
    }
    // Clear safety timer and reset _sendInProgress
    clearTimeout(sendInProgressSafety);
    set({ _sendInProgress: false });
  },

  appendStream(event) {
    const _log = (...args: unknown[]) => {
      if (typeof window !== "undefined" && (window as unknown as Record<string, unknown>).__DALAM_DEBUG) {
        console.log("[DALAM:store]", ...args);
      }
    };
    _log(`appendStream: ${event.type}`, event.type === "message-delta" ? `len=${event.content?.length ?? 0}` : event.type === "message-end" ? `msgId=${event.messageId}` : "");
    // Reset safety timer on every stream event — the agent loop is alive
    // as long as events keep flowing. This prevents the timer from killing
    // active multi-turn agent loops (tool approval waits, sequential LLM calls).
    // If there are pending tool approvals, use the extended 10-minute timeout.
    {
      const currentTimer = get()._safetyTimer;
      if (currentTimer) clearTimeout(currentTimer);
      // Cumulative stream duration guard: if streaming has been active for >30 minutes,
      // force-stop to prevent runaway streams that keep sending events.
      // Warn the user at 25 minutes so they aren't surprised by a hard stop.
      {
        const startedAt = get().streamingStartedAt;
        if (startedAt) {
          const elapsed = Date.now() - startedAt;
          const pending = get().pendingToolCalls;
          const hasUnresolved = pending.some(tc => tc.status === "awaiting-approval" || tc.status === "pending");
          if (hasUnresolved) {
            // Skip cumulative timeout — tool approval is pending
          } else if (elapsed > CUMULATIVE_STREAM_TIMEOUT_MS) {
            pushErrorToast("Stream timeout", "Session has been running for 30 minutes — force stopping.");
            devWarn("[Chat] Cumulative stream timeout (30 min) reached — force stopping");
            const api = createDalamAPI();
            const sid = get().activeSessionId;
            if (sid) api.agent.cleanupStream(sid);
            set({
              isStreaming: false,
              streamingStartedAt: null,
              streamingContent: "",
              thinkingContent: "",
              pendingToolCalls: [],
              pendingActivities: [],
              _pendingChanges: [],
              _safetyTimer: null,
              _sendInProgress: false,
            });
            return;
          } else if (elapsed > CUMULATIVE_WARNING_MS) {
            pushWarningToast("Stream approaching timeout", `Session has been running for ${Math.round(elapsed / 1000)}s — approaching 30 minute limit.`);
            devWarn(`[Chat] Cumulative stream warning (${Math.round(elapsed / 1000)}s) — approaching 30 min limit`);
          }
        }
      }
      const pending = get().pendingToolCalls;
      const hasUnresolved = pending.some(tc => tc.status === "awaiting-approval" || tc.status === "pending");
      const newTimer = _createSafetyTimer(get, set, hasUnresolved ? "tool-approval" : "normal");
      set({ _safetyTimer: newTimer });
    }

    // Dispatch event through runtime contract for phase tracking
    {
      let runtimeEvent: import("@/lib/agentRuntimeContract").AgentEvent | null = null;
      switch (event.type) {
        case "message-start": {
          runtimeEvent = { type: "STREAM_START", messageId: event.messageId };
          break;
        }
        case "tool-call": {
          runtimeEvent = { type: "TOOL_CALL", toolCallId: event.toolCall.id, toolName: event.toolCall.name };
          break;
        }
        case "diff-proposed": {
          // No separate event type — handled by the tool call flow
          break;
        }
        case "message-end": {
          const pending = get().pendingToolCalls;
          const hasMoreTools = pending.some(
            (tc) => tc.status === "awaiting-approval" || tc.status === "running" || tc.status === "pending"
          );
          runtimeEvent = { type: "STREAM_MESSAGE_END", messageId: event.messageId, hasMoreTools };
          break;
        }
        case "error": {
          const sessionId = get().activeSessionId ?? "";
          runtimeEvent = { type: "ERROR", sessionId, error: event.error };
          break;
        }
        case "tool-result": {
          const toolResult = event as import("@dalam/shared-types").StreamEvent & { type: "tool-result"; toolCallId: string; result: string };
          const isTimeout = toolResult.result?.includes("timed out");
          if (isTimeout) {
            // Timeout takes priority over result — marks the tool as errored
            runtimeEvent = { type: "TOOL_TIMEOUT", toolCallId: toolResult.toolCallId };
          } else {
            const isSuccess = !toolResult.result?.startsWith("Error:");
            runtimeEvent = { type: "TOOL_RESULT_RECEIVED", toolCallId: toolResult.toolCallId, success: isSuccess };
          }
          break;
        }
      }
      if (runtimeEvent) {
        const oldState = get().runtimeState;
        const newRuntimeState = agentReducer(oldState, runtimeEvent, { debug: false });

        // ── Phase Enforcement (must happen BEFORE set()) ──
        // If the reducer returned the same reference (invalid transition), drop the event.
        if (newRuntimeState === oldState) {
          _log(`[AgentRuntime] phase enforcement: dropping ${event.type} — invalid transition from ${oldState.phase}`);
          // If a message-end is dropped (e.g. duplicate or race), force-clear streaming
          // state to prevent the UI from getting stuck in "streaming" mode permanently.
          if (event.type === "message-end") {
            set({ isStreaming: false, streamingContent: "", thinkingContent: "", _safetyTimer: null, _sendInProgress: false, pendingToolCalls: [], pendingActivities: [], _pendingChanges: [] });
          }
          return; // Skip further processing for invalid events
        }

        if (newRuntimeState.phase !== oldState.phase) {
          _log(`[AgentRuntime] phase: ${oldState.phase} → ${newRuntimeState.phase}`);
        }
        set({ runtimeState: newRuntimeState });
      }
    }
    switch (event.type) {
      case "message-start": {
        const pending = get().pendingToolCalls;
        const hasUnresolved = pending.some(tc => tc.status === "awaiting-approval" || tc.status === "pending");
        set(() => ({
          ...(hasUnresolved ? {} : { streamingContent: "", thinkingContent: "", pendingActivities: [], _pendingChanges: [] }),
          // Don't clear taskPlan or todos here — they persist across turns within a session
          // They're only cleared when starting a completely new chat
          ...(hasUnresolved ? {} : { pendingToolCalls: [] }),
          isStreaming: true,
          streamingStartedAt: Date.now(),
        }));
        // NOTE: Safety timer is already reset by the preamble above this switch.
        // Only create a new one if no timer exists (e.g., first event after manual clear).
        if (!get()._safetyTimer) {
          const newTimer = _createSafetyTimer(get, set, "turn");
          set({ _safetyTimer: newTimer });
        }
        break;
      }
      case "message-delta": {
        const rawContent = event.content;
        // Strip XML tool call tags inline during streaming so partial
        // XML tags like <read_file path="... don't appear in the UI.
        const sid = get().activeSessionId ?? undefined;
        const cleanContent = stripInlineXml(rawContent, sid);
        if (!cleanContent && !rawContent) break;
        set((s) => {
          const MAX_STREAM = 200000;
          const prev = s.streamingContent;
          if (prev.length >= MAX_STREAM) {
            const newContent = prev.slice(prev.length - MAX_STREAM / 2) + cleanContent;
            return { streamingContent: newContent.length > MAX_STREAM ? newContent.slice(-MAX_STREAM) : newContent };
          }
          const newContent = prev + cleanContent;
          if (newContent.length > MAX_STREAM) {
            return { streamingContent: newContent.slice(-MAX_STREAM) };
          }
          return { streamingContent: newContent };
        });
        break;
      }
      case "diff-proposed": {
        const proposal = event.proposal;
        set((s) => {
          // Deterministic binding: prefer diffId-to-toolCall lookup first.
          // FUTURE: The stream protocol should include toolCallId in diff-proposed events.
          // Until then, heuristic fallbacks (Strategies 2-4) are used as a safety net
          // with dev warnings to surface when they fire.
          const proposalToolCallId = (proposal as { toolCallId?: string }).toolCallId;

          // Strategy 1: Direct toolCallId match (most deterministic)
          let idx = -1;
          if (proposalToolCallId) {
            idx = s.pendingToolCalls.findIndex(
              tc => tc.id === proposalToolCallId && !tc.diffId
            );
          }

          // Strategy 2: Match by filePath + edit tool name (precise)
          if (idx === -1) {
            idx = s.pendingToolCalls.findIndex(
              tc => (tc.status === "awaiting-approval" || tc.status === "pending" || tc.status === "completed") &&
                    tc.args.path === proposal.filePath &&
                    (tc.name === "write_file" || tc.name === "edit_file") &&
                    !tc.diffId
            );
            if (idx !== -1 && typeof import.meta !== "undefined" && import.meta.env?.DEV) {
              devWarn(`[DiffBinding] Using heuristic (filePath+toolName) for diff ${proposal.diffId} — stream protocol should provide toolCallId`);
            }
          }

          // Strategy 3: Match by content hash for write_file tools
          if (idx === -1) {
            idx = s.pendingToolCalls.findIndex(
              tc => (tc.status === "awaiting-approval" || tc.status === "pending" || tc.status === "completed") &&
                    tc.name === "write_file" &&
                    typeof tc.args.content === "string" &&
                    tc.args.content === proposal.newContent &&
                    !tc.diffId
            );
            if (idx !== -1 && typeof import.meta !== "undefined" && import.meta.env?.DEV) {
              devWarn(`[DiffBinding] Using heuristic (contentHash) for diff ${proposal.diffId} — stream protocol should provide toolCallId`);
            }
          }

          // Strategy 4 (final fallback): pick the most recent pending edit tool
          if (idx === -1) {
            for (let i = s.pendingToolCalls.length - 1; i >= 0; i--) {
              const tc = s.pendingToolCalls[i];
              if ((tc.status === "awaiting-approval" || tc.status === "pending" || tc.status === "completed") &&
                  !tc.diffId &&
                  (tc.name === "write_file" || tc.name === "edit_file" || tc.name === "write" || tc.name === "edit") &&
                  tc.args.path === proposal.filePath) {
                idx = i;
                break;
              }
            }
            if (idx !== -1 && typeof import.meta !== "undefined" && import.meta.env?.DEV) {
              devWarn(`[DiffBinding] Using heuristic (mostRecentEdit) for diff ${proposal.diffId} — stream protocol should provide toolCallId`);
            }
          }

          // If not found in pendingToolCalls, search messages (message-end may have already cleared pendingToolCalls)
          let targetMsgIdx = -1;
          let targetTcIdx = -1;
          if (idx === -1) {
            for (let m = s.messages.length - 1; m >= 0; m--) {
              const msg = s.messages[m];
              if (!msg.toolCalls) continue;
              const tcIdx = msg.toolCalls.findIndex(
                tc => !tc.diffId &&
                      (tc.name === "write_file" || tc.name === "edit_file" || tc.name === "write" || tc.name === "edit") &&
                      tc.args.path === proposal.filePath
              );
              if (tcIdx !== -1) {
                targetMsgIdx = m;
                targetTcIdx = tcIdx;
                break;
              }
            }
          }

          if (idx === -1 && targetMsgIdx === -1) return s;

          // If found in a message, update the message's toolCalls
          if (targetMsgIdx !== -1) {
            const updatedMsgs = [...s.messages];
            const msg = updatedMsgs[targetMsgIdx];
            const patchedToolCalls = msg.toolCalls!.map((tc, i) =>
              i === targetTcIdx ? { ...tc, diffId: proposal.diffId, diff: proposal } : tc
            );
            updatedMsgs[targetMsgIdx] = { ...msg, toolCalls: patchedToolCalls };
            const sid = s.activeSessionId;
            const updatedSM = sid
              ? { ...s.sessionMessages, [sid]: (s.sessionMessages[sid] ?? []).map((m) =>
                  m.id === msg.id ? { ...m, toolCalls: patchedToolCalls } : m
                ) }
              : s.sessionMessages;
            return { messages: updatedMsgs, sessionMessages: updatedSM };
          }

          const updated = [...s.pendingToolCalls];
          updated[idx] = { ...updated[idx], diffId: proposal.diffId, diff: proposal };
          return { pendingToolCalls: updated };
        });
        // Open diff view so user can preview the proposed change
        // Always open — even during streaming — so the diff is visible immediately
        useDiffView.getState().openFile({
          path: proposal.filePath,
          action: proposal.oldContent === "" ? "created" : "modified",
          additions: proposal.hunks.reduce((n: number, h: { newLines: number }) => n + h.newLines, 0),
          deletions: proposal.hunks.reduce((n: number, h: { oldLines: number }) => n + h.oldLines, 0),
        });
        break;
      }
      case "message-end": {
        const st = get();
        const { messages, thinkingContent, _pendingChanges, todos, pendingToolCalls, pendingActivities, session: liveSession } = st;
        const streamingContent = st.streamingContent;

        // Clear safety timeout if it exists — but ONLY when the turn is truly done.
        // During intermediate turns (tool calls just executed, agentic loop continues
        // with tool approval waits), extend the timer to 10 minutes so the agent
        // loop isn't killed while waiting for user approval.
        // Check if any pending tool calls have diffIds attached — these must not be orphaned.
        const existingTimer = get()._safetyTimer;
        if (existingTimer) {
          clearTimeout(existingTimer);
          const hasActiveToolCalls = pendingToolCalls.some(
            (tc) => tc.status === "awaiting-approval" || tc.status === "pending"
          );
          if (hasActiveToolCalls) {
            const extendedTimer = _createSafetyTimer(get, set, "tool-approval");
            set({ _safetyTimer: extendedTimer });
          } else {
            set({ _safetyTimer: null });
          }
        }

        // Invariant: message-end must not orphan tool calls with attached diffs
        // If any pending tool calls have diffIds, they must all be resolved before
        // clearing pendingToolCalls. If unresolved, we keep them so the UI can
        // continue showing the diffs — break out early to prevent downstream clear.
        const unresolvedDiffs = pendingToolCalls.filter(
          (tc) => tc.diffId && tc.status !== "completed" && tc.status !== "failed"
        );
        if (unresolvedDiffs.length > 0) {
          if (typeof import.meta !== "undefined" && import.meta.env?.DEV) {
            devWarn(
              `[AgentRuntime] INVARIANT: message-end with ${unresolvedDiffs.length} unresolved diff attachments. toolCallIds: ${unresolvedDiffs.map(t => t.id).join(", ")}. Keeping pendingToolCalls intact.`
            );
          }
          // Enforce invariant: do NOT clear pendingToolCalls when unresolved diffs exist.
          // Partial message-end: save current turn content but preserve tool state.
          // Strip XML tool tags from display content before saving.
          const { cleanedContent: intermediateCleaned } = parseXmlToolCalls(streamingContent);
          const intermediateMsg: ChatMessage = {
            id: event.messageId,
            role: "assistant",
            content: intermediateCleaned || streamingContent || "(executing tools...)",
            timestamp: Date.now(),
            ...(thinkingContent ? { thinking: thinkingContent } : {}),
            ...(_pendingChanges.length > 0 ? { fileChanges: [..._pendingChanges] } : {}),
            ...(pendingToolCalls.length > 0 ? { toolCalls: pendingToolCalls } : {}),
            ...(pendingActivities.length > 0 ? { activities: [...pendingActivities] } : {}),
          };
          const sessionId = get().activeSessionId;
          const newSessionMessages = sessionId
            ? { ...get().sessionMessages, [sessionId]: [...(get().sessionMessages[sessionId] ?? []), intermediateMsg] }
            : get().sessionMessages;
          set({
            messages: [...get().messages, intermediateMsg],
            sessionMessages: newSessionMessages,
            // Keep pendingToolCalls intact — don't clear!
            streamingContent: "",
            thinkingContent: "",
            _pendingChanges: [],
            _sendInProgress: false,
          });
          if (sessionId) savePersistedMessages(newSessionMessages);
          break;
        }

        // Tools are already populated in pendingToolCalls via tool-call events
        // emitted by the API layer. Use them as the single source of truth.
        // Clean XML tool call tags from display content only.
        let finalContent = streamingContent;
        const allToolCalls = pendingToolCalls;
        const { toolCalls: xmlToolCalls, cleanedContent } = parseXmlToolCalls(streamingContent);
        if (xmlToolCalls.length > 0 || cleanedContent !== streamingContent) {
          finalContent = cleanedContent;
        }

        // Skip creating a message if there's nothing to show (e.g., error already
        // handled the turn and cleared streamingContent)
        if (!finalContent && allToolCalls.length === 0 && pendingActivities.length === 0 && !thinkingContent) {
          const now = Date.now();
          const completedSessions = liveSession
            ? get().chatSessions.map((cs) =>
                cs.id === liveSession.id
                  ? { ...cs, status: "completed" as const, lastActivityAt: now, lastVisitedAt: now }
                  : cs
              )
            : get().chatSessions;
          set({
            isStreaming: false,
            _sendInProgress: false,
            pendingToolCalls: [],
            pendingActivities: [],
            streamingContent: "",
            thinkingContent: "",
            _pendingChanges: [],
            chatSessions: completedSessions,
          });
          savePersistedSessionSummaries(completedSessions);
          break;
        }

        // If there are pending tool calls, this is an intermediate turn (tools
        // were just executed). Save the current turn's content and clear transient
        // state so the agentic loop can continue streaming.
        if (allToolCalls.length > 0) {
          // Find the last user message to group this assistant turn under
          let lastUserMsgId: string | undefined;
          for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i].role === "user") { lastUserMsgId = messages[i].id; break; }
          }
          const intermediateMsg: ChatMessage = {
            id: event.messageId,
            role: "assistant",
            content: finalContent,
            timestamp: Date.now(),
            ...(lastUserMsgId ? { parentID: lastUserMsgId } : {}),
            ...(thinkingContent ? { thinking: thinkingContent } : {}),
            ...(_pendingChanges.length > 0 ? { fileChanges: [..._pendingChanges] } : {}),
            ...(allToolCalls.length > 0 ? { toolCalls: allToolCalls } : {}),
            ...(pendingActivities.length > 0 ? { activities: [...pendingActivities] } : {}),
          };
          const sessionId = get().activeSessionId;
          const newSessionMessages = sessionId
            ? { ...get().sessionMessages, [sessionId]: [...(get().sessionMessages[sessionId] ?? []), intermediateMsg] }
            : get().sessionMessages;
          // Open diff view for accumulated changes on intermediate messages
          // so the user sees progress even during multi-tool agentic loops
          if (_pendingChanges.length > 0) {
            useDiffView.getState().openFile(_pendingChanges[0]);
          }
          set({
            messages: [...get().messages, intermediateMsg],
            sessionMessages: newSessionMessages,
            streamingContent: "",
            thinkingContent: "",
            _pendingChanges: [],
            pendingToolCalls: [],
            pendingActivities: [],
            // NOTE: Don't clear _sendInProgress here — the agentic loop is still
            // running (tools were just executed, results will be sent back to API).
            // Clearing it here would allow the user to send another message while
            // the agent is still processing, creating a race condition.
          });
          if (sessionId) savePersistedMessages(newSessionMessages);
          break;
        }

        const currentTaskPlan = get().taskPlan;
        const currentTaskPlanSummary = get().taskPlanSummary;
        // Find the last user message to group this assistant turn under
        let lastUserMsgId: string | undefined;
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i].role === "user") { lastUserMsgId = messages[i].id; break; }
        }
        const assistantMsg: ChatMessage = {
          id: event.messageId,
          role: "assistant",
          content: finalContent,
          timestamp: Date.now(),
          ...(lastUserMsgId ? { parentID: lastUserMsgId } : {}),
          ...(thinkingContent ? { thinking: thinkingContent } : {}),
          ...(todos.length > 0 ? { todos: [...todos] } : {}),
          ...(_pendingChanges.length > 0 ? { fileChanges: [..._pendingChanges] } : {}),
          ...(allToolCalls.length > 0 ? { toolCalls: allToolCalls } : {}),
          ...(pendingActivities.length > 0 ? { activities: [...pendingActivities] } : {}),
          ...(currentTaskPlan && currentTaskPlan.length > 0 ? { taskPlan: currentTaskPlan, taskPlanSummary: currentTaskPlanSummary ?? undefined } : {}),
        };
        const sessionId = get().activeSessionId;
        const newSessionMessages = sessionId
          ? { ...get().sessionMessages, [sessionId]: [...(get().sessionMessages[sessionId] ?? []), assistantMsg] }
          : get().sessionMessages;
        set({
          messages: [...get().messages, assistantMsg],
          sessionMessages: newSessionMessages,
          streamingContent: "",
          thinkingContent: "",
          isStreaming: false,
          streamingStartedAt: null,
          _sendInProgress: false,
          _pendingChanges: [],
          pendingToolCalls: [],
          pendingActivities: [],
          chatSessions: liveSession
            ? get().chatSessions.map((s) =>
                s.id === liveSession.id
                  ? { ...s, status: "completed", lastActivityAt: Date.now(), lastVisitedAt: Date.now() }
                  : s
              )
            : get().chatSessions,
        });
        // Process message queue: auto-send next queued message
        // Guard: only send if not already streaming or in-progress
        const { messageQueue } = get();
        if (messageQueue.length > 0) {
          const next = messageQueue[0];
          set({ messageQueue: messageQueue.slice(1) });
          setTimeout(() => {
            // Double-check: only send if still not streaming
            const state = get();
            if (!state.isStreaming && !state._sendInProgress) {
              void get().sendMessage(next.content);
            } else {
              // Re-enqueue at front so it's tried again after streaming finishes
              // Cap retries at 10 (≈3 seconds) to prevent infinite loop
              const retryCount = _messageQueueRetries.get(next.id) ?? 0;
              if (retryCount < 10) {
                _messageQueueRetries.set(next.id, retryCount + 1);
                useChat.setState(s => ({ messageQueue: [next, ...s.messageQueue] }));
              }
            }
          }, 300);
        }
        // Record assistant message in trajectory
        if (sessionId) {
          recordAssistantMessage(sessionId, finalContent, undefined, allToolCalls.length > 0 ? allToolCalls.map(tc => ({ name: tc.name, arguments: tc.args, result: tc.result })) : undefined);
        }
      const liveState = get();
      savePersistedMessages(liveState.sessionMessages);
      savePersistedSessionSummaries(liveState.chatSessions);
        // Open diff view for all accumulated changes at turn completion.
        // During streaming, file-changed events skip opening the diff — we open
        // them all here so the user sees every change in the right sidebar.
        const accumulatedChanges = _pendingChanges; // captured before set() cleared it
        if (accumulatedChanges && accumulatedChanges.length > 0) {
          const firstChange = accumulatedChanges[0];
          if (firstChange) {
            useDiffView.getState().openFile(firstChange);
          }
        }
        // Auto-verification: if build agent produced changes in this turn,
        // set _pendingVerification so verifyAfterPlanExecution will run the verification pipeline.
        // Only check current turn's pending changes, not all historical messages.
        if (sessionId && !get()._pendingVerification) {
          if (accumulatedChanges && accumulatedChanges.length > 0) {
            const liveSess = get().session;
            if (liveSess?.workspacePath) {
              set({ _pendingVerification: { workspacePath: liveSess.workspacePath, planContent: "" } });
            }
          }
        }
        if (sessionId) {
          void get().compactSessionHistory(sessionId);
          // Post-turn verification: if a plan was just executed, run verification
          void get().verifyAfterPlanExecution();

          // Post-turn memory consolidation: async memory sync after each conversation turn
          // Inspired by Hermes memory lifecycle — extracts key facts from the conversation
          // and persists them to the memory store for future reference.
          void (async () => {
            try {
              const { extractMemoriesWithLLM } = await import("@/lib/memoryStore");
              const ws = useWorkspace.getState().workspaces.find(w => w.id === useWorkspace.getState().activeWorkspaceId);
              if (ws && finalContent) {
                const api = createDalamAPI();
                const model = useSettings.getState().settings.selectedModel;
                if (model) {
                  // Re-read messages from state (not stale closure) for memory extraction
                  const latestMessages = useChat.getState().messages;
                  // Extract key facts from the conversation and save as memory
                  await extractMemoriesWithLLM(
                    latestMessages.filter(m => m.role === "user").pop()?.content ?? "",
                    finalContent,
                    (prompt) => api.agent.summarizeMessages(model, [{ role: "user", content: prompt }]),
                    { sessionId, workspacePath: ws.path, maxEntries: 3 }
                  );
                }
              }
            } catch (err) {
              // Memory extraction is best-effort — don't break the main flow
              console.debug("[Chat] Post-turn memory extraction skipped:", err);
            }
          })();
        }
        break;
      }
      case "tool-call": {
        const tool = event.toolCall;
        const existing = get().pendingToolCalls.some((tc) => tc.id === tool.id);
        if (existing) break;
        // Canonicalize bash commands for permission matching
        const isBashTool = tool.name === "shell" || tool.name === "bash" || tool.name === "execute" || tool.name === "run_command";
        const commandStr = tool.args && typeof tool.args.command === "string" ? tool.args.command : "";
        const canonicalPattern = isBashTool && commandStr ? canonicaliseBashCommand(commandStr) : tool.name;
        // Map tool names to permission keys
        // Question tools always auto-approved — they inherently require user interaction and show their own dialog
        if (tool.name === "question") {
          set((s) => ({ pendingToolCalls: [...s.pendingToolCalls, tool] }));
          void get().resolveToolApproval(tool.id, "approved");
          break;
        }
        const permissionKey: PermissionKind = EDIT_TOOLS.has(tool.name)
          ? "edit"
          : BASH_TOOLS.has(tool.name)
            ? "bash"
            : READ_TOOLS.has(tool.name)
              ? "read"
              : tool.name.startsWith("mcp_")
                ? "mcp"
                : "edit";
        const agentAction = useAgents.getState().evaluatePermission(permissionKey, canonicalPattern);
        const needsApproval = agentAction === "ask";
        const denied = agentAction === "deny";
        // Auto-denied tools: mark as failed and resolve immediately so the
        // API layer's waitForToolApproval doesn't hang forever.
        if (denied) {
          // Log audit trail
          logPermission({
            timestamp: Date.now(),
            sessionId: get().activeSessionId ?? "",
            toolName: tool.name,
            command: commandStr,
            decision: "deny",
            source: "rule",
          });
          const deniedTool = { ...tool, status: "failed" as const, result: "Denied by permission policy" };
          set((s) => ({ pendingToolCalls: [...s.pendingToolCalls, deniedTool] }));
          void get().resolveToolApproval(tool.id, "denied", "Denied by permission policy");
          // Auto-remove denied tools from UI after a short delay
          const _autoRemoveTimer = setTimeout(() => {
            set((s) => ({ pendingToolCalls: s.pendingToolCalls.filter((tc) => tc.id !== tool.id) }));
            get()._autoRemoveTimers.delete(_autoRemoveTimer);
          }, 2000);
          get()._autoRemoveTimers.add(_autoRemoveTimer);
          break;
        }
        const annotated: typeof tool = needsApproval
          ? { ...tool, status: "awaiting-approval" as const }
          : { ...tool };
        set((s) => ({ pendingToolCalls: [...s.pendingToolCalls, annotated] }));
        if (needsApproval) {
          const description = `Dalam (${useAgents.getState().activeAgentName} agent) wants to use \`${tool.name}\`.`;
          const activeSession = get().session;
          void usePermission.getState().ask({
            kind: permissionKey,
            title: tool.name,
            description,
            ...(commandStr ? { command: commandStr } : {}),
            ...(activeSession?.workspacePath ? { workspacePath: activeSession.workspacePath } : {}),
          }).then((decision) => {
            void get().resolveToolApproval(tool.id, decision === "allow" || decision === "always" ? "approved" : "denied");
            // Log audit trail
            logPermission({
              timestamp: Date.now(),
              sessionId: get().activeSessionId ?? "",
              toolName: tool.name,
              command: commandStr,
              decision: decision === "always" ? "always" : decision === "allow" ? "allow" : "deny",
              source: "user",
            });
            // Persist "always allow" so future tools of the same kind are auto-approved
            if (decision === "always") {
              usePermission.getState().allowAlways({
              id: "perm-" + crypto.randomUUID(),
              createdAt: Date.now(),
              kind: permissionKey,
              title: tool.name,
              description,
              ...(commandStr ? { command: commandStr } : {}),
              ...(activeSession?.workspacePath ? { workspacePath: activeSession.workspacePath } : {}),
              });
            }
          }).catch((err) => {
            if (import.meta.env.DEV) console.error("Permission dialog error:", err);
            // If the dialog was dismissed/closed, deny the tool to unblock waitForToolApproval
            void get().resolveToolApproval(tool.id, "denied");
          });
        } else {
          // Log audit trail for auto-allow
          logPermission({
            timestamp: Date.now(),
            sessionId: get().activeSessionId ?? "",
            toolName: tool.name,
            command: commandStr,
            decision: "allow",
            source: "auto",
          });
          void get().resolveToolApproval(tool.id, "approved");
        }
        break;
      }
      case "tool-result":
        set((s) => {
          const updated = s.pendingToolCalls.map((tc) => {
            if (tc.id !== event.toolCallId) return tc;
            const isError = typeof event.result === "string" && event.result.startsWith("Error:");
            // If the tool has a diffId (diff proposal pending), keep status as "awaiting-approval"
            // so the user can approve/reject the diff. Only mark completed if there's no diff.
            const hasDiffPending = !!(tc as { diffId?: string }).diffId;
            const newStatus = isError ? "failed" as const
              : hasDiffPending ? "awaiting-approval" as const
              : "completed" as const;
            return {
              ...tc,
              status: newStatus,
              result: event.result,
            };
          });
          // If the tool call was already cleared by message-end (race condition),
          // the result is orphaned. Search ALL messages (not just last) for the
          // assistant message with matching toolCalls, so it's not lost.
          const found = s.pendingToolCalls.some((tc) => tc.id === event.toolCallId);
          if (!found && s.pendingToolCalls.length === 0 && s.messages.length > 0) {
            // Search backwards through all messages to find the matching tool call
            for (let msgIdx = s.messages.length - 1; msgIdx >= 0; msgIdx--) {
              const msg = s.messages[msgIdx];
              if (msg.role !== "assistant" || !msg.toolCalls?.length) continue;
              const hasMatchingTc = msg.toolCalls.some((tc) => tc.id === event.toolCallId);
              if (!hasMatchingTc) continue;
              // Guard: skip if this result was already applied (prevents double-patching in multi-turn loops)
              const alreadyApplied = msg.toolCalls.some((tc) => tc.id === event.toolCallId && tc.result !== undefined);
              if (alreadyApplied) break;
              const patchedToolCalls = msg.toolCalls.map((tc) =>
                tc.id === event.toolCallId
                  ? { ...tc, status: (typeof event.result === "string" && event.result.startsWith("Error:") ? "failed" : "completed") as "completed" | "failed", result: event.result }
                  : tc
              );
              const patchedMsg = { ...msg, toolCalls: patchedToolCalls };
              const patchedMessages = [...s.messages.slice(0, msgIdx), patchedMsg, ...s.messages.slice(msgIdx + 1)];
              // Also patch sessionMessages by ID, not by index (arrays may diverge)
              const sid = s.activeSessionId;
              const patchedSessionMessages = sid ? {
                ...s.sessionMessages,
                [sid]: (s.sessionMessages[sid] ?? []).map(m =>
                  m.id === patchedMsg.id ? patchedMsg : m
                ),
              } : s.sessionMessages;
              return {
                pendingToolCalls: updated,
                messages: patchedMessages,
                sessionMessages: patchedSessionMessages,
              };
            }
          }
          return { pendingToolCalls: updated };
        });
        // Doom loop detection + tool failure tracking (on tool RESULT, not call)
        {
          const tc = get().pendingToolCalls.find((t) => t.id === event.toolCallId);
          if (tc) {
            const sessionId = get().activeSessionId;
            if (sessionId) {
              const isError = typeof event.result === "string" && event.result.startsWith("Error:");
              if (isError) {
                // Record failure for doom loop tracking
                _recordToolFailure(sessionId, tc.name, tc.args);
                // Check doom loop threshold
                const doomResult = _checkDoomLoop(sessionId, tc.name, tc.args);
                 if (doomResult) {
                  if (doomResult.severity === "halt") {
                    pushErrorToast("Agent loop detected", doomResult.message);
                  } else {
                    pushWarningToast("Agent warning", doomResult.message);
                  }
                  devWarn("[Chat]", doomResult.message);
                  set((s) => ({ doomLoopWarningCount: s.doomLoopWarningCount + 1 }));
                  if (doomResult.severity === "halt") {
                    void get().abort(sessionId);
                  }
                }
              } else {
                // Reset doom loop failure counter for this specific signature on success
                _clearToolFailure(sessionId, tc.name, tc.args);
                // Reset doom loop warning count on any successful tool result
                set({ doomLoopWarningCount: 0 });
              }
            }
          }
        }
        break;
      case "sub-agent-start": {
        const newAgent: SubAgentState = {
          id: event.subAgentId,
          prompt: event.prompt,
          description: event.description,
          subagentType: event.subagentType,
          status: "running",
          startedAt: Date.now(),
          toolCalls: [],
          content: "",
        };
        set((s) => ({
          subAgents: [...s.subAgents, newAgent],
        }));
        break;
      }
      case "sub-agent-end": {
        set((s) => ({
          subAgents: s.subAgents.map((sa) =>
            sa.id === event.subAgentId
              ? { ...sa, status: event.status, completedAt: Date.now(), error: event.error }
              : sa
          ),
        }));
        // Auto-remove completed sub-agents from UI after 30 seconds
        const _subRemoveTimer = setTimeout(() => {
          set((s) => ({
            subAgents: s.subAgents.filter((sa) => sa.id !== event.subAgentId),
          }));
          get()._autoRemoveTimers.delete(_subRemoveTimer);
        }, 30000);
        get()._autoRemoveTimers.add(_subRemoveTimer);
        break;
      }
      case "sub-agent-update": {
        set((s) => ({
          subAgents: s.subAgents.map((sa) =>
            sa.id === event.subAgentId
              ? {
                  ...sa,
                  ...(event.toolCalls ? { toolCalls: event.toolCalls } : {}),
                  ...(event.content !== undefined ? { content: event.content } : {}),
                }
              : sa
          ),
        }));
        break;
      }
      case "file-changed": {
        const { isStreaming } = get();
        if (isStreaming) {
          set((s) => ({
            _pendingChanges: [...(s._pendingChanges ?? []), event.change],
          }));
        } else {
          // Find the last assistant message to attach file changes to.
          // Walk backwards to find it even if tool results are at the end.
          set((s) => {
            let lastAssistantIdx = -1;
            for (let i = s.messages.length - 1; i >= 0; i--) {
              if (s.messages[i].role === "assistant") {
                lastAssistantIdx = i;
                break;
              }
            }
            if (lastAssistantIdx === -1) return s;
            const updatedMessages = s.messages.map((m, i) =>
              i === lastAssistantIdx
                ? { ...m, fileChanges: [...(m.fileChanges ?? []), event.change] }
                : m
            );
            // Persist to sessionMessages so file changes survive session switches
            const sessionId = s.activeSessionId;
            return {
              messages: updatedMessages,
              ...(sessionId ? {
                sessionMessages: {
                  ...s.sessionMessages,
                  [sessionId]: updatedMessages,
                },
              } : {}),
            };
          });
        }
        // Only open diff view when not streaming — during streaming, changes
        // accumulate in _pendingChanges and open when the turn completes
        if (!get().isStreaming) {
          useDiffView.getState().openFile(event.change);
        }
        break;
      }
      case "todo-update": {
        set((s) => {
          const last = s.messages[s.messages.length - 1];
          const updatedMessages = last && last.role === "assistant"
            ? s.messages.map((m, i) =>
                i === s.messages.length - 1
                  ? { ...m, todos: event.todos }
                  : m
              )
            : s.messages;
          return { todos: event.todos, messages: updatedMessages };
        });
        break;
      }
      case "activity-think": {
        set((s) => ({
          thinkingContent: (s.thinkingContent + (s.thinkingContent ? "\n" : "") + event.content).slice(-100000),
        }));
        break;
      }
      case "activity-explore": {
        set((s) => ({
          pendingActivities: [
            ...s.pendingActivities,
            {
              id: "pa-" + crypto.randomUUID(),
              type: "explore" as const,
              query: event.query,
              ...(event.kind ? { kind: event.kind } : {}),
              matches: event.matches,
            },
          ].slice(-500) as typeof s.pendingActivities,
        }));
        break;
      }
      case "activity-read": {
        set((s) => ({
          pendingActivities: [
            ...s.pendingActivities,
            {
              id: "pa-" + crypto.randomUUID(),
              type: "read" as const,
              path: event.path,
              content: event.content,
              ...(event.lineRange ? { lineRange: event.lineRange } : {}),
            },
          ].slice(-500) as typeof s.pendingActivities,
        }));
        break;
      }
      case "activity-skill": {
        set((s) => ({
          pendingActivities: [
            ...s.pendingActivities,
            {
              id: "pa-" + crypto.randomUUID(),
              type: "skill" as const,
              name: event.name,
              content: event.content,
              ...(event.args ? { args: event.args } : {}),
            },
          ].slice(-500) as typeof s.pendingActivities,
        }));
        break;
      }
      case "activity-bash": {
        // Detect task plan and task completion events from the agent loop
        if (event.command === "task plan") {
          const resultText = event.result ?? "";
          const newTasks: TaskPlanItem[] = resultText.split("\n").filter(Boolean).map((line: string) => {
            // Match task IDs like "task-1", "1.2", "T1", etc. followed by colon and title
            const match = line.match(/^([\w.-]+):\s*(.+)$/);
            return match ? { id: match[1], title: match[2].trim(), status: "pending" as const } : null;
          }).filter(Boolean) as TaskPlanItem[];
          if (newTasks.length > 0) {
            // Merge with existing task plan — preserve status of tasks that already exist
            set((s) => {
              const existing = s.taskPlan ?? [];
              const existingMap = new Map(existing.map(t => [t.id, t]));
              const merged = newTasks.map(t => existingMap.get(t.id) ?? t);
              return { taskPlan: merged, taskPlanSummary: null };
            });
          }
        } else if (event.command === "completed") {
          set((s) => ({
            taskPlan: s.taskPlan
              ? s.taskPlan.map((t) => (t.status === "running" || t.status === "pending") ? { ...t, status: "completed" as const } : t)
              : s.taskPlan,
            taskPlanSummary: event.result || "Task completed",
          }));
        } else if (event.command === "task budget exhausted") {
          set((s) => ({
            taskPlan: s.taskPlan
              ? s.taskPlan.map((t) => (t.status === "pending" || t.status === "running") ? { ...t, status: "failed" as const } : t)
              : s.taskPlan,
            taskPlanSummary: event.result,
          }));
          // Hermes-style TurnFinalizer: when iteration budget exhausts without
          // a final response, make one toolless API call to get a summary
          // instead of failing silently.
          void (async () => {
            try {
              const sid = get().activeSessionId;
              const model = useSettings.getState().settings.selectedModel;
              if (!sid || !model) return;
              // Dedup guard: skip if a TurnFinalizer summary already exists in messages
              const hasFinalizerSummary = get().messages.some(
                (m) => m.role === "system" && m.content.startsWith("**Budget exhausted**")
              );
              if (hasFinalizerSummary) return;
              const recentMsgs = get().messages
                .slice(-20)
                .filter((m) => m.role === "user" || m.role === "assistant");
              if (recentMsgs.length === 0) return;
              const summaryPrompt = `The agent's iteration budget has been exhausted. Based on the conversation so far, provide a brief summary of what was accomplished and what remains. Do not use any tools — just summarize.`;
              const api = createDalamAPI();
              const summaryText = await api.agent.summarizeMessages(model, [
                ...recentMsgs.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
                { role: "user", content: summaryPrompt },
              ]);
              if (summaryText) {
                const summaryMsg: ChatMessage = {
                  id: "sys-" + crypto.randomUUID(),
                  role: "system",
                  content: `**Budget exhausted** — Here's a summary of progress:\n\n${summaryText}`,
                  timestamp: Date.now(),
                };
                const s = get();
                const sm = s.sessionMessages, msgs = s.messages;
                const sid2 = s.activeSessionId;
                const newSM = sid2 ? { ...sm, [sid2]: [...(sm[sid2] ?? []), summaryMsg] } : sm;
                set({ messages: [...msgs, summaryMsg], sessionMessages: newSM });
                if (sid2) savePersistedMessages(newSM);
              }
            } catch (err) {
              console.debug("[Chat] TurnFinalizer summary failed:", err);
            }
          })();
        }
        // Only append non-meta bash activities to the visible activity feed
        const META_COMMANDS = new Set(["task plan", "completed", "task budget exhausted"]);
        if (!META_COMMANDS.has(event.command)) {
          set((s) => ({
            pendingActivities: [
              ...s.pendingActivities,
              { id: "pa-" + crypto.randomUUID(), type: "bash" as const, command: event.command, result: event.result },
            ].slice(-500) as typeof s.pendingActivities,
          }));
        }
        break;
      }
      case "activity-plan": {
        set((s) => ({
          pendingActivities: [
            ...s.pendingActivities,
            { id: "pa-" + crypto.randomUUID(), type: "plan" as const, plan: event.plan },
          ].slice(-500) as typeof s.pendingActivities,
        }));
        break;
      }
      case "thinking":
        set((s) => ({ thinkingContent: (s.thinkingContent + (s.thinkingContent ? "\n" : "") + event.content).slice(-100000) }));
        break;
      case "status":
        set((s) => ({
          session: s.session ? { ...s.session, status: event.status } : s.session,
          chatSessions: s.session
            ? s.chatSessions.map((cs) =>
                cs.id === (s.session?.id ?? "")
                  ? { ...cs, status: event.status, lastActivityAt: Date.now() }
                  : cs
              )
            : s.chatSessions,
        }));
        break;
      case "ask-permission": {
        const VALID_KINDS = ["bash", "edit", "mcp", "read"] as const;
        const permKind = (VALID_KINDS as readonly string[]).includes(event.kind) ? (event.kind as typeof VALID_KINDS[number]) : "bash";
        const activeSession = get().session;
        usePermission.getState().ask({
          kind: permKind,
          title: "Permission required",
          description: event.description ?? `Dalam wants to run: ${event.kind}`,
          ...(event.command ? { command: event.command } : {}),
          ...(activeSession?.workspacePath ? { workspacePath: activeSession.workspacePath } : {}),
        }).then((decision) => {
          if (event.toolCallId) {
            void get().resolveToolApproval(event.toolCallId, decision === "allow" || decision === "always" ? "approved" : "denied");
          }
          // Persist "always allow" so future tools of the same kind are auto-approved
          if (decision === "always") {
            usePermission.getState().allowAlways({
              id: "perm-" + crypto.randomUUID(),
              createdAt: Date.now(),
              kind: permKind,
              title: "Permission required",
              description: event.description ?? `Dalam wants to run: ${event.kind}`,
              ...(event.command ? { command: event.command } : {}),
              ...(activeSession?.workspacePath ? { workspacePath: activeSession.workspacePath } : {}),
            });
          }
        }).catch((err) => {
          if (import.meta.env.DEV) console.error("Permission dialog error:", err);
          // If the dialog was dismissed/closed, deny the tool to unblock the agent loop
          if (event.toolCallId) {
            void get().resolveToolApproval(event.toolCallId, "denied");
          }
        });
        break;
      }
      case "ask-question": {
        const questionSessionId = get().activeSessionId;
        if (questionSessionId) {
          get().setSessionStatus(questionSessionId, "questioning");
        }
        const questionText = event.question;
        const questionOptions = event.options ?? [];
        const questionHeader = event.header ?? "Question";
        // Store the Q&A result when the user answers, so it persists in message history
        useQuestion.getState().ask({
          header: questionHeader,
          question: questionText,
          options: questionOptions,
        }).then((answer) => {
          if (!answer) return;
          const answerText = answer.customText || answer.selectedLabel;
          // Store Q&A in the current assistant message
          const st = get();
          let lastAssistantIdx = -1;
          for (let i = st.messages.length - 1; i >= 0; i--) {
            if (st.messages[i].role === "assistant") { lastAssistantIdx = i; break; }
          }
          if (lastAssistantIdx >= 0) {
            const msg = st.messages[lastAssistantIdx];
            const newQuestion = {
              id: "q-" + crypto.randomUUID(),
              question: questionText,
              options: questionOptions.map((o) => o.label),
              answer: answerText,
              timestamp: Date.now(),
            };
            const updatedMessages = [...st.messages];
            updatedMessages[lastAssistantIdx] = { ...msg, questions: [...(msg.questions ?? []), newQuestion] };
            const sid = st.activeSessionId;
            set({
              messages: updatedMessages,
              ...(sid ? { sessionMessages: { ...st.sessionMessages, [sid]: updatedMessages } } : {}),
            });
          }
        }).catch((err) => {
          if (import.meta.env.DEV) console.error("ask-question error:", err);
          if (questionSessionId) {
            try { useChat.getState().setSessionStatus(questionSessionId, "running"); } catch (e) { if (import.meta.env.DEV) devWarn("[Store] useChat.getState().setSessionStatus(questionSessio", e); }
          }
        });
        break;
      }
      case "error": {
        const sessionId = get().activeSessionId;
        if (sessionId && _isContextOverflowError(event.error)) {
          if (_handleContextOverflowRetry(sessionId)) {
            break; // retry initiated
          }
        }

        let lastUserMsgId: string | undefined;
        for (let i = get().messages.length - 1; i >= 0; i--) {
          if (get().messages[i].role === "user") { lastUserMsgId = get().messages[i].id; break; }
        }
        const errorMsg: ChatMessage = {
          id: "err-" + crypto.randomUUID(),
          role: "assistant",
          content: (() => {
            // Parse provider error JSON into human-readable text
            const raw = event.error;
            let friendly = raw;
            try {
              const json = JSON.parse(raw.replace(/^.*?(HTTP \d+:\s*)/, ""));
              if (json?.error?.message) friendly = String(json.error.message);
              else if (json?.detail) friendly = String(json.detail);
              else if (json?.message) friendly = String(json.message);
              else if (typeof json?.error === "string") friendly = json.error;
            } catch (e) {
              if (import.meta.env.DEV) devWarn("[Store] JSON parse:", e);
            }
            return `**Error**: ${friendly}\n\nCheck your provider settings and try again.`;
          })(),
          timestamp: Date.now(),
          ...(lastUserMsgId ? { parentID: lastUserMsgId } : {}),
        };
        const newSessionMessages = sessionId
          ? { ...get().sessionMessages, [sessionId]: [...(get().sessionMessages[sessionId] ?? []), errorMsg] }
          : get().sessionMessages;
        set((s) => {
          // Clear safety timer on error
          const timer = s._safetyTimer;
          if (timer) clearTimeout(timer);
          return {
            isStreaming: false,
            _sendInProgress: false,
            streamingContent: "",
            thinkingContent: "",
            pendingToolCalls: [],
            pendingActivities: [],
            _safetyTimer: null,
            messages: [...s.messages, errorMsg],
            sessionMessages: newSessionMessages,
            chatSessions: s.session
              ? s.chatSessions.map((cs) =>
                  cs.id === (s.session?.id ?? "")
                    ? { ...cs, status: "error", lastActivityAt: Date.now() }
                    : cs
                )
              : s.chatSessions,
          };
        });
        if (sessionId) {
          savePersistedMessages(newSessionMessages);
          savePersistedSessionSummaries(get().chatSessions);
        }
        break;
      }
      case "usage": {
        if (import.meta.env.DEV) {
          console.log("[Usage]", event.usage);
        }
        break;
      }
      default:
        devWarn("Unknown stream event type:", (event as { type: string }).type);
        break;
    }
  },

  reset() {
    // Clear safety timer on reset
    const currentTimer = get()._safetyTimer;
    if (currentTimer) clearTimeout(currentTimer);
    get()._clearAutoRemoveTimers();
    _pendingResolutions.clear();
    _toolCallResolvers.clear();
    _messageQueueRetries.clear();
    // Abort all in-flight operations to prevent stale writes
    const controllers = get()._abortControllers;
    for (const [, controller] of controllers) {
      try {        controller.abort();} catch (e) { if (import.meta.env.DEV) devWarn("[Store] controller.abort();", e); }
    }
    // Clear compaction state
    const nextCompacting = new Set(get()._compactingSessions);
    nextCompacting.clear();
    set({
      session: null,
      messages: [],
      streamingContent: "",
      thinkingContent: "",
      isStreaming: false,
      pendingToolCalls: [],
      pendingActivities: [],
      todos: [],
      _pendingChanges: [],
      planApproval: null,
      _pendingVerification: null,
      messageQueue: [],
      runtimeState: createInitialRuntimeState(),
      activeSessionId: null,
      restoredVersionId: null,
      preRestoreMessages: null,
      _safetyTimer: null,
      _sendInProgress: false,
      subAgents: [],
      _abortControllers: new Map(),
      _compactingSessions: nextCompacting,
    });
  },

  setActiveSession(id) {
    const timer = get()._safetyTimer;
    if (timer) clearTimeout(timer);
    get()._clearAutoRemoveTimers();
    // NOTE: Don't clear _pendingResolutions or _toolCallResolvers here.
    // They survive across session switches so pending tool approvals can still
    // resolve after the user switches back to the original session.
    // _pendingResolutions.clear();
    // _toolCallResolvers.clear();
    const { session, abort, sessionMessages, sessionAgentName, isStreaming } = get();
    // Clean up stream listener for the old session before switching
    if (session) {
      const api = createDalamAPI();
      api.agent.cleanupStream(session.id);
    }
    // Save terminal state before switching sessions
    const activeSessionId = get().activeSessionId;
    if (activeSessionId) {
      useTerminal.getState().saveForSession(activeSessionId);
    }
    // Only abort if the current session is actually streaming
    if (session && isStreaming) void abort(session.id).catch((err) => devWarn("[Store] abort during session switch failed:", err));      if (!id) {
        if (useUI.getState().bottomPanelTab === "terminal") {
          useUI.getState().setBottomPanelOpen(false);
        }
        _messageQueueRetries.clear();
        set({
        activeSessionId: null,
        session: null,
        messages: [],
        isStreaming: false,
        streamingContent: "",
        thinkingContent: "",
        pendingToolCalls: [],
        pendingActivities: [],
        pendingAttachments: [],
        restoredVersionId: null,
        preRestoreMessages: null,
        taskPlan: null,
        taskPlanSummary: null,
        planApproval: null,
        _sendInProgress: false,
        messageQueue: [],
        _suppressSessionRestore: false,
        _safetyTimer: null,
        todos: [],
        _pendingChanges: [],
        subAgents: [],
        chatHistory: [],
        chatHistoryIdx: -1,
        doomLoopWarningCount: 0,
      });
      return;
    }
    const messages = sessionMessages[id] ?? [];
      const agent = sessionAgentName[id] ?? "build";
    useAgents.getState().setActiveAgent(agent);
    // Restore task plan from the last assistant message that had one
    let restoredTaskPlan: TaskPlanItem[] | null = null;
    let restoredTaskPlanSummary: string | null = null;
    let restoredTodos: import("@dalam/shared-types").TodoItem[] = [];
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === "assistant" && msg.taskPlan && msg.taskPlan.length > 0 && !restoredTaskPlan) {
        restoredTaskPlan = msg.taskPlan;
        restoredTaskPlanSummary = msg.taskPlanSummary ?? null;
      }
      if (msg.role === "assistant" && msg.todos && msg.todos.length > 0 && restoredTodos.length === 0) {
        restoredTodos = msg.todos;
      }
      if (restoredTaskPlan && restoredTodos.length > 0) break;
    }
    // Reconstruct the AgentSession object from stored data
    const chatSession = get().chatSessions.find((cs) => cs.id === id);
    if (!chatSession || !chatSession.workspacePath) {
      if (useUI.getState().bottomPanelTab === "terminal") {
        useUI.getState().setBottomPanelOpen(false);
      }
    } else {
      useTerminal.getState().ensureTabForCwd(chatSession.workspacePath);
    }
    // Restore terminal state for the new session
    if (id) {
      useTerminal.getState().restoreForSession(id);
      // Clear diff view — it's per-session
      useDiffView.getState().close();
      // Clear browser tabs — they're per-session
      useUI.getState().clearBrowserTabs();
    }
    const restoredSession: AgentSession | null = chatSession
      ? {
          id: chatSession.id,
          workspacePath: chatSession.workspacePath,
          model: chatSession.model ?? useSettings.getState().settings.selectedModel,
          mode: chatSession.mode,
          startedAt: chatSession.startedAt,
          messages,
          status: chatSession.status === "completed" ? "idle" : chatSession.status,
        }
      : null;
    _messageQueueRetries.clear();
    set({
      activeSessionId: id,
      session: restoredSession,
      messages,
      isStreaming: false,
      streamingContent: "",
      thinkingContent: "",
      pendingToolCalls: [],
      pendingActivities: [],
      pendingAttachments: [],
      restoredVersionId: null,
      planApproval: null,
      preRestoreMessages: null,
      taskPlan: restoredTaskPlan,
      taskPlanSummary: restoredTaskPlanSummary,
      _sendInProgress: false,
      messageQueue: [],
      todos: restoredTodos,
      _pendingChanges: [],
      _pendingVerification: null,
      subAgents: [],
      _suppressSessionRestore: false,
      chatHistory: [],
      chatHistoryIdx: -1,
      // Mark session as visited — clears status dots in sidebar
      ...(id ? { chatSessions: get().chatSessions.map((cs) => cs.id === id ? { ...cs, lastVisitedAt: Date.now() } : cs) } : {}),
    });
    if (id) savePersistedSessionSummaries(get().chatSessions);
  },

  renameSession(id, title) {
    set((s) => ({
      chatSessions: s.chatSessions.map((cs) =>
        cs.id === id ? { ...cs, title } : cs
      ),
    }));
    savePersistedSessionSummaries(get().chatSessions);
  },

  setSessionStatus(id, status) {
    set((s) => ({
      chatSessions: s.chatSessions.map((cs) =>
        cs.id === id ? { ...cs, status, lastActivityAt: Date.now() } : cs
      ),
    }));
    savePersistedSessionSummaries(get().chatSessions);
  },

  async removeSession(id) {
    const timer = get()._safetyTimer;
    if (timer) clearTimeout(timer);
    // Clear all auto-remove timers to prevent leaked timers firing on stale state
    get()._clearAutoRemoveTimers();
    // Wait for abort to complete before cleanup to avoid race conditions
    try {      await get().abort(id);} catch (e) { if (import.meta.env.DEV) devWarn("[Store] await get().abort(id);", e); }
    void stopRecording(id).catch((err) => devWarn("[Recording] stopRecording failed:", err));
    // cleanupStream is handled inside abort()'s finally block
    // Clean all per-session caches to prevent memory leaks
    _clearDoomLoopState(id);
    _clearContextOverflowRetries(id);
    delete _lastCompactionCounts[id];
    delete _lastCompactionAttempt[id];
    delete _compactionTier[id];
    delete _antiThrashTimestamps[id];
    _pruneTerminalCache(id);
    _terminalStateCache.delete(id);
    // Clean up tool cost records to prevent memory leaks
    try {
      const { clearSessionToolCosts } = await import("../lib/toolExecutor");
      clearSessionToolCosts(id);
    } catch (e) {
      if (import.meta.env.DEV) devWarn("[Store] import(\"../lib/toolExecutor\");:", e);
    }
    // Abort any in-progress compaction
    const nextCompacting = new Set(get()._compactingSessions);
    nextCompacting.delete(id);
    // Compute new state outside set() to avoid side effects in updater
    const s = get();
    const { [id]: _removed1, ...restVersions } = s.sessionVersions;
    const { [id]: _removed2, ...restMessages } = s.sessionMessages;
    const { [id]: _removed3, ...restAgents } = s.sessionAgentName;
    const { [id]: _removed4, ...restCompaction } = s.compactionSummaries;
    const newSessions = s.chatSessions.filter((cs) => cs.id !== id);
    const isActive = s.activeSessionId === id;
    // When removing the active session, auto-switch to the most recent remaining
    // session so the user doesn't end up on a blank screen.
    const nextActiveSessionId = isActive
      ? (newSessions.length > 0 ? [...newSessions].sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0))[0].id : null)
      : s.activeSessionId;
    // Persist to disk (outside set updater to avoid side effects during render)
    savePersistedVersions(restVersions);
    savePersistedMessagesImmediate(restMessages);
    void saveWorkspaceData();
    savePersistedAgents(restAgents);
    savePersistedSessionSummaries(newSessions);
    savePersistedCompactionSummaries(restCompaction);
    // Update state
    set({
      chatSessions: newSessions,
      activeSessionId: nextActiveSessionId,
      sessionVersions: restVersions,
      sessionMessages: restMessages,
      sessionAgentName: restAgents,
      compactionSummaries: restCompaction,
      _compactingSessions: nextCompacting,
      ...(isActive ? {
        messages: [],
        isStreaming: false,
        streamingContent: "",
        thinkingContent: "",
        pendingToolCalls: [],
        pendingActivities: [],
        pendingAttachments: [],
        restoredVersionId: null,
        preRestoreMessages: null,
        session: null,
        _sendInProgress: false,
      } : {}),
    });
  },

  async archiveSession(id: string): Promise<void> {
    const s = get();
    const session = s.chatSessions.find(cs => cs.id === id);
    if (!session) return;

    // Mark session as archived
    const updatedSessions = s.chatSessions.map(cs =>
      cs.id === id ? { ...cs, archived: true, archivedAt: Date.now() } : cs
    );

    // Move messages to archive storage (await before removal to prevent data loss)
    const messages = s.sessionMessages[id];
    const ws = useWorkspace.getState().workspaces.find(w => w.id === useWorkspace.getState().activeWorkspaceId);
    if (messages && ws) {
      try {
        const { scopeSafeExists, scopeSafeMkdir, scopeSafeWriteFile } = await import("@/lib/dalamAPI");
        const archiveDir = joinPath(ws.path, ".dalam/archive");
        if (!(await scopeSafeExists(archiveDir))) {
          const created = await scopeSafeMkdir(archiveDir, { recursive: true });
          if (!created) {
            devWarn("[Session] Failed to create archive directory, keeping messages in active storage");
            return;
          }
        }
        await scopeSafeWriteFile(joinPath(archiveDir, `${id}.json`), JSON.stringify(messages));
      } catch (err) {
        const msg = (err as Error)?.message ?? String(err);
        if (!msg.includes("forbidden") && !msg.includes("scope")) {
          devWarn("[Session] Failed to archive messages, keeping messages in active storage:", err);
        }
        // Don't remove from active storage if archive fails
        return;
      }
    }

    // Remove from active storage
    const { [id]: _removed, ...restMessages } = s.sessionMessages;
    const { [id]: _removedV, ...restVersions } = s.sessionVersions;

    set({
      chatSessions: updatedSessions,
      sessionMessages: restMessages,
      sessionVersions: restVersions,
    });
    savePersistedSessionSummaries(updatedSessions);
    savePersistedMessagesImmediate(restMessages);
    savePersistedVersions(restVersions);
  },

  restoreSession(id: string) {
    const s = get();
    const session = s.chatSessions.find(cs => cs.id === id);
    if (!session?.archived) return;

    const ws = useWorkspace.getState().workspaces.find(w => w.id === useWorkspace.getState().activeWorkspaceId);
    if (!ws) return;

    // Load archived messages
    void import("@/lib/dalamAPI").then(async ({ scopeSafeExists, scopeSafeReadFile }) => {
      const archivePath = joinPath(ws.path, ".dalam/archive", `${id}.json`);
      try {
        if (await scopeSafeExists(archivePath)) {
          const content = await scopeSafeReadFile(archivePath);
          if (!content) return;
          const messages = JSON.parse(content);

          // Unarchive session
          const updatedSessions = get().chatSessions.map(cs =>
            cs.id === id ? { ...cs, archived: false, archivedAt: undefined } : cs
          );

          set({
            chatSessions: updatedSessions,
            sessionMessages: { ...get().sessionMessages, [id]: messages },
          });
          savePersistedSessionSummaries(updatedSessions);
          savePersistedMessagesImmediate({ ...get().sessionMessages, [id]: messages });
          // Best-effort cleanup of archive file
          try {
            const { remove } = await import("@tauri-apps/plugin-fs");
            await remove(archivePath);
          } catch {
            // Ignore cleanup errors
          }
        }
      } catch (err) {
        const msg = (err as Error)?.message ?? String(err);
        if (!msg.includes("forbidden") && !msg.includes("scope")) {
          devWarn("[Session] Failed to restore archived session:", err);
        }
      }
    });
  },

  approvePlan() {
    const { agentMode, planApproval, session } = get();
    const planContent = planApproval?.planContent ?? null;
    set({ planApproval: null });
    if (agentMode === "plan" && planContent) {
      // Set _pendingVerification so verification runs after plan execution
      if (session?.workspacePath) {
        set({ _pendingVerification: { workspacePath: session.workspacePath, planContent } });
      }
      const buildMode = "build" as import("@dalam/shared-types").AgentSessionMode;
      set({ agentMode: buildMode });
      useAgents.getState().setActiveAgent(buildMode);
      // Auto-send a message in build mode to execute the approved plan
      setTimeout(() => {
        const state = get();
        if (!state.isStreaming && !state._sendInProgress) {
          const executeMsg = `The user approved the plan. Execute it now.\n\nPlan:\n${planContent}`;
          void state.sendMessage(executeMsg);
        }
      }, 500);
    }
  },
  setAgentMode(mode) {
    set({ agentMode: mode });
    // Sync with agents store so the active agent matches the requested mode
    // This ensures sendMessage uses the correct agent name for permission evaluation
    useAgents.getState().setActiveAgent(mode);
  },

  rejectPlan() {
    const { planApproval, activeSessionId, agentMode } = get();
    if (planApproval && activeSessionId) {
      // Save the rejected plan as a version so user can go back
      get().saveVersion(activeSessionId, "Plan rejected — replan");
    }
    set({ planApproval: null });
    // Switch back to plan mode so user can provide feedback and the AI can replan
    if (agentMode === "build") {
      get().setAgentMode("plan" as import("@dalam/shared-types").AgentSessionMode);
    }
  },

  addPendingAttachment(file) {
    set((s) => ({ pendingAttachments: [...s.pendingAttachments, file] }));
  },

  removePendingAttachment(id) {
    set((s) => ({ pendingAttachments: s.pendingAttachments.filter((a) => a.id !== id) }));
  },

  clearPendingAttachments() {
    set({ pendingAttachments: [] });
  },

  addToQueue(content, attachments) {
    const id = "q-" + crypto.randomUUID();
    set((s) => ({
      messageQueue: [...s.messageQueue, { id, content, attachments, timestamp: Date.now() }],
    }));
  },

  removeFromQueue(id) {
    set((s) => ({
      messageQueue: s.messageQueue.filter((q) => q.id !== id),
    }));
  },

  reorderQueue(fromIdx, toIdx) {
    set((s) => {
      const queue = [...s.messageQueue];
      if (fromIdx < 0 || fromIdx >= queue.length) return {};
      if (toIdx < 0 || toIdx >= queue.length) return {};
      const [moved] = queue.splice(fromIdx, 1);
      queue.splice(toIdx, 0, moved);
      return { messageQueue: queue };
    });
  },

  editQueueItem(id, content) {
    set((s) => ({
      messageQueue: s.messageQueue.map((q) => q.id === id ? { ...q, content } : q),
    }));
  },

  steerQueueItem(id) {
    // Move the item to the front and send it immediately
    const { messageQueue } = get();
    const item = messageQueue.find((q) => q.id === id);
    if (!item) return;
    // Atomically check streaming state and either move to front or remove+send
    // This prevents the race where streaming starts between check and removal
    set((s) => {
      // Re-check isStreaming inside set to get fresh state
      if (s.isStreaming) {
        // Streaming started — move to front instead of sending
        const filtered = s.messageQueue.filter((q) => q.id !== id);
        return { messageQueue: [item, ...filtered] };
      }
      // Not streaming — remove from queue and send
      const updatedQueue = s.messageQueue.filter((q) => q.id !== id);
      return { messageQueue: updatedQueue };
    });
    // Send outside of set to avoid race — only if still not streaming
    setTimeout(() => {
      const state = get();
      if (!state.isStreaming) {
        void state.sendMessage(item.content);
      }
      // If streaming started, item is already at front of queue and will be sent later
    }, 0);
  },

  clearQueue() {
    _messageQueueRetries.clear();
    set({ messageQueue: [] });
  },

  injectSystemMessage(content) {
    const sessionId = get().activeSessionId;
    if (!sessionId) return;
    const sysMsg: ChatMessage = {
      id: "sys-" + crypto.randomUUID(),
      role: "system",
      content,
      timestamp: Date.now(),
    };
    set((s) => {
      const sessionMsgs = {
        ...s.sessionMessages,
        [sessionId]: [...(s.sessionMessages[sessionId] ?? []), sysMsg]
      };
      return {
        messages: [...s.messages, sysMsg],
        sessionMessages: sessionMsgs,
        chatSessions: s.chatSessions.map(cs =>
          cs.id === sessionId ? { ...cs, messageCount: (cs.messageCount ?? 0) + 1 } : cs
        ),
      };
    });
    savePersistedMessages(get().sessionMessages);
  },

  /**
   * Run verification after plan execution completes.
   * Checks auto-detected commands and file changes, then injects results.
   * If required checks fail, switches back to plan mode for replanning.
   */
  async verifyAfterPlanExecution() {
    const state = get();
    if (!state._pendingVerification) return;
    const { workspacePath } = state._pendingVerification;
    set({ _pendingVerification: null });
    try {
      const { buildDefaultCriteria, runVerificationPipeline } = await import("@/lib/verificationEngine");
      const criteria = await buildDefaultCriteria(workspacePath);
      if (criteria.verificationCommands.length === 0) return;
      const changeList = state._pendingChanges.length > 0
        ? state._pendingChanges
        : state.messages.flatMap(m => m.fileChanges ?? []);
      const result = await runVerificationPipeline(criteria, changeList, workspacePath);
      const content = [
        `## Verification Results ${result.status === "passed" ? "✅" : "❌"}`,
        `**Duration:** ${result.durationMs}ms`,
        `**Status:** ${result.status}`,
        result.summary,
      ].join("\n");
      const verifMsg: ChatMessage = {
        id: "verif-" + crypto.randomUUID(),
        role: "system",
        content,
        timestamp: Date.now(),
      };
      const sessionId = get().activeSessionId;
      if (sessionId) {
        const updatedSessionsMsg = { ...get().sessionMessages, [sessionId]: [...(get().sessionMessages[sessionId] ?? []), verifMsg] };
        set({
          messages: [...get().messages, verifMsg],
          sessionMessages: updatedSessionsMsg,
        });
        savePersistedMessages(updatedSessionsMsg);
      }
      // If verification failed with required checks, switch back to plan mode for self-correction
      // Only switch if currently in build mode and there are actual required check failures
      if (result.status !== "passed" && get().agentMode === "build") {
        const requiredFailed = result.commandResults.some(r => r.required && !r.passed);
        if (requiredFailed) {
          get().setAgentMode("plan" as import("@dalam/shared-types").AgentSessionMode);
          set({ planApproval: { planContent: `The previous plan needs corrections.\n\n${result.summary}\n\nPlease revise the plan and propose fixes.`, status: "pending" } });
        }
      }
    } catch (err) {
      devWarn("[Verification] Failed to run verification:", err);
    }
  },

  saveVersion(sessionId, label) {
    const { messages, sessionVersions } = get();
    if (!messages.length) return;
    const versions = sessionVersions[sessionId] ?? [];
    const parentId = versions.length > 0 ? versions[versions.length - 1].id : undefined;
    const version: import("@dalam/shared-types").ChatVersion = {
      id: "ver-" + crypto.randomUUID(),
      sessionId,
      label,
      messages: [...messages].map(m => ({
        ...m,
        ...(m.toolCalls ? { toolCalls: m.toolCalls.map(tc => ({ ...tc, diff: undefined, diffId: undefined })) } : {}),
      })),
      timestamp: Date.now(),
      parentVersionId: parentId,
    };
    // Cap at 50 versions per session to prevent localStorage bloat
    const newVersions = [...versions, version].slice(-50);
    const newSessionVersions = { ...sessionVersions, [sessionId]: newVersions };
    set({
      sessionVersions: newSessionVersions,
      chatSessions: get().chatSessions.map((s) =>
        s.id === sessionId ? { ...s, versionCount: newVersions.length } : s
      ),
    });
    savePersistedVersions(newSessionVersions);
    savePersistedSessionSummaries(get().chatSessions);
  },

  restoreVersion(sessionId, versionId) {
    const { messages, sessionVersions, sessionMessages, isStreaming, chatSessions } = get();
    if (isStreaming) return; // Don't restore while streaming
    const versions = sessionVersions[sessionId];
    if (!versions) return;
    const version = versions.find((v) => v.id === versionId);
    if (!version) return;
    // Strip stale diff artifacts but preserve tool results for context (Phase 6.3)
    const restoredMessages = [...version.messages].map((m) => ({
      ...m,
      toolCalls: m.toolCalls ? m.toolCalls.map((tc) => ({
        ...tc,
        result: tc.result,  // Preserve result for context
        diff: undefined,    // Diff is stale, remove
        diffId: undefined,
        status: "completed" as const,
      })) : m.toolCalls,
    }));
    const newSessionMessages = { ...sessionMessages, [sessionId]: restoredMessages };
    const lastUserMsg = [...restoredMessages].reverse().find((m) => m.role === "user");
    const preview = lastUserMsg
      ? lastUserMsg.content.length > 60 ? lastUserMsg.content.slice(0, 57) + "…" : lastUserMsg.content
      : undefined;
    set({
      preRestoreMessages: [...messages],
      messages: restoredMessages,
      sessionMessages: newSessionMessages,
      restoredVersionId: versionId,
      streamingContent: "",
      thinkingContent: "",
      pendingToolCalls: [],
      pendingActivities: [],
      planApproval: null,
      chatSessions: chatSessions.map((cs) =>
        cs.id === sessionId
          ? { ...cs, messageCount: restoredMessages.length, lastActivityAt: Date.now(), ...(preview ? { preview } : {}) }
          : cs
      ),
    });
    savePersistedMessages(newSessionMessages);
    savePersistedSessionSummaries(get().chatSessions);
    useWorkspace.getState().setActiveFile(null);
  },

  confirmVersionRestore() {
    const { messages, activeSessionId, sessionMessages, chatSessions } = get();
    // Persist the current (restored) messages as the session's messages
    if (activeSessionId) {
      const newSessionMessages = { ...sessionMessages, [activeSessionId]: [...messages] };
      const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
      const preview = lastUserMsg
        ? lastUserMsg.content.length > 60 ? lastUserMsg.content.slice(0, 57) + "…" : lastUserMsg.content
        : undefined;
      set({
        restoredVersionId: null,
        preRestoreMessages: null,
        sessionMessages: newSessionMessages,
        pendingToolCalls: [],
        pendingActivities: [],
        _pendingChanges: [],
        chatSessions: chatSessions.map((cs) =>
          cs.id === activeSessionId
            ? { ...cs, messageCount: messages.length, lastActivityAt: Date.now(), ...(preview ? { preview } : {}) }
            : cs
        ),
      });
      savePersistedMessages(newSessionMessages);
      savePersistedSessionSummaries(get().chatSessions);
    } else {
      set({ restoredVersionId: null, preRestoreMessages: null, pendingToolCalls: [], pendingActivities: [], _pendingChanges: [] });
    }
  },

  cancelVersionRestore() {
    const { preRestoreMessages, activeSessionId, sessionMessages, chatSessions } = get();
    if (!preRestoreMessages || !activeSessionId) return;
    const restoredMessages = [...preRestoreMessages];
    const newSessionMessages = { ...sessionMessages, [activeSessionId]: restoredMessages };
    const lastUserMsg = [...restoredMessages].reverse().find((m) => m.role === "user");
    const preview = lastUserMsg
      ? lastUserMsg.content.length > 60 ? lastUserMsg.content.slice(0, 57) + "…" : lastUserMsg.content
      : undefined;
    set({
      messages: restoredMessages,
      sessionMessages: newSessionMessages,
      restoredVersionId: null,
      preRestoreMessages: null,
      pendingToolCalls: [],
      pendingActivities: [],
      _pendingChanges: [],
      chatSessions: chatSessions.map((cs) =>
        cs.id === activeSessionId
          ? { ...cs, messageCount: restoredMessages.length, lastActivityAt: Date.now(), ...(preview ? { preview } : {}) }
          : cs
      ),
    });
    savePersistedMessages(newSessionMessages);
    savePersistedSessionSummaries(get().chatSessions);
  },

  deleteVersion(sessionId, versionId) {
    set((s) => {
      const versions = (s.sessionVersions[sessionId] ?? []).filter((v) => v.id !== versionId);
      return {
        sessionVersions: { ...s.sessionVersions, [sessionId]: versions },
        chatSessions: s.chatSessions.map((ss) =>
          ss.id === sessionId ? { ...ss, versionCount: versions.length } : ss
        ),
        ...(s.restoredVersionId === versionId ? { restoredVersionId: null, preRestoreMessages: null } : {}),
      };
    });
    savePersistedVersions(get().sessionVersions);
  },

  async compactSessionHistory(sessionId) {
    const { sessionMessages, selectedModelId, compactionSummaries, _compactingSessions } = get();
    if (_compactingSessions.has(sessionId)) return;
    // Create AbortController for cancellable compaction
    const compactController = new AbortController();
    // Atomically update the Map to avoid race condition with concurrent compactions
    set((s) => {
      const next = new Map(s._abortControllers);
      next.set(sessionId + "-compact", compactController);
      return { _abortControllers: next };
    });
    const messages = sessionMessages[sessionId];
    if (!messages || messages.length <= 6) return;

    // Anti-thrashing: skip if last compaction was ineffective (Hermes pattern)
    const lastCount = _lastCompactionCounts[sessionId];
    const lastSkip = _antiThrashTimestamps[sessionId];
    if (lastCount && lastCount < 0) {
      // Last compaction was ineffective — skip if within cooldown window
      if (lastSkip && Date.now() - lastSkip < ANTI_THRASH_SKIP_MS) {
        return;
      }
      // Cooldown expired — allow one retry
    }

    // Compaction throttle: don't attempt more than once per 30 seconds
    const lastAttempt = _lastCompactionAttempt[sessionId] ?? 0;
    if (Date.now() - lastAttempt < COMPACTION_THROTTLE_MS) return;
    _lastCompactionAttempt[sessionId] = Date.now();
    _pruneCompactionMaps(sessionId);

    // Minimum message count gate
    if (messages.length < COMPACTION_MIN_MESSAGES) return;

    // Create new Set first to avoid mutating the existing one
    const nextCompacting = new Set(_compactingSessions);
    nextCompacting.add(sessionId);
    set({ _compactingSessions: nextCompacting });

    try {
      // Look up the model's actual context window
      const modelId = selectedModelId || useSettings.getState().settings.selectedModel;
      const allModels = useModelProviders.getState().getAllModels();
      const found = allModels.find((m) => m.model.modelId === modelId);
      const maxContext = parseContextWindow(found?.model?.contextWindow);
      // Apply context budget reduction from overflow retries to prevent infinite loops
      const budgetFactor = _contextBudgetFactor[sessionId] ?? 1.0;
      const reducedMaxContext = Math.round(maxContext * budgetFactor);


      // Use context manager to determine what to compact
      const stats = computeContextStats(messages, reducedMaxContext);
      const currentTier = _compactionTier[sessionId] ?? 0;

      // Tier 1: Lightweight tool output pruning at 50% (no LLM call)
      const tier1Threshold = budgetFactor < 1.0
        ? CTX.TIER1_PRUNE_RATIO * 0.75
        : CTX.TIER1_PRUNE_RATIO;
      if (stats.pressureRatio >= tier1Threshold && currentTier < 1) {
        const { pruned, tokensReclaimed } = tier1PruneToolOutputs(messages);
        if (tokensReclaimed > 0) {
          _compactionTier[sessionId] = 1;
          set((s) => {
            const nextMessages = { ...s.sessionMessages, [sessionId]: pruned };
            const isActiveSession = s.activeSessionId === sessionId;
            return {
              sessionMessages: nextMessages,
              ...(isActiveSession ? { messages: pruned } : {}),
            };
          });
          savePersistedMessages(get().sessionMessages);
          if (import.meta.env.DEV) console.log(`[Compaction] Tier 1: pruned ~${tokensReclaimed} tokens from old tool outputs at ${(stats.pressureRatio * 100).toFixed(0)}% context usage.`);
        }
      }

      // Recompute stats after Tier 1 pruning so Tier 2 decisions use fresh data
      const freshStats = computeContextStats(
        get().sessionMessages[sessionId] ?? messages,
        reducedMaxContext
      );

      // Tier 2: Full LLM summarization at 85% (using TIER2_COMPACT_RATIO)
      const tier2Threshold = budgetFactor < 1.0
        ? CTX.TIER2_COMPACT_RATIO * 0.8
        : CTX.TIER2_COMPACT_RATIO;
      if (freshStats.pressureRatio >= tier2Threshold) {
        // Use LIVE store messages (not stale snapshot) to avoid Tier 2 overwriting Tier 1 pruning.
        const liveMessages = get().sessionMessages[sessionId] ?? messages;
        const { toCompact } = selectMessagesForCompaction(liveMessages, 6);
        if (toCompact.length > 0) {
          // Only prune tool outputs in the messages being compacted (preserve full outputs in kept messages)
          // Use freshStats (post Tier 1) instead of stale stats for accurate pruning decision
          const prunedToCompact = freshStats.shouldPrune
            ? pruneToolOutputs(toCompact).pruned
            : toCompact;

          const api = createDalamAPI();
          const previousSummary = compactionSummaries[sessionId];

          // Use the structured SUMMARY_TEMPLATE format (Goal/Instructions/Discoveries/Accomplished)
          const compactionMessages = buildCompactionPrompt(prunedToCompact, previousSummary);

          const model = selectedModelId || useSettings.getState().settings.selectedModel;
          const summary = await api.agent.summarizeMessages(model, compactionMessages);
          if (summary) {
            _compactionTier[sessionId] = 2;
            set((s) => {
              // Re-read LIVE messages inside updater to avoid losing messages
              // that arrived during the LLM summarize call (async gap).
              const currentMessages = s.sessionMessages[sessionId] ?? liveMessages;
              const currentIndices = new Set(toCompact.map(m => currentMessages.indexOf(m)).filter(i => i >= 0));
              const toKeepNow = currentMessages.filter((_, i) => !currentIndices.has(i));
              const summaryMsg: ChatMessage = {
                id: "compact-" + crypto.randomUUID(),
                role: "system",
                content: `[Conversation summary]\n${summary}`,
                timestamp: Date.now(),
              };
              const compactedNow = [summaryMsg, ...toKeepNow];
              const nextSummaries = { ...s.compactionSummaries, [sessionId]: summary };
              const nextMessages = { ...s.sessionMessages, [sessionId]: compactedNow };
              const isActiveSession = s.activeSessionId === sessionId;
              return {
                compactionSummaries: nextSummaries,
                sessionMessages: nextMessages,
                ...(isActiveSession ? { messages: compactedNow } : {}),
              };
            });
            savePersistedCompactionSummaries(get().compactionSummaries);
            savePersistedMessages(get().sessionMessages);

            // Anti-thrashing: track savings (Hermes ineffective compression detection)
            const postCompactionMessages = get().sessionMessages[sessionId] ?? [];
            const savingsPercent = liveMessages.length > 0
              ? ((liveMessages.length - postCompactionMessages.length) / liveMessages.length) * 100
              : 0;
            if (savingsPercent < COMPACTION_MIN_SAVINGS_PERCENT) {
              // Ineffective — mark with negative count and record skip timestamp
              _lastCompactionCounts[sessionId] = -liveMessages.length;
              _antiThrashTimestamps[sessionId] = Date.now();
              devWarn(`[Compaction] Anti-thrashing: savings ${savingsPercent.toFixed(1)}% < ${COMPACTION_MIN_SAVINGS_PERCENT}% threshold. Skipping for ${ANTI_THRASH_SKIP_MS / 1000}s.`);
            } else {
              // Effective — record positive count
              _lastCompactionCounts[sessionId] = postCompactionMessages.length;
              delete _antiThrashTimestamps[sessionId]; // Clear skip timestamp on success
            }
          }
        }
      }
    } catch (e) {
      devWarn("Background compaction failed:", e);
      pushWarningToast("Compaction failed", "Background compaction encountered an error. Context may grow beyond limits.");
    } finally {
      const remaining = new Set(get()._compactingSessions);
      remaining.delete(sessionId);
      // Clean up the AbortController now that compaction is done
      set((s) => {
        const next = new Map(s._abortControllers);
        next.delete(sessionId + "-compact");
        return { _compactingSessions: remaining, _abortControllers: next };
      });
    }
  },

  async resolveToolApproval(toolCallId, decision, result) {
    // Guard: if tool already reached a terminal state, ignore duplicate resolution
    const existingTool = get().pendingToolCalls.find((tc) => tc.id === toolCallId);
    if (existingTool && (existingTool.status === "completed" || existingTool.status === "failed")) return;

    // First, resolve via direct callback if registered (avoids polling races)
    const resolver = _toolCallResolvers.get(toolCallId);
    if (resolver) _toolCallResolvers.delete(toolCallId);
    const finalDecision = resolver ? await resolver(decision) : undefined;
    // If the resolver already handled the side effects, we may still need
    // to update the store for UI consistency. The resolver returns the
    // effective decision (e.g., "denied" if already resolved).
    const effectiveDecision = finalDecision ?? decision;

    const api = createDalamAPI();
    const sessionId = get().activeSessionId;

    // Find tool: first in pendingToolCalls, then fall back to scanning messages
    let tool = get().pendingToolCalls.find((tc) => tc.id === toolCallId);
    if (!tool) {
      for (const msg of get().messages) {
        if (msg.toolCalls) {
          tool = msg.toolCalls.find((tc) => tc.id === toolCallId);
          if (tool) break;
        }
      }
    }

    // Save decision for waitForToolApproval to pick up if no resolver was registered yet
    // (fixes the race where auto-approved tools resolve before waitForToolApproval registers)
    if (!resolver) {
      _pendingResolutions.set(toolCallId, effectiveDecision);
    }

    // Handle diff approval/rejection
    if (tool?.diffId) {
      if (effectiveDecision === "approved") {
        try {
          if (sessionId) await api.agent.approveDiff(sessionId, tool.diffId);
        } catch (err) {
          if (import.meta.env.DEV) console.error("Failed to approve diff:", err);
          const failMsg = `Diff approval failed: ${err}`;
          set((s) => ({
            pendingToolCalls: s.pendingToolCalls.map((tc) =>
              tc.id === toolCallId ? { ...tc, status: "failed" as const, result: failMsg } : tc
            ),
            messages: s.messages.map((msg) =>
              msg.toolCalls?.some((tc) => tc.id === toolCallId)
                ? { ...msg, toolCalls: msg.toolCalls.map((tc) => tc.id === toolCallId ? { ...tc, status: "failed" as const, result: failMsg } : tc) }
                : msg
            ),
            sessionMessages: sessionId
              ? { ...s.sessionMessages, [sessionId]: (s.sessionMessages[sessionId] ?? []).map((msg) =>
                  msg.toolCalls?.some((tc) => tc.id === toolCallId)
                    ? { ...msg, toolCalls: msg.toolCalls.map((tc) => tc.id === toolCallId ? { ...tc, status: "failed" as const, result: failMsg } : tc) }
                    : msg
                ) }
              : s.sessionMessages,
          }));
          return;
        }
      } else {
        try {
          if (sessionId) await api.agent.rejectDiff(sessionId, tool.diffId);
        } catch (err) {
          if (import.meta.env.DEV) console.error("Failed to reject diff:", err);
        }
      }
    }

    // Update tool status in pendingToolCalls, messages, and sessionMessages
    const applyStatus = (tc: ToolCall) => ({
      ...tc,
      status: (effectiveDecision === "approved" ? "completed" : "failed") as ToolCall["status"],
      result: result ?? (effectiveDecision === "denied" ? "Denied by user" : undefined),
    });

    set((s) => {
      const sid = s.activeSessionId;
      return {
        pendingToolCalls: s.pendingToolCalls.map((tc) => tc.id === toolCallId ? applyStatus(tc) : tc),
        messages: s.messages.map((msg) =>
          msg.toolCalls?.some((tc) => tc.id === toolCallId)
            ? { ...msg, toolCalls: msg.toolCalls.map((tc) => tc.id === toolCallId ? applyStatus(tc) : tc) }
            : msg
        ),
        sessionMessages: sid
          ? { ...s.sessionMessages, [sid]: (s.sessionMessages[sid] ?? []).map((msg) =>
              msg.toolCalls?.some((tc) => tc.id === toolCallId)
                ? { ...msg, toolCalls: msg.toolCalls.map((tc) => tc.id === toolCallId ? applyStatus(tc) : tc) }
                : msg
            ) }
          : s.sessionMessages,
      };
    });
  },

  async newChat() {
    const { session } = get();
    // Abort first to stop any in-progress streaming before clearing state
    if (session) await get().abort(session.id).catch((err) => devWarn("[Store] abort in newChat failed:", err));
    // Re-read state after abort — abort's finally block may have modified chatSessions
    const latestSession = get().session;
    const latestMessages = get().messages;
    // Clean up all timers and state
    get()._clearAutoRemoveTimers();
    _pendingResolutions.clear();
    _toolCallResolvers.clear();
    const currentTimer = get()._safetyTimer;
    if (currentTimer) clearTimeout(currentTimer);
    // Stop trajectory recording for old session
    if (latestSession) void stopRecording(latestSession.id).catch((err) => devWarn("[Recording] stopRecording in newChat failed:", err));
    // Clear doom loop + context overflow + compaction state
    if (latestSession) {
      _clearDoomLoopState(latestSession.id);
      set({ doomLoopWarningCount: 0 });
      _clearContextOverflowRetries(latestSession.id);
      delete _compactionTier[latestSession.id];
      delete _lastCompactionCounts[latestSession.id];
      delete _lastCompactionAttempt[latestSession.id];
      delete _antiThrashTimestamps[latestSession.id];
      // Abort any in-progress compaction to prevent it writing back after session is removed
      const nextCompacting = new Set(get()._compactingSessions);
      nextCompacting.delete(latestSession.id);
      set({ _compactingSessions: nextCompacting });
    }
    if (latestSession && latestMessages.length > 0) {
      get().saveVersion(latestSession.id, "Session checkpoint");
    }
    const { chatHistory, chatHistoryIdx, chatSessions } = get();
    const trimmedHistory = chatHistoryIdx >= 0
      ? chatHistory.slice(0, chatHistoryIdx + 1)
      : chatHistory;
    const newHistory = latestMessages.length > 0
      ? [...trimmedHistory, latestMessages].slice(-20)
      : trimmedHistory;
    const finalizedSessions = latestSession && latestMessages.length > 0
      ? chatSessions.map((cs) =>
          cs.id === latestSession!.id
            ? {
                ...cs,
                status: cs.status === "running" ? ("completed" as const) : cs.status,
                lastActivityAt: Date.now(),
                lastVisitedAt: Date.now(),
              }
            : cs
        )
      : chatSessions;
    if (useUI.getState().bottomPanelTab === "terminal") {
      useUI.getState().setBottomPanelOpen(false);
    }
    _messageQueueRetries.clear();
    set({
      chatHistory: newHistory,
      chatHistoryIdx: -1,
      messages: [],
      pendingToolCalls: [],
      pendingActivities: [],
      streamingStartedAt: null,
      streamingContent: "",
      thinkingContent: "",
      isStreaming: false,
      _pendingChanges: [],
      _sendInProgress: false,
      pendingAttachments: [],
      session: null,
      activeSessionId: null,
      chatSessions: finalizedSessions,
      planApproval: null,
      restoredVersionId: null,
      preRestoreMessages: null,
      taskPlan: null,
      taskPlanSummary: null,
      subAgents: [],
      todos: [],
      messageQueue: [],
      _abortControllers: new Map<string, AbortController>(),
      runtimeState: createInitialRuntimeState(),
      _safetyTimer: null,
      _suppressSessionRestore: true,
    });
    savePersistedSessionSummaries(finalizedSessions);
  },

  goBackChat() {
    const { isStreaming, chatHistory, chatHistoryIdx, messages } = get();
    if (isStreaming) return false;
    const msgs = messages ?? [];
    if (chatHistoryIdx === -1) {
      if (chatHistory.length === 0) return false;
      const lastHist = chatHistory[chatHistory.length - 1];
      const matchesLast = lastHist && lastHist.length === msgs.length && lastHist.every((m, i) => m.id === msgs[i]?.id);
      const newHistory = msgs.length > 0 && !matchesLast ? [...chatHistory, msgs] : chatHistory;
      const targetIdx = msgs.length > 0 && !matchesLast ? Math.max(0, newHistory.length - 2) : newHistory.length - 1;
      if (targetIdx < 0 || targetIdx >= newHistory.length) return false;
      const restoredMessages = newHistory[targetIdx] ?? [];
      set({
        chatHistory: newHistory,
        chatHistoryIdx: targetIdx,
        messages: restoredMessages,
        pendingToolCalls: [],
        streamingContent: "",
        thinkingContent: "",
        isStreaming: false,
        _pendingChanges: [],
      });
      // Don't touch sessionMessages during navigation — debounced saveWorkspaceData
      // would persist historical snapshots and corrupt the user's actual conversation.
      return true;
    }
    if (chatHistoryIdx <= 0) return false;
    const newIdx = chatHistoryIdx - 1;
    const restoredMessages = chatHistory[newIdx] ?? [];
    set({
      chatHistoryIdx: newIdx,
      messages: restoredMessages,
      pendingToolCalls: [],
      streamingContent: "",
      thinkingContent: "",
      isStreaming: false,
      _pendingChanges: [],
    });
    return true;
  },

  goForwardChat() {
    const { isStreaming, chatHistory, chatHistoryIdx } = get();
    if (isStreaming) return false;
    if (chatHistoryIdx < 0 || chatHistoryIdx >= chatHistory.length - 1) return false;
    const newIdx = chatHistoryIdx + 1;
    const restoredMessages = chatHistory[newIdx] ?? [];
    set({
      chatHistoryIdx: newIdx,
      messages: restoredMessages,
      pendingToolCalls: [],
      streamingContent: "",
      thinkingContent: "",
      isStreaming: false,
      _pendingChanges: [],
    });
    // Don't touch sessionMessages during navigation — same reason as goBackChat.
    return true;
  },
}));

// Subscribe to model selection events from settings
void import("./events").then(({ eventBus }) => {
  eventBus.on("chat:model-selected", ({ modelId }) => {
    void useChat.getState().setSelectedModel(modelId);
  });
  // Handle workspace switching - abort streaming when workspace changes
  eventBus.on("workspace:switched", ({ workspaceId: _workspaceId }) => {
    const { session, isStreaming } = useChat.getState();
    if (session && isStreaming) {
      void useChat.getState().abort(session.id).catch((err) => devWarn("[Store] abort during workspace switch failed:", err));
    }
  });
});


