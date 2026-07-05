# Phase 6: Session Management

> **Priority:** Medium-High
> **Estimated Effort:** 3-4 days
> **Dependencies:** Phase 4 (memory system)
> **Primary Files:** `useAppStore.ts` (lines 769-962, 1200-1610, 3601-3742)

## Current State Analysis

### Persistence Architecture

Sessions are persisted to **4 different stores**:

| Store | Data | Key |
|-------|------|-----|
| localStorage | Session summaries | `dalam.chatSessions.v1` |
| localStorage | Session messages | `dalam.sessionMessages.v1` |
| localStorage | Session versions | `dalam.sessionVersions.v1` |
| localStorage | Compaction summaries | `dalam.compactionSummaries.v1` |
| localStorage | Session agents | `dalam.sessionAgents.v1` |
| `.dalam/sessions.json` | All of above (workspace-scoped) | — |
| IndexedDB | Backup/migration target | — |
| Zustand store | Runtime working set | — |

### Version System

```typescript
type ChatVersion = {
  id: string;
  sessionId: string;
  label: string;
  messages: ChatMessage[];  // Full deep copy
  timestamp: number;
  parentVersionId?: string;
};
```

### Issues Found

| # | Issue | Severity | File:Line |
|---|-------|----------|-----------|
| 1 | Dual persistence (localStorage + sessions.json) risks split-brain | High | useAppStore.ts:819-962 |
| 2 | localStorage quota cascade silently loses data | High | useAppStore.ts:826-905 |
| 3 | Version restore strips tool results | Medium | useAppStore.ts:3630-3672 |
| 4 | Version tree structure suggested but linear only | Low | useAppStore.ts:3601-3628 |
| 5 | No session archival mechanism | Low | — |
| 6 | `removeSession` race conditions with async abort | Medium | useAppStore.ts:3345 |
| 7 | No auto-open last workspace on startup | Low | — |
| 8 | Version storage bloat (full message copies) | Medium | useAppStore.ts:3601-3628 |

---

## Improvement 6.1: Unify Persistence to Single Canonical Store

### Current Divergence

```
localStorage ←→ .dalam/sessions.json ←→ IndexedDB
     ↑                  ↑                    ↑
     └── Debounce 200ms └── Debounce 100ms  └── Backup only
```

### Fix: Canonical Store Policy

| Data Type | Canonical Store | Backup | Rationale |
|-----------|----------------|--------|-----------|
| Session summaries | `.dalam/sessions.json` | localStorage | Workspace-scoped, git-friendly |
| Session messages | `.dalam/sessions.json` | localStorage | Large data, workspace-scoped |
| Session versions | `.dalam/sessions.json` | localStorage | Tied to sessions |
| Compaction summaries | `.dalam/sessions.json` | localStorage | Tied to sessions |
| Settings | localStorage | — | Global, not workspace-specific |
| Memory | SQLite + Markdown | — | Already unified |

### Implementation

```typescript
// Remove localStorage as primary store for session data
// Keep only as fallback when .dalam/sessions.json is unavailable

async function saveSessionData(workspacePath: string, data: SessionData): Promise<void> {
  try {
    // Primary: workspace JSON
    await api.fs.writeFile(
      joinPath(workspacePath, ".dalam/sessions.json"),
      JSON.stringify(data, null, 2)
    );
  } catch (err) {
    // Fallback: localStorage (with warning)
    console.warn("[Session] Primary save failed, using localStorage fallback:", err);
    localStorage.setItem(SESSION_SUMMARIES_KEY, JSON.stringify(data.summaries));
    localStorage.setItem(SESSION_MESSAGES_KEY, JSON.stringify(data.messages));
  }
}
```

---

## Improvement 6.2: Notify User on Data Pruning

**File:** `useAppStore.ts:826-905`

### Current State

```typescript
// Lines 826-905: Silent cascading data loss
try {
  localStorage.setItem(key, value);
} catch (e) {
  if (e instanceof DOMException && e.name === "QuotaExceededError") {
    truncateToolResults();  // Silent
    trimOldMessages();      // Silent
    dropOldestSessions();   // Silent
  }
}
```

### Fix: Notify User

```typescript
try {
  localStorage.setItem(key, value);
} catch (e) {
  if (e instanceof DOMException && e.name === "QuotaExceededError") {
    // Attempt recovery
    const recovered = attemptStorageRecovery();
    
    // Notify user
    const { addToast } = useToast.getState();
    addToast({
      type: "warning",
      title: "Storage space low",
      description: recovered
        ? `Recovered space by pruning old data. Consider exporting sessions.`
        : `Could not save data. Please export and clear old sessions.`,
      duration: 10000,
    });
  }
}

function attemptStorageRecovery(): boolean {
  try {
    truncateToolResults();
    trimOldMessages();
    dropOldestSessions();
    return true;
  } catch {
    return false;
  }
}
```

