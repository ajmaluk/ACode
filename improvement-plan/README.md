# Dalam (ACode) — Comprehensive Improvement Plan

> **Codebase:** ~25,000 lines across 50+ source files (core lib)
> **Architecture:** Tauri v2 (Rust backend + React 19 frontend), Zustand stores, XML tool protocol, SQLite+FTS5 memory
> **Current Stability:** 1,014 tests passing, 0 TypeScript errors

## Executive Summary

This plan identifies **8 critical bugs**, **47 high-priority issues**, and **30+ improvement opportunities** across the entire Dalam codebase. It is organized into 16 phases, ordered by impact and dependency.

### Critical Bug Status (Last Audited: July 2026)

**Audit Verdict: 5/8 verified fixed, 1 needs inspection, 2 not implemented**

| # | File | Issue | Impact | Status |
|---|------|-------|--------|--------|
| 1 | `skillCrystallizer.ts:154` | Budget check reads wrong directory — 50-skill cap never enforced | Unbounded skill accumulation | 🔴 Not fixed — budget check still reads wrong dir |
| 2 | `agentRuntimeContract.ts:287-294` | `STREAM_MESSAGE_END` silently drops event — agent stuck in `streaming` forever | Dead agent state | ✅ Fixed — `streaming-pending-diffs` phase added |
| 3 | `dreamAgent.ts:548` | Dream timing stored in localStorage | Dream cycles run on every startup | ✅ Fixed — migrated to SQLite `kv_store` |
| 4 | `dreamAgent.ts:450-452` | In-place mutation during dedup iteration | Processed already-merged pairs | 🟡 Needs verification |
| 5 | `connectors.ts:806-811` | Config save stops connector but never restarts | Changes require app restart | ✅ Fixed — calls `initializeSingleConnector()` after save |
| 6 | `mcpCache.ts:62` | TTL parameter accepted but NEVER used | All entries use default 1h TTL | ✅ Fixed — `ttlMs` stored in `CacheEntry`, used by `isExpired()` |
| 7 | `verificationEngine.ts:38` | `contentPattern` field never checked | Dead schema | 🔴 Not fixed — `contentPattern` never checked in verificationEngine |
| 8 | `agentRuntimeContract.ts:338` | `transitionLog` grows unbounded | Memory leak in long sessions | ✅ Fixed — `MAX_TRANSITION_LOG = 500` added |

### Key Metrics (Current → Target)

| Metric | Current | Target | Progress |
|--------|---------|--------|----------|
| Orphan tool calls | Possible | 0 (state machine enforced) | 🟡 `streaming-pending-diffs` phase added, timeout/retry phases pending |
| Wrong diff applies | Possible (heuristics) | 0 (strict binding) | 🟡 Heuristics still used — strict binding pending |
| Dream cycle LLM calls | Up to 30 | ≤5 (batched) | 🔴 Not implemented |
| Parallel tool execution | Sequential | 3-5x speedup | 🟡 `toolExecutor.ts` has parallel batching (unused) |
| API key security | Plaintext localStorage | Encrypted (OS keychain) | 🔴 Not implemented |
| MCP stdio latency | 5-15s per call (new process) | <1s (persistent connection) | 🔴 Not implemented |
| Context overflow retries | Unbounded | Max 2 with budget check | 🟡 Retry exists, budget check pending |
| Memory extraction LLM calls/turn | Always attempted | Gated (~50% reduction) | 🔴 Not implemented |

## Documentation Index (Current Status)

