# Dalam (ACode) — Comprehensive Improvement Plan

> **Codebase:** ~35,000 lines across 50+ source files
> **Architecture:** Tauri v2 (Rust backend + React 19 frontend), Zustand stores, XML tool protocol, SQLite+FTS5 memory
> **Analysis Scope:** 12 parallel deep-analysis agents covering every module

## Executive Summary

This plan identifies **8 critical bugs**, **47 high-priority issues**, and **30+ improvement opportunities** across the entire Dalam codebase. It is organized into 16 phases, ordered by impact and dependency.

### Critical Bugs (Fix Immediately)

| # | File | Issue | Impact |
|---|------|-------|--------|
| 1 | `skillCrystallizer.ts:154` | Budget check reads wrong directory — 50-skill cap never enforced | Unbounded skill accumulation |
| 2 | `agentRuntimeContract.ts:287-294` | `STREAM_MESSAGE_END` silently drops event — agent stuck in `streaming` forever | Dead agent state |
| 3 | `dreamAgent.ts:548` | Dream timing stored in localStorage — cleared on browser clear | Dream cycles run on every startup |
| 4 | `dreamAgent.ts:450-452` | In-place mutation during dedup iteration | Processed already-merged pairs |
| 5 | `connectors.ts:806-811` | Config save stops connector but never restarts | Changes require app restart |
| 6 | `mcpCache.ts:62` | TTL parameter accepted but NEVER used | All entries use default 1h TTL |
| 7 | `verificationEngine.ts:38` | `contentPattern` field never checked | Dead schema |
| 8 | `agentRuntimeContract.ts:338` | `transitionLog` grows unbounded | Memory leak in long sessions |

### Key Metrics (Current → Target)

| Metric | Current | Target |
|--------|---------|--------|
| Orphan tool calls | Possible | 0 (state machine enforced) |
| Wrong diff applies | Possible (heuristics) | 0 (strict binding) |
| Dream cycle LLM calls | Up to 30 | ≤5 (batched) |
| Parallel tool execution | Sequential | 3-5x speedup |
| API key security | Plaintext localStorage | Encrypted (OS keychain) |
| MCP stdio latency | 5-15s per call (new process) | <1s (persistent connection) |
| Context overflow retries | Unbounded | Max 2 with budget check |
| Memory extraction LLM calls/turn | Always attempted | Gated (~50% reduction) |

## Documentation Index

| Phase | Document | Scope | Estimated Effort | Status |
|-------|----------|-------|-----------------|--------|
| 0 | [Critical Bugs](00-critical-bugs.md) | 8 bugs requiring immediate fixes | 1-2 days | ✅ Completed |
| 1 | [Agent Runtime Contract](01-agent-runtime-contract.md) | State machine, phases, invariants | 1 week | ✅ Completed |
| 2 | [Tool Calling](02-tool-calling.md) | Execution, parsing, parallel, security | 1 week | ✅ Completed |
| 3 | [Context Management](03-context-management.md) | Token estimation, compaction, overflow | 1 week | ✅ Completed |
| 4 | [Memory System](04-memory-system.md) | SQLite/FTS5, extraction, scoring | 1 week | ✅ Completed |
| 5 | [Dream Agent](05-dream-agent.md) | Consolidation, dedup, date adjustment | 1 week | ✅ Completed |
| 6 | [Session Management](06-session-management.md) | Persistence, versions, restore | 3-4 days | ✅ Completed |
| 7 | [UI & Desktop](07-ui-desktop.md) | Components, themes, performance | 1-2 weeks | ✅ Completed |
| 8 | [Security](08-security.md) | API keys, SSRF, permissions, CSP | 1 week | ✅ Completed |
| 9 | [Self-Improving Systems](09-self-improving.md) | Genes, skills, hooks, verification | 1 week | ✅ Completed |
| 10 | [MCP & Connectors](10-mcp-connectors.md) | Protocol, connectors, tool integration | 1 week | ✅ Completed |
| 11 | [Cross-OS](11-cross-os.md) | Platform-specific issues | 3-4 days | ✅ Completed |
| 12 | [Performance](12-performance.md) | Regex caching, lazy loading, memory | 3-4 days | ✅ Completed |
| 13 | [Missing Features](13-missing-features.md) | Feature parity with Claude Code/Cursor | 2-3 weeks | 🔄 In Progress |
| 14 | [Testing](14-testing.md) | Unit, integration, harness tests | 1 week |
| 15 | [Configuration](15-configuration.md) | Settings, providers, updates | 3-4 days |
| 16 | [Rust Backend](16-rust-backend.md) | Commands, security, error handling | 3-4 days |

