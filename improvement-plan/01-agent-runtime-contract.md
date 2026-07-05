# Phase 1: Agent Runtime Contract

> **Priority:** High
> **Estimated Effort:** 1 week
> **Dependencies:** Phase 0 (Bug 2 fix)
> **Primary Files:** `agentRuntimeContract.ts` (435 lines), `useAppStore.ts` (5,411 lines)

## Current State Analysis

### State Machine Architecture

The agent runtime contract (`agentRuntimeContract.ts`) implements a reducer-based state machine with these phases:

```
idle → sending → streaming → tool-waiting-approval → tool-running → tool-results → finalizing-message → idle
                                                                                                        ↑
                                                               aborted ←──────────────────────────────┘
```

**Current phases defined (line ~30):**
- `idle` — No active agent loop
- `sending` — Prompt sent to LLM, waiting for first token
- `streaming` — Receiving LLM response tokens
- `tool-waiting-approval` — Tool call awaiting user permission
- `tool-running` — Tool executing
- `tool-results` — Tool results being processed
- `finalizing-message` — Message finalization
- `aborted` — User cancelled

### Issues Found

| # | Issue | Severity | Line |
|---|-------|----------|------|
| 1 | `STREAM_MESSAGE_END` drops event when diffs pending | Critical | 287-294 |
| 2 | No timeout transition for tool execution | High | — |
| 3 | No retry state for failed tools | High | — |
| 4 | `transitionLog` grows unbounded | Medium | 338 |
| 5 | `DIFF_TO_TOOL_CALL` map never cleaned during streaming | Medium | 321 |
| 6 | Assertions only throw in VITEST | Medium | 371-374 |
| 7 | No concurrent tool approval support | Low | — |

---

## Improvement 1.1: Add Missing Phases

### New Phase Types

```typescript
export type AgentPhase =
  | "idle"
  | "sending"
  | "streaming"
  | "streaming-pending-diffs"  // NEW: Stream ended but diffs unresolved
  | "tool-waiting-approval"
  | "tool-running"
  | "tool-retrying"            // NEW: Tool failed, retrying
  | "tool-timed-out"           // NEW: Tool execution timed out
  | "tool-results"
  | "finalizing-message"
  | "aborted";
```

### New Event Types

```typescript
export type AgentEvent =
  | { type: "SEND_START" }
  | { type: "STREAM_START" }
  | { type: "STREAM_TOKEN"; token: string }
  | { type: "STREAM_END" }
  | { type: "TOOL_CALL"; toolCallId: string; name: string }
  | { type: "TOOL_APPROVED"; toolCallId: string }
  | { type: "TOOL_DENIED"; toolCallId: string }
  | { type: "TOOL_START"; toolCallId: string }
  | { type: "TOOL_COMPLETE"; toolCallId: string; success: boolean }
  | { type: "TOOL_TIMEOUT"; toolCallId: string }           // NEW
  | { type: "TOOL_RETRY"; toolCallId: string; attempt: number }  // NEW
  | { type: "DIFF_PROPOSED"; diffId: string; toolCallId: string }
  | { type: "DIFF_RESOLVED"; diffId: string }               // NEW
  | { type: "MESSAGE_END" }
  | { type: "ABORT" }
  | { type: "FINALIZE" };
```

### Transition Table

```
Current Phase          | Event              | New Phase
-----------------------|--------------------|------------------
idle                   | SEND_START         | sending
sending                | STREAM_START       | streaming
streaming              | STREAM_END         | idle (no tools) / tool-waiting-approval (with tools)
streaming              | STREAM_END (diffs) | streaming-pending-diffs
streaming-pending-diffs| DIFF_RESOLVED      | streaming-pending-diffs (more pending) / idle (all resolved)
tool-waiting-approval  | TOOL_APPROVED      | tool-running
tool-waiting-approval  | TOOL_DENIED        | tool-results
tool-running           | TOOL_COMPLETE      | tool-results
tool-running           | TOOL_TIMEOUT       | tool-timed-out
tool-running           | TOOL_RETRY         | tool-retrying
tool-retrying          | TOOL_COMPLETE      | tool-results
tool-retrying          | TOOL_TIMEOUT       | tool-timed-out
tool-timed-out         | MESSAGE_END        | idle
tool-results           | MESSAGE_END        | idle
any                    | ABORT              | aborted
```

---

## Improvement 1.2: Cap transitionLog

**File:** `agentRuntimeContract.ts`

```typescript
const MAX_TRANSITION_LOG = 500;

function addTransition(
  log: TransitionEntry[],
  from: AgentPhase,
  to: AgentPhase,
  event: string
): TransitionEntry[] {
  const entry = { from, to, event, timestamp: Date.now() };
  const newLog = [...log, entry];
  if (newLog.length > MAX_TRANSITION_LOG) {
    return newLog.slice(-MAX_TRANSITION_LOG);
  }
  return newLog;
}
```

---

## Improvement 1.3: Clean DIFF_TO_TOOL_CALL on Turn Boundary

