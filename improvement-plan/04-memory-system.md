# Phase 4: Memory System

> **Priority:** High
> **Estimated Effort:** 1 week
> **Dependencies:** Phase 3 (context management)
> **Primary Files:** `memoryStore.ts` (1,159 lines), `memoryTypes.ts` (90 lines), `database.ts`
> **Audit Status:** 🟡 Partial — 0/8 improvements fully implemented

## Current State Analysis

### Architecture: Git-first Markdown / SQLite-Cache Hybrid

```
Source of Truth:  .dalam/memories/*.md  (human-readable, git-friendly)
Search Cache:     SQLite FTS5           (fast keyword search, rebuilt from markdown if lost)
Index:            .dalam/MEMORY.md      (pointer file, capped at 200 lines)
```

### Issues Found & Resolution Status

| # | Issue | Severity | Status |
|---|-------|----------|--------|
| 1 | FTS5 query escaping is incomplete | Medium | ❌ Not fixed |
| 2 | No dedup against recently extracted memories in session | Medium | ❌ Not implemented |
| 3 | Memory extraction after compaction operates on summaries | High | ❌ Not fixed |
| 4 | SQLite and markdown can drift on write failure | High | ❌ Not fixed |
| 5 | `getAllMemories` called 3 times in dream cycle | Medium | ❌ Not cached |
| 6 | Jaccard similarity doesn't handle semantic similarity | Low | ❌ Not fixed |
| 7 | No memory export/import UI | Low | ❌ Not implemented |
| 8 | `scoreMemory` formula doesn't account for tier changes | Low | ❌ Not fixed |

### What's Verified Implemented

None of the 8 improvements from the plan have been implemented. The memory system is functional but has all the originally identified issues.

### Key Gaps

- **FTS5 escaping:** Still uses basic `escapeFts()` without handling `{}`/`[]` or empty token case
- **Session dedup:** No `sessionExtractedHashes` tracking
- **Extraction order:** Extraction still runs after compaction (summarized data)
- **Write failures:** No retry queue for markdown writes
- **Dream cycle:** `getAllMemories` called 3 times independently
- **Scoring:** No source quality, tag richness, or content quality heuristics

---

## Implementation Order

1. Cache `getAllMemories` in dream cycle (easiest, big impact)
2. Harden FTS5 query escaping (safety)
3. Add session-level dedup tracking for memory extraction
4. Reorder extraction and compaction in message-end handler
5. Implement write transaction with retry queue
6. Improve memory scoring formula
7. Add memory export/import UI in settings

---

## Success Criteria

- [ ] FTS5 queries handle all special characters correctly
- [ ] No duplicate memories extracted in same session
- [ ] Memories extracted before compaction preserves details
- [ ] SQLite and markdown stay in sync (retry queue)
- [ ] Dream cycle makes only 1 `getAllMemories` call
- [ ] Memory scoring accounts for source quality
- [ ] Export/import works via settings UI
