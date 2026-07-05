# Phase 8: Security

> **Priority:** High (Critical for production)
> **Estimated Effort:** 1 week
> **Dependencies:** None (can run in parallel)
> **Primary Files:** `toolSchemas.ts`, `capabilities/default.json`, storage layer, `system.rs`

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

| # | Issue | Severity | File:Line |
|---|-------|----------|-----------|
| 1 | API keys stored in plaintext localStorage | Critical | dalamAPI.ts:39-44 |
| 2 | MCP HTTP SSRF protection bypassed in tool execution | High | dalamAPI.ts:3834 |
| 3 | Connector bot tokens in plaintext localStorage | High | connectors.ts:681 |
| 4 | Dangerous command blocklist uses substring matching | Medium | toolSchemas.ts:298-327 |
| 5 | No permission audit trail | Medium | — |
| 6 | FS scope too broad (5 hardcoded directories) | Medium | capabilities/default.json |
| 7 | MCP stdio executes arbitrary commands from localStorage | High | dalamAPI.ts:3914-4003 |
| 8 | CSP has `unsafe-eval` for scripts | Medium | tauri.conf.json:27 |
| 9 | Clipboard race condition (predictable temp file) | Medium | system.rs:338 |
| 10 | `set_env` case-sensitive (unlike `get_env`) | Low | system.rs:476-484 |

---

## Improvement 8.1: Encrypt API Keys

**File:** Storage layer

### Current State

```typescript
// dalamAPI.ts:39-44: Plaintext in localStorage
interface StoredProvider {
  id: string;
  baseUrl: string;
  apiKey?: string;  // <-- Plaintext!
  apiFormat: "openai" | "anthropic";
}
```

### Fix: Use Tauri Stronghold (OS Keychain)

**Rust side:** Add `tauri-plugin-stronghold` to Cargo.toml

```toml
[dependencies]
tauri-plugin-stronghold = "2"
```

**Rust commands:**

```rust
// src-tauri/src/secure_store.rs
use tauri_plugin_stronghold::Stronghold;

#[tauri::command]
pub async fn secure_store_key(
    app: tauri::AppHandle,
    key: String,
    value: String,
) -> Result<(), String> {
    let stronghold = app.state::<Stronghold>();
    let store = stronghold.get_store("default").ok_or("Store not found")?;
    store.insert(key.as_bytes().to_vec(), value.as_bytes().to_vec())
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn secure_load_key(
    app: tauri::AppHandle,
    key: String,
) -> Result<Option<String>, String> {
    let stronghold = app.state::<Stronghold>();
    let store = stronghold.get_store("default").ok_or("Store not found")?;
    match store.get(key.as_bytes()) {
        Ok(Some(value)) => Ok(Some(String::from_utf8(value).map_err(|e| e.to_string())?)),
        Ok(None) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub async fn secure_delete_key(
    app: tauri::AppHandle,
    key: String,
) -> Result<(), String> {
    let stronghold = app.state::<Stronghold>();
    let store = stronghold.get_store("default").ok_or("Store not found")?;
    store.remove(key.as_bytes()).map_err(|e| e.to_string())?;
    Ok(())
}
```

**TypeScript side:**

```typescript
// lib/secureStorage.ts
export const secureStorage = {
  async storeKey(key: string, value: string): Promise<void> {
    await invoke("secure_store_key", { key, value });
  },
  
  async loadKey(key: string): Promise<string | null> {
    return await invoke<string | null>("secure_load_key", { key });
  },
  
  async deleteKey(key: string): Promise<void> {
    await invoke("secure_delete_key", { key });
  },
};

// Migration: move existing API keys from localStorage to secure storage
async function migrateApiKeys(): Promise<void> {
  const providers = JSON.parse(localStorage.getItem("dalam.providers.v1") || "[]");
  
  for (const provider of providers) {
    if (provider.apiKey) {
      await secureStorage.storeKey(`provider:${provider.id}:apiKey`, provider.apiKey);
      delete provider.apiKey;  // Remove from localStorage
    }
  }
  
  localStorage.setItem("dalam.providers.v1", JSON.stringify(providers));
}
```

---

## Improvement 8.2: MCP SSRF Protection in Tool Execution

**File:** `dalamAPI.ts:3834`

### Current State

```typescript
// Line 3834: MCP HTTP calls bypass SSRF validation
const response = await corsFetch(mcpServerUrl, { ... });
```

### Fix: Apply URL Validation

