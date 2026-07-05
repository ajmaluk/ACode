# Phase 12: Performance Optimization

> **Estimated Effort:** 3-4 days
> **Dependencies:** Phase 0 (critical bugs), Phase 1 (agent runtime)
> **Priority:** Medium

## Current State

Performance issues span regex compilation, lazy loading, memory usage, and structured logging. The codebase recompiles regex patterns on every call, eagerly loads large modules, lacks structured metrics, and has no performance monitoring.

### Regex Recompilation Hotspots

| File | Line | Pattern | Issue |
|------|------|---------|-------|
| `useAppStore.ts` | 53-54 | `XML_TOOL_CALL_RE`, `XML_ATTR_RE` | Compiled once at module load — OK |
| `useAppStore.ts` | 94-99 | `XML_STRIP_RE`, `XML_CLOSING_TAG_RE`, `XML_MCP_STRIP_RE`, `XML_INCOMPLETE_TAG_RE` | Compiled once at module load — OK |
| `dalamAPI.ts` | 159-186 | SSE parser | Inline regex `/\r\n/g`, `/\r/g` in hot loop |
| `dalamAPI.ts` | (multiple) | `KNOWN_TOOL_NAMES` joined regex | Recompiled per module load, but large |
| `verificationEngine.ts` | 104 | `new RegExp(vc.expectedPattern)` | Recompiled per verification command |
| `contextManager.ts` | (multiple) | Token estimation regex | Various inline patterns |
| `memoryStore.ts` | (multiple) | FTS5 query patterns | Pre-compiled — OK |

**Critical:** `verificationEngine.ts:104` recompiles `new RegExp(vc.expectedPattern)` on every verification command. For repeated patterns this is wasteful and potentially unsafe (ReDoS).

### Lazy Loading Opportunities

| Module | Size | Loaded At | Impact |
|--------|------|-----------|--------|
| `SettingsModal.tsx` | 1,944 lines | Eager (imported in App.tsx) | Delays initial render |
| `ActivityBlocks.tsx` | ~1,110 lines | Eager | Large component tree |
| `MemoryGraph` | Unknown | Eager in SettingsModal | Only visible on one tab |
| `TrajectoryRecorder` | 501 lines | Eager in useAppStore | Only used for recording |
| `Gene system` | 653 lines | Eager in dalamAPI | Background-only |
| `Dream agent` | 695 lines | Eager in dalamAPI | Background-only |

### Memory Usage

- `useAppStore.ts` is **5,411 lines** — entire app state in one Zustand store
- `localStorage` holds **46+ distinct keys** (see grep results) — all loaded synchronously at startup
- `_tokenCache` in `contextManager.ts` has no size-based eviction, only count-based (1000 entries)
- `activeControllers`, `sessionStartTimes`, `streamCallbacks`, `streamCleanups` Maps in `dalamAPI.ts:25-31` — never cleaned up after session ends
- `pendingDiffProposals` Map in `dalamAPI.ts:30` — entries removed only on accept, never on dismiss

### Structured Logging

- `_debugLog` in `dalamAPI.ts:12-18` — gated behind `window.__DALAM_DEBUG`, no structured format
- No performance metrics collected (token usage, tool duration, LLM latency)
- `trajectoryRecorder.ts` collects per-turn data but no aggregated metrics
- No timing instrumentation for LLM calls, tool execution, or UI rendering

## Issues Found

### 1. Regex ReDoS Risk in Verification Engine
**Severity:** HIGH
**Location:** `verificationEngine.ts:104`
**Issue:** `new RegExp(vc.expectedPattern)` with user-controlled `expectedPattern` — potential ReDoS.
**Fix:** Pre-compile patterns in `runVerificationCommand` and cache, or use `RegExp` with a timeout.

### 2. Unbounded Map Growth in dalamAPI
**Severity:** MEDIUM
**Location:** `dalamAPI.ts:25-31`
**Issue:** `activeControllers`, `streamCallbacks`, `streamCleanups` Maps grow unbounded if sessions don't clean up properly.
**Fix:** Add cleanup in session end handler; use WeakRef or periodic pruning.

### 3. localStorage Synchronous Loading
**Severity:** LOW
**Location:** `useAppStore.ts` (multiple), `dalamAPI.ts:99-108`
**Issue:** 46+ localStorage keys read synchronously at startup. Each `getItem` is a synchronous parse of JSON.
**Fix:** Lazy-load non-critical settings; batch reads; use `requestIdleCallback`.

