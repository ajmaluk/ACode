# Comprehensive Harness Deep Scan — Issues Report

## Overview
This report documents all bugs, security vulnerabilities, design issues, and performance problems found across the entire codebase. Each issue includes file path, line numbers, severity, and detailed explanation.

---

## 🔴 CRITICAL ISSUES

### C-1: Race Condition in `initDatabase` Mutex (database.ts:191-196)
**File:** `apps/desktop/src/renderer/lib/database.ts`
**Severity:** Bug — Data corruption / double initialization

The mutex pattern has a TOCTOU (time-of-check-time-of-use) window. Two concurrent calls can both see `_initMutex === null` on line 191, then both create their own mutex on line 196, overwriting one another's `_resolveInitMutex`. Both calls proceed into the critical section past the `while` loop. This means:
- Two databases can be opened for the same workspace simultaneously
- The `try { ... } finally { _resolveInitMutex?.(); }` at lines 363-367 can resolve a promise that was created by a different caller, leaving the other caller hanging forever
- The `dbInstance` assignment at lines 358-361 is not atomic, so one initialization's result can be lost

**Fix:** Use a proper mutex pattern (e.g., a simple promise chain) or `async-mutex`.

### C-2: Duplicate Stream Listener Registration (useChat.ts:820-825)
**File:** `apps/desktop/src/renderer/store/useChat.ts`
**Severity:** Bug — Message duplication / state corruption

`sendMessage` calls `api.agent.onStreamEvent(session.id, ...)` every time it's invoked, but never checks if a listener is already registered. If `sendMessage` is called multiple times (e.g., from message queue processing), multiple listeners accumulate for the same session, causing `appendStream` to process each event multiple times — duplicating messages, tool calls, and state updates.

### C-3: Compaction AbortController Key Mismatch (useChat.ts:2808 vs 750-766)
**File:** `apps/desktop/src/renderer/store/useChat.ts`
**Severity:** Bug — Resource leak / zombie compactions

`compactSessionHistory` stores its AbortController under a different key pattern than `cancelSessionOperations` uses to abort it. The compaction function uses `sessionId` directly, while `cancelSessionOperations` iterates `_abortControllers` which may use a different key. This means compaction operations can never be cancelled, leading to zombie compactions that continue running after session cancellation.

### C-4: Shell Command Injection via `launch_app` cwd (system.rs:214-216)
**File:** `apps/desktop/src-tauri/src/system.rs`
**Severity:** Security — Command injection

The `launch_app` command sets `cmd.current_dir(workdir)` with a user-supplied `cwd` parameter. While `app_name` is validated, the `cwd` parameter is NOT validated for dangerous characters. A malicious `cwd` like `/tmp; rm -rf /` could be passed. The `cwd` is only validated in the frontend `toolSchemas.ts` but the Rust backend has no server-side validation, making it vulnerable if the frontend validation is bypassed.

### C-5: Permission Bypass via `evaluate` Function (agents.ts:133-164)
**File:** `apps/desktop/src/renderer/lib/agents.ts`
**Severity:** Security — Permission bypass

The `evaluate` function has a logic flaw in the `lastGlobMatch` tracking. On line 158, `lastGlobMatch ??= r.action` uses nullish coalescing, which means once a global glob match is set, it can never be overridden by a later permission-level glob match. This means a global wildcard rule can shadow more specific permission-level glob rules that appear later in the ruleset. The comment says "later rules override earlier ones" but the `??=` operator prevents this.

### C-6: `write_file` afterContent Captures Wrong State (toolExecutor.ts:446-449)
**File:** `apps/desktop/src/renderer/lib/toolExecutor.ts`
**Severity:** Bug — Incorrect undo data

For `write_file` operations, the `afterContent` is captured from `toolCall.args.content` (the input content) rather than reading the actual file content after the write completes. This means if the write fails silently or is modified by the filesystem (e.g., line ending normalization), the undo stack will have incorrect data. For `edit_file`, the `result` (which is the tool output string) is used instead of the actual file content.

### C-7: `open_with_system_handler` Path Traversal (system.rs:126-168)
**File:** `apps/desktop/src-tauri/src/system.rs`
**Severity:** Security — Path traversal