```typescript
import { isPrivateIP, normalizeUrl } from "./security";

async function mcpFetch(url: string, options: RequestInit): Promise<Response> {
  // Validate URL against SSRF
  const normalized = normalizeUrl(url);
  if (isPrivateIP(normalized.hostname)) {
    throw new Error(`SSRF blocked: ${url} resolves to private IP`);
  }
  
  // Only allow HTTP/HTTPS
  if (!["http:", "https:"].includes(normalized.protocol)) {
    throw new Error(`SSRF blocked: protocol ${normalized.protocol} not allowed`);
  }
  
  return corsFetch(url, options);
}
```

---

## Improvement 8.3: Improve Dangerous Command Detection

**File:** `toolSchemas.ts:298-327`

### Current State

```typescript
// Substring matching — can be bypassed
const DANGEROUS_COMMANDS = [
  "rm -rf /",
  "mkfs",
  "dd if=",
  // ...
];
```

### Fix: AST-Based Detection

```typescript
import { parse as shellParse } from "shell-quote";

function isDangerousCommand(command: string): boolean {
  const tokens = shellParse(command);
  
  // Check for dangerous command patterns
  for (const token of tokens) {
    if (typeof token !== "string") continue;
    
    // rm with -rf and / or ~
    if (token === "rm") {
      const flags = tokens.filter(t => typeof t === "string" && t.startsWith("-")).join("");
      if (flags.includes("r") && flags.includes("f")) {
        const args = tokens.filter(t => typeof t === "string" && !t.startsWith("-"));
        if (args.some(a => a === "/" || a === "~" || a === "/*" || a === "~/")) {
          return true;
        }
      }
    }
    
    // mkfs
    if (token.startsWith("mkfs")) return true;
    
    // dd with of=
    if (token === "dd") {
      const args = tokens.filter(t => typeof t === "string");
      if (args.some(a => a.startsWith("of="))) return true;
    }
    
    // fork bombs
    if (token.includes(":")) {
      const parts = token.split(":");
      if (parts.length === 2 && parts[0] === parts[1]) {
        return true; // :(){ :|:& };:
      }
    }
  }
  
  return false;
}
```

---

## Improvement 8.4: Add Permission Audit Trail

### New Feature

```typescript
// lib/permissionAudit.ts
interface PermissionAuditEntry {
  timestamp: number;
  sessionId: string;
  toolName: string;
  toolArgs: string;
  decision: "allow" | "deny" | "ask";
  source: "auto" | "user" | "always-allow";
  userId?: string;
}

const _auditLog: PermissionAuditEntry[] = [];

export function logPermission(entry: PermissionAuditEntry): void {
  _auditLog.push(entry);
  
  // Persist to trajectory
  if (typeof window !== "undefined") {
    const trajectory = window.__TRAJECTORY_RECORDER__;
    if (trajectory) {
      trajectory.recordEvent({
        type: "permission_audit",
        ...entry,
      });
    }
  }
}

export function getAuditLog(sessionId?: string): PermissionAuditEntry[] {
  if (sessionId) {
    return _auditLog.filter(e => e.sessionId === sessionId);
  }
  return [..._auditLog];
}

export function exportAuditLog(): string {
  return JSON.stringify(_auditLog, null, 2);
}
```

---

## Improvement 8.5: Fix Clipboard Race Condition

**File:** `system.rs:338`

### Current State

```rust
// Line 338: Predictable temp file path
let tmp_path = temp_dir().join("dalam_clipboard_image.png");
```

### Fix: Use NamedTempFile

```rust
use tempfile::NamedTempFile;

pub async fn clipboard_read_image(_app: tauri::AppHandle) -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        let tmp_file = NamedTempFile::new()
            .map_err(|e| format!("Failed to create temp file: {}", e))?;
        let tmp_path = tmp_path.path().to_path_buf();
        
        // ... rest of the logic using tmp_path
    }
}
```

---

## Implementation Steps

1. Add `tauri-plugin-stronghold` to Cargo.toml
2. Implement secure storage Rust commands
3. Create TypeScript wrapper for secure storage
4. Migrate existing API keys from localStorage to secure storage
5. Add SSRF validation to MCP HTTP calls
6. Replace substring-based command detection with AST-based
7. Add permission audit trail logging
8. Fix clipboard race condition with NamedTempFile
9. Update CSP to remove `unsafe-eval` if possible
10. Add tests for SSRF validation and command detection

---

## Success Criteria

- [ ] API keys stored in OS keychain (not plaintext)
- [ ] MCP HTTP calls validated against SSRF
- [ ] Dangerous commands detected via AST (not substring)
- [ ] All permission decisions logged to audit trail
- [ ] Clipboard temp files use unpredictable names
- [ ] No `unsafe-eval` in CSP (if possible)
- [ ] Migration preserves existing API keys
