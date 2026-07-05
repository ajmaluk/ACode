# Phase 2: Tool Calling

> **Priority:** High
> **Estimated Effort:** 1 week
> **Dependencies:** Phase 1 (runtime contract)
> **Primary Files:** `toolExecutor.ts` (287 lines), `toolSchemas.ts` (406 lines), `dalamAPI.ts` (4,331 lines), `agents.ts` (465 lines)

## Current State Analysis

### Tool Execution Pipeline

```
LLM Response → parseToolCalls() → permission check → executeTool() → result injection
```

**50+ tools** across 8 categories: file ops, search, shell, git, memory, system, UI, agent.

### Issues Found

| # | Issue | Severity | File:Line |
|---|-------|----------|-----------|
| 1 | Parallel execution built but UNUSED | High | toolExecutor.ts |
| 2 | 30+ regex patterns compiled at runtime per call | Medium | dalamAPI.ts:2392-2883 |
| 3 | Diff binding uses unsafe heuristics (4-strategy fallback) | High | useAppStore.ts:2287-2399 |
| 4 | Tool args validated at multiple points | Medium | toolExecutor.ts:151, dalamAPI.ts:2965 |
| 5 | `run_command` output cap (50KB) ≠ `MAX_RESULT_CHARS` (30KB) | Low | dalamAPI.ts:3301, 1733 |
| 6 | No tool call cost tracking | Medium | — |
| 7 | MCP tool naming ambiguous with underscores | Medium | dalamAPI.ts:2759-2782 |
| 8 | No tool execution timeout per tool | High | — |

---

## Improvement 2.1: Pre-Compile All Tool Call Regex Patterns

**File:** `dalamAPI.ts`

### Current State (per call)

```typescript
// Lines 2392-2883: Creates ~30 regex objects on EVERY call
const read_file_regex = /<read_file\s+([^>]*?)\s*\/?>/gi;
const write_file_regex = /<write_file\s+([^>]*?)\s*\/?>/gi;
// ... 28 more patterns
```

### Fix: Module-Level Constants

```typescript
// At module top level (compiled once)
const TOOL_PATTERNS = {
  read_file: /<read_file\s+([^>]*?)\s*\/?>/gi,
  write_file: /<write_file\s+([^>]*?)\s*\/?>/gi,
  edit_file: /<edit_file\s+([^>]*?)\s*\/?>/gi,
  list_dir: /<list_dir\s+([^>]*?)\s*\/?>/gi,
  grep_file: /<grep_file\s+([^>]*?)\s*\/?>/gi,
  search_files: /<search_files\s+([^>]*?)\s*\/?>/gi,
  run_command: /<run_command\s+([^>]*?)\s*\/?>/gi,
  git_status: /<git_status\s*\/?>/gi,
  git_commit: /<git_commit\s+([^>]*?)\s*\/?>/gi,
  // ... all 50+ tools
} as const;

// In parseToolCalls, reset lastIndex before use
function parseToolCalls(text: string): ToolCall[] {
  const calls: ToolCall[] = [];
  
  for (const [toolName, pattern] of Object.entries(TOOL_PATTERNS)) {
    pattern.lastIndex = 0; // Reset global regex
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const args = parseArgs(match[1]);
      calls.push({ name: toolName, args });
    }
  }
  
  return deduplicateToolCalls(calls);
}
```

### Performance Impact

- **Before:** ~30 regex compilations per `parseToolCalls` call (called 1-3 times per agent turn)
- **After:** 0 regex compilations (compiled once at module load)
- **Estimated improvement:** ~30% faster tool parsing

---

## Improvement 2.2: Replace Diff Binding Heuristics with Strict Mapping

**File:** `useAppStore.ts:2287-2399`

### Current Unsafe Fallback Chain

```
Strategy 1: toolCallId match
Strategy 2: filePath + edit tool name
Strategy 3: content hash
Strategy 4: most recent edit tool fallback
Strategy 5: search messages backward
```

### New Strict Binding