---

## Improvement 6.3: Preserve Tool Results in Version Restore

**File:** `useAppStore.ts:3630-3672`

### Current State

```typescript
// Lines 3630-3672: Strips tool results from restored messages
restoredMessages.forEach(msg => {
  if (msg.toolCalls) {
    msg.toolCalls.forEach(tc => {
      tc.result = undefined;  // <-- Lost context
      tc.diff = undefined;
      tc.diffId = undefined;
      tc.status = "completed";
    });
  }
});
```

### Fix: Preserve Tool Results

```typescript
restoredMessages.forEach(msg => {
  if (msg.toolCalls) {
    msg.toolCalls.forEach(tc => {
      // Keep result for context, but mark as historical
      tc.historical = true;  // New flag: don't allow re-execution
      tc.diff = undefined;   // Diff is stale, remove
      tc.diffId = undefined;
      tc.status = "completed";
    });
  }
});
```

---

## Improvement 6.4: Fix removeSession Race Condition

**File:** `useAppStore.ts:3345`

### Current State

```typescript
// Lines 3345+: Async abort can modify state after cleanup
const removeSession = async (sessionId: string) => {
  abort(sessionId);  // Async, may not complete immediately
  
  // These run while abort is still in progress
  set(s => ({
    chatSessions: s.chatSessions.filter(cs => cs.id !== sessionId),
    sessionMessages: { ...s.sessionMessages, [sessionId]: undefined },
    // ... more cleanup
  }));
};
```

### Fix: Wait for Abort

```typescript
const removeSession = async (sessionId: string) => {
  // Wait for abort to complete
  try {
    await abort(sessionId);
  } catch {
    // Abort may throw, that's ok
  }
  
  // Now safe to clean up
  set(s => ({
    chatSessions: s.chatSessions.filter(cs => cs.id !== sessionId),
    sessionMessages: { ...s.sessionMessages, [sessionId]: undefined },
    sessionVersions: { ...s.sessionVersions, [sessionId]: undefined },
    compactionSummaries: { ...s.compactionSummaries, [sessionId]: undefined },
    sessionAgentName: { ...s.sessionAgentName, [sessionId]: undefined },
  }));
  
  // Auto-select next session
  const remaining = get().chatSessions;
  if (remaining.length > 0) {
    const nextSession = remaining.reduce((latest, s) =>
      s.lastActivityAt > latest.lastActivityAt ? s : latest
    );
    await setActiveSession(nextSession.id);
  }
  
  // Persist
  await persistSessionData();
};
```

---

## Improvement 6.5: Add Session Archival

### New Feature

```typescript
interface ChatSessionSummary {
  // ... existing fields
  archived?: boolean;
  archivedAt?: number;
}

// Archive instead of delete
const archiveSession = async (sessionId: string) => {
  set(s => ({
    chatSessions: s.chatSessions.map(cs =>
      cs.id === sessionId
        ? { ...cs, archived: true, archivedAt: Date.now() }
        : cs
    ),
  }));
  
  // Move messages to archive storage
  const messages = get().sessionMessages[sessionId];
  if (messages) {
    await api.fs.writeFile(
      joinPath(get().activeWorkspace!.path, `.dalam/archive/${sessionId}.json`),
      JSON.stringify(messages)
    );
    
    // Remove from active storage
    set(s => ({
      sessionMessages: { ...s.sessionMessages, [sessionId]: undefined },
    }));
  }
};

// Restore from archive
const restoreSession = async (sessionId: string) => {
  const archivePath = joinPath(
    get().activeWorkspace!.path,
    `.dalam/archive/${sessionId}.json`
  );
  
  const content = await api.fs.readFile(archivePath);
  const messages = JSON.parse(content);
  
  set(s => ({
    chatSessions: s.chatSessions.map(cs =>
      cs.id === sessionId
        ? { ...cs, archived: false, archivedAt: undefined }
        : cs
    ),
    sessionMessages: { ...s.sessionMessages, [sessionId]: messages },
  }));
  
  await api.fs.remove(archivePath);
  await persistSessionData();
};
```

---

## Implementation Steps

1. Unify persistence to `.dalam/sessions.json` as canonical
2. Add user notification on storage quota exceeded
3. Preserve tool results in version restore (mark as historical)
4. Fix removeSession to wait for abort completion
5. Add session archive/restore functionality
6. Add auto-open last workspace on startup
7. Add tests for persistence consistency
8. Add test: verify version restore preserves context

---

## Success Criteria

- [ ] Single canonical store for session data (no split-brain)
- [ ] User notified when data is pruned
- [ ] Version restore preserves tool results for context
- [ ] Session removal waits for abort completion
- [ ] Sessions can be archived and restored
- [ ] No data loss on storage quota exceeded
