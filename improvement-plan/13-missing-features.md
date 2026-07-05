# Phase 13: Missing Features (Claude Code / Cursor Parity)

> **Estimated Effort:** 2-3 weeks
> **Dependencies:** Phase 1 (agent runtime), Phase 2 (tool calling), Phase 7 (UI)
> **Priority:** Medium

## Current State Analysis

This document catalogs features present in Claude Code, Cursor, and other AI coding agents that are missing or incomplete in Dalam. Each feature includes a gap analysis, implementation complexity, and priority.

### Feature Comparison Matrix

| Feature | Claude Code | Cursor | Dalam Status | Gap |
|---------|-------------|--------|--------------|-----|
| Undo last change | `/undo` | Ctrl+Z | **MISSING** | No undo mechanism |
| Compact context | `/compact` | Auto | **PARTIAL** | No manual trigger |
| Cost tracking | Full | Full | **MISSING** | No token/cost display |
| Multi-model routing | Auto | Auto | **MISSING** | Single model only |
| Inline diff preview | Full | Full | **PARTIAL** | No inline preview |
| Codebase indexing | Full | Full | **MISSING** | No indexing |
| Custom instructions | Full | Full | **PARTIAL** | 4-layer system exists |
| Git integration | Full | Full | **PARTIAL** | Basic git commands |
| Terminal integration | Full | Full | **PARTIAL** | Basic terminal |
| Collaborative editing | N/A | Full | **MISSING** | Single user only |
| Background agents | N/A | Full | **PARTIAL** | Dream agent exists |
| Model switching mid-chat | Auto | Auto | **MISSING** | Fixed model |
| Token budget display | Full | Full | **MISSING** | No display |
| Error recovery suggestions | Full | Partial | **MISSING** | Generic errors |
| File change preview | Full | Full | **MISSING** | No preview |

## Missing Features — Detailed Analysis

### 1. `/undo` Command
**Priority:** HIGH
**Complexity:** Low-Medium

**Current State:** No undo mechanism exists. When the agent makes a bad change, the user must manually revert via git or file restore.

**What Claude Code Does:**
- `/undo` reverts the last file change made by the agent
- Maintains a change stack per session
- Supports multiple undo steps
- Shows what was undone

**Implementation:**
1. Create `lib/changeStack.ts`:
   ```ts
   interface ChangeRecord {
     filePath: string;
     beforeContent: string;
     afterContent: string;
     timestamp: number;
     toolCallId: string;
   }
   const changeStack: ChangeRecord[] = [];
   ```
2. Hook into `editFile` and `writeFile` tool handlers — record before/after content
3. Implement `/undo` command in `useAppStore.ts`:
   - Pop last change from stack
   - Restore `beforeContent` to file
   - Remove the corresponding chat messages
4. Add UI indicator showing undo stack size
5. Limit stack to 50 entries to bound memory

**Files to Modify:**
- New: `apps/desktop/src/renderer/lib/changeStack.ts`
- Modify: `apps/desktop/src/renderer/store/useAppStore.ts` (add `/undo` handler)
- Modify: `apps/desktop/src/renderer/lib/dalamAPI.ts` (record changes)

### 2. `/compact` Manual Trigger
**Priority:** HIGH
**Complexity:** Low

**Current State:** Compaction is automatic based on context pressure thresholds (60%/75%). No manual trigger exists.

**What Claude Code Does:**
- `/compact` forces immediate compaction
- User can provide custom summary focus
- Shows compaction stats (tokens before/after)

**Implementation:**
1. Add `/compact` case to slash command handler in `useAppStore.ts`
2. Call existing `buildCompactionPrompt` and `selectMessagesForCompaction`
3. Allow optional focus parameter: `/compact focus on authentication changes`
4. Display compaction stats in chat
5. Add UI button in chat toolbar

**Files to Modify:**
- Modify: `apps/desktop/src/renderer/store/useAppStore.ts` (add command)

### 3. Cost Tracking & Token Display
**Priority:** HIGH
**Complexity:** Medium

**Current State:** No token count or cost display. Users have no idea how many tokens they're using.

**What Claude Code Does:**
- Shows tokens used per message
- Shows cumulative session cost
- Shows cost per model
- Budget alerts

**Implementation:**
1. Parse token counts from LLM API responses (both OpenAI and Anthropic formats)
2. Store in `metrics` object (from Phase 12)
3. Add cost calculation per model (configurable pricing)
4. Display in chat footer: `↑ 1.2K ↓ 3.4K | $0.12`
5. Add `/cost` command for detailed breakdown
6. Add budget warning at configurable thresholds

**API Response Parsing:**
```ts
// OpenAI: response.usage.total_tokens
// Anthropic: response.usage.input_tokens + response.usage.output_tokens
interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd?: number;
}
```

