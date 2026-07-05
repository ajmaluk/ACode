# Phase 9: Self-Improving Systems

> **Priority:** Medium
> **Estimated Effort:** 1 week
> **Dependencies:** Phase 4 (memory), Phase 5 (dream agent)
> **Primary Files:** `genes.ts` (653 lines), `hookBus.ts` (284 lines), `hookListeners.ts` (551 lines), `skillCrystallizer.ts` (217 lines), `verificationEngine.ts` (359 lines)
> **Audit Status:** 🟡 Partial — 4/12 improvements implemented

## Current State Analysis

### Issues Found & Resolution Status

| # | Issue | Severity | Status |
|---|-------|----------|--------|
| 1 | Gene debounced save loses activation counts | Medium | ❌ Not fixed |
| 2 | Gene triggers compiled without sandboxing | Medium | ❌ Not fixed |
| 3 | No gene versioning/rollback | Low | ❌ Not implemented |
| 4 | No gene conflict resolution | Low | ❌ Not implemented |
| 5 | Missing `PreToolUse` hook | High | ✅ Implemented (hookBus.ts:251-273) |
| 6 | Missing `ContextCompaction` hook | Medium | ✅ Implemented (hookBus.ts:98-115) |
| 7 | Missing `MemorySaved` hook | Low | ❌ Not implemented |
| 8 | `onSessionEnd` runs 7 sequential steps | Medium | ❌ Not fixed |
| 9 | `autoExtractMemories` duplicates API logic | Medium | ❌ Not fixed |
| 10 | Verification engine only reads package.json | Medium | ❌ Not fixed |
| 11 | `runShellCommand` double-wraps output | Low | ❌ Not fixed |
| 12 | `buildDefaultCriteria` always includes "tests pass" | Low | ❌ Not fixed |

### What's Verified Implemented

- ✅ `PreToolUse` hook — `hookBus.ts` has event type, `emitPreToolUse()` helper, `PreToolUseResult` interface
- ✅ `ContextCompaction` hook — `hookBus.ts` has event type, `ContextCompactionEvent` interface
- ✅ `PreToolUse` returns `{ allow: boolean; reason?: string }` — hook listeners can block tools

### What's NOT Implemented

- ❌ Gene debounced save not fixed (race condition)
- ❌ Gene trigger validation not added
- ❌ `onSessionEnd` still sequential
- ❌ Verification engine only reads package.json
- ❌ `autoExtractMemories` duplicates API logic

---

## Implementation Priority

1. Fix gene debounced save with queue-based approach
2. Add gene trigger validation (length, dangerous patterns)
3. Parallelize session end steps
4. Expand verification engine to support Rust, Python, Go
5. Add `MemorySaved` hook

---

## Success Criteria

- [x] PreToolUse hook can auto-approve/block tools
- [x] ContextCompaction hook event type defined
- [ ] Gene activation counts never lost on rapid prompts
- [ ] Dangerous regex patterns rejected
- [ ] Session end completes 30% faster (parallelized)
- [ ] Verification engine supports JS, TS, Rust, Python, Go
