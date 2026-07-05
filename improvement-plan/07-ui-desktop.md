# Phase 7: UI & Desktop

> **Priority:** Medium-High
> **Estimated Effort:** 1-2 weeks
> **Dependencies:** Phase 1 (runtime contract), Phase 2 (tool calling)
> **Primary Files:** `ChatView.tsx` (1,445 lines), `SettingsModal.tsx` (1,944 lines), `useAppStore.ts` (5,411 lines)

## Current State Analysis

### Component Architecture

```
App.tsx (641 lines)
├── PanelGroup (sidebar | editor | right panel)
│   ├── Sidebar.tsx (sessions, file tree)
│   ├── Editor.tsx / ChatView.tsx
│   └── RightPanel.tsx (git, diff, browser)
├── BottomPanel.tsx (terminal)
├── SettingsModal.tsx (11 tabs)
├── CommandPalette.tsx
└── PermissionDialog.tsx
```

### State Management

Single monolithic Zustand store (`useAppStore.ts`, 5,411 lines) with 15+ slices:
- `useCommandPalette`, `useSettings`, `useSettingsView`, `useShortcuts`
- `useModelProviders`, `useWorkspace`, `useGit`
- `useAgents`, `useChat` (largest), `useTerminal`
- `useSkillsMcp`, `usePermission`, `useQuestion`
- `useDiffView`, `useUI`, `useBottomPanel`

### Issues Found

| # | Issue | Severity | File:Line |
|---|-------|----------|-----------|
| 1 | Monolithic store (5,411 lines) — poor separation | Medium | useAppStore.ts |
| 2 | File tree has no virtualization | Medium | FileTree.tsx |
| 3 | Monaco loaded upfront (2MB) even when hidden | Low | — |
| 4 | No `/undo` command | High | — |
| 5 | No inline diff preview before applying | High | MultiFileDiff.tsx |
| 6 | No cost tracking per session | Medium | — |
| 7 | Terminal theme applies via useEffect (flicker) | Low | TerminalPanel.tsx |
| 8 | Native `confirm()` calls inconsistent with UI | Medium | SettingsModal.tsx |
| 9 | ChatView.tsx (1,445 lines) too large | Medium | ChatView.tsx |
| 10 | SettingsModal.tsx (1,944 lines) too large | Medium | SettingsModal.tsx |
| 11 | No accessibility (aria-label, roles) | Medium | All components |
| 12 | Model dropdown code duplicated | Low | ChatView.tsx |
| 13 | `removedMessagesStack` grows unbounded | Low | ChatView.tsx |
| 14 | ContextPressureIndicator uses hardcoded 128k | Low | ContextPressureIndicator.tsx |

---

## Improvement 7.1: Split Monolithic Store

### Current: Single File (5,411 lines)

### New: Domain-Specific Stores

```
store/
├── useAppStore.ts          # Core + orchestration (~500 lines)
├── stores/
│   ├── chatStore.ts        # Messages, streaming, todos (~800 lines)
│   ├── sessionStore.ts     # Sessions, versions, persistence (~400 lines)
│   ├── workspaceStore.ts   # Files, tabs, active file (~300 lines)
│   ├── agentStore.ts       # Agents, permissions, skills (~300 lines)
│   ├── terminalStore.ts    # Terminal tabs, output (~200 lines)
│   ├── settingsStore.ts    # Settings, providers (~200 lines)
│   ├── uiStore.ts          # Panels, modals, shortcuts (~200 lines)
│   └── gitStore.ts         # Git status, branches (~150 lines)
```

### Cross-Store Communication

```typescript
// Use Zustand's subscribe for cross-store events
import { useChatStore } from './chatStore';
import { useSessionStore } from './sessionStore';

// In chatStore:
useChatStore.subscribe(
  (state) => state.isStreaming,
  (isStreaming, wasStreaming) => {
    if (wasStreaming && !isStreaming) {
      // Streaming ended — trigger post-turn hooks
      useSessionStore.getState().onStreamingComplete();
    }
  }
);
```

---

