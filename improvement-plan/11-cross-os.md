# Phase 11: Cross-OS Robustness

> **Priority:** Medium
> **Estimated Effort:** 3-4 days
> **Dependencies:** Phase 2 (tool calling)
> **Primary Files:** Platform utilities, `system.rs` (1,043 lines), path helpers
> **Audit Status:** 🟡 Partial — 3/9 improvements implemented

## Current State Analysis

### Issues Found & Resolution Status

| # | Issue | Severity | Status |
|---|-------|----------|--------|
| 1 | Path separator inconsistency | Medium | ❌ Not fixed |
| 2 | Windows drive letter handling untested | Medium | ❌ Not fixed |
| 3 | Cancellation doesn't propagate to dream/compaction | High | ✅ Implemented (CancellationToken.ts) |
| 4 | `beforeunload` flush is fire-and-forget | Medium | ❌ Not fixed |
| 5 | No auto-update mechanism | High | ✅ Implemented (updater.ts + tauri-plugin-updater) |
| 6 | Linux clipboard only works on X11 | Medium | ✅ Implemented (system.rs:304-309 tries wl-paste) |
| 7 | Windows `open_with_system_handler` has no path restriction | Medium | ❌ Not fixed |
| 8 | `wmic` deprecated on Windows | Low | ❌ Not fixed |
| 9 | Shell detection hardcoded paths may not exist | Low | ❌ Not fixed |

### What's Verified Implemented

- ✅ `CancellationToken` class — in `cancellationToken.ts` with `combine()`, `onAbort()`, `throwIfAborted()`
- ✅ Auto-update — `updater.ts` with `checkForUpdates()`, `installUpdate()` via `tauri-plugin-updater`
- ✅ Wayland clipboard — `system.rs` tries `wl-paste` first, falls back to `xclip`/`xsel`

### What's NOT Implemented

- ❌ Cancellation not integrated into agent loop/dream/compaction (token exists but unused)
- ❌ `beforeunload` flush not fixed (no `sendBeacon`)
- ❌ Path normalization utility not created
- ❌ Windows `open_with_system_handler` path restriction not added
- ❌ `wmic` still used on Windows

---

## Implementation Priority

1. Integrate `CancellationToken` into agent loop, dream, compaction
2. Fix `beforeunload` flush with `sendBeacon`
3. Add path normalization utility (handle `/` vs `\\` vs drive letters)
4. Add Windows `open_with_system_handler` path restriction

---

## Success Criteria

- [x] CancellationToken abstraction exists
- [x] Auto-update mechanism works on all platforms
- [x] Linux clipboard works on both X11 and Wayland
- [ ] CancellationToken propagates to all async operations
- [ ] `beforeunload` reliably flushes trajectory data
- [ ] Windows path handling is consistent with Unix
- [ ] No deprecated `wmic` usage on Windows
