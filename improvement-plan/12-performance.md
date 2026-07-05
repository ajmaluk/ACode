# Phase 12: Performance Optimization

> **Estimated Effort:** 3-4 days
> **Dependencies:** Phase 0 (critical bugs), Phase 1 (agent runtime)
> **Priority:** Medium
> **Audit Status:** 🟡 Partial — 1/5 improvements implemented

## Current State

### Issues Found & Resolution Status

| # | Issue | Severity | Status |
|---|-------|----------|--------|
| 1 | Regex ReDoS risk in verification engine | High | ✅ Fixed (regexCache.ts, getCachedRegex) |
| 2 | Unbounded Map growth in dalamAPI | Medium | ❌ Not fixed |
| 3 | localStorage synchronous loading | Low | ❌ Not fixed |
| 4 | No performance metrics collection | Medium | ❌ Not implemented |
| 5 | Large component trees not virtualized | Low | ❌ Not implemented |

### What's Verified Implemented

- ✅ `regexCache.ts` — `getCachedRegex()` used in `verificationEngine.ts:106-107`
- ✅ ReDoS protection via caching (patterns cached, not recompiled per call)

### What's NOT Implemented

- ❌ Map cleanup in `dalamAPI.ts` (activeControllers, streamCallbacks, streamCleanups)
- ❌ Lazy loading for SettingsModal, MemoryGraph, ActivityBlocks
- ❌ Performance metrics collection
- ❌ Chat message list virtualization
- ❌ File tree virtualization

---

## Implementation Priority

1. Add Map lifecycle management in dalamAPI (cleanup on session end)
2. Lazy load SettingsModal and MemoryGraph
3. Add performance metrics with `/metrics` command
4. Virtualize chat message list and file tree

---

## Success Criteria

- [x] No `new RegExp(userInput)` without caching or protection
- [ ] All Maps in `dalamAPI.ts` cleaned up on session end
- [ ] `SettingsModal` lazily loaded — initial bundle reduced by ~15KB
- [ ] Performance metrics available via `/metrics` command
- [ ] Chat message list renders < 50 DOM nodes even with 500+ messages
- [ ] No synchronous localStorage reads at startup for non-critical data
