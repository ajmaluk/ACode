# Phase 3: Context Management

> **Priority:** High
> **Estimated Effort:** 1 week
> **Dependencies:** Phase 2 (tool output format)
> **Primary Files:** `contextManager.ts` (753 lines), `memoryTypes.ts` (90 lines), `useAppStore.ts` (lines 3744-3897)
> **Audit Status:** 🟡 Partial — 2/8 improvements implemented, 6 pending

## Current State Analysis

### Token Estimation

Two separate estimation systems exist:

| System | Algorithm | Used By | Accuracy |
|--------|-----------|---------|----------|
| `estimateTokens()` | Character-based heuristic (4 chars/token) | `contextManager.ts` | ±20-30% |
| `js-tiktoken` | BPE tokenizer | `tokenizer.ts` | ±5% |

**Status:** tiktoken detection logic exists (`_tiktokenAvailable` flag), but `estimateTokens()` is still the primary path.

### Context Pressure Thresholds

```
none:   < 50% used
low:    50-70% used
medium: 70-85% used
high:   > 85% used
```

### Issues Found & Resolution Status

| # | Issue | Severity | Status |
|---|-------|----------|--------|
| 1 | Token estimation inconsistent between systems | High | 🟡 tiktoken detection exists, not used as primary |
| 2 | Compaction loses tool output context | High | ❌ Not fixed |
| 3 | No user-triggered `/compact` command | Medium | ✅ Fixed (ChatView.tsx:574-585) |
| 4 | Context overflow retry has no budget check | High | ❌ Not fixed |
| 5 | Compaction settings hardcoded | Medium | ❌ Not fixed |
| 6 | `OUTPUT_RESERVE` override inconsistency | Medium | ❌ Not fixed (4000 vs 32000 vs 8000) |
| 7 | No compaction quality metrics | Low | ❌ Not fixed |
| 8 | `selectMessagesForCompaction` protects 6 turns | Low | ❌ Not fixed |

### What's Verified Implemented

- ✅ `/compact` command in ChatView.tsx (triggers `compactSessionHistory()`)
- ✅ tiktoken availability detection in `contextManager.ts`

### What's NOT Implemented

- ❌ Token estimation doesn't use tiktoken as primary path
- ❌ Tool output context not preserved in compaction summaries
- ❌ Budget check not added to context overflow retry
- ❌ Compaction thresholds not configurable
- ❌ OUTPUT_RESERVE inconsistency not fixed

---

## Remaining Implementation Priority

1. Fix OUTPUT_RESERVE inconsistency (clear naming, centralize constants)
2. Add budget check to context overflow retry
3. Preserve tool output context in compaction summaries
4. Unify token estimation (use tiktoken as primary)
5. Make compaction settings configurable

---

## Success Criteria

- [x] `/compact` command works and shows token savings
- [ ] Token estimation uses tiktoken when available
- [ ] Compaction summaries include tool outputs and file changes
- [ ] Context overflow retry verifies compaction success before retrying
- [ ] All compaction thresholds are configurable via settings
- [ ] No OUTPUT_RESERVE confusion (clear naming)
- [ ] Tool-call/tool-result pairs are never split by compaction
