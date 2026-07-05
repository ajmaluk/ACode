# Phase 14: Comprehensive Test Suite

> **Estimated Effort:** 1 week
> **Dependencies:** All other phases (tests should cover fixed code)
> **Priority:** High

## Current State

### Existing Tests

| File | Coverage | Status |
|------|----------|--------|
| `toolExecutor.test.ts` | Parallel batching, retry logic | Good |
| `pathUtils.test.ts` | Path normalization, language detection | Good |
| `dalamTools.test.ts` | Tool parsing | Good |
| `dreamProposalPipeline.test.ts` | Dream agent proposals | Good |
| `instructions.test.ts` | Instruction loading | Good |
| `toolResultLifecycle.test.ts` | Tool result processing | Good |
| `toolParsing.test.ts` | XML tool call parsing | Good |
| `storage.pathNorm.test.ts` | Storage path normalization | Good |
| `database.crossPlatform.test.ts` | SQLite cross-platform | Good |
| `memoryStore.test.ts` | Memory CRUD | Good |
| `verificationEngine.test.ts` | Verification pipeline | Good |
| `hookBus.test.ts` | Event bus | Good |
| `database.test.ts` | Database operations | Good |
| `diff.test.ts` | Diff parsing | Good |
| `contextManager.test.ts` | Context management | Good |
| `skills.test.ts` | Skill registry | Good |
| `agents.test.ts` | Agent definitions | Good |
| `genes.test.ts` | Gene evolution | Good |
| `usePermission.test.ts` | Permission system | Good |
| `useChatSession.test.ts` | Chat session management | Good |

### Coverage Gaps

| Module | Test Coverage | Gap |
|--------|--------------|-----|
| `useAppStore.ts` (5,411 lines) | **NONE** | Core store untested |
| `dalamAPI.ts` (4,331 lines) | **NONE** | LLM streaming untested |
| `agentRuntimeContract.ts` | **NONE** | State machine untested |
| `mcpCache.ts` | **NONE** | Cache logic untested |
| `connectors.ts` | **NONE** | Plugin system untested |
| `skillCrystallizer.ts` | **NONE** | Auto-skill generation untested |
| `trajectoryRecorder.ts` | **NONE** | Recording untested |
| `ChatView.tsx` (1,445 lines) | **NONE** | UI untested |
| `SettingsModal.tsx` (1,944 lines) | **NONE** | Settings untested |
| Rust commands | **NONE** | Backend untested |

### Test Framework

- Uses Vitest (based on `.test.ts` file naming)
- No E2E tests found
- No integration tests for agent loop
- No snapshot tests for UI

## Issues Found

### 1. No Tests for Core Agent Loop
**Severity:** HIGH
**Location:** `useAppStore.ts`, `dalamAPI.ts`
**Issue:** The most critical code paths (LLM streaming, tool execution, state management) have zero test coverage.
**Fix:** Add unit tests for core functions; integration tests for agent loop.

### 2. No Tests for State Machine
**Severity:** HIGH
**Location:** `agentRuntimeContract.ts`
**Issue:** State transitions are the backbone of agent behavior. Untested transitions can cause stuck states.
**Fix:** Add exhaustive state machine tests covering all transition paths.

### 3. No E2E Tests
**Severity:** MEDIUM
**Location:** Throughout
**Issue:** No end-to-end tests simulating user interactions.
**Fix:** Add Playwright tests for critical user flows.

### 4. No Rust Command Tests
**Severity:** MEDIUM
**Location:** `src-tauri/src/system.rs`, `src-tauri/src/git.rs`
**Issue:** 1,043 lines of Rust with zero tests. Clipboard, process management, file operations untested.
**Fix:** Add Rust unit tests with `#[cfg(test)]` modules.

### 5. No Performance Regression Tests
**Severity:** LOW
**Location:** Throughout
**Issue:** No benchmarks or performance regression detection.
**Fix:** Add Vitest benchmarks for hot paths.

## Implementation Steps

### Step 1: Agent Runtime Contract Tests (1 day)
Create `agentRuntimeContract.test.ts`:
```ts
describe("agentReducer", () => {
  it("transitions from idle to streaming on START_STREAM", () => {});
  it("transitions from streaming to idle on STREAM_MESSAGE_END", () => {});
  it("transitions to error on TOOL_ERROR", () => {});
  it("rejects invalid transitions", () => {});
  it("caps transitionLog at 200 entries", () => {});
  it("handles streaming-pending-diffs phase", () => {});
  it("handles tool-retrying phase", () => {});
  it("handles tool-timed-out phase", () => {});
});
```