The `open_with_system_handler` function uses `std::fs::canonicalize` to resolve symlinks, but the path validation only checks if the canonical path starts with the home directory. A symlink inside the home directory pointing to `/etc/passwd` would pass this check. Additionally, the function doesn't validate the path before calling `opener::open`, which could open arbitrary files.

### C-8: `reveal_in_finder` Restricted Paths Bypass (system.rs:469-489)
**File:** `apps/desktop/src-tauri/src/system.rs`
**Severity:** Security — Path restriction bypass

The restricted paths list on line 476 (`["/etc", "/sys", "/proc", "/var", "/tmp", "/private", "/usr/local/etc"]`) uses `p.starts_with()` which can be bypassed with symlinks. A symlink at `/Users/uk/Development/ACode/link_to_etc` pointing to `/etc` would bypass the check because the path starts with the user's directory, not `/etc`.

---

## 🔴 HIGH SEVERITY ISSUES

### H-1: `normalizeDbPath` Path Traversal (database.ts:140-170)
**File:** `apps/desktop/src/renderer/lib/database.ts`
**Severity:** Security

No sanitization against path traversal. If a workspace path like `../../etc/passwd` is passed, the resulting SQLite URI could point to an arbitrary location. While the frontend may validate paths, the database module itself has no defense.

### H-2: `_sendInProgress` Race Condition (useChat.ts:792-800)
**File:** `apps/desktop/src/renderer/store/useChat.ts`
**Severity:** Bug — Double message send

The atomic check-and-set pattern has a TOCTOU race. Two concurrent `sendMessage` calls can both pass the `set()` updater before either returns, because Zustand's `set()` with updater function is synchronous but the `sendBlocked` flag is set asynchronously via closure. If both calls execute `set()` before either reaches `if (sendBlocked) return;`, both will proceed.

### H-3: `withPermission` Always-Allow Bypass (usePermission.ts:196-202)
**File:** `apps/desktop/src/renderer/store/usePermission.ts`
**Severity:** Security — Permission bypass

When a user selects "always allow", the `allowAlways` function is called AFTER the operation has already run. This means the first "always allow" operation runs without the permission being in the `alwaysAllowed` map, but the function is called with the `params` object which may have been mutated by the `run()` function. If `params.command` was modified during execution, the wrong key is stored.

### H-4: `DANGEROUS_PATH_PATTERNS` Regex Bypass (toolSchemas.ts:374-389)
**File:** `apps/desktop/src/renderer/lib/toolSchemas.ts`
**Severity:** Security — Path restriction bypass

The `DANGEROUS_PATH_PATTERNS` use `^` anchors but don't account for relative paths. A path like `foo/../../etc/passwd` would match `\.\.` but `foo/..\u200B/..\u200B/etc/passwd` with zero-width characters would bypass. Also, the patterns don't handle URL-encoded paths or Unicode normalization attacks.

### H-5: `DANGEROUS_COMMANDS` Bypass via Encoding (toolSchemas.ts:446-453)
**File:** `apps/desktop/src/renderer/lib/toolSchemas.ts`
**Severity:** Security — Command restriction bypass

The `normalizeCommand` function only removes quotes and backslashes, but doesn't handle:
- Unicode homoglyphs (e.g., `ｒｍ` instead of `rm`)
- Tab characters as whitespace
- Environment variable expansion (e.g., `$SHELL -c 'rm -rf /'`)
- Command substitution (e.g., `$(rm -rf /)`)
- Base64-encoded commands piped to shell

### H-6: `isPrivateHost` SSRF Bypass via DNS Rebinding (security.ts:6-56)
**File:** `apps/desktop/src/renderer/lib/security.ts`
**Severity:** Security — SSRF bypass

The `isPrivateHost` function checks DNS wildcard services (`nip.io`, `sslip.io`, `xip.io`, etc.) but doesn't handle:
- Double DNS resolution (e.g., `1.2.3.4.nip.io` that resolves to a public IP first, then to a private IP)
- IPv6 transition mechanisms (e.g., `::ffff:10.0.0.1` is checked but `64:ff9b::10.0.0.1` is not)
- DNS rebinding attacks where the DNS response changes between validation and connection