### 4. No Performance Metrics Collection
**Severity:** MEDIUM
**Location:** Throughout
**Issue:** No instrumentation for LLM call duration, token throughput, tool execution time, or UI render time.
**Fix:** Add lightweight performance counters to `dalamAPI.ts` and `toolExecutor.ts`.

### 5. Large Component Trees Not Virtualized
**Severity:** LOW
**Location:** `ChatView.tsx`, `ActivityBlocks.tsx`
**Issue:** Chat message list and activity blocks render all items even when off-screen.
**Fix:** Use `react-window` or `@tanstack/react-virtual` for message list virtualization.

## Implementation Steps

### Step 1: Regex Safety and Caching (0.5 days)
1. Add a `RegExpCache` utility in a new `lib/regexCache.ts`:
   ```ts
   const cache = new Map<string, RegExp>();
   export function getCachedRegex(pattern: string, flags?: string): RegExp {
     const key = `${pattern}::${flags ?? ""}`;
     if (!cache.has(key)) cache.set(key, new RegExp(pattern, flags));
     return cache.get(key)!;
   }
   ```
2. Replace `new RegExp(vc.expectedPattern)` in `verificationEngine.ts:104` with `getCachedRegex`
3. Add ReDoS protection: wrap with a timeout or limit pattern complexity (max 200 chars)
4. Pre-compile SSE parsing regexes in `dalamAPI.ts` as module-level constants

### Step 2: Map Lifecycle Management (0.5 days)
1. In `dalamAPI.ts`, add cleanup for `activeControllers`, `streamCallbacks`, `streamCleanups` on session end
2. Add periodic pruning for `pendingDiffProposals` (remove entries > 30 min old)
3. Add a `cleanupSessionMaps(sessionId)` function called from session end handler
4. Log map sizes in debug mode to detect growth

### Step 3: Lazy Loading (1 day)
1. Use `React.lazy()` for `SettingsModal`, `MemoryGraph`, `ActivityBlocks`:
   ```ts
   const SettingsModal = React.lazy(() => import("./settings/SettingsModal"));
   ```
2. Defer gene system, dream agent, and trajectory recorder imports:
   ```ts
   // In dalamAPI.ts, lazy-load background systems
   let _genesLoaded = false;
   async function ensureGenesLoaded() {
     if (!_genesLoaded) {
       const { loadGenePool } = await import("./genes");
       await loadGenePool();
       _genesLoaded = true;
     }
   }
   ```
3. Defer MCP cache initialization until first MCP tool call
4. Add loading skeletons for lazily-loaded components

### Step 4: Performance Metrics (1 day)
1. Create `lib/metrics.ts` with lightweight counters:
   ```ts
   export const metrics = {
     llmCalls: { count: 0, totalMs: 0, errors: 0 },
     toolCalls: new Map<string, { count: 0, totalMs: 0, errors: 0 }>(),
     tokenUsage: { input: 0, output: 0 },
   };
   ```
2. Instrument `dalamAPI.ts:sendPrompt` to record LLM call duration and token counts
3. Instrument `toolExecutor.ts:executeToolWithRetry` to record per-tool metrics
4. Add `/metrics` slash command to dump aggregated stats to chat
5. Add `performance.now()` timing to critical paths (compaction, memory extraction, dream cycles)

### Step 5: List Virtualization (1 day)
1. Install `@tanstack/react-virtual`
2. Virtualize chat message list in `ChatView.tsx` — only render visible messages
3. Virtualize activity blocks in `ActivityBlocks.tsx`
4. Virtualize file list in file tree component
5. Add `overscan` of 5 items for smooth scrolling

## Success Criteria

- [ ] No `new RegExp(userInput)` without caching or protection
- [ ] All Maps in `dalamAPI.ts` cleaned up on session end
- [ ] `SettingsModal` lazily loaded — initial bundle reduced by ~15KB
- [ ] Performance metrics available via `/metrics` command
- [ ] Chat message list renders < 50 DOM nodes even with 500+ messages
- [ ] No synchronous localStorage reads at startup for non-critical data

## Risk Mitigation

- Lazy loading may cause visible loading states — use Suspense with skeletons
- Virtualization changes scroll behavior — test with keyboard navigation
- Regex caching may use excessive memory — limit cache to 100 entries
- Performance metrics add overhead — use `performance.now()` only on hot paths