### Step 2: MCP Cache Tests (0.5 days)
Create `mcpCache.test.ts`:
```ts
describe("mcpCache", () => {
  it("stores and retrieves tool schemas", () => {});
  it("respects TTL expiration", () => {});
  it("handles cache overflow", () => {});
  it("invalidates on server restart", () => {});
});
```

### Step 3: Connector Tests (0.5 days)
Create `connectors.test.ts`:
```ts
describe("connectors", () => {
  it("loads connector configs from storage", () => {});
  it("validates connector config schema", () => {});
  it("starts and stops connectors", () => {});
  it("handles connector errors gracefully", () => {});
});
```

### Step 4: Skill Crystallizer Tests (0.5 days)
Create `skillCrystallizer.test.ts`:
```ts
describe("skillCrystallizer", () => {
  it("generates skill from repeated patterns", () => {});
  it("enforces 50-skill budget", () => {});
  it("skips crystallization when budget full", () => {});
  it("validates skill schema before saving", () => {});
});
```

### Step 5: Cost Tracker Tests (0.5 days)
Create `costTracker.test.ts`:
```ts
describe("costTracker", () => {
  it("parses OpenAI token usage", () => {});
  it("parses Anthropic token usage", () => {});
  it("calculates cost per model", () => {});
  it("accumulates session totals", () => {});
  it("triggers budget warnings", () => {});
});
```

### Step 6: Integration Tests (1 day)
Create `agentLoop.integration.test.ts`:
```ts
describe("agent loop integration", () => {
  it("executes a full agent cycle: prompt → LLM → tool → result", () => {});
  it("handles tool errors and retries", () => {});
  it("compacts context when threshold reached", () => {});
  it("extracts memory after user messages", () => {});
  it("records trajectory for post-hoc analysis", () => {});
});
```

### Step 7: E2E Tests with Playwright (1 day)
Create `e2e/` directory:
```ts
// e2e/agent-flow.spec.ts
test("user can send message and see response", async ({ page }) => {});
test("user can open settings and change model", async ({ page }) => {});
test("user can create and switch sessions", async ({ page }) => {});
test("user can search memory", async ({ page }) => {});
```

### Step 8: Rust Unit Tests (0.5 days)
Add `#[cfg(test)]` modules to Rust files:
```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_env_blocked() {
        // Test that blocked env vars are rejected
    }

    #[test]
    fn test_process_kill_safety() {
        // Test that PID 0, 1, self are rejected
    }

    #[test]
    fn test_path_validation() {
        // Test file path security checks
    }
}
```

### Step 9: Performance Benchmarks (0.5 days)
Create `bench/` directory:
```ts
// bench/tokenEstimation.bench.ts
import { bench, describe } from "vitest";
describe("token estimation", () => {
  bench("estimate 1K tokens", () => { /* ... */ });
  bench("estimate 10K tokens", () => { /* ... */ });
});

// bench/regexParsing.bench.ts
describe("XML tool call parsing", () => {
  bench("parse 10 tool calls", () => { /* ... */ });
});
```

## Test Configuration

### Vitest Config
```ts
// vitest.config.ts
export default defineConfig({
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./test/setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      exclude: ["node_modules/", "test/"],
    },
  },
});
```

### Playwright Config
```ts
// playwright.config.ts
export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  use: {
    baseURL: "http://localhost:1420",
    trace: "on-first-retry",
  },
  webServer: {
    command: "npm run dev",
    port: 1420,
  },
});
```

## Success Criteria

- [ ] All new code has > 80% unit test coverage
- [ ] Agent runtime contract has 100% transition coverage
- [ ] At least 5 E2E tests for critical user flows
- [ ] Rust commands have basic unit tests
- [ ] Performance benchmarks for hot paths
- [ ] CI pipeline runs all tests on every PR

## Test Coverage Targets

| Module | Current | Target |
|--------|---------|--------|
| `agentRuntimeContract.ts` | 0% | 90% |
| `dalamAPI.ts` | 0% | 60% (unit) + integration |
| `mcpCache.ts` | 0% | 80% |
| `connectors.ts` | 0% | 70% |
| `costTracker.ts` (new) | N/A | 90% |
| Rust commands | 0% | 50% |
| E2E flows | 0 | 5 tests |