### H-7: `validateMcpUrl` Only Checks Hostname (security.ts:62-78)
**File:** `apps/desktop/src/renderer/lib/security.ts`
**Severity:** Security — SSRF bypass

`validateMcpUrl` only validates the hostname but doesn't check the path. An attacker could use a URL like `https://evil.com/ssrf?target=http://169.254.169.254/` which would pass the hostname check but could be used for SSRF via the path.

### H-8: `computeSimpleDiff` Incorrect for Insertions/Deletions (diff.ts:580-648)
**File:** `apps/desktop/src/renderer/lib/diff.ts`
**Severity:** Bug — Incorrect diff output

The `computeSimpleDiff` function (used for files > 50,000 lines) compares lines by index position. If a line is inserted at the beginning, ALL subsequent lines will be marked as changed (remove+add) even if they're identical. This produces a completely incorrect diff for any non-trivial change in large files.

### H-9: `patienceDiff` Incorrect Anchor Sorting (diff.ts:163)
**File:** `apps/desktop/src/renderer/lib/diff.ts`
**Severity:** Bug — Incorrect diff output

The anchor sorting on line 163 uses `a[0] - b[0] || a[1] - b[1]` which sorts by old index first, then new index. This doesn't guarantee a valid LCS because anchors must be increasing in BOTH dimensions. An anchor with `(oldIdx=5, newIdx=2)` followed by `(oldIdx=6, newIdx=1)` would be valid by old index but invalid by new index (decreasing).

### H-10: `CronConnector` setTimeout Memory Leak (connectors.ts:460-476)
**File:** `apps/desktop/src/renderer/lib/connectors.ts`
**Severity:** Bug — Memory leak

Each cron job firing creates a new `setTimeout` via `scheduleNext()`. If a cron job fires every minute, after 24 hours there will be 1440 timer entries in the `this.timers` Map. The `clearTimeout` on line 459 only clears the PREVIOUS timer, but the Map grows unboundedly because old timer IDs are never removed.

### H-11: `TelegramConnector` Bot Token in URL (connectors.ts:519-521)
**File:** `apps/desktop/src/renderer/lib/connectors.ts`
**Severity:** Security — Token exposure

The bot token is included in the URL query string for `getUpdates` calls. URLs can be logged by proxies, load balancers, and browser history. The token should be sent as a header or in the POST body.

### H-12: `WhatsAppConnector` Bridge URL SSRF (connectors.ts:639-669)
**File:** `apps/desktop/src/renderer/lib/connectors.ts`
**Severity:** Security — SSRF

The bridge URL is user-configurable and is fetched without validation. An attacker could configure a malicious bridge URL pointing to an internal service (e.g., `http://169.254.169.254/latest/meta-data/`).

### H-13: `runShellCommand` Falls Back to `child_process` (verificationEngine.ts:71-84)
**File:** `apps/desktop/src/renderer/lib/verificationEngine.ts`
**Severity:** Security — Arbitrary command execution

When Tauri's shell plugin is unavailable, the code falls back to Node.js `child_process.execSync`. This is a security concern because `execSync` runs commands in a shell, which can interpret shell metacharacters. If a verification command contains user-controlled input, this could lead to command injection.

### H-14: `detectCommandsFromWorkspace` Reads Files Without Validation (verificationEngine.ts:330-404)
**File:** `apps/desktop/src/renderer/lib/verificationEngine.ts`
**Severity:** Security — Path traversal

The function reads `package.json`, `Cargo.toml`, `go.mod`, and `turbo.json` from the workspace path. If the workspace path is malicious (e.g., `../../etc/`), it could read arbitrary files. The `workspacePath` parameter is not validated.

### H-15: `_antiThrashTimestamps` Unbounded Growth (useChat.ts:66-67)
**File:** `apps/desktop/src/renderer/store/useChat.ts`
**Severity:** Bug — Memory leak

The `_antiThrashTimestamps` map is never pruned. While `_pruneCompactionMaps` prunes other maps, it doesn't prune `_antiThrashTimestamps` when the session is no longer active. Over time, this map grows unboundedly.

---

## 🟡 MEDIUM SEVERITY ISSUES

### M-1: `closeDatabase` Retry Uses Closed Instance (database.ts:395-411)
**File:** `apps/desktop/src/renderer/lib/database.ts`
**Severity:** Bug

