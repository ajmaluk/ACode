# Phase 5: Dream Agent

> **Priority:** High
> **Estimated Effort:** 1 week
> **Dependencies:** Phase 4 (memory system)
> **Primary Files:** `dreamAgent.ts` (726 lines), `dreamProposalPipeline.ts` (278 lines), `skillCrystallizer.ts` (217 lines)
> **Audit Status:** 🟡 Partial — 1/8 improvements implemented (localStorage fix), 7 pending

## Current State Analysis

### Dream Cycle Lifecycle

```
Phase 0: Guard checks (mutex, model availability)
Phase 1: Purge stale memories
Phase 2: Validate file references → mark-stale proposals
Phase 2.5: Re-score (promote/demote based on access)
Phase 3: LLM date adjustments (max 20 calls)
Phase 4: LLM dedup/merge (max 10 merges, 30 total LLM calls)
Phase 5: Post-dedup purge
Phase 6: Skill consolidation (Jaccard > 0.65)
Phase 7: Update MEMORY.md index
```

### Issues Found & Resolution Status

| # | Issue | Severity | Status |
|---|-------|----------|--------|
| 1 | Date adjustment: 1 LLM call per memory (up to 20) | High | ❌ Not fixed |
| 2 | Dedup: O(n²) pairwise nested loops | High | ❌ Not fixed |
| 3 | Skill consolidation Jaccard threshold too low (0.45) | Medium | ✅ Fixed (raised to 0.65) |
| 4 | `processProposals` is dead code | Low | ❌ Not integrated |
| 5 | Skill consolidation has no rollback on cancellation | Medium | ✅ Fixed (backupA/backupB + rollback logic) |
| 6 | Dream timing stored in localStorage | Critical | ✅ Fixed (migrated to SQLite kv_store) |
| 7 | In-place mutation during dedup | High | 🟡 Needs verification |
| 8 | No embedding-based similarity (Jaccard is word-level) | Low | ❌ Not implemented |

### What's Verified Implemented

- ✅ Dream timing uses SQLite `kv_store` (no localStorage)
- ✅ Skill consolidation threshold raised from 0.45 to 0.65
- ✅ Skill consolidation has backup/rollback mechanism

### What's NOT Implemented

- ❌ Date adjustments still 1 call per memory (sequential)
- ❌ Dedup still O(n²) pairwise (no clustering)
- ❌ `processProposals` not integrated into dream cycle
- ❌ No embedding-based similarity

---

## Remaining Implementation Priority

1. Batch date adjustment LLM calls (20 → 2 calls)
2. Replace pairwise dedup with clustering (O(n²) → O(n))
3. Integrate `processProposals` pipeline
4. Verify/fix in-place mutation during dedup

---

## Success Criteria

- [x] Dream timing persists across localStorage clears
- [x] Skill consolidation prevents over-merging (threshold 0.65)
- [x] Skill consolidation has rollback on failure
- [ ] Date adjustment uses ≤2 LLM calls (was up to 20)
- [ ] Dedup uses clustering (no O(n²) pairwise comparison)
- [ ] Proposal pipeline is used consistently
- [ ] Total LLM calls per dream cycle ≤10 (was up to 30)