```typescript
// New state field
interface UseChatState {
  pendingDiffBindings: Map<string, string>;  // diffId → toolCallId
  // ...
}

// When tool call is registered (in tool-call handler)
case "tool-call":
  if (event.diffId) {
    // Strict binding at registration time
    state.pendingDiffBindings.set(event.diffId, event.toolCallId);
  }

// When diff-proposed arrives
case "diff-proposed":
  const toolCallId = state.pendingDiffBindings.get(event.proposal.diffId);
  
  if (!toolCallId) {
    // No binding found — this is a bug, not a fallback
    console.error(`[DiffBinding] No binding for diffId: ${event.proposal.diffId}`);
    // Show error artifact, not silently fail
    return {
      ...state,
      diffBindingErrors: [...state.diffBindingErrors, {
        diffId: event.proposal.diffId,
        filePath: event.proposal.filePath,
        timestamp: Date.now(),
      }],
    };
  }
  
  // Strict binding: patch the exact tool call
  const patchedToolCalls = state.pendingToolCalls.map(tc =>
    tc.id === toolCallId
      ? { ...tc, diffId: event.proposal.diffId, diff: event.proposal }
      : tc
  );
  
  return { ...state, pendingToolCalls: patchedToolCalls };

// Cleanup on turn completion
case "message-end":
  return {
    ...state,
    pendingDiffBindings: new Map(),
    diffBindingErrors: [],
  };
```

### DiffBindingError UI

```typescript
// Show binding errors in the chat
{diffBindingErrors.length > 0 && (
  <div className="bg-yellow-500/10 border border-yellow-500/30 rounded p-3 text-sm">
    <Warning className="inline w-4 h-4 mr-1" />
    {diffBindingErrors.length} diff(s) could not be bound to tool calls.
    These changes were applied but cannot be undone.
  </div>
)}
```

---

## Improvement 2.3: Single Canonical Validation Point

**File:** `toolExecutor.ts`

### Current State

Tool args are validated in:
1. `toolExecutor.ts:151` — `validateToolArgs()` before execution
2. `dalamAPI.ts:2965-2969` — Zod validation in `executeTool()`
3. `toolSchemas.ts` — Schema definitions

### Fix: Validate Once in `executeTool()`

```typescript
// toolExecutor.ts
export async function executeToolWithRetry(
  tc: ToolCall,
  abortSignal?: AbortSignal
): Promise<ToolResult> {
  // Single validation point (already exists at line 151)
  const validation = validateToolArgs(tc.name, tc.args);
  if (!validation.success) {
    return {
      toolCallId: tc.id,
      name: tc.name,
      result: `Error: Invalid arguments: ${validation.error}`,
      success: false,
    };
  }
  
  // Execute with retry
  return executeWithRetry(tc, abortSignal);
}
```

Remove duplicate validation from `dalamAPI.ts:2965-2969`.

---

## Improvement 2.4: Add Tool Execution Timeout

**File:** `toolExecutor.ts`

```typescript
const TOOL_TIMEOUTS: Record<string, number> = {
  read_file: 10_000,      // 10s
  write_file: 30_000,     // 30s
  edit_file: 30_000,      // 30s
  run_command: 60_000,    // 60s
  grep_file: 30_000,      // 30s
  search_files: 60_000,   // 60s
  git_status: 15_000,     // 15s
  git_commit: 30_000,     // 30s
  default: 30_000,        // 30s
};

async function executeWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  toolName: string
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`Tool ${toolName} timed out after ${timeoutMs}ms`)), timeoutMs)
    ),
  ]);
}

// In executeToolWithRetry:
const timeout = TOOL_TIMEOUTS[tc.name] || TOOL_TIMEOUTS.default;
const result = await executeWithTimeout(
  executeTool(tc.name, tc.args),
  timeout,
  tc.name
);
```

---

## Improvement 2.5: Align Output Caps

**File:** `dalamAPI.ts`

### Current Inconsistency

| Constant | Value | Location |
|----------|-------|----------|
| `MAX_RESULT_CHARS` | 30,000 | line 1733 |
| `run_command` maxLen | 50,000 | line 3301 |
| `MAX_SUB_RESULT` | 15,000 | line 4274 |

### Fix: Unified Constants