On line 404, the retry calls `dbInstance.close()` but `dbInstance` might have been set to `null` by another concurrent `closeDatabase` call between the first and second attempt. This would cause a null reference error.

### M-2: `applyUndo` Pushes Back to Wrong Stack (changeStack.ts:113-116)
**File:** `apps/desktop/src/renderer/lib/changeStack.ts`
**Severity:** Bug

When undo fails, the code pushes the change back to the stack. But it uses `getStack(sessionId)` which creates a NEW stack if the session was cleared. This means the change is pushed to a new stack instead of the original one, and the original stack (which may still have other changes) is orphaned.

### M-3: `recordChange` in toolExecutor.ts Uses Wrong sessionId (toolExecutor.ts:455)
**File:** `apps/desktop/src/renderer/lib/toolExecutor.ts`
**Severity:** Bug

`recordChange` is called with `sessionId ?? "unknown"` but the `recordChange` function in `changeStack.ts` expects the sessionId as the SECOND parameter. The call on line 455 passes `sessionId` as part of the change object, not as the separate sessionId parameter.

### M-4: `groupToolCallsForExecution` First-Fit Not Optimal (toolExecutor.ts:361-387)
**File:** `apps/desktop/src/renderer/lib/toolExecutor.ts`
**Severity:** Performance

The first-fit bin packing algorithm can produce suboptimal batches. For example, with tools [read(A), read(B), write(C), read(D)], the algorithm produces [[read(A)], [read(B), write(C)], [read(D)]] instead of the optimal [[read(A), read(B), read(D)], [write(C)]].

### M-5: `TOOL_TIMEOUTS` Missing Many Tools (toolExecutor.ts:179-213)
**File:** `apps/desktop/src/renderer/lib/toolExecutor.ts`
**Severity:** Design

Many tools registered in `TOOL_DEPENDENCIES` are missing from `TOOL_TIMEOUTS`, including `bash`, `shell`, `execute`, `grep`, `search`, `webfetch`, `websearch`, `git_create_branch`, `create_file`, `browser_navigate`, `browser_execute`, `run_preview`, `create_task_plan`, `kill_process`, `launch_app`, `reveal_in_finder`, `open_panel`, `set_theme`, `toggle_theme`, `set_view_mode`, `toggle_view_mode`, `toggle_right_panel`, `toggle_bottom_panel`, `set_right_panel_tab`, `set_bottom_panel_tab`, `new_terminal`, `terminal_write`. These all fall back to the 30s default, which may be inappropriate.

### M-6: `getToolStats` Division by Zero (toolExecutor.ts:670-672)
**File:** `apps/desktop/src/renderer/lib/toolExecutor.ts`
**Severity:** Bug

If `results.length === 0`, the `avgDurationMs` calculation divides by zero, producing `NaN`.

### M-7: `loadAlwaysAllowed` JSON Parse Error (usePermission.ts:32-33)
**File:** `apps/desktop/src/renderer/store/usePermission.ts`
**Severity:** Bug

If `localStorage.getItem(ALWAYS_ALLOWED_KEY)` returns malformed JSON, `JSON.parse(raw)` throws an uncaught exception. The try-catch on line 38 catches it, but the error message in the catch references a different variable name (`ALWAYS_ALLOWED_KE` instead of `ALWAYS_ALLOWED_KEY`), which is a copy-paste error.

### M-8: `persistAlwaysAllowedToDisk` Race Condition (usePermission.ts:49-76)
**File:** `apps/desktop/src/renderer/store/usePermission.ts`
**Severity:** Bug

Multiple rapid "always allow" decisions can race. The function reads the existing config, modifies it, and writes it back. If two calls happen concurrently, one will overwrite the other's changes (lost update).

### M-9: `saveConnectorConfig` Race Condition (connectors.ts:896-929)
**File:** `apps/desktop/src/renderer/lib/connectors.ts`
**Severity:** Bug

The function reads configs, modifies them, saves them, then stops the old connector and starts a new one. If called concurrently, the read-modify-write cycle can lose updates.

### M-10: `CronConnector` `clearTimeout` on Wrong Timer (connectors.ts:458-459)
**File:** `apps/desktop/src/renderer/lib/connectors.ts`
**Severity:** Bug

