# Phase 15: Configuration System

> **Estimated Effort:** 3-4 days
> **Dependencies:** Phase 8 (security), Phase 12 (performance)
> **Priority:** Medium
> **Audit Status:** 🔴 Not started — 0/5 improvements implemented

## Current State

Configuration is scattered across localStorage with 46+ keys, hardcoded values in source files, and no validation or migration system.

### Issues Found

| # | Issue | Severity | Status |
|---|-------|----------|--------|
| 1 | No schema validation for settings | High | ❌ Not implemented |
| 2 | No migration system | Medium | ❌ Not implemented |
| 3 | Hardcoded configuration values | Medium | ❌ Not fixed |
| 4 | No settings export/import | Low | ❌ Not implemented |
| 5 | No environment-based configuration | Low | ❌ Not implemented |

### What's Verified Implemented

None. All 5 configuration improvements remain unaddressed.

---

## Implementation Order

1. Create Zod settings schema for all config keys
2. Add validation on load (graceful fallback to defaults)
3. Move hardcoded values to tunable config
4. Add settings export/import
5. Add migration system for schema upgrades
6. Add environment config overlay

---

## Success Criteria

- [ ] All settings validated with Zod on load
- [ ] Migration system handles schema upgrades
- [ ] No hardcoded configuration values in source
- [ ] Settings export/import works
- [ ] Advanced settings UI for tunable values
- [ ] Environment variable overlay for dev/testing
