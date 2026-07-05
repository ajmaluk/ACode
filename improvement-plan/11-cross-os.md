# Phase 11: Cross-OS Robustness

> **Priority:** Medium
> **Estimated Effort:** 3-4 days
> **Dependencies:** Phase 2 (tool calling)
> **Primary Files:** Platform utilities, `system.rs` (1,043 lines), path helpers

## Current State Analysis

### Platform Support Matrix

| Feature | macOS | Windows | Linux |
|---------|-------|---------|-------|
| File operations | ✅ | ✅ | ✅ |
| Shell execution | ✅ bash/zsh/fish | ✅ cmd/powershell/pwsh | ✅ bash/zsh/fish/sh |
| Clipboard | ✅ osascript | ✅ PowerShell | ⚠️ xclip/xsel (X11 only) |
| Process management | ✅ kill | ✅ taskkill | ✅ kill |
| Disk space | ✅ df | ⚠️ wmic (deprecated) | ✅ df |
| IDE detection | ✅ | ✅ | ⚠️ Limited |
| Shell detection | ✅ | ✅ | ✅ |
| Deep links | ✅ dalam:// | ✅ dalam:// | ✅ dalam:// |

### Issues Found

| # | Issue | Severity | File:Line |
|---|-------|----------|-----------|
| 1 | Path separator inconsistency | Medium | — |
| 2 | Windows drive letter handling untested | Medium | — |
| 3 | Cancellation doesn't propagate to dream/compaction | High | — |
| 4 | `beforeunload` flush is fire-and-forget | Medium | trajectoryRecorder.ts:498-499 |
| 5 | No auto-update mechanism | High | — |
| 6 | Linux clipboard only works on X11 | Medium | system.rs:304-322 |
| 7 | Windows `open_with_system_handler` has no path restriction | Medium | system.rs:150-158 |
| 8 | `wmic` deprecated on Windows | Low | system.rs:682-702 |
| 9 | Shell detection hardcoded paths may not exist | Low | system.rs:779-812 |

---

## Improvement 11.1: Add CancellationToken Abstraction

### New Module

```typescript
// lib/cancellationToken.ts
export class CancellationToken {
  private _aborted = false;
  private _reason?: string;
  private _listeners: Array<() => void> = [];
  
  get isAborted(): boolean {
    return this._aborted;
  }
  
  get reason(): string | undefined {
    return this._reason;
  }
  
  abort(reason?: string): void {
    if (this._aborted) return;
    this._aborted = true;
    this._reason = reason;
    
    for (const listener of this._listeners) {
      listener();
    }
    this._listeners = [];
  }
  
  throwIfAborted(): void {
    if (this._aborted) {
      throw new Error(`Operation cancelled: ${this._reason || "unknown reason"}`);
    }
  }
  
  onAbort(callback: () => void): () => void {
    if (this._aborted) {
      callback();
      return () => {};
    }
    this._listeners.push(callback);
    return () => {
      this._listeners = this._listeners.filter(l => l !== callback);
    };
  }
  
  static combine(...tokens: CancellationToken[]): CancellationToken {
    const combined = new CancellationToken();
    
    for (const token of tokens) {
      token.onAbort(() => combined.abort(token.reason));
    }
    
    return combined;
  }
}
```

### Usage in Agent Loop

```typescript
// Create per-session cancellation token
const sessionTokens: Map<string, CancellationToken> = new Map();

// When starting a session
function startSession(sessionId: string): CancellationToken {
  const token = new CancellationToken();
  sessionTokens.set(sessionId, token);
  return token;
}

// When aborting
function abortSession(sessionId: string, reason?: string): void {
  const token = sessionTokens.get(sessionId);
  if (token) {
    token.abort(reason);
  }
}

// In agent loop
async function agentLoop(sessionId: string, token: CancellationToken) {
  while (!token.isAborted) {
    token.throwIfAborted();
    
    // ... streaming, tool execution, etc.
    
    // Pass token to dream/compaction
    await compactSessionHistory(sessionId, token);
  }
}

// In dream agent
async function runDreamCycle(
  workspacePath: string,
  token: CancellationToken
): Promise<DreamCycleResult> {
  // Check cancellation before each phase
  token.throwIfAborted();
  await phase1_purgeStale();
  
  token.throwIfAborted();
  await phase2_validateFiles();
  
  // ... etc
}
```

---

## Improvement 11.2: Fix beforeunload Flush

**File:** `trajectoryRecorder.ts:498-499`

### Current State

```typescript
// Lines 498-499: Fire-and-forget
window.addEventListener("beforeunload", () => {
  void flushAll();  // <-- Async, may not complete
});
```

### Fix: Use sendBeacon for Critical Data