On line 458-459, the code clears the PREVIOUS timer before setting a new one. But the previous timer was already cleared by the `scheduleNext()` call at the end of the previous firing. This means the `clearTimeout` is a no-op, and the old timer ID remains in the Map.

### M-11: `FileWatcherConnector` Poll Reads Entire File (connectors.ts:260-298)
**File:** `apps/desktop/src/renderer/lib/connectors.ts`
**Severity:** Performance

The poll function reads the ENTIRE file content on every poll interval. For large files (e.g., log files > 100MB), this would be extremely slow and memory-intensive. Should use file size/mtime checks first.

### M-12: `runVerificationPipeline` Runs All Commands Even on Failure (verificationEngine.ts:197-201)
**File:** `apps/desktop/src/renderer/lib/verificationEngine.ts`
**Severity:** Design

All verification commands run in parallel via `Promise.all`, even if a required command fails. This wastes resources. Should use sequential execution with early bail on required failure.

### M-13: `buildDefaultCriteria` Checklist Logic Error (verificationEngine.ts:419-420)
**File:** `apps/desktop/src/renderer/lib/verificationEngine.ts`
**Severity:** Bug

The checklist item "Changes compile without errors" is added if ANY command's label includes "check". But `cargo check` and `cargo clippy` both match, and `cargo clippy` is a lint check, not a compilation check. The label matching is too broad.

### M-14: `detectProjectTypes` Only Checks Top-Level Files (verificationEngine.ts:298-324)
**File:** `apps/desktop/src/renderer/lib/verificationEngine.ts`
**Severity:** Design

The function only reads the top-level directory entries. For monorepos with nested projects (e.g., `packages/*/package.json`), it would miss the project type entirely.

### M-15: `_pruneCompactionMaps` Only Prunes on Add (useChat.ts:69-85)
**File:** `apps/desktop/src/renderer/store/useChat.ts`
**Severity:** Design

The pruning function only runs when a new session is added that pushes the count over the cap. But it doesn't run when sessions are removed, so the maps can contain stale entries for sessions that no longer exist.

### M-16: `_createSafetyTimer` Not Cancelled on Session End (useChat.ts:95-100)
**File:** `apps/desktop/src/renderer/store/useChat.ts`
**Severity:** Bug

The safety timer created in `sendMessage` is not explicitly cancelled when a session ends. If the timer fires after session cleanup, it could try to update state for a non-existent session.

### M-17: `isPrivateHost` Octal IP Check Too Broad (security.ts:28)
**File:** `apps/desktop/src/renderer/lib/security.ts`
**Severity:** Bug

The regex `/^0[0-7]+\.[0-7]+\.[0-7]+\.[0-7]+$/` matches any IP with leading zeros, but `0.0.0.0` is already caught by the `/^0\./` check. More importantly, it doesn't handle mixed octal-decimal IPs like `0177.0.0.1`.

### M-18: `validateToolArgs` MCP Tool Validation Too Permissive (toolSchemas.ts:469-518)
**File:** `apps/desktop/src/renderer/lib/toolSchemas.ts`
**Severity:** Security

MCP tools only check that args are a plain object and that string values don't contain dangerous paths/commands. But MCP tools can have arbitrary argument structures, and the validation doesn't check nested objects or arrays for dangerous content.

### M-19: `normalizeCommand` Removes Backslashes (toolSchemas.ts:451)
**File:** `apps/desktop/src/renderer/lib/toolSchemas.ts`
**Severity:** Security