**Files to Modify:**
- New: `apps/desktop/src/renderer/lib/costTracker.ts`
- Modify: `apps/desktop/src/renderer/lib/dalamAPI.ts` (parse usage from responses)
- Modify: `apps/desktop/src/renderer/components/editor/ChatView.tsx` (display)

### 4. Multi-Model Routing
**Priority:** MEDIUM
**Complexity:** Medium-High

**Current State:** Single model configured per provider. No ability to use different models for different tasks.

**What Claude Code Does:**
- Uses Haiku for simple tasks, Sonnet for complex, Opus for critical
- Auto-routes based on task complexity
- User can override per-message

**Implementation:**
1. Add model profiles to settings:
   ```ts
   interface ModelProfile {
     name: string;
     providerId: string;
     modelId: string;
     useFor: "simple" | "complex" | "code" | "all";
   }
   ```
2. Add task complexity classifier (keyword-based + token count heuristic)
3. Route to appropriate model based on complexity
4. Add model selector in chat input (dropdown)
5. Show which model was used per message

**Files to Modify:**
- Modify: `apps/desktop/src/renderer/components/settings/SettingsModal.tsx`
- Modify: `apps/desktop/src/renderer/lib/dalamAPI.ts` (routing logic)
- Modify: `apps/desktop/src/renderer/store/useAppStore.ts` (model selection)

### 5. Inline Diff Preview
**Priority:** MEDIUM
**Complexity:** Medium

**Current State:** File changes are applied directly. No preview before applying.

**What Claude Code Does:**
- Shows inline diff before applying changes
- User can accept/reject individual changes
- Supports multiple file changes in one preview

**Implementation:**
1. Before applying `editFile`/`writeFile`, generate a diff proposal
2. Store in `pendingDiffProposals` Map (already exists in `dalamAPI.ts:30`)
3. Render diff preview in chat using a diff library (e.g., `diff`, `@codemirror/merge`)
4. Add accept/reject buttons per file
5. Support batch accept/reject

**Files to Modify:**
- Modify: `apps/desktop/src/renderer/components/editor/ChatView.tsx` (diff UI)
- Modify: `apps/desktop/src/renderer/lib/dalamAPI.ts` (propose before apply)

### 6. Codebase Indexing
**Priority:** MEDIUM
**Complexity:** High

**Current State:** No codebase indexing. Search is file-by-file via `grep` and `search_files`.

**What Claude Code Does:**
- Indexes entire codebase at startup
- Enables semantic search across files
- Provides file summaries and relationships
- Powers "find relevant files" for context

**Implementation:**
1. Create `lib/codeIndex.ts` with AST-based indexing
2. Index on workspace open (background worker)
3. Store index in SQLite (reuse `memoryStore.ts` infrastructure)
4. Expose search via new `codeSearch` tool
5. Auto-inject relevant file paths into context

**Note:** This is a large feature. Consider using `tree-sitter` for AST parsing.

### 7. Error Recovery Suggestions
**Priority:** LOW
**Complexity:** Medium

**Current State:** Generic error messages. No actionable suggestions.

**What Claude Code Does:**
- Analyzes error patterns
- Suggests specific fixes
- Links to documentation

**Implementation:**
1. Create `lib/errorPatterns.ts` with common error patterns:
   ```ts
   const ERROR_PATTERNS = [
     { match: /Cannot find module '(.+)'/, suggestion: "Run `npm install $1`" },
     { match: /Type '(.+)' is not assignable/, suggestion: "Check type definition for $1" },
     // ...
   ];
   ```
2. When a tool fails, match against patterns
3. Include suggestion in tool error response
4. Auto-fix simple issues (e.g., missing module)

## Implementation Order

### Wave 1 (Week 1-2): Quick Wins
1. `/compact` manual trigger (1 day)
2. `/undo` command (2-3 days)
3. Cost tracking (2-3 days)

### Wave 2 (Week 3-4): UX Improvements
4. Inline diff preview (3-4 days)
5. Error recovery suggestions (2-3 days)

### Wave 3 (Week 5-6): Advanced Features
6. Multi-model routing (3-4 days)
7. Codebase indexing (5-7 days)

## Success Criteria

- [ ] `/undo` reverts last file change with confirmation
- [ ] `/compact` forces compaction and shows stats
- [ ] Token count and cost displayed per message
- [ ] Diff preview shown before applying changes
- [ ] At least 10 common error patterns with suggestions
- [ ] Model selector visible in chat input

## Risk Mitigation

- `/undo` must handle edge cases (file deleted, directory changed)
- Cost tracking requires accurate token counting from API responses
- Diff preview may conflict with auto-apply — need clear UX distinction
- Codebase indexing may be slow for large repos — use incremental updates
