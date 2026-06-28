#!/usr/bin/env python3
"""Apply all session changes to useAppStore.ts in one shot."""
import sys

with open('apps/desktop/src/renderer/store/useAppStore.ts', 'r') as f:
    content = f.read()

changes = []

# ===========================================================================
# 1. Add doom loop, anti-thrashing, and context overflow detection
# ===========================================================================
anchor = 'function savePersistedCompactionSummaries(summaries: Record<string, string>) {\n  try { localStorage.setItem(COMPACTION_SUMMARIES_KEY, JSON.stringify(summaries)); } catch (e) { console.warn("Failed to save compaction summaries:", e); }\n  void saveWorkspaceData();\n}'

new_block = anchor + """

// Compaction throttle: avoid redundant computeContextStats + summarization calls
const _lastCompactionAttempt: Record<string, number> = {};
const COMPACTION_THROTTLE_MS = 30_000;
const COMPACTION_MIN_MESSAGES = 10;

// Anti-thrashing: track compaction effectiveness to skip ineffective compactions.
// Negative = ineffective (abs = original msg count); positive = compacted msg count
const _lastCompactionCounts: Record<string, number> = {};
const COMPACTION_MIN_SAVINGS_PERCENT = 5;

// ============================================================================
// Doom Loop / Death Spiral Detection (inspired by Hermes ToolCallGuardrailController)
// Warns at DOOM_LOOP_THRESHOLD, hard-stops at DOOM_LOOP_HALT_THRESHOLD.
// ============================================================================
const DOOM_LOOP_THRESHOLD = 5;
const DOOM_LOOP_HALT_THRESHOLD = DOOM_LOOP_THRESHOLD * 2;
interface ToolCallRecord { name: string; args: string; }
const _toolCallHistory: Record<string, ToolCallRecord[]> = {};
const _toolFailureCounts: Record<string, Record<string, number>> = {};

type DoomLoopResult = { message: string; severity: "warn" | "halt" };

function _checkDoomLoop(sessionId: string, toolName: string, toolArgs: Record<string, unknown>): DoomLoopResult | null {
  const sig = `${toolName}:${JSON.stringify(toolArgs)}`;
  const history = _toolCallHistory[sessionId] ?? [];
  const failures = _toolFailureCounts[sessionId] ?? {};
  const currentCount = (failures[sig] ?? 0) + 1;
  failures[sig] = currentCount;
  _toolFailureCounts[sessionId] = failures;
  if (currentCount >= DOOM_LOOP_HALT_THRESHOLD) {
    return { message: `Doom loop HALTED: tool "${toolName}" has failed ${currentCount} times consecutively with identical arguments. The agentic loop has been stopped.`, severity: "halt" };
  }
  if (currentCount >= DOOM_LOOP_THRESHOLD) {
    return { message: `Doom loop detected: tool "${toolName}" has failed ${currentCount} times consecutively with identical arguments. The agent appears stuck in a death spiral.`, severity: "warn" };
  }
  const toolFailures = history.filter(h => h.name === toolName).length;
  if (toolFailures >= DOOM_LOOP_HALT_THRESHOLD) {
    return { message: `Tool guardrail HALTED: "${toolName}" has accumulated ${toolFailures} failures across this session. The agentic loop has been stopped.`, severity: "halt" };
  }
  if (toolFailures >= DOOM_LOOP_THRESHOLD * 2) {
    return { message: `Tool guardrail: "${toolName}" has accumulated ${toolFailures} failures across this session. Consider changing strategy.`, severity: "warn" };
  }
  return null;
}

function _recordToolFailure(sessionId: string, toolName: string, toolArgs: Record<string, unknown>) {
  const history = _toolCallHistory[sessionId] ?? [];
  history.push({ name: toolName, args: JSON.stringify(toolArgs) });
  _toolCallHistory[sessionId] = history.slice(-50);
}

function _clearToolFailure(sessionId: string, toolName: string, toolArgs: Record<string, unknown>) {
  const sig = `${toolName}:${JSON.stringify(toolArgs)}`;
  const failures = _toolFailureCounts[sessionId] ?? {};
  delete failures[sig];
  _toolFailureCounts[sessionId] = failures;
}

function _clearDoomLoopState(sessionId: string) {
  delete _toolCallHistory[sessionId];
  delete _toolFailureCounts[sessionId];
}

// ============================================================================
// Context Overflow Detection (inspired by OpenCode's auto-retry pattern)
// ============================================================================
const CONTEXT_OVERFLOW_PATTERNS = [
  /context[_ ]length[_ ]exceeded/i,
  /maximum[_ ]context[_ ]length/i,
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
];

function _isContextOverflowError(errorMsg: string): boolean {
  return CONTEXT_OVERFLOW_PATTERNS.some((p) => p.test(errorMsg));
}

const _contextOverflowRetries: Record<string, number> = {};
const MAX_CONTEXT_OVERFLOW_RETRIES = 2;

function _clearContextOverflowRetries(sessionId: string) {
  delete _contextOverflowRetries[sessionId];
}"""