```typescript
// Shared constants
const TOOL_RESULT_LIMITS = {
  default: 30_000,
  run_command: 50_000,  // Commands can produce more output
  sub_agent: 15_000,    // Sub-agents have less context
  read_file: 100_000,   // File reads need full content for context
} as const;

function truncateToolResult(
  result: string,
  toolName: string
): string {
  const limit = TOOL_RESULT_LIMITS[toolName] || TOOL_RESULT_LIMITS.default;
  if (result.length <= limit) return result;
  return result.slice(0, limit) + `\n\n[Truncated at ${limit} chars]`;
}
```

---

## Improvement 2.6: Add Tool Call Cost Tracking

**File:** `toolExecutor.ts`

```typescript
interface ToolCostRecord {
  toolCallId: string;
  name: string;
  durationMs: number;
  tokenEstimate: number;  // Estimated tokens in input/output
  retries: number;
  success: boolean;
  timestamp: number;
}

// Track costs per session
const _toolCosts: Map<string, ToolCostRecord[]> = new Map();

export function recordToolCost(record: ToolCostRecord): void {
  const sessionCosts = _toolCosts.get(record.toolCallId.split('-')[0]) || [];
  sessionCosts.push(record);
  _toolCosts.set(record.toolCallId.split('-')[0], sessionCosts);
}

export function getSessionToolCosts(sessionId: string): {
  totalCalls: number;
  totalDurationMs: number;
  totalRetries: number;
  byTool: Record<string, { calls: number; durationMs: number }>;
} {
  const costs = _toolCosts.get(sessionId) || [];
  const byTool: Record<string, { calls: number; durationMs: number }> = {};
  
  for (const cost of costs) {
    if (!byTool[cost.name]) {
      byTool[cost.name] = { calls: 0, durationMs: 0 };
    }
    byTool[cost.name].calls++;
    byTool[cost.name].durationMs += cost.durationMs;
  }
  
  return {
    totalCalls: costs.length,
    totalDurationMs: costs.reduce((sum, c) => sum + c.durationMs, 0),
    totalRetries: costs.reduce((sum, c) => sum + c.retries, 0),
    byTool,
  };
}
```

---

## Improvement 2.7: Fix MCP Tool Name Disambiguation

**File:** `dalamAPI.ts:2759-2782`

### Current Ambiguous Matching

```typescript
// Line 2759-2782: Prefix matching can be ambiguous
// Server "stitch" and "stitch-api" both match "stitch_list"
```

### Fix: Exact Match First, Then Longest Prefix

```typescript
function resolveMcpToolName(
  rawName: string,
  serverNames: string[]
): { serverName: string; toolName: string } | null {
  // Split: mcp_<server>_<tool>
  const parts = rawName.split('_');
  if (parts.length < 3 || parts[0] !== 'mcp') return null;
  
  // Try exact server name match (longest first)
  const sortedServers = [...serverNames].sort((a, b) => b.length - a.length);
  
  for (const serverName of sortedServers) {
    const serverParts = serverName.split(/[-_]/);
    const prefix = ['mcp', ...serverParts].join('_');
    
    if (rawName.startsWith(prefix + '_')) {
      const toolName = rawName.slice(prefix.length + 1);
      return { serverName, toolName };
    }
  }
  
  return null;
}
```

---

## Implementation Steps

1. Pre-compile all regex patterns as module constants
2. Replace diff binding heuristics with strict `diffId → toolCallId` map
3. Remove duplicate tool args validation
4. Add per-tool execution timeouts
5. Align output truncation caps
6. Add tool call cost tracking
7. Fix MCP tool name disambiguation
8. Add tests for all tool parsing edge cases
9. Add integration test: parallel execution of read-only tools

---

## Success Criteria

- [ ] Tool parsing is ~30% faster (regex pre-compilation)
- [ ] Zero wrong diff bindings (strict mapping)
- [ ] Tool execution timeout prevents hanging
- [ ] Cost tracking shows per-tool breakdown
- [ ] MCP tool names resolve correctly with underscores
- [ ] Parallel execution works for independent read-only tools