## Implementation Order

```
Wave 1 (Week 1-2): Critical Fixes + Security
├── Phase 0: Fix 8 critical bugs
└── Phase 8: API key encryption, MCP SSRF validation

Wave 2 (Week 3-4): Tool Calling + Parallel Execution
├── Phase 1: Agent runtime contract state machine
├── Phase 2: Wire parallel tool execution, pre-compile regex
└── Phase 9: Gene system fixes, missing hooks

Wave 3 (Week 5-6): Context & Memory Efficiency
├── Phase 3: Token estimation consistency, compaction fixes
├── Phase 4: Memory extraction gating, FTS hardening
└── Phase 5: Dream agent batching, request reduction

Wave 4 (Week 7-8): MCP + Connectors
├── Phase 10: Persistent MCP connections, session management
└── Phase 15: Settings validation, provider config

Wave 5 (Week 9-10): UI & Desktop
├── Phase 7: Store split, virtualization, diff preview
├── Phase 11: Cross-OS fixes
└── Phase 12: Performance optimization

Wave 6 (Week 11-12): Features & Testing
├── Phase 6: Session persistence unification
├── Phase 13: Missing features (undo, compact, cost tracking)
├── Phase 14: Comprehensive test suite
└── Phase 16: Rust backend hardening
```

## File Reference Map

### Core Agent Loop
- `apps/desktop/src/renderer/store/useAppStore.ts` (~5,411 lines) — Main store with agent orchestration
- `apps/desktop/src/renderer/lib/dalamAPI.ts` (~4,331 lines) — LLM streaming, tool execution, system prompt

### Tool System
- `apps/desktop/src/renderer/lib/toolExecutor.ts` (287 lines) — Parallel execution (UNUSED)
- `apps/desktop/src/renderer/lib/toolSchemas.ts` (406 lines) — Zod validation, security checks
- `apps/desktop/src/renderer/lib/agents.ts` (465 lines) — Agent definitions, permission rules

### Context & Memory
- `apps/desktop/src/renderer/lib/contextManager.ts` (692 lines) — Token estimation, compaction
- `apps/desktop/src/renderer/lib/memoryStore.ts` (1,095 lines) — SQLite+FTS5 memory
- `apps/desktop/src/renderer/lib/memoryTypes.ts` (90 lines) — Constants, types

### Self-Improving
- `apps/desktop/src/renderer/lib/genes.ts` (653 lines) — Gene evolution system
- `apps/desktop/src/renderer/lib/dreamAgent.ts` (695 lines) — Background consolidation
- `apps/desktop/src/renderer/lib/skillCrystallizer.ts` (215 lines) — Auto skill generation
- `apps/desktop/src/renderer/lib/hookBus.ts` (227 lines) — Lifecycle events
- `apps/desktop/src/renderer/lib/hookListeners.ts` (551 lines) — Event handlers
- `apps/desktop/src/renderer/lib/verificationEngine.ts` (304 lines) — Verify/execute/finalize
- `apps/desktop/src/renderer/lib/agentRuntimeContract.ts` (435 lines) — State machine
- `apps/desktop/src/renderer/lib/trajectoryRecorder.ts` (501 lines) — JSONL recording

### MCP & Connectors
- `apps/desktop/src/renderer/lib/mcpCache.ts` (143 lines) — Tool caching
- `apps/desktop/src/renderer/lib/connectors.ts` (831 lines) — Plugin system
- `apps/desktop/src/renderer/lib/skills.ts` (580 lines) — Skill registry
- `apps/desktop/src/renderer/lib/instructions.ts` (380 lines) — 4-layer instructions

### Rust Backend
- `apps/desktop/src-tauri/src/lib.rs` (56 lines) — Plugin registration
- `apps/desktop/src-tauri/src/git.rs` (305 lines) — Git operations
- `apps/desktop/src-tauri/src/system.rs` (1,043 lines) — OS integration

### UI Components
- `apps/desktop/src/renderer/App.tsx` (641 lines) — Root layout
- `apps/desktop/src/renderer/components/editor/ChatView.tsx` (1,445 lines) — Chat interface
- `apps/desktop/src/renderer/components/settings/SettingsModal.tsx` (1,944 lines) — Settings
- `apps/desktop/src/renderer/components/chat/ActivityBlocks.tsx` (~1,110 lines) — Activity display