| Phase | Document | Scope | Effort | Status | Notes |
|-------|----------|-------|--------|--------|-------|
| 0 | [Critical Bugs](00-critical-bugs.md) | 8 bugs | 1-2 days | ✅ **5/8 verified fixed** | Bugs 1, 7 still open; Bug 4 needs inspection |
| 1 | [Agent Runtime Contract](01-agent-runtime-contract.md) | State machine | 1 week | 🟡 **Partial** | Phases added; timeout/retry wiring, parallel exec pending |
| 2 | [Tool Calling](02-tool-calling.md) | Execution, parsing | 1 week | 🟡 **Partial** | Schemas done; pre-compile, per-tool timeout, parallel pending |
| 3 | [Context Management](03-context-management.md) | Token estimation | 1 week | 🟡 **Partial** | tiktoken available; `/compact` implemented; OUTPUT_RESERVE still inconsistent |
| 4 | [Memory System](04-memory-system.md) | SQLite/FTS5 | 1 week | 🟡 **Partial** | FTS5 escaping needs hardening; extraction order, dedup session tracking pending |
| 5 | [Dream Agent](05-dream-agent.md) | Consolidation | 1 week | 🟡 **Partial** | localStorage bug fixed; batching, pipeline integration pending |
| 6 | [Session Management](06-session-management.md) | Persistence | 3-4 days | 🔴 **Not started** | Dual persistence still an issue |
| 7 | [UI & Desktop](07-ui-desktop.md) | Components | 1-2 weeks | 🟡 **Partial** | /undo, cost tracking implemented; store still monolithic |
| 8 | [Security](08-security.md) | API keys, SSRF | 1 week | 🔴 **Not started** | Keys still in localStorage plaintext |
| 9 | [Self-Improving](09-self-improving.md) | Genes, hooks | 1 week | 🟡 **Partial** | PreToolUse, ContextCompaction hooks exist; gene save, sessionEnd parallel pending |
| 10 | [MCP & Connectors](10-mcp-connectors.md) | Protocol | 1 week | 🟡 **Partial** | HTTP mutex added; persistent stdio, tool naming pending |
| 11 | [Cross-OS](11-cross-os.md) | Platform | 3-4 days | 🟡 **Partial** | CancellationToken, auto-update, Wayland clipboard implemented |
| 12 | [Performance](12-performance.md) | Caching, lazy load | 3-4 days | 🟡 **Partial** | RegExp cache implemented; lazy loading, virtualization, metrics pending |
| 13 | [Missing Features](13-missing-features.md) | Parity | 2-3 weeks | 🟡 **4/17 done** | /undo, /compact, cost tracking, changeStack implemented |
| 14 | [Testing](14-testing.md) | Test suite | 1 week | 🟡 **31 files, 1,014 tests** | dalamAPI + useAppStore tests added; MCP cache, connectors, E2E still open |
| 15 | [Configuration](15-configuration.md) | Settings | 3-4 days | 🔴 **Not started** | No schema validation, no migration system |
| 16 | [Rust Backend](16-rust-backend.md) | Commands | 3-4 days | 🔴 **Not started** | No Rust tests, no structured errors |

## What Has Been Implemented

The following work has been verified completed in the codebase:

### Phase 0: Bug Fixes (5/8)
| Bug | Status | Code Evidence |
|-----|--------|---------------|
| Bug 2: STREAM_MESSAGE_END drop | ✅ Fixed | `streaming-pending-diffs` phase, `DIFF_RESOLVED` handler, `pendingDiffToolCalls` field |
| Bug 3: Dream timing localStorage | ✅ Fixed | Uses SQLite `kv_store` — `getLastDreamTime()`, `setLastDreamTime()` |
| Bug 5: Connector restart | ✅ Fixed | `initializeSingleConnector()` called after config save |
| Bug 6: MCP cache TTL unused | ✅ Fixed | `ttlMs` stored in `CacheEntry`, `isExpired()` uses it |
| Bug 8: transitionLog unbounded | ✅ Fixed | `MAX_TRANSITION_LOG = 500` with splice capping |

### Phase 1: Agent Runtime Contract (Partial)
| Feature | Status | Code Evidence |
|---------|--------|---------------|
| `streaming-pending-diffs` phase | ✅ Added | `AgentPhase` includes it, transition table handles it |
| `tool-retrying` / `tool-timed-out` phases | ✅ Added | Types defined, transition entries exist |
| `DIFF_RESOLVED` event | ✅ Added | Reducer handles it |
| `TOOL_RETRY` with "approved" status | ✅ Fixed | Added "approved" to invariant check |
| `TOOL_APPROVED` / `TOOL_RUNNING` events | ✅ Implemented | Full invariant enforcement |
| `transitionLog` capped | ✅ Fixed | `MAX_TRANSITION_LOG = 500` |
| Tool timeout wiring into useAppStore | ❌ Pending | Phase transitions defined but not connected |
| Parallel execution in main loop | ❌ Pending | toolExecutor has batching but unused |