## Improvement 7.2: Add File Tree Virtualization

**File:** `components/sidebar/FileTree.tsx`

### Current State

Recursive component renders all nodes in DOM. Large directories (1000+ files) cause layout thrashing.

### Fix: Virtual List for Visible Nodes

```typescript
import { useVirtualizer } from '@tanstack/react-virtual';

function FileTree({ nodes }: { nodes: FileNode[] }) {
  const parentRef = useRef<HTMLDivElement>(null);
  
  const flatNodes = useMemo(() => flattenTree(nodes), [nodes]);
  
  const virtualizer = useVirtualizer({
    count: flatNodes.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 28, // Row height
    overscan: 10,
  });
  
  return (
    <div ref={parentRef} className="h-full overflow-auto">
      <div style={{ height: `${virtualizer.getTotalSize()}px`, position: 'relative' }}>
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const node = flatNodes[virtualRow.index];
          return (
            <div
              key={node.path}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                height: `${virtualRow.size}px`,
                transform: `translateY(${virtualRow.start}px)`,
              }}
            >
              <FileTreeNode node={node} depth={node.depth} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function flattenTree(nodes: FileNode[], depth = 0): (FileNode & { depth: number })[] {
  const result: (FileNode & { depth: number })[] = [];
  for (const node of nodes) {
    result.push({ ...node, depth });
    if (node.expanded && node.children) {
      result.push(...flattenTree(node.children, depth + 1));
    }
  }
  return result;
}
```

---

## Improvement 7.3: Lazy Load Monaco Editor

### Current State

Monaco is loaded upfront via `@monaco-editor/react` even when the editor tab isn't active.

### Fix: Dynamic Import

```typescript
// components/editor/Editor.tsx
import React, { Suspense } from 'react';

const MonacoEditor = React.lazy(() => import('@monaco-editor/react'));

function Editor({ filePath, content, onChange }: EditorProps) {
  const [isReady, setIsReady] = useState(false);
  
  return (
    <Suspense fallback={
      <div className="flex items-center justify-center h-full">
        <LoadingSpinner />
        <span className="ml-2 text-sm text-gray-400">Loading editor...</span>
      </div>
    }>
      <MonacoEditor
        language={getLanguage(filePath)}
        value={content}
        onChange={onChange}
        onMount={() => setIsReady(true)}
        options={{
          minimap: { enabled: false },
          fontSize: 14,
          // ... other options
        }}
      />
    </Suspense>
  );
}
```

---

## Improvement 7.4: Add `/undo` Command (Git-Based)

### New Feature

```typescript
// In ChatView.tsx slash command handler
case "/undo":
  if (!activeSessionId) {
    toast({ title: "No active session", type: "warning" });
    return;
  }
  
  // Get the last file changes
  const messages = useChat.getState().messages;
  const lastAssistant = [...messages]
    .reverse()
    .find(m => m.role === "assistant" && m.fileChanges?.length);
  
  if (!lastAssistant?.fileChanges) {
    toast({ title: "No changes to undo", type: "info" });
    return;
  }
  
  // Confirm with user
  const confirmed = await showConfirmDialog({
    title: "Undo Changes",
    description: `Revert ${lastAssistant.fileChanges.length} file change(s)?`,
    changes: lastAssistant.fileChanges,
  });
  
  if (!confirmed) return;
  
  // Revert each file
  for (const change of lastAssistant.fileChanges) {
    if (change.action === "created") {
      await api.fs.remove(change.path);
    } else if (change.action === "modified" && change.backup) {
      await api.fs.writeFile(change.path, change.backup);
    } else if (change.action === "deleted" && change.backup) {
      await api.fs.writeFile(change.path, change.backup);
    }
  }
  
  // Remove the assistant message
  useChat.getState().removeMessage(lastAssistant.id);
  
  toast({ title: "Changes reverted", type: "success" });
```

---

## Improvement 7.5: Add Inline Diff Preview

**File:** `components/chat/MultiFileDiff.tsx`

### Current State

Shows file names and +/- stats but no actual diff content.

