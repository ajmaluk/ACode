# Phase 7: UI & Desktop

> **Priority:** Medium-High
> **Estimated Effort:** 1-2 weeks
> **Dependencies:** Phase 1 (runtime contract), Phase 2 (tool calling)
> **Primary Files:** `ChatView.tsx` (~1,445 lines), `SettingsModal.tsx` (~1,944 lines), `useAppStore.ts` (5,564 lines)
> **Audit Status:** 🟡 Partial — 3/14 improvements implemented

## Current State Analysis

### Issues Found & Resolution Status

| # | Issue | Severity | Status |
|---|-------|----------|--------|
| 1 | Monolithic store (5,564 lines) — poor separation | Medium | ❌ Not fixed |
| 2 | File tree has no virtualization | Medium | ❌ Not fixed |
| 3 | Monaco loaded upfront (2MB) even when hidden | Low | ❌ Not fixed |
| 4 | No `/undo` command | High | ✅ Fixed (changeStack.ts + ChatView.tsx:710-749) |
| 5 | No inline diff preview before applying | High | ❌ Not fixed |
| 6 | No cost tracking per session | Medium | ✅ Fixed (costTracker.ts + SessionCostTracker.tsx) |
| 7 | Terminal theme applies via useEffect (flicker) | Low | ❌ Not fixed |
| 8 | Native `confirm()` calls inconsistent with UI | Medium | ❌ Not fixed |
| 9 | ChatView.tsx (1,445 lines) too large | Medium | ❌ Not fixed |
| 10 | SettingsModal.tsx (1,944 lines) too large | Medium | ❌ Not fixed |
| 11 | No accessibility (aria-label, roles) | Medium | ❌ Not fixed |
| 12 | Model dropdown code duplicated | Low | ❌ Not fixed |
| 13 | `removedMessagesStack` grows unbounded | Low | ❌ Not fixed |
| 14 | ContextPressureIndicator uses hardcoded 128k | Low | ❌ Not fixed |

### What's Verified Implemented

- ✅ `/undo` command — two-phase undo (file-level via changeStack, then message-level)
- ✅ Cost tracking — `SessionCostTracker.tsx` with live token/cost display, `/cost` command
- ✅ `/compact` command — triggers `compactSessionHistory()`
- ✅ Error recovery — `errorPatterns.ts` with 20+ patterns

### What's NOT Implemented

- ❌ Store split (monolithic 5,564 lines)
- ❌ File tree virtualization
- ❌ Monaco lazy loading
- ❌ Inline diff preview
- ❌ Accessibility improvements
- ❌ `removedMessagesStack` capping

---

## Implementation Priority

1. Cap `removedMessagesStack` at 50 entries (quick fix)
2. Replace native `confirm()` with custom dialogs
3. Extract model dropdown into shared component
4. Lazy load Monaco editor
5. Add file tree virtualization
6. Add inline diff preview in MultiFileDiff
7. Split monolithic store into domain-specific stores
8. Add aria-labels and roles to all interactive elements

---

## Success Criteria

- [x] `/undo` reverts last file change with confirmation
- [x] Cost tracking shows per-session breakdown
- [x] `/compact` forces compaction and shows stats
- [ ] Store split into 8+ domain modules
- [ ] File tree handles 1000+ files without lag
- [ ] Monaco lazy loads (not upfront)
- [ ] Diff preview shows actual content before approval
- [ ] No native `confirm()` calls
- [ ] All interactive elements have aria-labels
