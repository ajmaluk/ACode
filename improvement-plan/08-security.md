# Phase 8: Security

> **Priority:** High (Critical for production)
> **Estimated Effort:** 1 week
> **Dependencies:** None (can run in parallel)
> **Primary Files:** `toolSchemas.ts`, `capabilities/default.json`, storage layer, `system.rs`
> **Audit Status:** 🔴 Not started — 0/10 improvements implemented

## Current State Analysis

### Security Measures

| Area | Current State | Rating |
|------|--------------|--------|
| API key storage | Plaintext in localStorage | Critical risk |
| Tool arg validation | Zod schemas | Good |
| Dangerous path blocking | Regex patterns | Good |
| Dangerous command blocking | Substring matching | Medium |
| Shell metacharacter detection | Pattern matching | Good |
| Tauri CSP | Configured | Medium |
| FS scope | Hardcoded directories | Medium |
| Env var blocking | 33-var blocklist | Medium |

### Issues Found

| # | Issue | Severity | Status |
|---|-------|----------|--------|
| 1 | API keys stored in plaintext localStorage | Critical | ❌ Not fixed |
| 2 | MCP HTTP SSRF protection bypassed in tool execution | High | ❌ Not fixed |
| 3 | Connector bot tokens in plaintext localStorage | High | ❌ Not fixed |
| 4 | Dangerous command blocklist uses substring matching | Medium | ❌ Not fixed |
| 5 | No permission audit trail | Medium | ❌ Not implemented |
| 6 | FS scope too broad (5 hardcoded directories) | Medium | ❌ Not fixed |
| 7 | MCP stdio executes arbitrary commands from localStorage | High | ❌ Not fixed |
| 8 | CSP has `unsafe-eval` for scripts | Medium | ❌ Not fixed |
| 9 | Clipboard race condition (predictable temp file) | Medium | ❌ Not fixed |
| 10 | `set_env` case-sensitive (unlike `get_env`) | Low | ❌ Not fixed |

### What's Verified Implemented

None. All 10 security improvements remain unaddressed.

---

## Implementation Order

1. Encrypt API keys (tauri-plugin-stronghold or OS keychain)
2. Add SSRF validation to MCP HTTP calls
3. Replace substring-based command detection with AST-based
4. Add permission audit trail logging
5. Fix clipboard race condition with NamedTempFile
6. Migrate existing API keys from localStorage to secure storage
7. Update CSP to remove `unsafe-eval` if possible

---

## Success Criteria

- [ ] API keys stored in OS keychain (not plaintext)
- [ ] MCP HTTP calls validated against SSRF
- [ ] Dangerous commands detected via AST (not substring)
- [ ] All permission decisions logged to audit trail
- [ ] Clipboard temp files use unpredictable names
- [ ] No `unsafe-eval` in CSP (if possible)
- [ ] Migration preserves existing API keys
