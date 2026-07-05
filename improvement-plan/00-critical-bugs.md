# Phase 0: Critical Bugs

> **Priority:** CRITICAL — Fix before any other work
> **Estimated Effort:** 1-2 days
> **Dependencies:** None

## Overview

8 critical bugs identified across the codebase that can cause dead states, data loss, or security issues. These must be fixed before any feature work begins.

---

## Bug 1: Skill Crystallizer Budget Check Reads Wrong Directory

**File:** `apps/desktop/src/renderer/lib/skillCrystallizer.ts:154`
**Severity:** Critical
**Impact:** 50-skill cap is NEVER enforced — skills accumulate unboundedly

### Current State

```typescript
// Line 153-155: Reads the TARGET skill directory, not the skills root
const skillEntries = await readDir(skillsDir);
if (skillEntries.length >= 50) {
  // This checks the contents of the skill being CREATED, not total skills
```

`skillsDir` is `joinPath(workspacePath, .dalam/skills/${safeName})` — the specific skill directory being created. This reads 0 entries (directory doesn't exist yet) or 1 (if overwriting), so the budget check always passes.

### Fix

```typescript
// Correct: Read the skills ROOT directory
const skillsRootDir = joinPath(workspacePath, ".dalam/skills");
const allSkillEntries = await readDir(skillsRootDir);
if (allSkillEntries.length >= 50) {
  // Now correctly checks total skill count
```

### Implementation Steps

1. Read `skillCrystallizer.ts` lines 140-160
2. Change `skillsDir` to `joinPath(workspacePath, ".dalam/skills")` for the budget check
3. Keep the original `skillsDir` for the actual skill write
4. Add test: create 49 skills, verify 50th is rejected

### Success Criteria

- [ ] Creating skill #51 is rejected with appropriate message
- [ ] Existing skills are not affected
- [ ] Budget check reads correct directory

---

## Bug 2: Agent Runtime Contract Silently Drops STREAM_MESSAGE_END

**File:** `apps/desktop/src/renderer/lib/agentRuntimeContract.ts:287-294`
**Severity:** Critical
**Impact:** Agent can get stuck in `streaming` phase forever with no recovery

### Current State

```typescript
// Lines 287-294: Returns original state when unresolved diffs exist
if (unresolvedWithDiffs.length > 0) {
  // ... logs warning ...
  return state;  // <-- No phase transition! Event silently dropped.
}
```

When `STREAM_MESSAGE_END` fires but tool calls with `diffId` are still unresolved, the reducer returns the same state reference. The caller interprets this as "invalid transition" and drops the event. The agent remains in `streaming` phase with no way to recover.

### Fix

```typescript
// Add a new phase: streaming-with-pending-diffs
if (unresolvedWithDiffs.length > 0) {
  return {
    ...state,
    phase: "streaming-pending-diffs",
    pendingDiffToolCalls: unresolvedWithDiffs,
    transitionLog: [...state.transitionLog, { from: state.phase, to: "streaming-pending-diffs", event: "STREAM_MESSAGE_END" }]
  };
}

// Add transition handler for when diffs resolve
case "DIFF_RESOLVED":
  if (state.phase === "streaming-pending-diffs") {
    const remaining = state.pendingDiffToolCalls.filter(tc => tc.diffId !== action.diffId);
    if (remaining.length === 0) {
      return { ...state, phase: "idle", pendingDiffToolCalls: [] };
    }
    return { ...state, pendingDiffToolCalls: remaining };
  }
  return state;
```

### Implementation Steps

1. Add `streaming-pending-diffs` phase to `AgentPhase` type
2. Add `pendingDiffToolCalls` field to state interface
3. Handle the transition in the reducer
4. Add `DIFF_RESOLVED` event type
5. Add timeout: if stuck in `streaming-pending-diffs` for >10 minutes, force transition to `idle`

### Success Criteria

- [ ] Agent never gets stuck in `streaming` phase
- [ ] Pending diffs are tracked explicitly
- [ ] Timeout forces recovery after 10 minutes

---

## Bug 3: Dream Agent Timing Stored in localStorage

**File:** `apps/desktop/src/renderer/lib/dreamAgent.ts:548`
**Severity:** Critical
**Impact:** Dream timing lost on localStorage clear, causing dream cycles on every startup

### Current State

```typescript
// Line 548: Uses localStorage despite comment saying otherwise
const lastDreamStr = localStorage.getItem(`dalam.lastDreamTime.${workspacePath}`);
```

The comment block at lines 18-19 explicitly says "Previously used localStorage which was lost on workspace switch or browser clear." But the implementation still uses localStorage.

### Fix

```typescript
// Store in SQLite instead
import { getDb } from "./database";

async function getLastDreamTime(workspacePath: string): Promise<number> {
  const db = await getDb(workspacePath);
  const result = await db.select<{ value: string }[]>(
    "SELECT value FROM kv_store WHERE key = 'lastDreamTime'"
  );
  return result.length > 0 ? parseInt(result[0].value, 10) : 0;
}

async function setLastDreamTime(workspacePath: string, time: number): Promise<void> {
  const db = await getDb(workspacePath);
  await db.execute(
    "INSERT OR REPLACE INTO kv_store (key, value) VALUES ('lastDreamTime', ?)",
    [time.toString()]
  );
}
```

### Implementation Steps

1. Add `kv_store` table to database schema if not present
2. Replace `localStorage.getItem` with `getLastDreamTime()`
3. Replace `localStorage.setItem` with `setLastDreamTime()`
4. Add migration: read existing localStorage values and move to SQLite
5. Remove localStorage fallback

### Success Criteria

- [ ] Dream timing persists across localStorage clears
- [ ] Migration preserves existing timing data
- [ ] No localStorage access in dreamAgent.ts

---

## Bug 4: Dream Agent In-Place Mutation During Dedup Iteration

**File:** `apps/desktop/src/renderer/lib/dreamAgent.ts:450-452`
**Severity:** High
**Impact:** Already-merged memories can be re-processed in subsequent iterations

### Current State

```typescript
// Lines 450-452: Mutates objects in the iteration array
m1.stale = true;
m2.stale = true;
```

The `if (m1.stale || m2.stale) continue;` guard on line 389 handles this for the current iteration, but subsequent iterations in the same category loop may see stale flags on objects that were just merged.

### Fix

```typescript
// Track merged IDs in a Set instead of mutating
const mergedIds = new Set<string>();

for (const m1 of catMemories) {
  if (mergedIds.has(m1.id) || m1.stale) continue;
  
  for (const m2 of catMemories) {
    if (mergedIds.has(m2.id) || m2.stale || m1.id === m2.id) continue;
    
    const similarity = jaccardSimilarity(m1.content, m2.content);
    if (similarity <= 0.55) continue;
    
    // ... merge logic ...
    
    mergedIds.add(m1.id);
    mergedIds.add(m2.id);
    break; // m1 is merged, move to next
  }
}
```

### Implementation Steps

1. Add `mergedIds = new Set<string>()` before the category loop
2. Replace `m1.stale = true; m2.stale = true;` with `mergedIds.add(m1.id); mergedIds.add(m2.id);`
3. Add `mergedIds.has(m1.id)` and `mergedIds.has(m2.id)` to continue conditions
4. Keep the `markStale()` calls for database persistence

### Success Criteria

- [ ] No in-place mutation of iteration arrays
- [ ] Merged memories are never re-processed
- [ ] Same merge results as before (no behavioral change)

---

## Bug 5: Connector Config Save Stops But Never Restarts

**File:** `apps/desktop/src/renderer/lib/connectors.ts:806-811`
**Severity:** High
**Impact:** Connector config changes require app restart to take effect

### Current State

```typescript
// Lines 806-811: Stops connector but doesn't restart
const connector = connectors.get(config.id);
if (connector) {
  try { await connector.stop(); } catch { /* ignore */ }
  connectors.delete(config.id);
  // BUG: missing re-initialization
}
```

### Fix

```typescript
// After saving, re-initialize the connector
const connector = connectors.get(config.id);
if (connector) {
  try { await connector.stop(); } catch { /* ignore */ }
  connectors.delete(config.id);
}

// Re-initialize if enabled
if (config.enabled) {
  try {
    await initializeSingleConnector(config);
  } catch (err) {
    console.warn(`[Connectors] Failed to restart ${config.id}:`, err);
  }
}
```

### Implementation Steps

1. Extract `initializeSingleConnector` from `initializeConnectors` (currently lines 716-772 handle all configs)
2. Call `initializeSingleConnector` after config save
3. Add error handling for restart failure
4. Add test: save config, verify connector restarts

### Success Criteria

- [ ] Config changes take effect immediately
- [ ] Connector restarts with new settings
- [ ] Restart failure is handled gracefully

---

## Bug 6: MCP Cache TTL Parameter Never Used

**File:** `apps/desktop/src/renderer/lib/mcpCache.ts:62`
**Severity:** Medium
**Impact:** All MCP tool caches use default 1-hour TTL regardless of caller intent

### Current State

```typescript
// Line 62: _ttlMs is prefixed with underscore, never stored
export function cacheTools(
  serverName: string,
  tools: McpTool[],
  serverUrl?: string,
  _ttlMs: number = DEFAULT_TTL_MS  // <-- never stored or used
): void {
```

### Fix

```typescript
interface CacheEntry {
  tools: McpTool[];
  serverUrl?: string;
  cachedAt: number;
  ttlMs: number;  // Store the TTL
}

export function cacheTools(
  serverName: string,
  tools: McpTool[],
  serverUrl?: string,
  ttlMs: number = DEFAULT_TTL_MS
): void {
  const entry: CacheEntry = {
    tools,
    serverUrl,
    cachedAt: Date.now(),
    ttlMs,  // Actually store it
  };
  memoryCache.set(serverName, entry);
  // ... persist to localStorage with TTL
}

function isExpired(entry: CacheEntry): boolean {
  return Date.now() - entry.cachedAt > entry.ttlMs;  // Use stored TTL
}
```

### Implementation Steps

1. Add `ttlMs` field to cache entry interface
2. Store TTL when caching
3. Use stored TTL in `isExpired` check
4. Update all callers to pass appropriate TTL

### Success Criteria

- [ ] TTL parameter is honored
- [ ] Different servers can have different TTLs
- [ ] Cache expiry works correctly

---

## Bug 7: Verification Engine contentPattern Never Checked

**File:** `apps/desktop/src/renderer/lib/verificationEngine.ts` + `doneCriteria.ts:38`
**Severity:** Medium
**Impact:** File content validation is dead code — expected patterns are never verified

### Current State

```typescript
// doneCriteria.ts line 38: Schema defines contentPattern
interface ExpectedFileChange {
  filePath: string;
  action: "created" | "modified" | "deleted";
  contentPattern?: string;  // <-- Never checked
}

// doneCriteria.ts lines 146-186: checkExpectedFiles ignores contentPattern
```

### Fix

```typescript
// In checkExpectedFiles, add content pattern validation
async function checkExpectedFile(
  change: ExpectedFileChange,
  workspacePath: string
): Promise<{ passed: boolean; reason?: string }> {
  const filePath = joinPath(workspacePath, change.filePath);
  const exists = await api.fs.exists(filePath);
  
  if (change.action === "deleted") {
    return exists
      ? { passed: false, reason: `File still exists: ${change.filePath}` }
      : { passed: true };
  }
  
  if (!exists) {
    return { passed: false, reason: `File not found: ${change.filePath}` };
  }
  
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

### Implementation Steps

1. Read `doneCriteria.ts` `checkExpectedFiles` function
2. Add content pattern check after existence check
3. Use regex matching for pattern validation
4. Add test: create file with expected pattern, verify pass/fail

### Success Criteria

- [ ] `contentPattern` is validated when provided
- [ ] Regex patterns work correctly
- [ ] Clear error messages for pattern mismatches

---

## Bug 8: TransitionLog Grows Unbounded

**File:** `apps/desktop/src/renderer/lib/agentRuntimeContract.ts:338`
**Severity:** Medium
**Impact:** Memory leak in long sessions — thousands of transition entries accumulated

### Current State

```typescript
// Line 338: Every transition appends without limit
newState.transitionLog.push({
  from: state.phase,
  to: newState.phase,
  event: action.type,
  timestamp: Date.now(),
});
```

### Fix

```typescript
const MAX_TRANSITION_LOG = 500;

// In the reducer, cap the log
const newLog = [...state.transitionLog, {
  from: state.phase,
  to: newState.phase,
  event: action.type,
  timestamp: Date.now(),
}];

// Keep only the last 500 entries
if (newLog.length > MAX_TRANSITION_LOG) {
  newLog.splice(0, newLog.length - MAX_TRANSITION_LOG);
}

return { ...newState, transitionLog: newLog };
```

### Implementation Steps

1. Add `MAX_TRANSITION_LOG = 500` constant
2. Cap `transitionLog` array in reducer
3. Add test: simulate 600 transitions, verify only 500 kept

### Success Criteria

- [ ] `transitionLog` never exceeds 500 entries
- [ ] Recent transitions are always available
- [ ] No memory growth in long sessions

---

## Verification Checklist

After fixing all 8 bugs:

- [ ] `pnpm test` passes
- [ ] `pnpm lint` passes
- [ ] `pnpm typecheck` passes
- [ ] Manual test: create 50+ skills, verify budget enforced
- [ ] Manual test: run agent until `streaming-pending-diffs`, verify recovery
- [ ] Manual test: clear localStorage, verify dream timing persists
- [ ] Manual test: modify connector config, verify restart
- [ ] Manual test: cache MCP tools with custom TTL, verify honored
- [ ] Manual test: run verification with `contentPattern`, verify checked
- [ ] Manual test: run agent for 100+ tool calls, verify no memory growth