if anchor in content:
    content = content.replace(anchor, new_block, 1)
    changes.append("OK: Added doom loop (with halt), anti-thrashing, context overflow detection")
else:
    changes.append("FAIL: savePersistedCompactionSummaries anchor not found")
    sys.exit(1)

# ===========================================================================
# 2. Throttled savePersistedMessages
# ===========================================================================
old_save_marker = 'function savePersistedMessages(messages: Record<string, import("@dalam/shared-types").ChatMessage[]>) {'
if old_save_marker in content:
    idx = content.index(old_save_marker)
    # Find the closing of this function (the next void saveWorkspaceData();)
    ws_marker = "void saveWorkspaceData();\n}"
    ws_idx = content.index(ws_marker, idx)
    old_fn = content[idx:ws_idx + len(ws_marker)]

    new_fn = """// Throttled message persistence: batches rapid localStorage writes during streaming.
let _saveMessagesTimer: ReturnType<typeof setTimeout> | null = null;
let _pendingMessagesRef: Record<string, import("@dalam/shared-types").ChatMessage[]> | null = null;
const SAVE_MESSAGES_DEBOUNCE_MS = 200;
if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", () => flushSavePersistedMessages());
}
type MessagesMap = Record<string, import("@dalam/shared-types").ChatMessage[]>;
function _doSavePersistedMessages(messages: MessagesMap) {
  try {
    localStorage.setItem(SESSION_MESSAGES_KEY, JSON.stringify(messages));
  } catch (e) {
    if (e instanceof DOMException && e.name === 'QuotaExceededError') {
      console.warn("[Storage] Quota exceeded - truncating tool results");
      const pruned = truncateToolResults(messages);
      try { localStorage.setItem(SESSION_MESSAGES_KEY, JSON.stringify(pruned)); } catch {
        console.warn("[Storage] Quota exceeded - trimming old message content");
        const pruned2 = trimOldMessages(pruned);
        try { localStorage.setItem(SESSION_MESSAGES_KEY, JSON.stringify(pruned2)); } catch {
          console.warn("[Storage] Quota exceeded - dropping oldest sessions");
          const pruned3 = dropOldestSessions(pruned2, 3);
          try { localStorage.setItem(SESSION_MESSAGES_KEY, JSON.stringify(pruned3)); } catch {
            console.error("[Storage] Failed to save messages even after aggressive pruning");
          }
        }
      }
    } else {
      console.warn("Failed to save messages:", e);
    }
  }
}
function savePersistedMessages(messages: MessagesMap) {
  _pendingMessagesRef = messages;
  if (_saveMessagesTimer) clearTimeout(_saveMessagesTimer);
  _saveMessagesTimer = setTimeout(() => {
    _saveMessagesTimer = null;
    if (_pendingMessagesRef) { const latest = _pendingMessagesRef; _pendingMessagesRef = null; _doSavePersistedMessages(latest); void saveWorkspaceData(); }
  }, SAVE_MESSAGES_DEBOUNCE_MS);
}
function flushSavePersistedMessages() {
  if (_saveMessagesTimer) { clearTimeout(_saveMessagesTimer); _saveMessagesTimer = null; }
  if (_pendingMessagesRef) { const latest = _pendingMessagesRef; _pendingMessagesRef = null; _doSavePersistedMessages(latest); void saveWorkspaceData(); }
}"""
    content = content[:idx] + new_fn + content[idx + len(old_fn):]
    changes.append("OK: Throttled savePersistedMessages")
else:
    changes.append("FAIL: savePersistedMessages not found")

