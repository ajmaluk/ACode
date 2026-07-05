# Phase 2: Tool Calling

> **Priority:** High
> **Estimated Effort:** 1 week
> **Dependencies:** Phase 1 (runtime contract)
> **Primary Files:** `toolExecutor.ts` (287 lines), `toolSchemas.ts` (406 lines), `dalamAPI.ts` (4,598 lines), `agents.ts` (465 lines)
> **Audit Status:** 🟡 Partial — 2/8 improvements implemented, 6 pending

## Current State Analysis

### Tool Execution Pipeline

```
LLM Response → parseToolCalls() → permission check → executeTool() → result injection
```

**50+ tools** across 8 categories: file ops, search, shell, git, memory, system, UI, agent.

### Issues Found & Resolution Status

| # | Issue | Severity | Status |
|---|-------|----------|--------|
| 1 | Parallel execution built but UNUSED | High | ❌ Not wired into main loop |
| 2 | 30+ regex patterns compiled at runtime per call | Medium | 🟡 Partially (regexCache.ts exists, dalamAPI regex not pre-compiled) |
| 3 | Diff binding uses unsafe heuristics (4-strategy fallback) | High | ❌ Not fixed |
| 4 | Tool args validated at multiple points | Medium | ❌ Not fixed |
| 5 | `run_command` output cap (50KB) ≠ `MAX_RESULT_CHARS` (30KB) | Low | ❌ Not fixed |
| 6 | No tool call cost tracking | Medium | ✅ Fixed (costTracker.ts, recordToolCost in toolExecutor.ts) |
| 7 | MCP tool naming ambiguous with underscores | Medium | ❌ Not fixed |
| 8 | No tool execution timeout per tool | High | ❌ Not implemented |

### What's Verified Implemented

- ✅ Tool call cost tracking (`costTracker.ts`, `recordToolCost()`)
- ✅ Regex caching utility (`regexCache.ts` with `getCachedRegex`)
- ✅ Tool schemas validated via Zod (single validation point in `toolExecutor.ts`)
- ✅ Error recovery patterns (`errorPatterns.ts` with 20+ patterns)

### What's NOT Implemented

- ❌ Parallel execution not used in `useAppStore.ts` main loop
- ❌ 30+ regex patterns in `dalamAPI.ts` still compiled per call
- ❌ Diff binding heuristics not replaced with strict mapping
- ❌ No per-tool execution timeout
- ❌ Output caps not aligned (50KB vs 30KB)
- ❌ MCP tool naming disambiguation not fixed

---

## Implementation Order

### Quick Fix (1 day)
1. Pre-compile all regex patterns as module constants in `dalamAPI.ts`
2. Align output truncation caps

### Medium Effort (2-3 days)
3. Add per-tool execution timeouts with `TOOL_TIMEOUTS` map
4. Fix MCP tool name disambiguation (longest prefix match)

### High Effort (3-4 days)
5. Replace diff binding heuristics with strict `diffId → toolCallId` map
6. Wire parallel execution from `toolExecutor.ts` into main loop

---

## Success Criteria (Updated)

- [ ] Tool parsing is ~30% faster (regex pre-compilation)
- [ ] Zero wrong diff bindings (strict mapping)
- [ ] Tool execution timeout prevents hanging
- [x] Cost tracking shows per-tool breakdown
- [ ] MCP tool names resolve correctly with underscores
- [ ] Parallel execution works for independent read-only tools
