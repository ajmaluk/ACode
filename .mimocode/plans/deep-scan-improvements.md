# Deep Scan: Comprehensive Codebase Improvements

## Phase 1: Critical Cleanup (Production console.log)
- Guard all unconditional console.log calls in production code
- Files: hookListeners.ts, connectors.ts, trajectoryRecorder.ts, agentRuntimeContract.ts, dreamAgent.ts

## Phase 2: localStorage → SQLite Migration
- Migrate session messages from localStorage to SQLite (quota issues)
- Migrate session summaries, permissions, MCP configs
- Add proper migration logic with fallback

## Phase 3: Race Condition Fixes
- Fix _abortControllers Map mutation pattern in useAppStore.ts
- Fix _toolCallHistory/_toolFailureCounts concurrent access
- Fix _pendingMessagesRef throttle buffer

## Phase 4: Code Quality
- Remove unused imports across components
- Make model pricing configurable (costTracker.ts)
- Add missing tool dependency entries

## Phase 5: Integration Tests
- Add integration tests for tool execution pipeline
- Add integration tests for compaction flow
- Add integration tests for permission system

## Phase 6: Performance
- Pre-compile regex patterns in dalamAPI.ts
- Optimize context pressure calculations
- Add missing tool timeouts