### Phase 13: Missing Features (4/17 done)
| Feature | Status | Files |
|---------|--------|-------|
| `/undo` change stack | ✅ Implemented | `changeStack.ts`, `changeStack.test.ts` |
| `/compact` manual trigger | ✅ Implemented | ChatView.tsx slash command handler |
| Cost tracking | ✅ Implemented | `costTracker.ts`, `costTracker.test.ts`, `SessionCostTracker.tsx` |
| Error recovery patterns | ✅ Implemented | `errorPatterns.ts`, `errorPatterns.test.ts` |
| Inline diff preview | ❌ Pending | Not implemented |
| Codebase indexing | ❌ Pending | Not implemented |

### Phase 11: Cross-OS (Partial)
| Feature | Status | Code Evidence |
|---------|--------|---------------|
| CancellationToken | ✅ Implemented | `cancellationToken.ts` with `combine()`, `onAbort()`, `throwIfAborted()` |
| Auto-update mechanism | ✅ Implemented | `updater.ts` with `checkForUpdates()`, `installUpdate()` via `tauri-plugin-updater` |
| Wayland clipboard support | ✅ Implemented | `system.rs`:304-309 tries `wl-paste` first, falls back to `xclip`/`xsel` |
| beforeunload flush fix | ❌ Pending | Not implemented |

### Phase 14: Testing (New Test Files)
| Module | Tests Created | Coverage |
|--------|---------------|----------|
| `dalamAPI.ts` | 22 tests | ProviderError, getRecentFiles, getActiveProvider, corsFetch, createDalamAPI |
| `useAppStore.ts` | 59 tests | stripXmlToolCallTags, parseXmlToolCalls, useGit, useCommandPalette |
| `costTracker.ts` | 5 describe blocks | Parsing, recording, formatting, pricing |
| `errorPatterns.ts` | 2 describe blocks | All 20+ error patterns |
| `changeStack.ts` | 4 describe blocks | LIFO, peek, clear, capping |
| `agentRuntimeContract.ts` | 8 describe blocks | Full state machine transitions |
| `tokenizer.ts` | 3 describe blocks | Counting, messages, budget |
| `toolSchemas.ts` | 10+ describe blocks | All schemas, security, dangerous commands |
| `platform.ts` | 6 describe blocks | Detection, shortcuts, command wrapping |
| `security.ts` | 3 describe blocks | Private host, SSRF, audit logging |
| `instructions.ts` | 4 describe blocks | Parsing, loading, formatting, globs |
| `safetyTimer.ts` | 3 describe blocks | Timer creation, clearance, timeouts |

### Other Fixes
| File | Change | Status |
|------|--------|--------|
| `platform.ts` | Added `resetPlatformCache()` for test isolation | ✅ |
| `agentRuntimeContract.ts` | Added "approved" to TOOL_RETRY invariant | ✅ |
| `errorPatterns.ts` | Fixed Go undefined identifier regex `(.+?)`→`(.+)` | ✅ |
| `dalamAPI.ts` | Added missing imports for `parseUsageFromChunk`, `recordTokenUsage` | ✅ |
| `useAppStore.ts` | Fixed `stripXmlToolCallTags` content stripping | ✅ |
| `agents.ts` | Fixed `globToRegex` brace expansion, added missing BASH_ARITY | ✅ |
| `changeStack.ts` | Added `applyUndo()` async function | ✅ |
| `toolExecutor.ts` | Replaced Node `fs.readFileSync` with Tauri `@tauri-apps/plugin-fs` | ✅ |
| `ChatView.tsx` | Enhanced `/undo` with file-level undo via changeStack | ✅ |

## Implementation Order (Revised)

```
Wave 1 — NOW: Remaining Critical Bugs
├── Bug 1: Fix skill budget directory check
├── Bug 7: Implement contentPattern verification
└── Verify Bug 4: In-place mutation during dedup

Wave 2 — NEXT: Security + Performance
├── Phase 8: API key encryption (OS keychain)
├── Phase 12: Lazy loading, virtualization, metrics
└── Phase 2: Pre-compile regex, parallel tool execution

Wave 3 — NEXT: MCP + Dream + Context
├── Phase 10: Persistent MCP stdio connections
├── Phase 5: Batch date adjustments, clustering dedup
└── Phase 3: Unify token estimation, OUTPUT_RESERVE inconsistency

Wave 4 — FOLLOW-UP: Memory, Session, UI
├── Phase 4: FTS5 hardening, extraction order, session dedup
├── Phase 6: Session persistence unification
└── Phase 7: Store split, inline diff preview

Wave 5 — LATER: Config, Testing, Rust
├── Phase 14: Full test coverage (MCP cache, connectors, E2E)
├── Phase 15: Settings validation, migration system
└── Phase 16: Rust backend hardening
```