Removing ALL backslashes from commands is too aggressive. A command like `rm -rf \/tmp\/build` becomes `rm -rf /tmp/build` which is fine, but `echo \` becomes `echo` which changes the command's behavior. This could cause false negatives in dangerous command detection.

### M-20: `myersDiff` O(ND) Space Complexity (diff.ts:51-80)
**File:** `apps/desktop/src/renderer/lib/diff.ts`
**Severity:** Performance

The `trace` array stores a Map for each depth level, leading to O(D²) memory usage. For files with large edit distances (e.g., 10,000 edits), this could use significant memory. The standard Myers implementation only needs to store the current and previous V arrays.

---

## 🟢 LOW SEVERITY ISSUES

### L-1: `_globRegexCache` Not Exported for Testing (agents.ts:85-124)
**File:** `apps/desktop/src/renderer/lib/agents.ts`
**Severity:** Design

The `_globRegexCache` and `globToRegex` function are module-private, making them untestable. The cache could have bugs that are never caught.

### L-2: `BASH_ARITY` Missing Common Commands (agents.ts:175-367)
**File:** `apps/desktop/src/renderer/lib/agents.ts`
**Severity:** Design

Missing common commands: `docker exec`, `docker logs`, `kubectl apply`, `kubectl describe`, `helm upgrade`, `helm uninstall`, `terraform plan`, `terraform destroy`, `pulumi preview`, `pulumi destroy`, `sst shell`, `npx`, `bunx`, `yarn dlx`, `pnpm dlx`.

### L-3: `hasShellMetacharacters` False Positive on `$` in Variable Names (agents.ts:374-378)
**File:** `apps/desktop/src/renderer/lib/agents.ts`
**Severity:** Bug

The regex `/[|;`$]|&&|\|\|/` matches `$` anywhere in the command, including in variable names like `$HOME` or `$PATH`. This means `echo $HOME` is flagged as having shell metacharacters, which is incorrect — `$HOME` is a variable expansion, not a metacharacter for command chaining.

### L-4: `canonicaliseBashCommand` Truncates at 5 Tokens (agents.ts:391)
**File:** `apps/desktop/src/renderer/lib/agents.ts`
**Severity:** Design

The function only checks up to 5 tokens. Commands like `docker container ls --filter name=foo --format json` would be truncated to `docker container ls` which loses the `--filter` and `--format` arguments that could affect permission decisions.

### L-5: `TOOL_DEPENDENCIES` Missing `git_create_branch` Read-Only Flag (toolExecutor.ts:76-80)
**File:** `apps/desktop/src/renderer/lib/toolExecutor.ts`
**Severity:** Design

`git_create_branch` is marked as `readOnly: false` but creating a branch is a read-only operation (it doesn't modify tracked files). This prevents it from running in parallel with other read-only tools.

### L-6: `TOOL_DEPENDENCIES` Missing `git_checkout` Write Flag (toolExecutor.ts:94)
**File:** `apps/desktop/src/renderer/lib/toolExecutor.ts`
**Severity:** Design

`git_checkout` is marked as `readOnly: false` but checking out a branch can change file contents. This is correct, but `git_checkout` should have a dependency on `write_file` and `edit_file` to prevent parallel execution with file modifications.

### L-7: `formatToolResults` No Truncation (toolExecutor.ts:636-646)
**File:** `apps/desktop/src/renderer/lib/toolExecutor.ts`
**Severity:** Design

Tool results are included verbatim in conversation history. A tool that returns megabytes of output (e.g., `list_dir` on a large directory) would bloat the context window. Results should be truncated to a maximum size.

### L-8: `_toolCosts` Map Never Pruned by Time (toolExecutor.ts:293-308)
**File:** `apps/desktop/src/renderer/lib/toolExecutor.ts`
**Severity:** Design

The cost map is pruned by count (max 50 sessions, 500 records per session) but never by time. Old sessions that are no longer active remain in the map until new sessions push them out.

### L-9: `loadAlwaysAllowed` Error Message Has Wrong Variable Name (usePermission.ts:39)
**File:** `apps/desktop/src/renderer/store/usePermission.ts`
**Severity:** Bug

The error message on line 39 references `ALWAYS_ALLOWED_KE` instead of `ALWAYS_ALLOWED_KEY`. This is a copy-paste error that makes debugging harder.

### L-10: `persistAlwaysAllowedToDisk` Inconsistent Error Handling (usePermission.ts:62-68)
**File:** `apps/desktop/src/renderer/store/usePermission.ts`
**Severity:** Design

The try-catch on line 62 catches errors from reading the config file, but the catch block on line 69 is at a different indentation level, making it unclear which try statement it belongs to. The code structure is confusing.

### L-11: `WebhookConnector` is a Stub (connectors.ts:150-164)
**File:** `apps/desktop/src/renderer/lib/connectors.ts`
**Severity:** Design

The webhook connector is explicitly marked as a stub ("Webhook server is a stub — actual HTTP server requires runtime environment"). It always reports as connected but never actually listens for webhooks. This is misleading.

### L-12: `CronConnector` Uses `setTimeout` Instead of Proper Cron (connectors.ts:432-480)
**File:** `apps/desktop/src/renderer/lib/connectors.ts`
**Severity:** Design

The cron implementation uses `setTimeout` to schedule the next occurrence, which drifts over time. Each `setTimeout` callback takes time to execute, and the delay calculation doesn't account for this drift. After 1000 firings, the cron could be significantly off.

### L-13: `CronConnector` SAFETY_LIMIT Too Large (connectors.ts:441)
**File:** `apps/desktop/src/renderer/lib/connectors.ts`
**Severity:** Performance

The safety limit of 366*24*60 = 527,040 iterations means the cron scheduler could loop half a million times trying to find the next valid time. For a cron expression like `0 0 29 2 *` (Feb 29), it would loop through all 527,040 minutes before giving up.

### L-14: `TelegramConnector` No Rate Limiting (connectors.ts:530-531)
**File:** `apps/desktop/src/renderer/lib/connectors.ts`
**Severity:** Design

The Telegram connector polls every 2 seconds without rate limiting. If the bot receives a burst of messages, it could overwhelm the event system.

### L-15: `WhatsAppConnector` No Message Deduplication (connectors.ts:728-747)
**File:** `apps/desktop/src/renderer/lib/connectors.ts`
**Severity:** Bug

The WhatsApp connector uses `lastMessageTimestamp` for deduplication, but multiple messages can have the same timestamp. This could cause message duplication or message loss.

### L-16: `runVerificationCommand` No Timeout (verificationEngine.ts:93-131)
**File:** `apps/desktop/src/renderer/lib/verificationEngine.ts`
**Severity:** Design

The `runShellCommand` function has a 30s timeout via `execSync`, but the Tauri shell plugin path has no timeout. A verification command could hang indefinitely.

### L-17: `detectCommandsFromWorkspace` Redundant File Reads (verificationEngine.ts:340-401)
**File:** `apps/desktop/src/renderer/lib/verificationEngine.ts`
**Severity:** Performance

The function reads `Cargo.toml`, `go.mod`, and `turbo.json` multiple times — once in `detectProjectTypes` and again in `detectCommandsFromWorkspace`. These should be cached.

### L-18: `_tokenCache` Not Invalidated on Compaction (contextManager.ts:38-62)
**File:** `apps/desktop/src/renderer/lib/contextManager.ts`
**Severity:** Performance

The token cache is cleared on compaction, but it's not invalidated when individual messages are modified (e.g., tool output pruning). This means stale estimates could be used between compactions.

### L-19: `CTX_LOCAL` Duplicates CTX (contextManager.ts:29-32)
**File:** `apps/desktop/src/renderer/lib/contextManager.ts`
**Severity:** Design

`CTX_LOCAL` spreads `CTX` and overrides `OUTPUT_RESERVE`, but `CTX` is already imported from `memoryTypes`. This creates a duplicate object that could get out of sync if `CTX` is modified.

### L-20: `isPrivateHost` IPv6 Check Incomplete (security.ts:10-12)
**File:** `apps/desktop/src/renderer/lib/security.ts`
**Severity:** Bug

The IPv6 ULA check `/^\[?f[cd][0-9a-f]{2}:/i` only matches the first 3 hex digits after `fc`/`fd`. A valid ULA like `fd00::1` matches, but `fd0::1` (missing a digit) would also match incorrectly.

---

## Summary

| Severity | Count |
|----------|-------|
| 🔴 Critical | 8 |
| 🔴 High | 15 |
| 🟡 Medium | 20 |
| 🟢 Low | 20 |
| **Total** | **63** |

### Top 5 Most Critical Fixes Needed

1. **C-1**: Fix `initDatabase` mutex race condition — can cause data corruption
2. **C-2**: Fix duplicate stream listener registration — causes message duplication
3. **C-4**: Add server-side validation for `launch_app` cwd — command injection risk
4. **C-5**: Fix `evaluate` permission bypass — `??=` prevents later rules from overriding
5. **C-6**: Fix `write_file` afterContent capture — incorrect undo data