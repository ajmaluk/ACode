---
description: Run the full verification pipeline for ACode (typecheck, test, optional build)
---

# Verify ACode

Run the full verification pipeline to confirm the codebase is healthy after edits.

## Steps

1. **TypeScript type check (desktop app):**
   ```bash
   cd /Users/uk/Development/ACode && npx tsc --noEmit --project apps/desktop/tsconfig.json 2>&1 | head -30
   ```

2. **TypeScript type check (shared types):**
   ```bash
   cd /Users/uk/Development/ACode && npx tsc --noEmit --project packages/shared-types/tsconfig.json 2>&1 | head -10
   ```

3. **Run tests:**
   ```bash
   cd /Users/uk/Development/ACode/apps/desktop && npx vitest run 2>&1 | tail -15
   ```

4. **(Optional) Rust check** — only if user asks or if Tauri backend was modified:
   ```bash
   cd /Users/uk/Development/ACode/apps/desktop/src-tauri && cargo check 2>&1 | tail -10
   ```

5. **Report summary:** Table of pass/fail for each step.

## Notes

- If the user says "quick verify", skip step 4 (Rust check).
- If the user says "full verify" or "build verify", also run `npx tauri build` at the end.
- Parse test output for the `passed` / `failed` counts to give a clean summary.