**File:** `agentRuntimeContract.ts`

```typescript
// In the reducer, clear diff map on turn completion
case "MESSAGE_END":
  return {
    ...state,
    phase: "idle",
    diffToToolCall: new Map(),  // Clear on turn end
    transitionLog: addTransition(state.transitionLog, state.phase, "idle", "MESSAGE_END"),
  };
```

---

## Improvement 1.4: Make Assertions Throw in DEV Mode

**File:** `agentRuntimeContract.ts:371-374`

```typescript
// Current: only throws in VITEST
if (typeof process !== "undefined" && process.env?.VITEST) {
  throw new Error(message);
}

// Fix: throw in DEV mode too
const isDev = typeof import.meta !== "undefined" && import.meta.env?.DEV;
const isTest = typeof process !== "undefined" && process.env?.VITEST;
if (isDev || isTest) {
  throw new Error(`[AgentRuntimeContract] ${message}`);
} else {
  console.warn(`[AgentRuntimeContract] ${message}`);
}
```

---

## Improvement 1.5: Add Tool Timeout Transition

**File:** `agentRuntimeContract.ts`

```typescript
case "TOOL_TIMEOUT":
  if (state.phase === "tool-running") {
    return {
      ...state,
      phase: "tool-timed-out",
      transitionLog: addTransition(state.transitionLog, state.phase, "tool-timed-out", "TOOL_TIMEOUT"),
    };
  }
  return state; // Invalid transition
```

**Integration with `useAppStore.ts`:**

```typescript
// In tool execution, add timeout
const TOOL_EXECUTION_TIMEOUT_MS = 120_000; // 2 minutes

const toolTimeout = setTimeout(() => {
  agentDispatch({ type: "TOOL_TIMEOUT", toolCallId: tc.id });
}, TOOL_EXECUTION_TIMEOUT_MS);

try {
  const result = await executeTool(tc.name, tc.args);
  clearTimeout(toolTimeout);
  // ... handle result
} catch (err) {
  clearTimeout(toolTimeout);
  // ... handle error
}
```

---

## Improvement 1.6: Add Tool Retry State

**File:** `agentRuntimeContract.ts`

```typescript
case "TOOL_RETRY":
  if (state.phase === "tool-running" || state.phase === "tool-timed-out") {
    return {
      ...state,
      phase: "tool-retrying",
      retryCount: (state.retryCount || 0) + 1,
      transitionLog: addTransition(state.transitionLog, state.phase, "tool-retrying", "TOOL_RETRY"),
    };
  }
  return state;
```

---

## Improvement 1.7: Integrate Parallel Tool Execution

**File:** `useAppStore.ts` (tool execution section, lines 1687-1749)

Currently, tools are executed sequentially in a `for...of` loop. The `toolExecutor.ts` module already implements parallel batching but is unused.

### Current Sequential Execution

```typescript
// dalamAPI.ts lines 1687-1749
for (const tc of toolCalls) {
  const result = await executeTool(tc.name, tc.args);
  toolResults.push(result);
}
```

### New Parallel Execution

```typescript
import { executeToolCalls, groupToolCallsForExecution } from "./toolExecutor";

// In the agent loop, after tool parsing:
const batches = groupToolCallsForExecution(toolCalls);

for (const batch of batches) {
  if (batch.length === 1) {
    // Single tool: execute directly
    const result = await executeToolWithRetry(batch[0]);
    toolResults.push(result);
  } else {
    // Multiple tools: execute in parallel
    const results = await Promise.allSettled(
      batch.map(tc => executeToolWithRetry(tc))
    );
    for (const result of results) {
      if (result.status === "fulfilled") {
        toolResults.push(result.value);
      } else {
        toolResults.push({ error: result.reason?.message || "Tool execution failed" });
      }
    }
  }
}
```

### Parallel Execution Rules (from `toolExecutor.ts`)

- Read-only tools (`read_file`, `list_dir`, `grep_file`, `search_files`, git read tools, memory read tools) can run in parallel
- Write tools (`write_file`, `edit_file`, `run_command`, memory write tools) must run sequentially
- `git_commit` depends on `write_file`/`edit_file`

---

## Implementation Steps

1. Add new phases and events to `agentRuntimeContract.ts`
2. Implement transition table in reducer
3. Cap `transitionLog` at 500 entries
4. Clean `DIFF_TO_TOOL_CALL` on turn boundary
5. Make assertions throw in DEV mode
6. Add tool timeout transition and integrate with execution
7. Add tool retry state
8. Wire `toolExecutor.ts` parallel batching into main loop
9. Add tests for all new transitions
10. Add integration test: simulate tool-call → approval → result → diff → complete

---

## Success Criteria

- [ ] Agent never gets stuck in any phase
- [ ] `transitionLog` capped at 500 entries
- [ ] Tool timeout forces recovery after 2 minutes
- [ ] Parallel execution works for read-only tools
- [ ] All state transitions have tests
- [ ] DEV mode throws on invariant violations
