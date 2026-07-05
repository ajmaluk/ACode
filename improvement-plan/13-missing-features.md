# Phase 13: Missing Features (Claude Code / Cursor Parity)

> **Estimated Effort:** 2-3 weeks
> **Dependencies:** Phase 1 (agent runtime), Phase 2 (tool calling), Phase 7 (UI)
> **Priority:** Medium
> **Audit Status:** 🟡 **4/17 done** — /undo, /compact, cost tracking, error patterns implemented

## Current State Analysis

### Feature Comparison Matrix

| Feature | Claude Code | Cursor | Dalam Status | Gap |
|---------|-------------|--------|--------------|-----|
| Undo last change | `/undo` | Ctrl+Z | ✅ **IMPLEMENTED** | changeStack.ts + ChatView.tsx |
| Compact context | `/compact` | Auto | ✅ **IMPLEMENTED** | ChatView.tsx slash command |
| Cost tracking | Full | Full | ✅ **IMPLEMENTED** | costTracker.ts, SessionCostTracker.tsx |
| Error recovery suggestions | Full | Partial | ✅ **IMPLEMENTED** | errorPatterns.ts (20+ patterns) |
| Multi-model routing | Auto | Auto | ❌ Not implemented | Single model only |
| Inline diff preview | Full | Full | ❌ Not implemented | No inline preview |
| Codebase indexing | Full | Full | ❌ Not implemented | No indexing |
| Custom instructions | Full | Full | 🟡 **PARTIAL** | 4-layer system exists |
| Git integration | Full | Full | 🟡 **PARTIAL** | Basic git commands |
| Terminal integration | Full | Full | 🟡 **PARTIAL** | Basic terminal |
| Collaborative editing | N/A | Full | ❌ Not implemented | Single user only |
| Background agents | N/A | Full | 🟡 **PARTIAL** | Dream agent exists |
| Model switching mid-chat | Auto | Auto | ❌ Not implemented | Fixed model |
| Token budget display | Full | Full | 🟡 **PARTIAL** | In SessionCostTracker |
| File change preview | Full | Full | ❌ Not implemented | No preview |

### What's Verified Implemented

- ✅ **/undo** — Two-phase: file-level via `changeStack.ts:applyUndo()`, then message-level fallback
- ✅ **/compact** — Calls `chat.compactSessionHistory(sessionId)` with toast notifications
- ✅ **Cost tracking** — `SessionCostTracker.tsx` with live display, `/cost` command for detailed breakdown
- ✅ **Error recovery** — `errorPatterns.ts` with 20+ patterns (missing modules, type errors, Python/Rust/Go errors)

### What's NOT Implemented

- ❌ Inline diff preview before applying changes
- ❌ Multi-model routing (auto-select based on task complexity)
- ❌ Codebase indexing with semantic search
- ❌ Model switching mid-chat
- ❌ Collaborative editing

---

## Implementation Priority

1. Inline diff preview in MultiFileDiff (expandable hunks + accept/reject buttons)
2. Codebase indexing with SQLite (AST-based, background worker)
3. Error recovery auto-fix for simple issues (missing module → `npm install`)
4. Multi-model routing (keyword-based + token count heuristic)

---

## Success Criteria

- [x] `/undo` reverts last file change with confirmation
- [x] `/compact` forces compaction and shows stats
- [x] Token count and cost displayed per message
- [x] At least 10 common error patterns with suggestions
- [ ] Diff preview shown before applying changes
- [ ] Model selector visible in chat input
- [ ] Codebase indexing enabled for semantic search
