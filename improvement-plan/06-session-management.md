# Phase 6: Session Management

> **Priority:** Medium-High
> **Estimated Effort:** 3-4 days
> **Dependencies:** Phase 4 (memory system)
> **Primary Files:** `useAppStore.ts` (lines 769-962, 1200-1610, 3601-3742)
> **Audit Status:** 🔴 Not started — 0/8 improvements implemented

## Current State Analysis

### Persistence Architecture

Sessions are persisted to **4 different stores**:

| Store | Data | Key |
|-------|------|-----|
| localStorage | Session summaries | `dalam.chatSessions.v1` |
| localStorage | Session messages | `dalam.sessionMessages.v1` |
| localStorage | Session versions | `dalam.sessionVersions.v1` |
| localStorage | Compaction summaries | `dalam.compactionSummaries.v1` |
| localStorage | Session agents | `dalam.sessionAgents.v1` |
| `.dalam/sessions.json` | All of above (workspace-scoped) | — |
| IndexedDB | Backup/migration target | — |
| Zustand store | Runtime working set | — |

### Issues Found

| # | Issue | Severity | Status |
|---|-------|----------|--------|
| 1 | Dual persistence (localStorage + sessions.json) risks split-brain | High | ❌ Not fixed |
| 2 | localStorage quota cascade silently loses data | High | ❌ Not fixed |
| 3 | Version restore strips tool results | Medium | ❌ Not fixed |
| 4 | Version tree structure suggested but linear only | Low | ❌ Not fixed |
| 5 | No session archival mechanism | Low | ❌ Not implemented |
| 6 | `removeSession` race conditions with async abort | Medium | ❌ Not fixed |
| 7 | No auto-open last workspace on startup | Low | ❌ Not implemented |
| 8 | Version storage bloat (full message copies) | Medium | ❌ Not fixed |

### What's Verified Implemented

None. All 8 improvements remain unaddressed.

---

## Implementation Order

1. Fix `removeSession` race condition (wait for abort)
2. Add user notification on storage quota exceeded
3. Preserve tool results in version restore
4. Unify persistence to `.dalam/sessions.json` as canonical
5. Add session archive/restore functionality
6. Add auto-open last workspace on startup

---

## Success Criteria

- [ ] Single canonical store for session data (no split-brain)
- [ ] User notified when data is pruned
- [ ] Version restore preserves tool results for context
- [ ] Session removal waits for abort completion
- [ ] Sessions can be archived and restored
- [ ] No data loss on storage quota exceeded