# ===========================================================================
# 3. newChat cleanup
# ===========================================================================
extract_marker = 'const { session, abort, messages } = get();\n    if (session && messages.length > 0) {'
if extract_marker in content:
    cleanup = "\n    // Clear doom loop + context overflow + compaction state\n    if (session) {\n      _clearDoomLoopState(session.id);\n      _clearContextOverflowRetries(session.id);\n      delete _lastCompactionCounts[session.id];\n    }\n    if (session && messages.length > 0) {"
    content = content.replace(extract_marker, cleanup, 1)
    changes.append("OK: newChat cleanup")
else:
    changes.append("WARN: newChat cleanup pattern not found (may differ)")

# ===========================================================================
# 4. removeSession cleanup
# ===========================================================================
remove_marker = 'delete _lastCompactionAttempt[id];\n    _clearDoomLoopState(id);'
if remove_marker in content:
    new_remove = "delete _lastCompactionAttempt[id];\n    delete _lastCompactionCounts[id];\n    _clearDoomLoopState(id);\n    _clearContextOverflowRetries(id);"
    content = content.replace(remove_marker, new_remove, 1)
    changes.append("OK: removeSession cleanup")
else:
    changes.append("WARN: removeSession cleanup pattern not found")

# removeSession: use _doSavePersistedMessages directly
remove_msg = "savePersistedMessages(restMessages);"
if remove_msg in content:
    idx = content.index(remove_msg)
    # Only replace the first one (in removeSession)
    content = content[:idx] + "_doSavePersistedMessages(restMessages);\n      void saveWorkspaceData();" + content[idx + len(remove_msg):]
    changes.append("OK: removeSession uses direct save")
else:
    changes.append("WARN: removeSession savePersistedMessages not found")

# ===========================================================================
# 5. Doom loop tool-call handler with severity-based abort
# ===========================================================================
old_handler = '''        // Doom loop detection: check if agent is stuck calling the same failing tool
        const sessionId = get().activeSessionId;
        if (sessionId) {
          const doomMsg = _checkDoomLoop(sessionId, tool.name, tool.args);
          if (doomMsg) {
            console.warn("[Chat]", doomMsg);
            const doomWarning: ChatMessage = {
              id: "sys-" + Math.random().toString(36).slice(2, 9),
              role: "system",
              content: `**Warning**: ${doomMsg}\\n\\nThe agent may be stuck. Consider sending a different prompt to redirect it.`,
              timestamp: Date.now(),
            };
            set((s) => ({
              messages: [...s.messages, doomWarning],
            }));
          }
        }'''

new_handler = '''        // Doom loop detection: check if agent is stuck calling the same failing tool
        const sessionId = get().activeSessionId;
        if (sessionId) {
          const doomResult = _checkDoomLoop(sessionId, tool.name, tool.args);
          if (doomResult) {
            console.warn("[Chat]", doomResult.message);
            const prefix = doomResult.severity === "halt" ? "**\\ud83d\\uded1 Loop Terminated**" : "**Warning**";
            const suffix = doomResult.severity === "halt"
              ? "The agentic loop has been stopped automatically. Send a new prompt to continue."
              : "The agent may be stuck. Consider sending a different prompt to redirect it.";
            const doomWarning: ChatMessage = {
              id: "sys-" + Math.random().toString(36).slice(2, 9),
              role: "system",
              content: `${prefix}: ${doomResult.message}\\n\\n${suffix}`,
              timestamp: Date.now(),
            };
            set((s) => ({
              messages: [...s.messages, doomWarning],
            }));
            if (doomResult.severity === "halt") {
              void get().abort(sessionId);
              return;
            }
          }
        }'''

if old_handler in content:
    content = content.replace(old_handler, new_handler, 1)
    changes.append("OK: Tool-call handler now aborts on halt severity")
else:
    changes.append("FAIL: Tool-call doom loop handler not found")

