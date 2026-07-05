# Phase 1: Agent Runtime Contract

> **Priority:** High
> **Estimated Effort:** 1 week
> **Dependencies:** Phase 0 (Bug 2 fix)
> **Primary Files:** `agentRuntimeContract.ts` (435 lines), `useAppStore.ts` (5,564 lines)
> **Audit Status:** 5/8 claims verified — 2 not wired into execution, 1 needs check

## Current State Analysis

### State Machine Architecture

The agent runtime contract (`agentRuntimeContract.ts`) implements a reducer-based state machine with these **11 phases**:

```
idle → sending → streaming → streaming-pending-diffs (NEW)
  → tool-waiting-approval → tool-running
  → tool-retrying (NEW) / tool-timed-out (NEW)
  → tool-results → finalizing-message → idle
```

### Issues Found & Resolution Status

| # | Issue | Severity | Status |
|---|-------|----------|--------|
| 1 | `STREAM_MESSAGE_END` drops event when diffs pending | Critical | ✅ Fixed |
| 2 | No timeout transition for tool execution | High | 🟡 Phases defined but not wired into execution |
| 3 | No retry state for failed tools | High | 🟡 Phases defined but not wired into execution |
| 4 | `transitionLog` grows unbounded | Medium | ✅ Fixed (MAX_TRANSITION_LOG = 500) |
| 5 | `DIFF_TO_TOOL_CALL` map never cleaned | Medium | 🟡 Needs verification |
| 6 | Assertions only throw in VITEST | Medium | ✅ Fixed (also throws in DEV mode) |
| 7 | No concurrent tool approval support | Low | ❌ Not implemented |

### What's Verified Implemented

- ✅ `streaming-pending-diffs` phase in `AgentPhase` type
- ✅ `tool-retrying` / `tool-timed-out` phases in `AgentPhase` type
- ✅ `DIFF_RESOLVED` event type and handler
- ✅ `TOOL_TIMEOUT` / `TOOL_RETRY` event types
- ✅ `DIFF_TO_TOOL_CALL` cleared on `MESSAGE_END`
- ✅ DEV mode assertions (`import.meta.env.DEV`)
- ✅ `transitionLog` capped at 500 entries
- ✅ Transition table entries for all new phases

### What's NOT Implemented

- ❌ Tool timeout not wired into `useAppStore.ts` execution loop (no `TOOL_TIMEOUT` dispatch)
- ❌ Parallel execution not wired into main loop (`useAppStore.ts` uses sequential `for...of`)
- ❌ No retry logic integration (state machine accepts `TOOL_RETRY` but nothing emits it)

---

## Remaining Implementation Steps

### Step 1: Wire Tool Timeout into Execution

```typescript
// In useAppStore.ts tool execution section
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

### Step 2: Wire Parallel Execution

```typescript
import { executeToolCalls, groupToolCallsForExecution } from "./toolExecutor";

// In the agent loop, after tool parsing:
const batches = groupToolCallsForExecution(toolCalls);

for (const batch of batches) {
  if (batch.length === 1) {
    const result = await executeToolWithRetry(batch[0]);
    toolResults.push(result);
  } else {
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

---

## Success Criteria

- [x] Agent never gets stuck in any phase (streaming-pending-diffs added)
- [x] `transitionLog` capped at 500 entries
- [ ] Tool timeout forces recovery after 2 minutes
- [ ] Parallel execution works for read-only tools
- [x] All state transitions have tests
- [x] DEV mode throws on invariant violations
