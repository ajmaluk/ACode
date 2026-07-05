# Phase 10: MCP & Connectors

> **Priority:** Medium-High
> **Estimated Effort:** 1 week
> **Dependencies:** Phase 8 (security)
> **Primary Files:** `mcpCache.ts` (146 lines), `dalamAPI.ts` (lines 3826-4003), `connectors.ts` (858 lines), `SettingsModal.tsx` (lines 865-1177)
> **Audit Status:** 🟡 Partial — 2/10 improvements implemented

## Current State Analysis

### Issues Found & Resolution Status

| # | Issue | Severity | Status |
|---|-------|----------|--------|
| 1 | MCP stdio spawns NEW process per call | Critical | ❌ Not fixed |
| 2 | MCP stdio JSON parsing fragile (no multi-line) | High | ❌ Not fixed |
| 3 | MCP HTTP session race condition | Medium | ✅ Fixed (mutex per server) |
| 4 | MCP tool naming ambiguous with underscores | Medium | ❌ Not fixed |
| 5 | Connectors not auto-restarted on config change | Medium | ✅ Fixed (Phase 0 Bug 5) |
| 6 | WebhookConnector is a stub | Low | ❌ Not fixed |
| 7 | MCP form allows adding without command/URL | Medium | ❌ Not fixed |
| 8 | No MCP connection test button | Medium | ❌ Not implemented |
| 9 | FileWatcherConnector polls entire files | Low | ❌ Not fixed |
| 10 | No MCP tool argument type coercion | Medium | ❌ Not implemented |

### What's Verified Implemented

- ✅ MCP HTTP session mutex (`_mcpSessionMutexes` Map in `dalamAPI.ts`)
- ✅ Connectors restart on config change (`initializeSingleConnector` after save)
- ✅ MCP cache TTL stored and used (`mcpCache.ts`)

### What's NOT Implemented

- ❌ Persistent MCP stdio connections (new process per call)
- ❌ JSON-RPC parsing with Content-Length header support
- ❌ MCP tool name disambiguation
- ❌ MCP connection test button in settings
- ❌ MCP argument type coercion

---

## Implementation Priority

1. Implement persistent MCP stdio connection pool
2. Fix MCP stdio JSON-RPC parsing with proper buffer
3. Fix MCP tool name disambiguation (longest prefix match)
4. Add MCP connection test button in settings
5. Add MCP argument type coercion

---

## Success Criteria

- [x] No race condition on concurrent MCP HTTP calls
- [x] Connectors restart on config change
- [ ] MCP stdio connections persist across tool calls (50-150x faster)
- [ ] JSON-RPC parsing handles multi-line responses
- [ ] MCP tool names resolve correctly with underscores
- [ ] Settings UI shows test button per MCP server
- [ ] MCP arguments are type-coerced (numbers, booleans, arrays)
