# Phase 3: Context Management

> **Priority:** High
> **Estimated Effort:** 1 week
> **Dependencies:** Phase 2 (tool output format)
> **Primary Files:** `contextManager.ts` (692 lines), `memoryTypes.ts` (90 lines), `useAppStore.ts` (lines 3744-3897)

## Current State Analysis

### Token Estimation

Two separate estimation systems exist:

| System | Algorithm | Used By | Accuracy |
|--------|-----------|---------|----------|
| `estimateTokens()` | Character-based heuristic (4 chars/token) | `contextManager.ts` | ±20-30% |
| `js-tiktoken` | BPE tokenizer | `tokenizer.ts` | ±5% |

**Critical issue:** Context pressure calculations use the heuristic, but compaction decisions should use accurate tokenization.

### Context Pressure Thresholds

```
none:   < 50% used
low:    50-70% used
medium: 70-85% used
high:   > 85% used
```

### Two-Tier Compaction

| Tier | Trigger | Action | LLM Call |
|------|---------|--------|----------|
| Tier 1 | 50% usage | Truncate tool outputs | No |
| Tier 2 | 85% usage | LLM summarization | Yes |

### Issues Found

| # | Issue | Severity | File:Line |
|---|-------|----------|-----------|
| 1 | Token estimation inconsistent between systems | High | contextManager.ts:197 |
| 2 | Compaction loses tool output context | High | contextManager.ts:507-537 |
| 3 | No user-triggered `/compact` command | Medium | — |
| 4 | Context overflow retry has no budget check | High | useAppStore.ts:1143-1199 |
| 5 | Compaction settings hardcoded | Medium | memoryTypes.ts:67-87 |
| 6 | `OUTPUT_RESERVE` override inconsistency (4000 vs 32000 vs 8000) | Medium | contextManager.ts:31, memoryTypes.ts:70, dalamAPI.ts:1441 |
| 7 | No compaction quality metrics | Low | — |
| 8 | `selectMessagesForCompaction` protects 6 turns (should be 4) | Low | contextManager.ts:417 |

---

## Improvement 3.1: Unify Token Estimation

**File:** `contextManager.ts`

### Current State

```typescript
// contextManager.ts:197 — Heuristic used for pressure calculation
export function estimateTokens(text: string): number {
  // Character-based: 4 chars/token for English, 3.5 for code, 1.5 for CJK
}

// dalamAPI.ts:1429 — tiktoken used for message inclusion
const { estimateTokens: estTokens } = await import("./contextManager");
// But estTokens is the HEURISTIC, not tiktoken
```

### Fix: Use tiktoken When Available

```typescript
import { countTokens } from "./tokenizer";

let _tiktokenAvailable: boolean | null = null;

async function getEstimator(): Promise<(text: string) => number> {
  if (_tiktokenAvailable === null) {
    try {
      await countTokens("test");
      _tiktokenAvailable = true;
    } catch {
      _tiktokenAvailable = false;
    }
  }
  
  if (_tiktokenAvailable) {
    return countTokens;
  }
  return estimateTokens; // Fallback to heuristic
}

// Cached estimator
let _cachedEstimator: ((text: string) => number) | null = null;

export async function getReliableEstimator(): Promise<(text: string) => number> {
  if (!_cachedEstimator) {
    _cachedEstimator = await getEstimator();
  }
  return _cachedEstimator;
}
```

---

## Improvement 3.2: Preserve Tool Output Context in Compaction

**File:** `contextManager.ts:507-537`

### Current State

```typescript
// buildCompactionPrompt drops all metadata
messages.map(m => ({
  role: m.role,
  content: m.content,  // Only content preserved
  // toolCalls, fileChanges, todos, thinking — ALL DROPPED
}));
```

### Fix: Include Key Tool Outputs in Summary

```typescript
export function buildCompactionPrompt(
  messages: ChatMessage[],
  previousSummary?: string
): { role: string; content: string }[] {
  // Format messages with preserved metadata
  const formatted = messages.map(m => {
    let content = m.content;
    
    // Preserve tool call results (not just the content)
    if (m.toolCalls?.length) {
      const toolSummary = m.toolCalls
        .filter(tc => tc.result)
        .map(tc => `[${tc.name}] ${tc.result?.slice(0, 500)}`)
        .join('\n');
      if (toolSummary) {
        content += `\n\nTool Results:\n${toolSummary}`;
      }
    }
    
    // Preserve file changes
    if (m.fileChanges?.length) {
      const changeSummary = m.fileChanges
        .map(fc => `${fc.action}: ${fc.path}`)
        .join('\n');
      content += `\n\nFile Changes:\n${changeSummary}`;
    }
    
    // Preserve todos
    if (m.todos?.length) {
      const todoSummary = m.todos
        .map(t => `${t.done ? '✓' : '○'} ${t.content}`)
        .join('\n');
      content += `\n\nTodos:\n${todoSummary}`;
    }
    
    return { role: m.role, content };
  });
  
  // ... rest of prompt building
}
```

---

## Improvement 3.3: Add `/compact` Command

**File:** `components/editor/ChatView.tsx`

### Slash Command Handler