### Fix: Expandable Diff View

```typescript
function MultiFileDiff() {
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set());
  
  const toggleFile = (path: string) => {
    setExpandedFiles(prev => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };
  
  return (
    <div className="space-y-2">
      {pendingDiffs.map(diff => (
        <div key={diff.filePath} className="border rounded">
          <button
            onClick={() => toggleFile(diff.filePath)}
            className="w-full flex items-center justify-between p-2 hover:bg-white/5"
          >
            <span className="font-mono text-sm">{diff.filePath}</span>
            <span className="text-xs text-gray-400">
              +{diff.additions} -{diff.deletions}
            </span>
          </button>
          
          {expandedFiles.has(diff.filePath) && diff.hunks && (
            <div className="border-t font-mono text-xs">
              {diff.hunks.map((hunk, i) => (
                <div key={i} className="p-2">
                  <div className="text-gray-500 mb-1">{hunk.header}</div>
                  {hunk.lines.map((line, j) => (
                    <div
                      key={j}
                      className={
                        line.startsWith('+')
                          ? 'bg-green-500/10 text-green-400'
                          : line.startsWith('-')
                          ? 'bg-red-500/10 text-red-400'
                          : 'text-gray-300'
                      }
                    >
                      {line}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
          
          <div className="flex gap-2 p-2 border-t">
            <button
              onClick={() => resolveToolApproval(diff.toolCallId, "approved")}
              className="px-3 py-1 bg-green-500/20 text-green-400 rounded text-sm"
            >
              Approve
            </button>
            <button
              onClick={() => resolveToolApproval(diff.toolCallId, "denied")}
              className="px-3 py-1 bg-red-500/20 text-red-400 rounded text-sm"
            >
              Reject
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
```

---

## Improvement 7.6: Add Cost Tracking

### New Component

```typescript
// components/chat/SessionCostTracker.tsx
function SessionCostTracker() {
  const { activeSessionId, messages } = useChat();
  const { selectedModel, selectedProvider } = useSettings();
  
  const stats = useMemo(() => {
    if (!activeSessionId) return null;
    
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalToolCalls = 0;
    
    for (const msg of messages) {
      if (msg.role === "user") {
        totalInputTokens += estimateTokens(msg.content);
      } else if (msg.role === "assistant") {
        totalOutputTokens += estimateTokens(msg.content);
        totalToolCalls += msg.toolCalls?.length || 0;
      }
    }
    
    const model = getModelPricing(selectedModel);
    const cost = model
      ? (totalInputTokens * model.inputPrice + totalOutputTokens * model.outputPrice) / 1_000_000
      : 0;
    
    return {
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      toolCalls: totalToolCalls,
      estimatedCost: cost,
    };
  }, [messages, selectedModel]);
  
  if (!stats) return null;
  
  return (
    <div className="flex items-center gap-4 text-xs text-gray-400">
      <span>{formatTokens(stats.inputTokens)} in</span>
      <span>{formatTokens(stats.outputTokens)} out</span>
      <span>{stats.toolCalls} tools</span>
      <span>${stats.estimatedCost.toFixed(4)}</span>
    </div>
  );
}
```

---

## Implementation Steps

1. Split monolithic store into domain-specific stores
2. Add file tree virtualization
3. Lazy load Monaco editor
4. Implement `/undo` command with git-based revert
5. Add inline diff preview in MultiFileDiff
6. Add cost tracking per session
7. Replace native `confirm()` with custom dialogs
8. Add aria-labels and roles to all interactive elements
9. Extract model dropdown into shared component
10. Cap `removedMessagesStack` at 50 entries

---

## Success Criteria

- [ ] Store split into 8+ domain modules
- [ ] File tree handles 1000+ files without lag
- [ ] Monaco lazy loads (not upfront)
- [ ] `/undo` reverts last file changes
- [ ] Diff preview shows actual content before approval
- [ ] Cost tracking shows per-session breakdown
- [ ] No native `confirm()` calls
- [ ] All interactive elements have aria-labels
