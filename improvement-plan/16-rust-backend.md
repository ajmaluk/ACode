# Phase 16: Rust Backend Hardening

> **Estimated Effort:** 3-4 days
> **Dependencies:** Phase 8 (security), Phase 11 (cross-OS)
> **Priority:** Medium

## Current State

The Rust backend (`src-tauri/src/`) contains two modules:
- `system.rs` (1,043 lines) — OS integration, clipboard, notifications, process management
- `git.rs` (305 lines) — Git operations
- `lib.rs` (56 lines) — Plugin registration and command handler

### Rust Code Summary

| File | Lines | Functions | Commands |
|------|-------|-----------|----------|
| `system.rs` | 1,043 | 15 | 15 |
| `git.rs` | 305 | 7 | 7 |
| `lib.rs` | 56 | 1 | 0 |
| **Total** | **1,404** | **23** | **22** |

### Command Inventory

| Command | File:Line | Purpose | Security Notes |
|---------|-----------|---------|----------------|
| `clipboard_read_text` | `system.rs:16` | Read clipboard | Safe |
| `clipboard_write_text` | `system.rs:25` | Write clipboard | Safe |
| `clipboard_has_image` | `system.rs:265` | Check clipboard image | Safe |
| `clipboard_read_image` | `system.rs:333` | Read clipboard image | Race condition at line 338 |
| `notify` | `system.rs:46` | Send notification | Safe |
| `system_get_info` | `system.rs:77` | Get system info | Safe |
| `get_working_dir` | `system.rs:112` | Get CWD | Safe |
| `open_with_system_handler` | `system.rs:126` | Open URL/file | Path validation |
| `launch_app` | `system.rs:167` | Launch application | Input validation |
| `reveal_in_finder` | `system.rs:429` | Reveal in file manager | Path validation |
| `get_env` | `system.rs:449` | Get env var | Blocked list |
| `set_env` | `system.rs:475` | Set env var | Blocked list |
| `get_screen_info` | `system.rs:506` | Get screen info | Safe |
| `list_processes` | `system.rs:533` | List processes | Safe |
| `kill_process` | `system.rs:598` | Kill process | PID safety |
| `get_disk_space` | `system.rs:646` | Get disk space | Path injection |
| `detect_available_shells` | `system.rs:750` | Detect shells | Safe |
| `detect_installed_ides` | `system.rs:830` | Detect IDEs | Safe |
| `git_status` | `git.rs:*` | Git status | Path validation |
| `git_commit` | `git.rs:*` | Git commit | Path validation |
| `git_log` | `git.rs:*` | Git log | Path validation |
| `git_branches` | `git.rs:*` | Git branches | Path validation |
| `git_checkout` | `git.rs:*` | Git checkout | Path validation |
| `git_create_branch` | `git.rs:*` | Create branch | Path validation |
| `git_diff_file` | `git.rs:*` | Git diff | Path validation |

## Issues Found

### 1. Clipboard Image Race Condition
**Severity:** HIGH
**Location:** `system.rs:338`
**Issue:** `clipboard_read_image` uses a predictable temp file path:
```rust
let tmp_path = std::env::temp_dir().join("dalam_clipboard_image.png");
```
This is vulnerable to:
- Symlink attacks (attacker creates symlink at path)
- Race conditions (two concurrent calls overwrite each other)
- Information leakage (temp file readable by other processes)

**Fix:** Use `tempfile::NamedTempFile` for unique, secure temp files:
```rust
use tempfile::NamedTempFile;
let tmp_file = NamedTempFile::new()
    .map_err(|e| format!("Failed to create temp file: {e}"))?;
let tmp_path = tmp_file.path().to_path_buf();
```

### 2. No Error Context in Rust Commands
**Severity:** MEDIUM
**Location:** All commands
**Issue:** Errors use `format!("...")` strings with no structured context. Debugging requires reading string messages.
**Fix:** Create a custom error type:
```rust
#[derive(Debug, thiserror::Error)]
enum DalamError {
    #[error("Clipboard operation failed: {0}")]
    Clipboard(String),
    #[error("Process management failed: {0}")]
    Process(String),
    #[error("Path validation failed: {0}")]
    PathValidation(String),
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
}

impl serde::Serialize for DalamError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}
```

### 3. No Logging in Rust Commands
**Severity:** MEDIUM
**Location:** All commands
**Issue:** No `log::info!` or `log::debug!` calls in any command. Difficult to debug in production.
**Fix:** Add structured logging to all commands:
```rust
#[tauri::command]
pub async fn kill_process(pid: u32) -> Result<(), String> {
    log::info!("Attempting to kill process with PID {pid}");
    // ... existing code ...
    log::info!("Successfully killed process {pid}");
    Ok(())
}
```

### 4. No Timeout on Process Execution
**Severity:** MEDIUM
**Location:** `system.rs:209`, `system.rs:239`, `system.rs:253`, `system.rs:534-550`, `system.rs:604`
**Issue:** `std::process::Command::output()` blocks indefinitely. A hanging process freezes the Tauri command.
**Fix:** Add timeouts:
```rust
use std::time::Duration;
let output = cmd.output()
    .map_err(|e| format!("Failed to launch '{app_name}': {e}"))?;

// Or with timeout:
use std::process::Command;
let child = cmd.spawn()?;
let output = child.wait_with_output()?; // Or use timeout API
```