```typescript
window.addEventListener("beforeunload", () => {
  // Try synchronous flush first
  try {
    for (const buffer of _buffers.values()) {
      if (buffer.lines.length > 0) {
        const content = buffer.lines.join('\n') + '\n';
        const blob = new Blob([content], { type: 'application/jsonl' });
        const url = URL.createObjectURL(blob);
        
        // Use sendBeacon (synchronous, survives page unload)
        navigator.sendBeacon(url, blob);
        URL.revokeObjectURL(url);
      }
    }
  } catch {
    // Fallback: best-effort async
    void flushAll();
  }
});
```

---

## Improvement 11.3: Add Auto-Update Mechanism

### New Dependencies

```toml
# Cargo.toml
[dependencies]
tauri-plugin-updater = "2"
```

### Rust Side

```rust
// In lib.rs
builder.plugin(tauri_plugin_updater::Builder::new().build());
```

### TypeScript Side

```typescript
// lib/updater.ts
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export async function checkForUpdates(): Promise<{
  available: boolean;
  version?: string;
  notes?: string;
}> {
  try {
    const update = await check();
    
    if (update) {
      return {
        available: true,
        version: update.version,
        notes: update.body,
      };
    }
    
    return { available: false };
  } catch (err) {
    console.warn("[Updater] Failed to check for updates:", err);
    return { available: false };
  }
}

export async function installUpdate(): Promise<void> {
  const update = await check();
  if (update) {
    // Download and install
    await update.downloadAndInstall((progress) => {
      console.log(`[Updater] Download progress: ${progress}%`);
    });
    
    // Relaunch app
    await relaunch();
  }
}
```

### Settings Integration

```typescript
// In SettingsModal.tsx, GeneralTab
function UpdateSection() {
  const [updateInfo, setUpdateInfo] = useState<{ available: boolean; version?: string } | null>(null);
  const [checking, setChecking] = useState(false);
  
  const handleCheck = async () => {
    setChecking(true);
    const info = await checkForUpdates();
    setUpdateInfo(info);
    setChecking(false);
  };
  
  return (
    <div className="border rounded p-4">
      <h3 className="font-medium mb-2">Updates</h3>
      {updateInfo?.available ? (
        <div className="space-y-2">
          <p className="text-sm text-green-400">
            Update available: v{updateInfo.version}
          </p>
          <button
            onClick={installUpdate}
            className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600"
          >
            Install Update
          </button>
        </div>
      ) : (
        <button
          onClick={handleCheck}
          disabled={checking}
          className="px-4 py-2 bg-white/10 rounded hover:bg-white/20 disabled:opacity-50"
        >
          {checking ? "Checking..." : "Check for Updates"}
        </button>
      )}
    </div>
  );
}
```

---

## Improvement 11.4: Linux Wayland Clipboard Support

**File:** `system.rs:304-322`

### Current State

```rust
// Lines 304-322: Only X11 clipboard tools
let output = Command::new("xclip")
    .args(["-selection", "clipboard", "-o"])
    .output();
```

### Fix: Try Wayland First

```rust
pub async fn clipboard_has_image(_app: tauri::AppHandle) -> Result<bool, String> {
    #[cfg(target_os = "linux")]
    {
        // Try Wayland first (wl-paste)
        if let Ok(output) = Command::new("wl-paste")
            .args(["--type", "image/png"])
            .output()
        {
            if output.status.success() && !output.stdout.is_empty() {
                return Ok(true);
            }
        }
        
        // Fall back to X11 (xclip)
        if let Ok(output) = Command::new("xclip")
            .args(["-selection", "clipboard", "-o", "-t", "image/png"])
            .output()
        {
            if output.status.success() && !output.stdout.is_empty() {
                return Ok(true);
            }
        }
        
        // Fall back to xsel
        if let Ok(output) = Command::new("xsel")
            .args(["--clipboard", "--output"])
            .output()
        {
            if output.status.success() && !output.stdout.is_empty() {
                return Ok(true);
            }
        }
        
        Ok(false)
    }
}
```

---

## Implementation Steps

1. Create `CancellationToken` abstraction
2. Integrate cancellation into agent loop, dream, compaction
3. Fix `beforeunload` flush with `sendBeacon`
4. Add `tauri-plugin-updater` for auto-updates
5. Add update check/install UI in settings
6. Add Wayland clipboard support for Linux
7. Add path normalization utility (handle `/` vs `\` vs drive letters)
8. Add Windows `open_with_system_handler` path restriction
9. Replace `wmic` with PowerShell on Windows
10. Add tests for cross-platform path handling

---

## Success Criteria

- [ ] CancellationToken propagates to all async operations
- [ ] `beforeunload` reliably flushes trajectory data
- [ ] Auto-update mechanism works on all platforms
- [ ] Linux clipboard works on both X11 and Wayland
- [ ] Windows path handling is consistent with Unix
- [ ] No deprecated `wmic` usage on Windows
