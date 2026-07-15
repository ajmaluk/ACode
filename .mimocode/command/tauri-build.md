---
description: Build the ACode Tauri desktop app and copy the DMG to ~/Downloads
---

# Tauri Build & Distribute

Build the ACode desktop app using Tauri and copy the resulting DMG to the Downloads folder for easy access.

## Steps

1. **Type-check the TypeScript source:**
   ```bash
   cd /Users/uk/Development/ACode/apps/desktop && npx tsc --noEmit 2>&1 | head -20
   ```
   If errors are found, fix them before proceeding.

2. **Run tests:**
   ```bash
   cd /Users/uk/Development/ACode/apps/desktop && npx vitest run 2>&1 | tail -10
   ```
   If tests fail, fix failures before proceeding.

3. **Build the Tauri app:**
   ```bash
   cd /Users/uk/Development/ACode/apps/desktop && npx tauri build 2>&1 | tail -20
   ```
   Timeout: 10 minutes. The build produces a DMG at `src-tauri/target/release/bundle/dmg/`.

4. **Copy DMG to Downloads:**
   ```bash
   cp /Users/uk/Development/ACode/apps/desktop/src-tauri/target/release/bundle/dmg/ACode_*.dmg ~/Downloads/ && ls -lh ~/Downloads/ACode_*.dmg
   ```

5. **Report result:** Tell the user the build succeeded, which DMG was copied, and its size.

## Notes

- Skip steps 1-2 if the user says "just build" or "quick build".
- The DMG filename pattern is `ACode_<version>_aarch64.dmg` on Apple Silicon.
- If `tauri build` fails with Rust compilation errors, run `cd /Users/uk/Development/ACode/apps/desktop/src-tauri && cargo check 2>&1 | tail -5` first to isolate the issue.