# ===========================================================================
# 6. Context overflow auto-compaction in error handler
# ===========================================================================
error_case = '      case "error": {\n        const sessionId = get().activeSessionId;'
if error_case in content:
    idx = content.index(error_case)
    end_idx = idx + len(error_case)
    overflow_block = """
        if (sessionId && _isContextOverflowError(event.error)) {
          const retryCount = _contextOverflowRetries[sessionId] ?? 0;
          if (retryCount < MAX_CONTEXT_OVERFLOW_RETRIES) {
            _contextOverflowRetries[sessionId] = retryCount + 1;
            console.warn(`[Chat] Context overflow detected - compacting and retrying (attempt ${retryCount + 1}/${MAX_CONTEXT_OVERFLOW_RETRIES})`);
            const infoMsg: ChatMessage = { id: "sys-" + Math.random().toString(36).slice(2, 9), role: "system", content: `Context window exceeded. Compacting and retrying... (attempt ${retryCount + 1}/${MAX_CONTEXT_OVERFLOW_RETRIES})`, timestamp: Date.now() };
            const infoSM = sessionId ? { ...get().sessionMessages, [sessionId]: [...(get().sessionMessages[sessionId] ?? []), infoMsg] } : get().sessionMessages;
            set({ messages: [...get().messages, infoMsg], sessionMessages: infoSM });
            if (sessionId) savePersistedMessages(infoSM);
            const lastUserMsg = [...get().messages].reverse().find((m) => m.role === "user");
            if (lastUserMsg) {
              void get().compactSessionHistory(sessionId).then(() => {
                set((s) => {
                  const msgs = [...s.messages];
                  for (let i = msgs.length - 1; i >= 0; i--) { if (msgs[i].role === "user") { msgs.splice(i, 1); break; } }
                  const sid = s.activeSessionId;
                  const msgIds = new Set(msgs.map((m) => m.id));
                  const smsgs = sid ? (s.sessionMessages[sid] ?? []).filter((m) => msgIds.has(m.id)) : s.sessionMessages;
                  return { isStreaming: false, streamingContent: "", thinkingContent: "", pendingToolCalls: [], pendingActivities: [], messages: msgs, ...(sid ? { sessionMessages: { ...s.sessionMessages, [sid]: smsgs } } : {}) };
                });
                setTimeout(() => { void get().sendMessage(lastUserMsg.content); }, 500);
              }).catch((compactErr) => { console.warn("[Chat] Compaction failed:", compactErr); set({ isStreaming: false, streamingContent: "", thinkingContent: "", pendingToolCalls: [], pendingActivities: [] }); });
              break;
            }
          } else { delete _contextOverflowRetries[sessionId]; }
        }
"""
    content = content[:end_idx] + overflow_block + content[end_idx:]
    changes.append("OK: Context overflow auto-compaction in error handler")
else:
    changes.append("FAIL: error case not found")

# ===========================================================================
# 7. Anti-thrashing guard in compactSessionHistory
# ===========================================================================
throttle_marker = '_lastCompactionAttempt[sessionId] = Date.now();'
if throttle_marker in content:
    idx = content.index(throttle_marker)
    end = idx + len(throttle_marker)
    anti_thrift = "\n\n  // Anti-thrashing: skip compaction if previous attempt was ineffective\n  const prevCompactionResult = _lastCompactionCounts[sessionId];\n  if (prevCompactionResult !== undefined && prevCompactionResult < 0) {\n    const origMsgCount = Math.abs(prevCompactionResult);\n    if (messages.length < origMsgCount + COMPACTION_MIN_MESSAGES) { return; }\n    delete _lastCompactionCounts[sessionId];\n  }"
    content = content[:end] + anti_thrift + content[end:]
    changes.append("OK: Anti-thrashing guard in compactSessionHistory")
else:
    changes.append("WARN: throttle marker not found in compactSessionHistory")

# ===========================================================================
# 8. Anti-thrashing tracking after compaction
# ===========================================================================
compacted_marker = "const compacted = [summaryMsg, ...toKeep];"
if compacted_marker in content:
    idx = content.index(compacted_marker)
    set_close = content.find("});", idx)
    if set_close != -1:
        track = "\n            const ineffective = compacted.length >= messages.length * (1 - COMPACTION_MIN_SAVINGS_PERCENT / 100);\n            _lastCompactionCounts[sessionId] = ineffective ? -messages.length : compacted.length;"
        content = content[:set_close + 3] + track + content[set_close + 3:]
        changes.append("OK: Anti-thrashing tracking after compaction")
    else:
        changes.append("FAIL: set() closing not found")
else:
    changes.append("WARN: compacted marker not found")

with open('apps/desktop/src/renderer/store/useAppStore.ts', 'w') as f:
    f.write(content)

for c in changes:
    print(c)
