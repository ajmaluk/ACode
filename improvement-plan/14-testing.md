# Phase 14: Comprehensive Test Suite

> **Estimated Effort:** 1 week (partial — 12 new test files added, 1,014 tests)
> **Dependencies:** All other phases (tests should cover fixed code)
> **Priority:** High
> **Current State:** 31 test files, 1,014 tests, 0 TypeScript errors

## Current State (Updated July 2026)

### Existing Tests

| File | Coverage | Status |
|------|----------|--------|
| `__tests__/agentRuntimeContract.test.ts` | 18 tests — State machine transitions, invariants, helpers | ✅ New |
| `__tests__/changeStack.test.ts` | 12 tests — LIFO, peek, clear, capping | ✅ New |
| `__tests__/costTracker.test.ts` | 15 tests — Parsing, recording, formatting, pricing | ✅ New |
| `__tests__/errorPatterns.test.ts` | 22 tests — All 20+ error patterns, edge cases | ✅ New |
| `__tests__/instructions.test.ts` | 18 tests — Parsing, loading, formatting, glob matching | ✅ New |
| `__tests__/platform.test.ts` | 22 tests — Detection, shortcuts, command wrapping | ✅ New |
| `__tests__/safetyTimer.test.ts` | 12 tests — Timer creation, clearance, timeout handler | ✅ New |
| `__tests__/security.test.ts` | 20 tests — Private host, SSRF, audit logging | ✅ New |
| `__tests__/tokenizer.test.ts` | 15 tests — Token counting, messages, budget | ✅ New |
| `__tests__/toolSchemas.test.ts` | 45 tests — All schemas, security, dangerous commands | ✅ New |
| `__tests__/dalamAPI.test.ts` | **22 tests** — ProviderError, getRecentFiles, getActiveProvider, corsFetch, createDalamAPI | ✅ **New** |
| `__tests__/useAppStore.test.ts` | **59 tests** — stripXmlToolCallTags, parseXmlToolCalls, useGit, useCommandPalette | ✅ **New** |
| `toolExecutor.test.ts` | Parallel batching, retry logic | Existing |
| `pathUtils.test.ts` | Path normalization, language detection | Existing |
| `dalamTools.test.ts` | Tool parsing | Existing |
| `dreamProposalPipeline.test.ts` | Dream agent proposals | Existing |
| `instructions.test.ts` | Instruction loading | Existing |
| `toolResultLifecycle.test.ts` | Tool result processing | Existing |
| `toolParsing.test.ts` | XML tool call parsing | Existing |
| `memoryStore.test.ts` | Memory CRUD (SQLite+FTS5) | Existing |
| `verificationEngine.test.ts` | Verification pipeline | Existing |
| `hookBus.test.ts` | Event bus | Existing |
| `database.test.ts` | Database operations | Existing |
| `diff.test.ts` | Diff parsing | Existing |
| `contextManager.test.ts` | Context management | Existing |
| `skills.test.ts` | Skill registry | Existing |
| `agents.test.ts` | Agent definitions | Existing |
| `genes.test.ts` | Gene evolution | Existing |
| `usePermission.test.ts` | Permission system | Existing |
| `useChatSession.test.ts` | Chat session management | Existing |
| `database.crossPlatform.test.ts` | SQLite cross-platform | Existing |

### Coverage Gaps (Still Open)

| Module | Lines | Test Coverage | Gap |
|--------|-------|--------------|-----|
| ~~`useAppStore.ts`~~ | 5,564 | **59 tests added** | ✅ **Partially covered** |
| ~~`dalamAPI.ts`~~ | 4,598 | **22 tests added** | ✅ **Partially covered** |
| `mcpCache.ts` | 146 | **NONE** | Cache logic untested |
| `connectors.ts` | 858 | **NONE** | Plugin system untested |
| `skillCrystallizer.ts` | 217 | **NONE** | Auto-skill generation |
| `trajectoryRecorder.ts` | 515 | **NONE** | Recording untested |
| `dreamAgent.ts` | 726 | **NONE** | Dream cycle untested |
| `ChatView.tsx` | ~1,445 | **NONE** | UI untested |
| `SettingsModal.tsx` | ~1,944 | **NONE** | Settings untested |
| Rust commands | 1,404 | **NONE** | Backend untested |

### Test Framework

- Uses **Vitest** — fast, native TypeScript, watch mode
- **31 test files total** covering lib modules and stores
- **1,014 tests total**, all passing, 0 TypeScript errors
- No E2E tests yet (Playwright not configured)
- No integration tests for full agent loop
- No snapshot tests for UI
- No Rust unit tests (`#[cfg(test)]` modules)

## Remaining Implementation Steps

### Step 1: MCP Cache Tests (0.5 days)
Create `mcpCache.test.ts` covering store/retrieve, TTL, overflow, invalidation.

### Step 2: Connector Tests (0.5 days)
Create `connectors.test.ts` covering config loading, schema validation, start/stop, error handling.

### Step 3: Skill Crystallizer Tests (0.5 days)
Create `skillCrystallizer.test.ts` covering generation, budget enforcement, schema validation.

### Step 4: Integration Tests (1 day)
Create `agentLoop.integration.test.ts` covering full agent cycle: prompt → LLM → tool → result.

### Step 5: E2E Tests with Playwright (1 day)
Create `e2e/` directory with tests for send message, settings, session management.

### Step 6: Rust Unit Tests (0.5 days)
Add `#[cfg(test)]` modules for env blocking, process safety, path validation.

## Success Criteria (Updated)

- [x] Agent runtime contract has 100% transition coverage (18 tests) ✅
- [x] Change stack, cost tracker, error patterns, tokenizer fully tested ✅
- [x] All 40+ tool schemas validated with security checks ✅
- [x] Platform detection tested on all OS variants ✅
- [x] `dalamAPI.ts` has 22 unit tests ✅
- [x] `useAppStore.ts` has 59 unit tests ✅
- [ ] `mcpCache.ts`, `connectors.ts`, `skillCrystallizer.ts` have tests (open)
- [ ] At least 5 E2E tests for critical user flows (open)
- [ ] Rust commands have basic unit tests (open)
- [ ] Performance benchmarks for hot paths (open)
