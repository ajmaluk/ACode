# Phase 16: Rust Backend Hardening

> **Estimated Effort:** 3-4 days
> **Dependencies:** Phase 8 (security), Phase 11 (cross-OS)
> **Priority:** Medium
> **Audit Status:** 🔴 Not started — 0/8 improvements implemented

## Current State

The Rust backend (`src-tauri/src/`) contains two modules:
- `system.rs` (1,043 lines) — OS integration, clipboard, notifications, process management
- `git.rs` (305 lines) — Git operations
- `lib.rs` (56 lines) — Plugin registration and command handler

### Issues Found

| # | Issue | Severity | Status |
|---|-------|----------|--------|
| 1 | Clipboard image race condition (predictable temp file) | High | ❌ Not fixed |
| 2 | No error context in Rust commands | Medium | ❌ Not implemented |
| 3 | No logging in Rust commands | Medium | ❌ Not implemented |
| 4 | No timeout on process execution | Medium | ❌ Not fixed |
| 5 | No input sanitization for Git commands | Medium | ❌ Not implemented |
| 6 | `get_disk_space` path injection on Windows | Low | ❌ Not fixed |
| 7 | No Tauri state management | Low | ❌ Not implemented |
| 8 | No Rust unit tests | Medium | ❌ Not implemented |

### What's Verified Implemented

None. All 8 Rust backend improvements remain unaddressed.

---

## Implementation Order

1. Custom error type (`DalamError` with `thiserror`)
2. Fix clipboard race condition with `NamedTempFile`
3. Add structured logging to all commands
4. Add process execution timeouts
5. Input validation for Git commands
6. Tauri state management
7. Rust unit tests (`#[cfg(test)]` modules)

---

## Success Criteria

- [ ] All commands use `DalamError` for structured errors
- [ ] Clipboard image uses secure temp file
- [ ] All commands have logging
- [ ] Process execution has timeouts
- [ ] Git commands validate paths
- [ ] Shared state managed via Tauri state
- [ ] At least 10 Rust unit tests
- [ ] All public functions documented