```typescript
// In handleSubmit, add to slash command switch
case "/compact":
  if (!activeSessionId) {
    toast({ title: "No active session", type: "warning" });
    return;
  }
  
  const { compactSessionHistory } = useChat.getState();
  toast({ title: "Compacting context...", type: "info" });
  
  try {
    const result = await compactSessionHistory(activeSessionId);
    if (result.success) {
      toast({
        title: "Context compacted",
        description: `Reclaimed ~${result.tokensReclaimed} tokens`,
        type: "success",
      });
    } else {
      toast({
        title: "Compaction not needed",
        description: "Context usage is already low",
        type: "info",
      });
    }
  } catch (err) {
    toast({ title: "Compaction failed", type: "error" });
  }
  return;
```

### Update Help Text

```typescript
case "/help":
  return `/help — Show this help
/compact — Manually compact context window
/clear — Clear conversation
/dream — Run memory consolidation
...`;
```

---

## Improvement 3.4: Budget-Aware Context Overflow Retry

**File:** `useAppStore.ts:1143-1199`

### Current State

```typescript
// Lines 1143-1199: Retries without checking compaction success
const _handleContextOverflowRetry = async (...) => {
  if (retryCount >= MAX_CONTEXT_OVERFLOW_RETRIES) return false;
  
  _reduceContextBudget(sessionId);
  await compactSessionHistory(sessionId);
  sendMessage(retryMsg.content); // Auto-retry without checking compaction result
};
```

### Fix: Verify Compaction Success

```typescript
const _handleContextOverflowRetry = async (...) => {
  if (retryCount >= MAX_CONTEXT_OVERFLOW_RETRIES) {
    // Surface actionable error instead of silent failure
    const errorMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: "assistant",
      content: `Context window overflow after ${MAX_CONTEXT_OVERFLOW_RETRIES} retries. 
        Try starting a new session or using /compact manually.`,
      timestamp: Date.now(),
    };
    set(s => ({ messages: [...s.messages, errorMsg] }));
    return false;
  }
  
  // Reduce budget
  _reduceContextBudget(sessionId);
  
  // Compact and verify
  const compactResult = await compactSessionHistory(sessionId);
  
  if (!compactResult || compactResult.tokensReclaimed < 1000) {
    // Compaction didn't reclaim enough — don't retry
    const errorMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: "assistant",
      content: `Context overflow: compaction only reclaimed ${compactResult?.tokensReclaimed || 0} tokens.
        Consider starting a new session.`,
      timestamp: Date.now(),
    };
    set(s => ({ messages: [...s.messages, errorMsg] }));
    return false;
  }
  
  // Only retry if compaction succeeded
  setTimeout(() => {
    if (session.id === get().activeSessionId) {
      sendMessage(retryMsg.content);
    }
  }, 500);
  
  return true;
};
```

---

## Improvement 3.5: Make Compaction Settings Configurable

**File:** `packages/shared-types/src/index.ts`

```typescript
// Add to AppSettings
interface AppSettings {
  // ... existing fields
  
  // Context management (NEW)
  contextCompactionThreshold?: number;    // Default: 0.85
  contextPruneThreshold?: number;         // Default: 0.50
  contextOutputReserve?: number;          // Default: 8000
  contextCompactionBuffer?: number;       // Default: 20000
  maxContextOverflowRetries?: number;     // Default: 2
}
```

**File:** `contextManager.ts`

```typescript
function getCompactionThresholds(settings: AppSettings) {
  return {
    tier1Prune: settings.contextPruneThreshold ?? CTX.TIER1_PRUNE_RATIO,
    tier2Compact: settings.contextCompactionThreshold ?? CTX.TIER2_COMPACT_RATIO,
    outputReserve: settings.contextOutputReserve ?? 8000,
    compactionBuffer: settings.contextCompactionBuffer ?? CTX.COMPACTION_BUFFER,
  };
}
```

---

## Improvement 3.6: Fix OUTPUT_RESERVE Inconsistency

**Current inconsistency:**

| Location | Value | Purpose |
|----------|-------|---------|
| `memoryTypes.ts:70` | 32,000 | MiMo budget injection |
| `contextManager.ts:31` | 4,000 | Context pressure calculation |
| `dalamAPI.ts:1441` | 8,000 | Message inclusion backward scan |

### Fix: Document and Centralize

```typescript
// memoryTypes.ts — Define all reserves with clear purposes
export const CTX = {
  // ... existing constants
  
  // Token reserves (clearly named)
  OUTPUT_RESERVE_PRESSURE: 4_000,   // For context pressure calculation
  OUTPUT_RESERVE_MESSAGE: 8_000,    // For message inclusion in API calls
  OUTPUT_RESERVE_MIMO: 32_000,      // For MiMo budget injection
  COMPACTION_BUFFER: 20_000,        // Safety headroom
} as const;
```

---

## Implementation Steps

1. Unify token estimation (use tiktoken when available)
2. Preserve tool output context in compaction summaries
3. Add `/compact` slash command
4. Add budget check to context overflow retry
5. Make compaction thresholds configurable in settings
6. Fix OUTPUT_RESERVE naming and centralize constants
7. Add compaction quality metrics (track information loss)
8. Reduce protected turns from 6 to 4
9. Add tests for compaction boundary alignment
10. Add test: verify tool-call/tool-result pairs are never split

---

## Success Criteria

- [ ] Token estimation uses tiktoken when available
- [ ] Compaction summaries include tool outputs and file changes
- [ ] `/compact` command works and shows token savings
- [ ] Context overflow retry verifies compaction success before retrying
- [ ] All compaction thresholds are configurable via settings
- [ ] No OUTPUT_RESERVE confusion (clear naming)
- [ ] Tool-call/tool-result pairs are never split by compaction
