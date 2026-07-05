# Phase 0: Critical Bugs

> **Priority:** CRITICAL — Fix before any other work
> **Estimated Effort:** 1-2 days (remaining: 2 bugs)
> **Status:** ✅ 5/8 verified fixed — 2 still open, 1 needs verification
> **Dependencies:** None

## Overview

8 critical bugs identified across the codebase that can cause dead states, data loss, or security issues. After a full codebase audit (July 2026): **5 are verified fixed, 2 remain open, 1 needs deeper inspection.**

---

## Bug 1: Skill Crystallizer Budget Check Reads Wrong Directory

**File:** `apps/desktop/src/renderer/lib/skillCrystallizer.ts:154`
**Severity:** Critical
**Impact:** 50-skill cap is NEVER enforced — skills accumulate unboundedly
**Status:** 🔴 Not fixed

### Original Issue

`skillsDir` is `joinPath(workspacePath, .dalam/skills/${safeName})` — the specific skill directory being created. This reads 0 entries (directory doesn't exist yet) or 1 (if overwriting), so the budget check always passes.

### Fix Proposed

Change to read the skills root directory for the budget check.

---

## Bug 2: Agent Runtime Contract Silently Drops STREAM_MESSAGE_END

**File:** `apps/desktop/src/renderer/lib/agentRuntimeContract.ts`
**Severity:** Critical
**Impact:** Agent can get stuck in `streaming` phase forever with no recovery
**Status:** ✅ Fixed (Verified July 2026)

### What Was Done

- Added `streaming-pending-diffs` phase to `AgentPhase` type
- Added `pendingDiffToolCalls` field to state interface
- Added `DIFF_RESOLVED` event type and handler
- Transition table updated for the new phase
- `STREAM_MESSAGE_END` now transitions to `streaming-pending-diffs` instead of silently dropping

---

## Bug 3: Dream Agent Timing Stored in localStorage

**File:** `apps/desktop/src/renderer/lib/dreamAgent.ts`
**Severity:** Critical
**Impact:** Dream timing lost on localStorage clear
**Status:** ✅ Fixed (Verified July 2026)

### What Was Done

- `getLastDreamTime()` uses SQLite `kv_store` via `SELECT value FROM kv_store WHERE key = ?`
- `setLastDreamTime()` uses `INSERT OR REPLACE INTO kv_store`
- `triggerDreamCycleIfNeeded()` calls `getLastDreamTime()` to check last run time
- After a dream cycle, `setLastDreamTime()` records the timestamp
- Zero references to `localStorage` for dream timing — migration complete

---

## Bug 4: Dream Agent In-Place Mutation During Dedup

**File:** `apps/desktop/src/renderer/lib/dreamAgent.ts:450-452`
**Severity:** High
**Impact:** Processed already-merged pairs can be re-processed
**Status:** 🟡 Needs deeper inspection

Not yet verified. Requires tracing the dedup loop to confirm if `splice()` during iteration causes skipped elements.

---

## Bug 5: Connector Config Save Stops But Never Restarts

**File:** `apps/desktop/src/renderer/lib/connectors.ts:808-833`
**Severity:** High
**Impact:** Config changes require app restart
**Status:** ✅ Fixed (Verified July 2026)

### What Was Done

- `saveConnectorConfig()` stops the existing connector if running
- Then calls `initializeSingleConnector()` to restart with new config
- Error handling: restart failure is caught and logged, doesn't prevent save
- The `initializeSingleConnector` helper was already extracted from the loop

---

## Bug 6: MCP Cache TTL Parameter Never Used

**File:** `apps/desktop/src/renderer/lib/mcpCache.ts:63-69`
**Severity:** Medium
**Impact:** All entries use default 1h TTL
**Status:** ✅ Fixed (Verified July 2026)

### What Was Done

- `ttlMs` added to `CacheEntry` interface (required field)
- `cacheTools()` stores `ttlMs` in the entry at line 69
- `isExpired()` uses `entry.ttlMs ?? DEFAULT_TTL_MS` to check expiry
- Parameter is NOT prefixed with underscore — fully wired up

---

## Bug 7: Verification Engine contentPattern Never Checked

**File:** `apps/desktop/src/renderer/lib/verificationEngine.ts:38`
**Severity:** Medium
**Impact:** File content validation is dead code
**Status:** 🔴 Not fixed

### Original Issue

The `contentPattern` field in `ExpectedFileChange` is defined in the schema but never checked during verification.

### Fix Proposed

```typescript
// In checkExpectedFiles, add content pattern validation
async function checkExpectedFile(
  change: ExpectedFileChange,
  workspacePath: string
): Promise<{ passed: boolean; reason?: string }> {
  // ... existing checks ...
  
  if (change.contentPattern) {
    const content = await api.fs.readFile(filePath);
    const regex = new RegExp(change.contentPattern);
    if (!regex.test(content)) {
      return {
        passed: false,
        reason: `Content pattern not matched in ${change.filePath}`
      };
    }
  }
  
  return { passed: true };
}
```

---

## Bug 8: TransitionLog Grows Unbounded

**File:** `apps/desktop/src/renderer/lib/agentRuntimeContract.ts:338`
**Severity:** Medium
**Impact:** Memory leak in long sessions
**Status:** ✅ Fixed (Verified July 2026)

### What Was Done

- Added `const MAX_TRANSITION_LOG = 500` at line 398
- Capped array with `splice(0, newLog.length - MAX_TRANSITION_LOG)` at line 424-425
- Test coverage in `agentRuntimeContract.test.ts`

---

## Verification Checklist

After fixing all 8 bugs:

- [ ] `pnpm test` passes
- [ ] `pnpm lint` passes
- [ ] `pnpm typecheck` passes
- [ ] Manual test: create 50+ skills, verify budget enforced
- [ ] Manual test: run agent until `streaming-pending-diffs`, verify recovery
- [ ] Manual test: clear localStorage, verify dream timing persists (✅ already works)
- [ ] Manual test: modify connector config, verify restart (✅ already works)
- [ ] Manual test: cache MCP tools with custom TTL, verify honored
- [ ] Manual test: run verification with `contentPattern`, verify checked
- [ ] Manual test: run agent for 100+ tool calls, verify no memory growth