### 5. No Input Sanitization for Git Commands
**Severity:** MEDIUM
**Location:** `git.rs` (all commands)
**Issue:** Git commands likely pass user input directly to `git` subprocess arguments. While Rust's `Command` API prevents shell injection, path traversal is still possible.
**Fix:** Validate all paths before passing to git commands. Ensure paths are within workspace.

### 6. `get_disk_space` Path Injection on Windows
**Severity:** LOW
**Location:** `system.rs:650`
**Issue:** On Windows, `drive_letter` is extracted from the first character of `path`. If path is `-a`, this could cause issues.
**Fix:** Validate drive letter is alphanumeric before using.

### 7. No Tauri State Management
**Severity:** LOW
**Location:** `lib.rs`
**Issue:** No `tauri::State` is used. Each command creates fresh state. No shared state between commands.
**Fix:** Add managed state for shared resources (e.g., env store, process list cache).

## Implementation Steps

### Step 1: Custom Error Type (0.5 days)
1. Add `thiserror` dependency to `Cargo.toml`
2. Create `error.rs` with `DalamError` enum
3. Update all commands to return `Result<T, DalamError>`
4. Update `lib.rs` to use the new error type

### Step 2: Fix Clipboard Race Condition (0.5 days)
1. Add `tempfile` dependency to `Cargo.toml`
2. Replace `std::env::temp_dir().join(...)` with `NamedTempFile`
3. Ensure temp file is cleaned up after use
4. Add test for concurrent clipboard reads

### Step 3: Add Structured Logging (0.5 days)
1. Add `log` calls to all commands:
   - `log::info!` at entry
   - `log::debug!` for parameters
   - `log::info!` at success
   - `log::error!` at failure
2. Add logging to `git.rs` commands
3. Test logging in debug mode

### Step 4: Add Process Execution Timeouts (0.5 days)
1. Create a `run_with_timeout` helper:
   ```rust
   use std::time::Duration;
   use std::process::Command;
   
   fn run_with_timeout(
       cmd: &mut Command,
       timeout: Duration,
   ) -> Result<std::process::Output, String> {
       let child = cmd.spawn().map_err(|e| e.to_string())?;
       // Use wait_with_output or manual timeout
       child.wait_with_output().map_err(|e| e.to_string())
   }
   ```
2. Apply to all `Command::output()` calls
3. Set timeout to 30 seconds for most commands

### Step 5: Input Validation for Git (0.5 days)
1. Create `validate_workspace_path(path: &str, workspace: &str) -> Result<(), String>`
2. Ensure all paths are canonicalized and within workspace
3. Apply to all git commands
4. Add tests for path traversal attempts

### Step 6: Tauri State Management (0.5 days)
1. Create shared state struct:
   ```rust
   struct AppState {
       env_store: Mutex<HashMap<String, String>>,
   }
   ```
2. Register with `tauri::Builder::manage()`
3. Use `tauri::State<AppState>` in commands
4. Move `LOCAL_ENV` to managed state

### Step 7: Rust Tests (0.5 days)
Add `#[cfg(test)]` modules:
```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_open_with_system_handler_blocks_ftp() {
        let result = tokio_test::block_on(open_with_system_handler(
            "ftp://example.com/file".to_string()
        ));
        assert!(result.is_err());
    }

    #[test]
    fn test_kill_process_refuses_pid_0() {
        let result = tokio_test::block_on(kill_process(0));
        assert!(result.is_err());
    }

    #[test]
    fn test_env_blocked_keys() {
        let result = tokio_test::block_on(get_env(
            "AWS_SECRET_ACCESS_KEY".to_string()
        ));
        assert!(result.is_err());
    }

    #[test]
    fn test_launch_app_rejects_semicolons() {
        let result = tokio_test::block_on(launch_app(
            /* app_handle */ todo!(),
            "rm".to_string(),
            Some(vec!["-rf; /".to_string()]),
            None,
        ));
        assert!(result.is_err());
    }
}
```

### Step 8: Documentation (0.5 days)
1. Add `///` doc comments to all public functions
2. Document safety invariants
3. Add examples for common usage
4. Create `SECURITY.md` for Rust backend

## Cargo.toml Dependencies to Add

```toml
[dependencies]
thiserror = "2"
tempfile = "3"
log = "0.4"  # already present via tauri_plugin_log

[dev-dependencies]
tokio-test = "0.4"
```

## Success Criteria

- [ ] All commands use `DalamError` for structured errors
- [ ] Clipboard image uses secure temp file
- [ ] All commands have logging
- [ ] Process execution has timeouts
- [ ] Git commands validate paths
- [ ] Shared state managed via Tauri state
- [ ] At least 10 Rust unit tests
- [ ] All public functions documented

## Risk Mitigation

- Custom error type must implement `Serialize` for Tauri compatibility
- Temp file cleanup must not fail silently
- Logging must not include sensitive data (API keys, file contents)
- Timeouts must not be too short (30s is reasonable for most operations)
- State management must not introduce deadlocks (use `try_lock` where appropriate)