## File Reference Map

### Core Agent Loop
- `apps/desktop/src/renderer/store/useAppStore.ts` (~5,564 lines) — Main store with agent orchestration
- `apps/desktop/src/renderer/lib/dalamAPI.ts` (~4,598 lines) — LLM streaming, tool execution, system prompt

### Tool System
- `apps/desktop/src/renderer/lib/toolExecutor.ts` (389 lines) — Parallel execution, retry, cost tracking
- `apps/desktop/src/renderer/lib/toolSchemas.ts` (406 lines) — Zod validation, security checks
- `apps/desktop/src/renderer/lib/agents.ts` (471 lines) — Agent definitions, permission rules

### Context & Memory
- `apps/desktop/src/renderer/lib/contextManager.ts` (753 lines) — Token estimation, compaction
- `apps/desktop/src/renderer/lib/memoryStore.ts` (1,159 lines) — SQLite+FTS5 memory
- `apps/desktop/src/renderer/lib/memoryTypes.ts` (90 lines) — Constants, types
- `apps/desktop/src/renderer/lib/tokenizer.ts` (153 lines) — Real token counting via js-tiktoken

### Missing Features
- `apps/desktop/src/renderer/lib/changeStack.ts` (62 lines) — Undo change stack
- `apps/desktop/src/renderer/lib/costTracker.ts` (164 lines) — Token usage & cost tracking
- `apps/desktop/src/renderer/lib/errorPatterns.ts` (153 lines) — Error pattern matching

### Self-Improving
- `apps/desktop/src/renderer/lib/genes.ts` (653 lines) — Gene evolution system
- `apps/desktop/src/renderer/lib/dreamAgent.ts` (726 lines) — Background consolidation
- `apps/desktop/src/renderer/lib/skillCrystallizer.ts` (217 lines) — Auto skill generation
- `apps/desktop/src/renderer/lib/hookBus.ts` (284 lines) — Lifecycle events
- `apps/desktop/src/renderer/lib/hookListeners.ts` (549 lines) — Event handlers
- `apps/desktop/src/renderer/lib/verificationEngine.ts` (359 lines) — Verify/execute/finalize
- `apps/desktop/src/renderer/lib/agentRuntimeContract.ts` (517 lines) — State machine (11 phases, 16 events)
- `apps/desktop/src/renderer/lib/trajectoryRecorder.ts` (515 lines) — JSONL recording

### MCP & Connectors
- `apps/desktop/src/renderer/lib/mcpCache.ts` (146 lines) — Tool caching (TTL now stored)
- `apps/desktop/src/renderer/lib/connectors.ts` (858 lines) — Plugin system
- `apps/desktop/src/renderer/lib/skills.ts` (580 lines) — Skill registry
- `apps/desktop/src/renderer/lib/instructions.ts` (380 lines) — 4-layer instructions

### Rust Backend
- `apps/desktop/src-tauri/src/lib.rs` (56 lines) — Plugin registration
- `apps/desktop/src-tauri/src/git.rs` (305 lines) — Git operations
- `apps/desktop/src-tauri/src/system.rs` (1,043 lines) — OS integration

### UI Components
- `apps/desktop/src/renderer/App.tsx` (643 lines) — Root layout
- `apps/desktop/src/renderer/components/editor/ChatView.tsx` (~1,445 lines) — Chat interface
- `apps/desktop/src/renderer/components/settings/SettingsModal.tsx` (~1,944 lines) — Settings
- `apps/desktop/src/renderer/components/chat/ActivityBlocks.tsx` (~1,110 lines) — Activity display

### Test Files
- `apps/desktop/src/renderer/lib/__tests__/` (18 files, ranging 149-767 lines) — All lib module tests
- `apps/desktop/src/renderer/lib/dalamTools.test.ts` (747 lines) — Tool parsing tests
- `apps/desktop/src/renderer/store/useChatSession.test.ts` — Chat session tests
- `apps/desktop/src/renderer/store/usePermission.test.ts` — Permission tests
- **Total: 31 test files, 1,014 tests, all passing**
