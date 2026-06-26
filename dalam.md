# Dalam — AI-Native IDE / Agentic Development Environment

> **Version:** 0.1.0  
> **License:** MIT  
> **Architecture:** Tauri v2 (Rust backend + React/TypeScript frontend)

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Architecture & Technology Stack](#2-architecture--technology-stack)
3. [Directory Structure](#3-directory-structure)
4. [Monorepo Configuration](#4-monorepo-configuration)
5. [Shared Types Package](#5-shared-types-package)
6. [Tauri Backend (Rust)](#6-tauri-backend-rust)
7. [Renderer — Entry Points](#7-renderer--entry-points)
8. [State Management (Zustand Store)](#8-state-management-zustand-store)
9. [DalamAPI — The Bridge Layer](#9-dalamapi--the-bridge-layer)
10. [Agent System](#10-agent-system)
11. [Chat UI & Streaming](#11-chat-ui--streaming)
12. [Tool System (XML Parsing & Execution)](#12-tool-system-xml-parsing--execution)
13. [Memory System](#13-memory-system)
14. [Skill System](#14-skill-system)
15. [Gene System (Self-Evolution)](#15-gene-system-self-evolution)
16. [Dream Agent (Memory Consolidation)](#16-dream-agent-memory-consolidation)
17. [Skill Crystallizer](#17-skill-crystallizer)
18. [Context Manager](#18-context-manager)
19. [Hook Event Bus](#19-hook-event-bus)
20. [Hook Listeners](#20-hook-listeners)
21. [Agent Evolution](#21-agent-evolution)
22. [Diff Engine](#22-diff-engine)
23. [Instructions System](#23-instructions-system)
24. [Path Utilities](#24-path-utilities)
25. [Memory Graph Visualization](#25-memory-graph-visualization)
26. [Platform Utilities](#26-platform-utilities)
27. [UI Components](#27-ui-components)
28. [Theming & Styling](#28-theming--styling)
29. [Testing](#29-testing)
30. [Task Management Response Format](#30-task-management-response-format)
32. [Workspace Initialization Flow](#32-workspace-initialization-flow)

---

## 1. Project Overview

**Dalam** is an AI-native desktop IDE built with Tauri v2. It provides an agentic coding environment where users chat with AI agents that can read, write, edit files, run shell commands, manage git, and interact with the desktop system. The application features:

- **Multi-agent architecture** with 3 primary agents (Build, Plan, YOLO) and 7 subagents
- **Agentic tool loop** — agents autonomously execute file operations, shell commands, and git tasks
- **Persistent workspace memory** using SQLite FTS5 + Markdown hybrid storage
- **Self-evolving intelligence** via Gene system (learned strategies), Skill Crystallizer (auto-created skills), and Dream Agent (memory consolidation)
- **Diff-based file editing** with approval workflow (Myers' algorithm)
- **Real-time streaming** with thinking/reasoning visualization
- **Context management** with automatic compaction and tool output pruning
- **MCP server integration** for external tool扩展
- **4-layer instructions hierarchy** (global → org → project → local)
- **Task plan checklists** with live status tracking

---

## 2. Architecture & Technology Stack

### Frontend (Renderer)
| Technology | Purpose |
|---|---|
| React 19 | UI framework |
| Zustand 5 | State management |
| TypeScript 5.8 | Type safety |
| Vite 6 | Build tool & dev server |
| Tailwind CSS 3.4 | Styling with custom dark/light theme tokens |
| Monaco Editor | Code editing |
| xterm.js | Terminal emulation |
| react-resizable-panels | Panel layout |
| cmdk | Command palette |
| react-markdown + remark-gfm + rehype-highlight | Markdown rendering |
| zod 4 | Runtime validation |
| Lucide React | Icons |

### Backend (Tauri)
| Technology | Purpose |
|---|---|
| Tauri 2.11 | Desktop framework |
| Rust 2021 | Backend language |
| tauri-plugin-sql (SQLite) | Memory database with FTS5 |
| tauri-plugin-shell | Terminal & shell commands |
| tauri-plugin-fs | File system operations |
| tauri-plugin-dialog | Native dialogs |
| tauri-plugin-http | CORS-free HTTP requests |
| tauri-plugin-clipboard-manager | Clipboard access |
| tauri-plugin-notification | Desktop notifications |
| git2 (via Rust) | Git operations |

### Monorepo
| Tool | Purpose |
|---|---|
| pnpm 9.15 | Package manager |
| Turborepo | Build orchestration |
| Workspaces | `apps/*` + `packages/*` |

---

## 3. Directory Structure

```
ACode/
├── apps/
│   └── desktop/                    # Main Tauri application
│       ├── src-tauri/              # Rust backend
│       │   ├── src/
│       │   │   ├── main.rs         # Entry point
│       │   │   ├── lib.rs          # Tauri plugin init & commands
│       │   │   ├── system.rs       # System commands (clipboard, notify, etc.)
│       │   │   └── git.rs          # Git operations
│       │   ├── Cargo.toml          # Rust dependencies
│       │   ├── tauri.conf.json     # Tauri config
│       │   └── capabilities/       # Permission capabilities
│       └── src/
│           └── renderer/           # React frontend
│               ├── main.tsx        # React entry point
│               ├── App.tsx         # Root component
│               ├── index.css       # Global styles & theme tokens
│               ├── store/
│               │   └── useAppStore.ts    # Zustand store (all state)
│               ├── lib/            # Core business logic
│               │   ├── dalamAPI.ts       # Bridge layer (FS, Terminal, Agent, Git, Settings, System)
│               │   ├── agents.ts         # Agent definitions & permissions
│               │   ├── skills.ts         # Skill system
│               │   ├── genes.ts          # Gene system (self-evolution)
│               │   ├── memoryStore.ts    # Memory CRUD & search
│               │   ├── memoryTypes.ts    # Memory & context types
│               │   ├── database.ts       # SQLite + FTS5 initialization
│               │   ├── contextManager.ts # Context window management
│               │   ├── hookBus.ts        # Lifecycle event bus
│               │   ├── hookListeners.ts  # Hook event handlers
│               │   ├── dreamAgent.ts     # Memory consolidation
│               │   ├── skillCrystallizer.ts # Auto skill creation
│               │   ├── agentEvolution.ts # Agent reproduction
│               │   ├── diff.ts           # Myers' diff algorithm
│               │   ├── instructions.ts   # 4-layer instructions
│               │   ├── memoryGraph.ts    # Knowledge graph visualization
│               │   ├── pathUtils.ts      # Cross-platform path helpers
│               │   ├── platform.ts       # OS detection
│               │   └── types.ts          # Zod schemas
│               └── components/     # UI components
│                   ├── sidebar/    # File tree & sidebar
│                   ├── editor/     # Monaco editor, tabs, breadcrumbs
│                   ├── rightpanel/ # Chat, activity, task plan
│                   ├── terminal/   # xterm.js terminal
│                   ├── settings/   # Settings modal & memory graph
│                   ├── permissions/ # Permission & question dialogs
│                   ├── chat/       # Activity blocks
│                   ├── palette/    # Command palette
│                   ├── onboarding/ # Welcome screen
│                   ├── shell/      # Titlebar, status bar, menubar
│                   └── ui/         # Toaster, context menu, error boundary
└── packages/
    └── shared-types/               # Shared TypeScript types
        └── src/
            └── index.ts            # All IPC types (DalamAPI, ChatMessage, etc.)
```

---

## 4. Monorepo Configuration

### Root `package.json`
- **Name:** `dalam`
- **Package Manager:** pnpm 9.15
- **Scripts:** `dev`, `build`, `test`, `lint`, `typecheck`, `tauri`, `tauri:dev`, `tauri:build`
- **Dev Dependencies:** `@tauri-apps/api`, `@tauri-apps/cli`, `prettier`, `turbo`, `typescript`

### `turbo.json`
- `build` depends on `^build` (topological), outputs `dist/**` and `out/**`
- `dev` is persistent (no cache)
- `typecheck` depends on `^build`
- `lint` and `test` are independent

### `pnpm-workspace.yaml`
```yaml
packages:
  - 'apps/*'
  - 'packages/*'
```

### Desktop `package.json`
- **Name:** `@dalam/desktop`
- **Key Dependencies:** React 19, Zustand 5, Monaco Editor, xterm.js, cmdk, react-markdown, zod, react-resizable-panels, Lucide React
- **Key Dev Dependencies:** Vite 6, Vitest 4, ESLint 10, TypeScript 5.8, PostCSS, Tailwind CSS

---

## 5. Shared Types Package

**File:** `packages/shared-types/src/index.ts`

This is the **single source of truth** for all TypeScript interfaces used across the IPC boundary. The renderer never accesses Node/OS APIs directly — every call goes through the typed `DalamAPI` bridge.

### Core Types

| Type | Description |
|---|---|
| `AppSettings` | User preferences (theme, model, provider, editor settings) |
| `FileNode` | File tree node with git status |
| `GitStatus` | Branch, modified/added/deleted/untracked files |
| `ChatMessage` | Message with role, content, toolCalls, fileChanges, todos, activities, taskPlan |
| `ToolCall` | Tool invocation with name, args, status, result, diff |
| `DiffProposal` | Proposed file change with hunks |
| `AgentSession` | Active session with id, workspace, model, mode, messages |
| `AgentInfo` | Agent definition with name, category, mode, permissions |
| `SkillInfo` | Skill with name, description, content, source |
| `McpServer` | MCP server config with transport, tools, status |
| `StreamEvent` | 18+ event types for real-time streaming |
| `FileChange` | File modification record |
| `TodoItem` | Task checklist item |
| `PendingActivity` | Think/explore/read/skill/bash/plan activity |
| `ChatSessionSummary` | Sidebar session metadata |
| `ChatVersion` | Version checkpoint for undo/restore |
| `FileAttachment` | User-attached files (images, text) |
| `Workspace` | Workspace with id, path, name, tasks |

### `StreamEvent` Variants

```
message-start | message-delta | message-end
tool-call | tool-result | diff-proposed
file-changed | todo-update | thinking | status
ask-permission | ask-question
activity-think | activity-explore | activity-read | activity-skill | activity-bash | activity-plan
error
```

### `DalamAPI` Interface

The bridge surface exposed to the renderer:

```typescript
interface DalamAPI {
  fs: { readFile, writeFile, listDir, createFile, createDirectory, deletePath, renamePath, watchPath }
  terminal: { create, writeInput, resize, kill, onData }
  agent: { startSession, sendPrompt, summarizeMessages, abort, approveDiff, rejectDiff, onStreamEvent, cleanupStream }
  git: { status, commit, log, branches, checkout, createBranch, diffFile }
  settings: { get, set, getAll }
  system: { openDirectoryPicker, openLink, revealInFinder, clipboardRead/Write, notify, getSystemInfo, launchApp, getEnv, getScreenInfo, listProcesses, killProcess, getDiskSpace }
}
```

---

## 6. Tauri Backend (Rust)

### `main.rs`
Standard Tauri entry point — calls `lib::run()`.

### `lib.rs`
- Initializes all Tauri plugins (fs, shell, dialog, clipboard, notification, sql, http, log)
- Registers Tauri commands: `git_status`, `git_commit`, `git_log`, `git_branches`, `git_checkout`, `git_create_branch`, `git_diff_file`, `clipboard_read_text`, `clipboard_write_text`, `clipboard_has_image`, `notify`, `system_get_info`, `get_working_dir`, `open_with_system_handler`, `reveal_in_finder`, `launch_app`, `get_env`, `get_screen_info`, `list_processes`, `kill_process`, `get_disk_space`

### `system.rs`
Implements system-level commands using Rust stdlib + `hostname`, `dirs`, `opener` crates.

### `git.rs`
Uses Rust `git2` crate for git operations (status, commit, log, branches, checkout, create branch, diff).

### `tauri.conf.json`
- **Product:** Dalam v0.1.0
- **Identifier:** `com.dalam.desktop`
- **Window:** 1280×800, min 900×600
- **Security:** Strict CSP with `default-src 'self'`, WebSocket for HMR
- **Bundle:** All platforms, icon set

### `Cargo.toml`
- **Edition:** 2021, Rust 1.77.2+
- **Key Dependencies:** `tauri 2.11.3`, `serde`, `serde_json`, `log`, all Tauri plugins, `hostname`, `dirs`, `opener`

---

## 7. Renderer — Entry Points

### `main.tsx`
```typescript
1. createDalamAPI()         // Initialize the bridge (singleton)
2. registerHookListeners()  // Register lifecycle event handlers
3. createRoot().render(     // Mount React app
     <StrictMode>
       <ErrorBoundary>
         <App />
       </ErrorBoundary>
     </StrictMode>
   )
```

### `App.tsx`
The root component orchestrating the entire UI:

1. **Theme Management** — Reads `effectiveTheme()` from settings, applies `data-theme` attribute and Tailwind `dark` class. Listens for system theme changes when set to "system".

2. **MCP Server Auto-Connect** — On startup, iterates all enabled MCP servers and connects any that are disconnected.

3. **Keyboard Shortcuts** — Global handlers:
   - `Cmd/Ctrl+K` → Command Palette
   - `?` → Shortcuts Cheatsheet
   - `Cmd/Ctrl+,` → Settings
   - `Cmd/Ctrl+B` → Toggle Sidebar
   - `Cmd/Ctrl+N` → New Chat
   - `Cmd/Ctrl+\` → Toggle Right Panel
   - `Cmd/Ctrl+[` / `Cmd/Ctrl+]` → Navigate chat history
   - `Escape` → Close palette

4. **Panel Layout** — Uses `react-resizable-panels` with 3 panels:
   - **Sidebar** (default 20%, collapsible, min 12%, max 32%)
   - **Editor** (default 55%, min 30%)
   - **Right Panel** (default 25%, collapsible, min 16%, max 42%)

5. **Settings-Only Mode** — When settings modal is open, renders only the settings UI (no panels).

6. **Workspace Restore** — On startup, restores the last active workspace from localStorage.

7. **Settings Load** — Loads user settings from the bridge on mount.

---

## 8. State Management (Zustand Store)

**File:** `apps/desktop/src/renderer/store/useAppStore.ts` (~3000+ lines)

This is the **central nervous system** of the application. All UI state lives here, organized into multiple Zustand stores:

### Store Slices

| Store | Purpose |
|---|---|
| `useCommandPalette` | Command palette open state & query |
| `useSettings` | App settings (theme, model, provider) with load/update |
| `useWorkspace` | Active workspace, file tree, open tabs, CRUD operations |
| `useGit` | Git status loading & refresh |
| `useAgents` | Active agent, permission rules, skills, subagent selection |
| `useChat` | **The largest store** — session, messages, streaming, todos, task plans, versions, attachments, compaction |
| `useTerminal` | Terminal tabs, output buffer |
| `useSkillsMcp` | Skills registry & MCP server management |
| `usePermission` | Permission dialog state & always-allowed rules |
| `useQuestion` | Question dialog for agent prompts |
| `useDiffView` | Diff viewer state |
| `useUI` | Sidebar/right panel open state, active tab |

### `useCommandPalette` — Command Palette

**State:**
- `open: boolean` — Whether the command palette overlay is visible
- `query: string` — Current search query in the palette

**Key Actions:**

| Action | Description |
|---|---|
| `setOpen(open)` | Opens or closes the palette. On close, clears the query. |
| `setQuery(query)` | Updates the search filter text |
| `toggle()` | Toggles visibility and resets query |

**Usage:** Triggered by `Cmd/Ctrl+K` keyboard shortcut. The palette uses the `cmdk` library to filter commands (settings, new chat, toggle panels, etc.) based on the query string.

---

### `useSettings` — Application Settings

**State:**
- `settings: AppSettings` — All user preferences (theme, model, provider, editor settings)
- `loaded: boolean` — Whether settings have been loaded from the bridge

**Key Actions:**

| Action | Description |
|---|---|
| `load()` | Loads all settings from the bridge (`api.settings.getAll()`). Also syncs `selectedModel` to the chat store. |
| `update(key, value)` | Atomically updates a single setting via the bridge and local state |
| `updateSettings(updates)` | Bulk-updates multiple settings at once |
| `effectiveTheme()` | Returns the resolved theme: if `"system"`, checks `prefers-color-scheme: dark` media query; otherwise returns the configured theme |

**Persistence:** Settings are stored via the bridge layer (`api.settings.set()`), which uses a localStorage-backed key-value store with in-memory cache.

**Default Settings:** Loaded from `DEFAULT_SETTINGS` in `@dalam/shared-types`.

---

### `useSettingsView` — Settings Modal UI State

**State:**
- `openState: boolean` — Whether the settings modal is visible
- `activeTab: SettingsTab` — Currently active settings tab
- `selectedProviderId: string | null` — Provider being edited (for models sub-view)

**Available Tabs (`SettingsTab`):**
```
"general" | "code-preview" | "models" | "agents" | "permissions" |
"instructions" | "skills" | "mcp" | "memory-graph" | "plugins" | "commands"
```

**Key Actions:**

| Action | Description |
|---|---|
| `open(tab?)` | Opens the settings modal, optionally on a specific tab. Resets `selectedProviderId`. |
| `close()` | Closes the settings modal |
| `setActiveTab(tab)` | Switches to a different settings tab |
| `setSelectedProvider(id)` | Sets the provider being edited (e.g., for adding/removing models) |

**Usage:** Triggered by `Cmd/Ctrl+,` keyboard shortcut or clicking the settings button. When the settings modal is open, `App.tsx` renders only the settings UI (no panels).

---

### `useShortcuts` — Keyboard Shortcuts Cheatsheet

**State:** `open: boolean` — Whether the shortcuts overlay is visible

**Key Actions:**

| Action | Description |
|---|---|
| `setOpen(open)` | Opens or closes the cheatsheet |
| `toggle()` | Toggles visibility |

**Usage:** Triggered by pressing `?` key. Renders the `ShortcutsCheatsheet` component overlay showing all available keyboard shortcuts.

---

### `useModelProviders` — Model Provider Management

**State:** `providers: ModelProvider[]` — List of configured AI model providers

**Key Actions:**

| Action | Description |
|---|---|
| `addProvider()` | Adds a new provider (generates ID from name + timestamp) |
| `removeProvider()` | Removes provider and its localStorage key |
| `toggleProvider()` | Enables/disables a provider |
| `updateProvider()` | Partial update (API key, base URL, etc.) |
| `addModel()` | Adds a model to a provider |
| `removeModel()` | Removes a model from a provider |
| `getAllModels()` | Returns flattened list of all models from enabled providers |

**Persistence:** Each provider's config (name, baseUrl, apiKey, models, enabled) is stored in localStorage under `dalam.providers.v1`. Provider-specific settings (like selected model/provider) are also synced to `.dalam/config.json` via `saveWorkspaceData()`.

---

### `useUI` — Panel Visibility & Browser

**State:**
- `sidebarOpen` — Whether the file tree sidebar is visible
- `rightPanelOpen` — Whether the right panel (chat/terminal/diff) is visible
- `rightPanelTab` — Active tab: `"git"` | `"diff"` | `"review"` | `"browser"` | `"progress"` | `"terminal"`
- `browserTabs` — In-app browser tabs with URL, history, loading state
- `activeBrowserTabId` — Currently active browser tab

**Key Actions:**

| Action | Description |
|---|---|
| `setSidebarOpen()` / `toggleSidebar()` | Panel visibility control |
| `setRightPanelOpen()` / `toggleRightPanel()` | Right panel visibility |
| `setRightPanelTab()` | Switch between git, diff, review, browser, progress, terminal |
| `addBrowserTab()` | Opens a new in-app browser tab |
| `removeBrowserTab()` | Closes a browser tab |
| `navigateBrowser()` | Navigates a browser tab (normalizes URLs, detects search queries) |
| `goBackBrowser()` / `goForwardBrowser()` | Browser history navigation |

**URL Normalization:** `normalizeBrowserUrl()` intelligently handles:
- Plain domains → `https://domain.com`
- Google searches (spaces) → `https://www.google.com/search?q=...`
- Private IPs → blocked (SSRF protection)
- TLD detection for auto-https

---

### `usePermission` — Permission Dialog

**State:**
- `request: PermissionRequest | null` — Active permission request (shown in dialog)
- `alwaysAllowed: Record<string, true>` — Persisted always-allowed rules (key: `workspace::kind::command`)

**Key Actions:**

| Action | Description |
|---|---|
| `ask()` | Shows permission dialog, returns Promise resolved with user decision |
| `allowAlways()` | Adds rule to always-allowed map, persists to disk |
| `resolve()` | Resolves the pending ask() Promise with user's choice |
| `cancel()` | Denies the pending request and clears it |
| `loadFromDisk()` | Loads always-allowed rules from `.dalam/config.json`, merges with localStorage |

**PermissionRequest Shape:**
```typescript
type PermissionRequest = {
  id: string;
  kind: "bash" | "edit" | "mcp" | "read";
  title: string;
  description: string;
  command?: string;          // Bash command string for bash kind
  workspacePath?: string;    // Current workspace for key generation
  createdAt: number;
};
```

**Permission Request Flow:**
1. Tool requires permission → `evaluate()` returns `"ask"`
2. `usePermission.ask()` called with kind, title, description, command
3. If key is in `alwaysAllowed` → auto-allow (no dialog)
4. Otherwise → sets `request` state, dialog renders, blocks on Promise
5. User clicks Allow/Always/Deny → `resolve()` called → Promise resolves
6. If "always" → `allowAlways()` persists the rule to `.dalam/config.json`

**Helper:** `withPermission(params, run)` — Wraps any async operation with permission check. Returns `null` if denied.

---

### `useQuestion` — Agent Question Dialog

**State:** `request: QuestionRequest | null` — Active question from agent

**Key Actions:**

| Action | Description |
|---|---|
| `ask()` | Shows question dialog with options, returns Promise with answer |
| `resolve()` | Resolves the pending ask() Promise |

**QuestionRequest Shape:**
```typescript
type QuestionRequest = {
  id: string;
  header: string;           // e.g., "Choose approach"
  question: string;         // Detailed question text
  options: QuestionOption[]; // Array of {label, description, preview?}
  allowFreeText?: boolean;   // Whether user can type custom answer
  workspaceName?: string;    // Context
  branch?: string;           // Current git branch
  createdAt: number;
};
```

**Usage:** Triggered by `ask-question` stream events when the agent needs user input (e.g., choosing between implementation approaches). The dialog presents labeled options and optionally a free-text field.

---

### `useDiffView` — Diff Viewer

**State:**
- `open` — Whether the diff panel is visible
- `current: FileChange | null` — Currently displayed file change
- `history: FileChange[]` — Back navigation stack
- `forwardStack: FileChange[]` — Forward navigation stack

**Key Actions:**

| Action | Description |
|---|---|
| `openFile(change)` | Opens a file change in the diff viewer, pushes to history |
| `close()` | Closes diff viewer, clears history |
| `next()` / `prev()` | Navigate forward/back through file change history |
| `setOpen()` | Toggle visibility |

**Behavior:** When `openFile()` is called, it automatically opens the right panel and switches to the `"diff"` tab if not already visible. History only pushes when navigating to a *different* file (same-file updates don't pollute history).

**Integration:** Used by:
- `appendStream('diff-proposed')` — When agent proposes a file change
- `appendStream('file-changed')` — When a file is modified
- `useChat.openFile()` — When user clicks a file change notification

---

### `useChat` — The Core Chat Store

This is the most complex store, managing the entire chat lifecycle:

**State:**
- `session` — Active `AgentSession` object
- `messages` — Current conversation messages
- `pendingToolCalls` — Tools awaiting execution/approval
- `pendingActivities` — Real-time activity feed (think, explore, read, bash, skill, plan)
- `streamingContent` — Accumulated streaming text
- `thinkingContent` — Model reasoning/thinking content
- `isStreaming` — Whether LLM is currently streaming
- `todos` — Current task checklist
- `taskPlan` — Task plan items with status
- `chatSessions` — All session summaries for sidebar
- `sessionMessages` — Messages per session (persisted)
- `sessionVersions` — Version checkpoints per session
- `compactionSummaries` — Compacted history per session
- `pendingAttachments` — Files attached by user
- `planApproval` — Plan mode approval state

**Key Actions:**

| Action | Description |
|---|---|
| `startSession()` | Creates new agent session, registers stream listener |
| `sendMessage()` | Auto-selects agent, creates session if needed, sends prompt with attachments |
| `appendStream()` | **The streaming event handler** — processes 18+ event types |
| `abort()` | Cancels active stream |
| `saveVersion()` | Creates checkpoint (max 50 per session) |
| `restoreVersion()` / `confirmVersionRestore()` / `cancelVersionRestore()` | Version restore workflow |
| `newChat()` | Saves checkpoint, aborts, clears state |
| `goBackChat()` / `goForwardChat()` | Chat history navigation |
| `setActiveSession()` | Switches to a different session |
| `removeSession()` | Deletes session and all its data |
| `approvePlan()` / `rejectPlan()` | Plan mode workflow |
| `compactSessionHistory()` | Background context compaction |
| `resolveToolApproval()` | Approve/deny tool calls |

### XML Tool Call Parser

The store includes `parseXmlToolCalls()` — a parser that extracts tool calls from XML tags in assistant text content (for models that output tools as XML instead of using the proper tool-call protocol).

**Known Tool Tag Mappings:**
```typescript
list_dir, read_file, write_file, edit_file, bash, shell,
search, grep, webfetch, websearch, run_command
```

### Persistence

All chat data is persisted to localStorage with these keys:
- `dalam.chatSessions.v1` — Session summaries
- `dalam.sessionMessages.v1` — Messages per session
- `dalam.sessionVersions.v1` — Version checkpoints
- `dalam.sessionAgents.v1` — Agent name per session
- `dalam.compactionSummaries.v1` — Compacted histories
- `dalam.enabledSkills.v1` — Enabled skills
- `dalam.workspaces.v1` — Workspace list
- `dalam.mcpServers.v1` — MCP server configs

**Quota Management:** When localStorage quota is exceeded, tool results are automatically pruned (truncated to 500 chars) to free space.

### Workspace Data Persistence

Sessions, config, and context are also saved to the workspace's `.dalam/` directory:
- `.dalam/sessions.json` — Chat sessions & messages
- `.dalam/config.json` — Project settings, providers, MCP servers
- `.dalam/context.json` — Pinned files, ignore patterns

---

## 9. DalamAPI — The Bridge Layer

**File:** `apps/desktop/src/renderer/lib/dalamAPI.ts`

This is the **API implementation** that the renderer uses. It's a singleton object implementing the `DalamAPI` interface, using Tauri plugins for all OS interactions.

### Key Implementation Details

#### File System (`fs`)
- `readFile()` — Detects binary vs text files, returns `[Binary file: ...]` placeholder for binary
- `writeFile()` — Encodes to UTF-8, tracks recent files
- `listDir()` — Recursive directory scan with junk directory filtering (`.git`, `node_modules`, `dist`, etc.), max 10K files, max depth 20
- `deletePath()` — Recursive delete, closes any open tabs for deleted files
- `renamePath()` — Uses OS rename, falls back to read+write+delete

#### Terminal (`terminal`)
- Spawns shell processes (bash/zsh on Unix, powershell on Windows)
- Manages process lifecycle, stdout/stderr listeners
- Supports multiple tabs with per-tab output buffering (max 100KB per tab)
- Title parsing extracts shell name from display titles

#### Agent (`agent`)
- **`sendPrompt()`** — The heart of the agentic loop:
  1. Assembles system prompt with context (workspace memory, SQLite memories, pinned files, instructions, skills, MCP tools, active file, genes)
  2. Enters a while loop (max 30 iterations, 5 min timeout)
  3. Streams LLM response via SSE (OpenAI or Anthropic format)
  4. Parses XML tool calls from response
  5. Executes tools with permission checking
  6. Pushes tool results as user message
  7. Loops until no more tools are called

- **`summarizeMessages()`** — Non-streaming LLM call for compaction
- **`approveDiff()` / `rejectDiff()`** — Diff approval workflow
- **`onStreamEvent()`** — Registers stream callback per session

#### Git (`git`)
All operations use Tauri `invoke()` to call Rust backend commands.

#### Settings (`settings`)
Simple localStorage-backed key-value store with in-memory cache.

#### System (`system`)
Directory picker, clipboard, notifications, system info, app launching — all via Tauri `invoke()`.

### Provider System

Supports two API formats:
1. **OpenAI** — `POST /chat/completions` with `Authorization: Bearer` header
2. **Anthropic** — `POST /v1/messages` with `x-api-key` header and `anthropic-version: 2023-06-01`

**SSE Parsing:** Custom `parseSSEEvents()` handles CRLF normalization, heartbeat comments, and `[DONE]` markers.

**Retry Logic:** `retryWithBackoff()` with exponential backoff, max 3 retries. Auth (401) and credit (402/429) errors are never retried.

**CORS Handling:** `corsFetch()` uses `@tauri-apps/plugin-http` to bypass browser CORS restrictions, with browser `fetch()` as fallback.

---

## 10. Agent System

**File:** `apps/desktop/src/renderer/lib/agents.ts`

### Agent Architecture

Dalam uses a **primary + subagent** architecture inspired by MiMo-Code:

#### Primary Agents (User-Selectable)

| Agent | Color | Permissions | Description |
|---|---|---|---|
| **Build** | `#fb8147` | Full access + questions | Default agent. Executes tools based on configured permissions. |
| **Plan** | `#c7e2a8` | Read-only + plans dir | Plan mode. Disallows all edit/write tools. Produces a plan for review. |
| **YOLO** | `#e85d75` | Unrestricted | Full access — reads, writes, executes everything without asking. |

#### Subagents (Internal)

| Agent | Category | Permissions | Description |
|---|---|---|---|
| **General** | general | No directory changes | Multi-step task execution |
| **Explore** | explore | Read-only | Fast codebase exploration |
| **Title** | title | Skills only | Generates conversation titles |
| **Summary** | summary | None | Summarizes conversation histories |
| **Compaction** | compaction | None | Compresses context windows |
| **Dream** | dream | None | Creative code/design proposals |
| **Distill** | distill | None | Extracts essential structure |

### Permission System

Permissions follow a **ruleset** pattern with 3 actions: `allow`, `deny`, `ask`.

**Permission Keys:**
```
* (wildcard), bash, edit, read, write, webfetch, websearch,
task, skill, doom_loop, external_directory, question,
plan_enter, plan_exit, change_directory
```

**Ruleset Merging:** Later rulesets override earlier ones for the same (permission, pattern) pair.

**Evaluation Order:**
1. Exact permission + pattern match
2. Permission wildcard (`*`)
3. Global wildcard (`*`)
4. Default: `ask`

**Bash Command Canonicalization:** Commands are mapped to canonical forms using an arity table (e.g., `git checkout main -b feature` → `git checkout`). This allows permission rules to match at the command level.

**Dangerous Commands:** `kill`, `killall`, `rm -rf /`, `mkfs`, `dd`, fork bombs — always require explicit permission.

### Auto-Agent Selection

The `autoSelectAgent()` function implements **evolver-inspired adaptive routing**:
- Checks selection history for learned patterns
- Planning keywords → Plan agent
- Dangerous commands → Build agent (never auto-select YOLO)
- Simple tasks → Build agent
- Default: Keep current agent

Selection history is persisted (last 100 records) with success tracking.

---

## 11. Chat UI & Streaming

### Message Flow

```
User Input → sendMessage() → startSession() (if needed) → api.agent.sendPrompt()
                                                                ↓
                                                     SSE Stream Events
                                                                ↓
                                                     appendStream() handler
                                                                ↓
                                                     useChat state updates
                                                                ↓
                                                     React UI re-renders
```

### Streaming Event Processing (`appendStream`)

The `appendStream()` method handles 18+ event types:

| Event | Behavior |
|---|---|
| `message-start` | Clears streaming content, resets pending state |
| `message-delta` | Appends content to `streamingContent` (truncates at 200K) |
| `message-end` | Parses XML tools, creates final assistant message, saves persistence |
| `tool-call` | Evaluates permissions, adds to `pendingToolCalls`, triggers approval dialog if needed |
| `tool-result` | Updates tool call status with result |
| `diff-proposed` | Attaches diff to matching pending tool call |
| `file-changed` | Tracks file changes, opens diff view |
| `todo-update` | Updates task checklist |
| `activity-think` | Appends thinking content |
| `activity-explore` | Adds exploration activity |
| `activity-read` | Adds file read activity |
| `activity-skill` | Adds skill invocation activity |
| `activity-bash` | Handles task plan detection (`task plan`, `completed`, `task budget exhausted`) |
| `activity-plan` | Adds plan activity |
| `thinking` | Appends reasoning content |
| `status` | Updates session status |
| `ask-permission` | Triggers permission dialog |
| `ask-question` | Triggers question dialog |
| `error` | Creates error message, stops streaming |

### Task Plan Detection

When `activity-bash` events contain specific commands:
- `task plan` → Parses newline-separated tasks into `TaskPlanItem[]`
- `completed` → Marks all tasks as done
- `task budget exhausted` → Marks pending/running tasks as failed

### Safety Timeout

A 5-minute safety timer prevents infinite streaming. If streaming doesn't complete within 5 minutes, it's forcibly stopped.

### Version System

- **Save:** Creates a `ChatVersion` snapshot with messages, label, and parent chain
- **Restore:** Replaces current messages with version's messages (with undo/confirm workflow)
- **Cap:** Maximum 50 versions per session

### Context Compaction

When context pressure exceeds 85%:
1. Computes context stats (token estimation)
2. Selects messages to compact (protects first user message, last N user turns, messages with file changes/todos)
3. Prunes old tool outputs if needed
4. Calls LLM to generate structured summary (Goal/Instructions/Discoveries/Accomplished)
5. Stores compaction summary for future sessions

---

## 12. Tool System (XML Parsing & Execution)

### Tool Call Parsing

The `parseToolCalls()` function uses regex to extract tool calls from LLM text output. Supported tools:

| Tool | Format | Description |
|---|---|---|
| `read_file` | `<read_file path="..." />` | Read file contents |
| `write_file` | `<write_file path="...">content</write_file>` | Write file (creates diff proposal) |
| `edit_file` | `<edit_file path="..."><search>...</search><replace>...</replace></edit_file>` | Search & replace edit |
| `list_dir` | `<list_dir path="..." />` | List directory |
| `grep_file` | `<grep_file path="..." pattern="..." />` | Search within file |
| `search_files` | `<search_files pattern="..." glob="..." />` | Search across files |
| `run_command` | `<run_command command="..." />` | Execute shell command |
| `git_status` | `<git_status />` | Git status |
| `git_commit` | `<git_commit message="..." />` | Git commit |
| `git_log` | `<git_log />` | Git log |
| `clipboard_read/write` | `<clipboard_read />` / `<clipboard_write>text</clipboard_write>` | Clipboard operations |
| `notify` | `<notify title="..." body="..." />` | Desktop notification |
| `system_info` | `<system_info />` | System information |
| `open_url` | `<open_url url="..." />` | Open URL in browser |
| `launch_app` | `<launch_app name="..." />` | Launch desktop app |
| `reveal_in_finder` | `<reveal_in_finder path="..." />` | Open in file manager |
| `memory_*` | Various | Memory save/search/delete/stats/maintain/extract/export/import |
| `mcp_*` | `<mcp_servername_toolname />` | MCP server tool calls |

### Tool Execution

`executeTool()` handles each tool:

- **File operations** — Creates diff proposals (not direct writes) for `write_file` and `edit_file`
- **Shell commands** — 60-second timeout, output truncation at 50KB
- **File search** — Recursive directory walk with glob matching, binary file skipping
- **Memory operations** — Delegates to `memoryStore.ts`
- **MCP tools** — Parses server name from tag, routes to correct MCP server

### Diff Proposal Workflow

1. `write_file`/`edit_file` creates a `DiffProposal` with old/new content and hunks
2. Proposal is stored in `pendingDiffProposals` map
3. `diff-proposed` event is emitted to UI
4. User sees diff in the diff viewer
5. User approves → `approveDiff()` writes the file
6. User rejects → `rejectDiff()` discards the proposal

### Tool Approval

Tools requiring permission go through `waitForToolApproval()`:
- Polls `useChat.pendingToolCalls` for status changes
- 5-minute timeout
- Returns `"approved"` or `"denied"`

---

## 13. Memory System

### Architecture

**Git-first Markdown / SQLite-Cache Hybrid:**
- **Source of truth:** Markdown files in `.dalam/memories/*.md` (git-friendly, human-readable)
- **Search cache:** SQLite via `@tauri-apps/plugin-sql` with FTS5 (fast keyword search)
- **Rebuild:** SQLite is rebuilt from markdown if lost

### Database Schema

```sql
CREATE TABLE memories (
  id            TEXT PRIMARY KEY,
  category      TEXT NOT NULL,        -- user|feedback|project|reference|task|decision
  tier          TEXT NOT NULL,        -- critical|high|medium|low
  content       TEXT NOT NULL,
  summary       TEXT NOT NULL,        -- ≤150 chars pointer
  tags          TEXT NOT NULL,        -- JSON array
  source_session TEXT,
  source_file   TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  access_count  INTEGER DEFAULT 0,
  last_accessed INTEGER DEFAULT 0,
  verified      INTEGER DEFAULT 0,
  stale         INTEGER DEFAULT 0
);

CREATE VIRTUAL TABLE memories_fts USING fts5(
  id UNINDEXED, content, summary, tags,
  category UNINDEXED,
  content='memories', content_rowid='rowid'
);
```

### Memory Operations

| Operation | Description |
|---|---|
| `saveMemory()` | Mem0-inspired ADD/UPDATE/NOOP conflict resolution via Jaccard similarity |
| `searchMemories()` | FTS5 BM25 ranking with fallback to LIKE |
| `getCriticalMemories()` | Always-inject critical tier entries |
| `markStale()` | Soft delete |
| `purgeStale()` | Hard delete |
| `getMemoryStats()` | Aggregate counts by category/tier |
| `exportMemories()` | Write all as markdown for git |
| `importMemories()` | Parse markdown → rebuild SQLite |
| `updateMemoryIndex()` | Regenerate MEMORY.md pointer file (≤200 lines) |
| `runMaintenance()` | Full self-improving maintenance cycle |

### Memory Scoring

`scoreMemory()` computes a composite quality score:
- **Tier weight:** critical=4, high=3, medium=2, low=1 (×10)
- **Access frequency:** log-scaled bonus
- **Recency:** exponential decay (half-life 14 days)
- **Age penalty:** for never-accessed memories >7 days old
- **Verified bonus:** +5

### Memory Extraction

Two extraction methods:
1. **Heuristic** — Pattern matching for rules ("always", "never"), file paths, build commands, tech stack decisions
2. **LLM-powered** — Sends exchange to model, parses structured JSON response

### Auto-Maintenance

Runs every N sessions (configurable):
1. Detects stale memories (not accessed >30 days for low/medium, never accessed >14 days for low)
2. Enforces budget (500 max active memories)
3. Purges stale entries

---

## 14. Skill System

### Skill Format

Skills are markdown files with YAML frontmatter:

```markdown
---
name: my-skill
description: A short tagline
---

Detailed prompt content that gets injected when the skill is invoked.
```

### Skill Sources (Priority Order)

1. **Project** — `.dalam/skills/*/SKILL.md` (highest priority, always enabled)
2. **Bundled** — Shipped with Dalam (9 built-in skills)
3. **User** — Added via UI (localStorage)

### Bundled Skills

| Skill | Description |
|---|---|
| `accessibility-compliance` | WCAG 2.1 AA audit |
| `refactor` | Readability & maintainability suggestions |
| `explain` | Plain English code explanation |
| `test-writer` | Unit test generation |
| `code-review` | Diff review for correctness & style |
| `docs-writer` | API documentation |
| `perf-audit` | Performance profiling & optimization |
| `debug` | Bug investigation workflow |
| `plan` | Implementation plan creation |

### Skill Invocation

- **Explicit:** `$skill-name args` syntax in chat prompt
- **Implicit:** Skill name appears as whole word in prompt

### Skill Registry

- Singleton `SkillRegistry` class with CRUD operations
- Supports backup/restore (up to 10 backups per skill)
- Listeners for UI reactivity
- Project skills override bundled skills with same name

---

## 15. Gene System (Self-Evolution)

**File:** `apps/desktop/src/renderer/lib/genes.ts`

Inspired by Evolver's GEP (Gene Expression Protocol):

### Gene Lifecycle

1. **OBSERVE** — Agent notices a pattern in its behavior
2. **CANDIDATE** — Pattern is promoted to a candidate gene
3. **VALIDATE** — Gene is tested against historical sessions
4. **SOLIDIFY** — Gene is committed to the gene pool
5. **EXPRESS** — Gene influences future agent decisions

### Gene Structure

```typescript
interface Gene {
  id: string;
  name: string;
  description: string;
  trigger: string;           // Regex or keyword
  action: string;            // Prompt template or tool call
  category: "strategy" | "tool_use" | "error_recovery" | "optimization" | "pattern";
  confidence: number;        // 0-1
  activationCount: number;
  successCount: number;
  source: "session" | "reflection" | "manual";
  tags: string[];
}
```

### Reflection Engine

`reflectOnSession()` analyzes session history for:
- **Tool error patterns** → Creates recovery genes
- **File edit patterns** → Creates optimization genes (batching)
- **Repeated user phrases** → Creates strategy genes (proactive)
- **Successful tool patterns** → Creates positive reinforcement genes

### Gene Expression

`expressGenes()` matches genes against prompt + recent messages:
- Top 3 matches by confidence
- Tracks activation for matched genes (debounced save)

### Evolution

`evolveGenes()`:
- Boosts confidence of successful genes (>70% success rate, >5 activations)
- Reduces confidence of unused genes (>30 days)
- Removes very low confidence genes

### Pool Management

- Max 50 genes (evicts lowest confidence/oldest)
- Deduplication by name or trigger
- Stored in localStorage

---

## 16. Dream Agent (Memory Consolidation)

**File:** `apps/desktop/src/renderer/lib/dreamAgent.ts`

Runs asynchronously during idle times or workspace startup:

### Dream Cycle Steps

1. **Purge stale memories** — Hard delete already-flagged entries
2. **Validate file references** — Mark memories with missing source files as stale
3. **Relative date adjustments** — LLM rewrites "yesterday", "recently" → absolute dates
4. **Deduplication** — Jaccard similarity >0.40 triggers LLM merge
5. **Skill consolidation** — Merges redundant workspace skills (similarity >0.45)
6. **Update MEMORY.md** — Regenerates pointer file

### Trigger Conditions

- ≥24 hours since last dream cycle
- ≥5 new sessions
- Runs in background with 5s deferral
- Cancellable per workspace

---

## 17. Skill Crystallizer

**File:** `apps/desktop/src/renderer/lib/skillCrystallizer.ts`

Automatically creates reusable skills from complex sessions:

### Process

1. **Gatekeeper:** Only crystallizes if ≥5 tool outputs executed (or manually forced)
2. **LLM Analysis:** Sends session transcript to model asking for reusable workflow
3. **Proposal:** If workflow found, generates SKILL.md with YAML frontmatter
4. **User Approval:** Toast notification with Approve/Reject buttons
5. **Registration:** On approval, writes to `.dalam/skills/` and refreshes registry

---

## 18. Context Manager

**File:** `apps/desktop/src/renderer/lib/contextManager.ts`

### Token Estimation

- English text: ~4 chars per token
- Code: ~3.5 chars per token
- CJK: ~1.5 chars per token
- Whitespace: ~1 token per space/newline

### Context Pressure Levels

| Pressure | Usage | Action |
|---|---|---|
| none | <50% | No action |
| low | 50-70% | Monitor |
| medium | 70-85% | Consider pruning |
| high | >85% | Force compaction |

### Compaction Strategy

1. Protect: first user message, last N user turns, messages with file changes/todos
2. Compact tool results first (usually largest)
3. Then older assistant messages
4. Keep recent assistant messages

### Tool Output Pruning

Backward-scan algorithm:
- Protects recent user turns (last 2)
- Prunes old tool outputs when total tool tokens exceed 10K
- Minimum 5K tokens to reclaim before pruning

---

## 19. Hook Event Bus

**File:** `apps/desktop/src/renderer/lib/hookBus.ts`

A typed event bus for lifecycle events:

### Events

| Event | Payload | When |
|---|---|---|
| `SessionStart` | sessionId, workspacePath, model, agentName, mode | New session created |
| `UserPromptSubmit` | sessionId, prompt, conversationHistory, agentName, attachments | User sends message |
| `PostToolUse` | sessionId, toolName, toolArgs, result, error?, durationMs | Tool executed |
| `Stop` | sessionId, fullContent, messageCount, toolCallsExecuted | LLM turn ends |
| `SessionEnd` | sessionId, reason, messageCount, durationMs | Session closed/aborted |

### Features

- Sequential handler execution (not parallel)
- Error catching with logging (never throws)
- Execution log (last 100 entries)
- Handler snapshot during emit (safe against mid-iteration modification)

---

## 20. Hook Listeners

**File:** `apps/desktop/src/renderer/lib/hookListeners.ts`

Registered at startup, handles:

1. **Tool Usage Stats** — Tracks call counts, error rates, per-tool timing
2. **Session End** — Persists session summary to `.dalam/session-history.json`, auto-extracts memories (heuristic + LLM), runs periodic maintenance, triggers skill crystallization, runs gene reflection
3. **Prompt Analytics** — (Placeholder for future telemetry)
4. **Session Start** — (Placeholder for future tracking)
5. **Stop** — Logs turn completion stats

---

## 21. Agent Evolution

**File:** `apps/desktop/src/renderer/lib/agentEvolution.ts`

Self-reproducing agent system with population control:

### Population Rules

- Max 15 agents total (5 primary + 10 sub-agents)
- Reproduction only when population <12
- Auto-archive agents unused for 7+ days
- Self-destruct archived agents after 30 days

### Reproduction

- Parent must be mature (≥5 sessions, ≥0.5 confidence)
- Child inherits parent permissions
- Child starts with 0.3 confidence

---

## 22. Diff Engine

**File:** `apps/desktop/src/renderer/lib/diff.ts`

### Algorithms

1. **Myers' Diff** — O(ND) where D is edit distance. Used for most files.
2. **Patience Diff** — Better for files with many identical lines. Uses unique lines as anchors.
3. **Simple Fallback** — For files with >50K total lines.

### Features

- Context lines around hunks (default 3)
- Adjacent hunk merging
- Line number tracking
- Addition/deletion counting

---

## 23. Instructions System

**File:** `apps/desktop/src/renderer/lib/instructions.ts`

### 4-Layer Hierarchy

| Layer | Path | Priority |
|---|---|---|
| Global | `~/.dalam/DALAM.md` | Lowest |
| Org | `<workspace>/.dalam/org/DALAM.md` | ↑ |
| Project | `<workspace>/DALAM.md` | ↑ |
| Local | `<workspace>/.dalam/local/DALAM.md` | Highest |

### Legacy Fallback

If no project `DALAM.md` exists, checks:
1. `.cursorrules`
2. `.agentrules`
3. `.dalam/rules.md`

### Path-Scoped Rules

```markdown
@path: src/components/*.tsx
- Use functional components with hooks
- Name files PascalCase

@path: *.test.ts
- Always use vitest
- Mock external dependencies
```

### Glob Matching

Supports: `*`, `**`, `?`, `{a,b}` brace expansion. Rules without `/` match any directory.

---

## 24. Path Utilities

**File:** `apps/desktop/src/renderer/lib/pathUtils.ts`

Cross-platform path helpers that accept both `/` and `\` separators and emit `/` consistently:

| Function | Description |
|---|---|
| `toPosix()` | Convert to forward slashes |
| `splitPath()` | Split into segments |
| `basename()` | Last segment |
| `dirname()` | Parent path (handles Windows drive letters) |
| `joinPath()` | Join segments (resolves `.` and `..`) |
| `shortPath()` | Truncate for display (e.g., `…/src/components/App.tsx`) |
| `pathsEqual()` | Case-insensitive comparison |

---

## 25. Memory Graph Visualization

**File:** `apps/desktop/src/renderer/lib/memoryGraph.ts`

### Graph Structure

- **Nodes:** memories, agents, skills, genes, projects, tools
- **Edges:** created_by, uses, related_to, depends_on, evolved_from
- **Weights:** Based on tag overlap, temporal proximity, co-occurrence

### Force Layout

- **Barnes-Hut quadtree** for O(N log N) repulsion
- Spiral seed positions for better convergence
- Quadratic cooling schedule
- Edge attraction with weight scaling
- Center gravity

### Statistics

- Degree centrality
- Clustering coefficients
- Connected components (union-find)
- BFS shortest path
- Graph density
- Diameter estimation (BFS sampling)

### Operations

- `pruneWeakEdges()` — Remove edges below threshold
- `exportGraph()` / `importGraph()` — JSON serialization
- `hitTest()` — Canvas coordinate → node lookup

---

## 26. Platform Utilities

**File:** `apps/desktop/src/renderer/lib/platform.ts`

Detects OS platform and provides keyboard shortcut helpers:

| Function | Description |
|---|---|
| `platform()` | Returns `"mac"`, `"win"`, `"linux"`, or `"other"` |
| `modKey()` | Returns `"⌘"` on macOS, `"Ctrl"` elsewhere |
| `shortcut(key, opts)` | Renders shortcut string (e.g., `"⌘K"` or `"Ctrl K"`) |

---

## 27. UI Components

### Sidebar (`components/sidebar/`)
- **FileTree.tsx** — Hierarchical file system view with git status indicators
- **Sidebar.tsx** — Main sidebar container with workspace/session list

### Editor (`components/editor/`)
- **Editor.tsx** — Monaco editor integration with language detection
- **EditorPane.tsx** — Tab management, file open/close/switch
- **TopNav.tsx** — Top navigation bar
- **Breadcrumb.tsx** — File path breadcrumb
- **PromptAutocomplete.tsx** — Autocomplete for chat input

### Right Panel (`components/rightpanel/`)
- **RightPanel.tsx** — Chat interface, activity feed, task plan, terminal

### Terminal (`components/terminal/`)
- **TerminalPanel.tsx** — xterm.js integration with Tauri shell

### Settings (`components/settings/`)
- **SettingsModal.tsx** — Full settings UI (theme, model, provider, etc.)
- **MemoryGraph.tsx** — Interactive knowledge graph visualization

### Permissions (`components/permissions/`)
- **PermissionDialog.tsx** — Tool approval dialog
- **QuestionDialog.tsx** — Agent question dialog

### UI Primitives (`components/ui/`)
- **Toaster.tsx** — Toast notification system
- **ContextMenu.tsx** — Right-click context menus
- **ErrorBoundary.tsx** — React error boundary
- **ShortcutsCheatsheet.tsx** — Keyboard shortcuts overlay

### Shell (`components/shell/`)
- **TitleBar.tsx** — Custom title bar
- **StatusBar.tsx** — Bottom status bar
- **Menubar.tsx** — Application menu

### Onboarding (`components/onboarding/`)
- **WelcomeScreen.tsx** — First-run welcome screen

### Palette (`components/palette/`)
- **CommandPalette.tsx** — Cmd+K command palette (using cmdk)

### Chat (`components/chat/`)
- **ActivityBlocks.tsx** — Real-time activity visualization

---

## 28. Theming & Styling

### CSS Custom Properties

The app uses CSS custom properties for theming, defined in `index.css`:

**Dark Theme (default):**
- Surfaces: `#1e1e1e` → `#444444`
- Text: `#ededed` → `#4a4a4a`
- Accent: `#4f8ef7`
- Git: modified `#e2c08d`, added `#73c991`, deleted `#f06c6c`

**Light Theme:**
- Surfaces: `#ffffff` → `#e0e0e0`
- Text: `#1a1a1a` → `#b0b0b0`
- Accent: `#2563eb`

### Tailwind Config

Custom `dalam` color palette, custom fonts (JetBrains Mono, Inter), custom animations (pulse-soft, fade-in, slide-up).

### Component Classes

- `.glass` — Backdrop blur overlay
- `.panel-resizer` — Panel resize handles
- `.skeleton` — Loading skeleton
- `.btn-icon` — Icon button with hover/active states
- `.input-base` — Styled input
- `.chip` — Small label chip
- `.menu-item` — Menu item
- `.surface` — Card surface
- `.prose-dalam` — Markdown prose styles

---

## 29. Testing

### Test Files

| File | Tests |
|---|---|
| `dalamTools.test.ts` | XML tool call parsing (30+ tests) |
| `contextManager.test.ts` | Token estimation, pressure, compaction, pruning |
| `genes.test.ts` | Gene pool CRUD, expression, reflection, solidification, evolution |
| `agents.test.ts` | Permission rules, agent definitions, bash canonicalization |
| `skills.test.ts` | Frontmatter parsing, skill registry, invocation matching |
| `diff.test.ts` | Myers' diff, edge cases, hunks, large files, patience diff |
| `memoryGraph.test.ts` | Graph building, hit testing |
| `memoryStore.test.ts` | Jaccard similarity, scoring, extraction, parsing |
| `instructions.test.ts` | Glob matching, path-scoped rules, layer loading |
| `pathUtils.test.ts` | Path manipulation (cross-platform) |

### Test Framework

- **Vitest 4** with default config
- Run: `pnpm test` or `pnpm test:watch`

---

## 30. Task Management Response Format

The task management system uses a structured format throughout the codebase:

### Task Plan Items

```typescript
type TaskPlanItem = {
  id: string;           // Unique identifier (e.g., "T1", "T2")
  title: string;        // Human-readable description
  status: "pending" | "running" | "done" | "failed";
};
```

### Todo Items

```typescript
type TodoItem = {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed" | "failed";
};
```

### Task Plan Detection in Streaming

When the agent outputs `activity-bash` events with specific commands:

1. **`task plan`** — Agent signals the start of a task plan. The result text is parsed:
   ```
   T1: Set up project structure
   T2: Implement authentication
   T3: Add tests
   ```
   Each line becomes a `TaskPlanItem` with status `"pending"`.

2. **`completed`** — All tasks marked as `"done"`.

3. **`task budget exhausted`** — Remaining tasks marked as `"failed"`.

### Plan Mode Workflow

1. User sends message in Plan mode
2. Agent produces a plan (read-only analysis)
3. Agent outputs `[PLAN_COMPLETE]` marker
4. `planApproval` state is set with the plan content
5. UI shows Approve/Reject buttons
6. **Approve:** Switches to Build mode, sends plan as execution instruction
7. **Reject:** Saves version checkpoint, stays in Plan mode for replanning

### Chat Message Structure

```typescript
type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  timestamp: number;
  parentID?: string;           // Groups assistant response with user message
  toolCalls?: ToolCall[];      // Executed tools
  thinking?: string;           // Model reasoning
  fileChanges?: FileChange[];  // Files modified
  todos?: TodoItem[];          // Task checklist
  activities?: PendingActivity[];  // Real-time activity feed
  taskPlan?: TaskPlanItem[];   // Task plan
  taskPlanSummary?: string;    // Completion summary
  attachments?: FileAttachment[];  // User-attached files
};
```

### Session Summary

```typescript
type ChatSessionSummary = {
  id: string;
  workspacePath: string;
  workspaceName: string;
  title: string;              // Auto-generated from first message
  agentName: string;          // build|plan|yolo
  mode: AgentSessionMode;
  model?: string;
  startedAt: number;
  lastActivityAt: number;
  messageCount: number;
  status: "idle" | "running" | "completed" | "aborted" | "error";
  preview?: string;           // First 60 chars of last user message
  versionCount: number;
};
```

---

## 31. Data Flow — Complete Lifecycle

This section traces the **end-to-end flow** from user input to persistence, showing how every system interconnects.

### 31.1 Overview Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         USER INPUT PHASE                                    │
│                                                                             │
│  User types message ──→ useChat.sendMessage()                              │
│       │                                                                     │
│       ├──→ Auto-select agent (autoSelectAgent)                             │
│       ├──→ Match skill invocation ($skill-name)                            │
│       ├──→ Create user ChatMessage                                          │
│       └──→ Save version checkpoint                                         │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                       SESSION PHASE                                          │
│                                                                             │
│  startSession() (if needed)                                                │
│       │                                                                     │
│       ├──→ api.agent.startSession({workspacePath, model, mode})            │
│       ├──→ hookBus.emit('SessionStart')                                    │
│       ├──→ Register stream listener (onStreamEvent)                        │
│       └──→ Create ChatSessionSummary                                       │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                    SYSTEM PROMPT ASSEMBLY                                    │
│                                                                             │
│  assembleContext(cleanPrompt) builds the system prompt from:                │
│       │                                                                     │
│       ├──→ Agent system prompt (build/plan/yolo mode)                      │
│       ├──→ Workspace memory (.dalam/memory.json)                           │
│       ├──→ SQLite memories (FTS5 search + critical tier)                   │
│       ├──→ 4-layer instructions (DALAM.md hierarchy)                       │
│       ├──→ Tool documentation (23+ tools)                                  │
│       ├──→ Active skill prompt (if matched)                                │
│       ├──→ MCP tools documentation (connected servers)                     │
│       ├──→ Active editor file context                                      │
│       ├──→ Pinned files (.dalam/context.json)                              │
│       └──→ Gene strategies (expressed genes)                               │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                       LLM STREAMING PHASE                                   │
│                                                                             │
│  api.agent.sendPrompt() enters agentic loop (max 30 iterations)            │
│       │                                                                     │
│       ├──→ streamChat() ──→ streamOpenAI() or streamAnthropic()            │
│       │       │                                                             │
│       │       ├──→ SSE parsing (parseSSEEvents)                            │
│       │       ├──→ yield {type:'message-delta', content}                   │
│       │       └──→ yield {type:'activity-think', content}                  │
│       │                                                                     │
│       ├──→ emit('message-start')                                           │
│       ├──→ emit('message-delta') ──→ appendStream() ──→ UI update          │
│       └──→ emit('message-end') or continue loop                           │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                    TOOL PARSING PHASE                                        │
│                                                                             │
│  Response content scanned for XML tool tags:                               │
│       │                                                                     │
│       ├──→ parseToolCalls(text) — regex extraction                        │
│       │       ├──→ <read_file path="..." />                                │
│       │       ├──→ <write_file path="...">content</write_file>            │
│       │       ├──→ <edit_file path="..."><search>...</search>...</edit>  │
│       │       ├──→ <run_command command="..." />                           │
│       │       ├──→ <memory_save>...</memory_save>                          │
│       │       └──→ <mcp_server_tool />                                     │
│       │                                                                     │
│       └──→ emit({type:'tool-call', toolCall}) per parsed tool             │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                    PERMISSION EVALUATION                                     │
│                                                                             │
│  For each tool call:                                                       │
│       │                                                                     │
│       ├──→ canonicaliseBashCommand(command) for bash tools                │
│       ├──→ Map to permission key (edit/bash/read/mcp)                     │
│       ├──→ evaluate(agentRules + userRules, permission, pattern)           │
│       │       ├──→ exact match → action                                   │
│       │       ├──→ permission wildcard → action                           │
│       │       ├──→ global wildcard → action                               │
│       │       └──→ default → "ask"                                        │
│       │                                                                     │
│       ├──→ "allow" → auto-approve                                        │
│       ├──→ "deny" → mark as failed, skip execution                       │
│       └──→ "ask" → usePermission.ask() → PermissionDialog → user decides │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                    TOOL EXECUTION PHASE                                      │
│                                                                             │
│  executeTool(name, args, workspacePath) for approved tools:                │
│       │                                                                     │
│       ├──→ read_file: readFile() → return text                            │
│       ├──→ write_file: create DiffProposal → emit('diff-proposed')         │
│       ├──→ edit_file: create DiffProposal → emit('diff-proposed')         │
│       ├──→ list_dir: readDirRecursive() → return JSON                     │
│       ├──→ grep_file: readFile() → regex match → return lines             │
│       ├──→ search_files: recursive dir walk → grep → return matches       │
│       ├──→ run_command: Command.create() → spawn → collect output         │
│       ├──→ git_*: invoke('git_*') → Rust backend                         │
│       ├──→ memory_*: memoryStore.*() → SQLite FTS5                        │
│       ├──→ clipboard_*: invoke('clipboard_*')                             │
│       ├──→ notify: invoke('notify')                                       │
│       ├──→ open_url/launch_app/reveal_in_finder: shell/invokes           │
│       └──→ mcp_*: fetch MCP server via HTTP/stdio                        │
│                                                                             │
│  Results emitted:                                                          │
│       ├──→ emit({type:'tool-result', toolCallId, result})                 │
│       ├──→ emit({type:'file-changed', change}) if file modified           │
│       └──→ hookBus.emit('PostToolUse')                                    │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                    DIFF APPROVAL PHASE                                       │
│                                                                             │
│  For write_file/edit_file proposals:                                        │
│       │                                                                     │
│       ├──→ DiffProposal stored in pendingDiffProposals map                │
│       ├──→ User sees diff in DiffViewer component                         │
│       │                                                                     │
│       ├──→ User APPROVES:                                                 │
│       │       ├──→ api.agent.approveDiff(sessionId, diffId)              │
│       │       ├──→ writeFile(path, newContent)                            │
│       │       └──→ emit({type:'file-changed', change})                    │
│       │                                                                     │
│       └──→ User REJECTS:                                                  │
│               ├──→ api.agent.rejectDiff(sessionId, diffId)               │
│               └──→ Proposal discarded                                     │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                    RESULTS → NEXT TURN                                       │
│                                                                             │
│  Tool results pushed as user message:                                      │
│       │                                                                     │
│       ├──→ currentHistory.push({role:'user', content: toolResults.join()})│
│       ├──→ emit('message-end') — current turn done                         │
│       ├──→ continue loop → next LLM turn (with tool results in context)   │
│       │                                                                     │
│       └──→ If no tools parsed: loop exits, turn complete                  │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                    CONTEXT UPDATE PHASE                                      │
│                                                                             │
│  After turn completes:                                                     │
│       │                                                                     │
│       ├──→ appendStream('message-end')                                     │
│       │       ├──→ Parse any remaining XML tools                           │
│       │       ├──→ Create final ChatMessage with toolCalls, fileChanges    │
│       │       ├──→ Add to messages[] and sessionMessages[sessionId]       │
│       │       ├──→ Update chatSessions status → 'completed'               │
│       │       └──→ Clear streaming/thinking/pending state                 │
│       │                                                                     │
│       ├──→ Context pressure check (computeContextStats)                   │
│       │       ├──→ <85%: no action                                        │
│       │       ├──→ ≥85%: compactSessionHistory() triggers                │
│       │       │       ├──→ selectMessagesForCompaction()                  │
│       │       │       ├──→ pruneToolOutputs() if needed                  │
│       │       │       └──→ LLM summarize → store compactionSummary       │
│       │       └──→ High pressure: force compaction                       │
│       │                                                                     │
│       └──→ hookBus.emit('Stop', {fullContent, toolCallsExecuted})        │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                    PERSISTENCE PHASE                                         │
│                                                                             │
│  Multiple persistence layers run:                                          │
│       │                                                                     │
│       ├──→ localStorage (debounced 100ms via saveWorkspaceData):          │
│       │       ├──→ dalam.chatSessions.v1 — session summaries              │
│       │       ├──→ dalam.sessionMessages.v1 — all messages                │
│       │       ├──→ dalam.sessionVersions.v1 — version checkpoints        │
│       │       ├──→ dalam.sessionAgents.v1 — agent per session            │
│       │       └──→ dalam.compactionSummaries.v1 — compacted history      │
│       │                                                                     │
│       ├──→ .dalam/ directory (workspace-level):                           │
│       │       ├──→ .dalam/sessions.json — same data as localStorage      │
│       │       ├──→ .dalam/config.json — providers, MCP, alwaysAllowed    │
│       │       ├──→ .dalam/memory.json — workspace memory                  │
│       │       ├──→ .dalam/context.json — pinned files, ignore patterns   │
│       │       └──→ .dalam/memories/*.md — memory entries (source of truth)│
│       │                                                                     │
│       └──→ SQLite (project.db):                                          │
│               ├──→ memories table — all memory entries                    │
│               ├──→ memories_fts — FTS5 search index                      │
│               └──→ triggers — keep FTS5 in sync                          │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                    POST-SESSION HOOKS                                        │
│                                                                             │
│  hookBus.emit('SessionEnd') triggers:                                      │
│       │                                                                     │
│       ├──→ hookListeners: Persist session summary to                      │
│       │       .dalam/session-history.json                                  │
│       │                                                                     │
│       ├──→ hookListeners: Auto-extract memories                           │
│       │       ├──→ Heuristic extraction (pattern matching)                │
│       │       ├──→ LLM extraction (if heuristic finds nothing)            │
│       │       └──→ saveMemory() → SQLite + markdown                       │
│       │                                                                     │
│       ├──→ hookListeners: Periodic maintenance (every N sessions)         │
│       │       ├──→ autoMarkStale() — detect stale memories               │
│       │       ├──→ enforceMemoryBudget() — keep under 500                │
│       │       └──→ purgeStale() — hard delete                             │
│       │                                                                     │
│       ├──→ hookListeners: Skill crystallization                           │
│       │       ├──→ proposeSkillFromSession() (if ≥5 tool outputs)        │
│       │       └──→ LLM analysis → SKILL.md proposal → user approval      │
│       │                                                                     │
│       ├──→ hookListeners: Gene reflection                                 │
│       │       ├──→ reflectOnSession() — detect patterns                  │
│       │       ├──→ addGene() — create recovery/optimization genes        │
│       │       └──→ evolveGenes() — boost successful, prune stale        │
│       │                                                                     │
│       └──→ Dream Agent (triggered on next workspace load if ≥24h):       │
│               ├──→ Purge stale memories                                   │
│               ├──→ Validate file references                               │
│               ├──→ LLM date adjustments                                   │
│               ├──→ Deduplicate similar memories (Jaccard >0.40)          │
│               ├──→ Consolidate redundant skills                           │
│               └──→ Update MEMORY.md index                                │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 31.2 Detailed Step-by-Step Flow

#### Step 1: User Input

```
User types "Refactor the auth module" in chat input
    │
    ▼
useChat.sendMessage(content)
    │
    ├──→ autoSelectAgent("Refactor the auth module", "build")
    │       Checks: plan keywords? → no
    │       Checks: dangerous commands? → no
    │       Checks: simple patterns? → no
    │       Returns: "build" (keep current)
    │
    ├──→ skill matching: matchSkillInvocation()
    │       Checks $refactor prefix → not found
    │       Checks word "refactor" in prompt → matches "refactor" skill
    │       Returns: {skill: refactor, args: "the auth module"}
    │
    ├──→ Create user ChatMessage with id, content, timestamp
    │
    ├──→ saveVersion(sessionId, "Refactor the auth module")
    │
    └──→ Start streaming: api.agent.sendPrompt()
```

#### Step 2: System Prompt Assembly

```
assembleContext("Refactor the auth module")
    │
    ├──→ Agent prompt: "You are Dalam, an AI coding assistant..."
    │
    ├──→ Workspace memory: load .dalam/memory.json
    │       → "Project uses Express + TypeScript, auth uses JWT..."
    │
    ├──→ SQLite memories: searchMemories("auth refactor")
    │       → [critical] "Auth uses bcrypt for password hashing"
    │       → [high] "JWT tokens expire after 24h"
    │
    ├──→ Instructions: loadInstructions(workspacePath)
    │       → DALAM.md: "Always use functional components"
    │       → @path: src/auth/*.ts: "Use dependency injection"
    │
    ├──→ Tool docs: 23+ tools documented (read_file, edit_file, etc.)
    │
    ├──→ Skill prompt: renderSkillForPrompt(refactor skill)
    │       → "Analyze the selected code and propose refactors..."
    │
    ├──→ MCP tools: (none connected)
    │
    ├──→ Active file: /workspace/src/auth/jwt.ts (open in editor)
    │
    └──→ Genes: expressGenes(pool, "refactor", recentMessages)
            → [optimization] "batch-file-operations" gene matched
```

#### Step 3: LLM Streaming

```
streamChat(baseUrl, apiKey, "openai", model, messages, signal)
    │
    ├──→ POST /chat/completions {stream: true}
    │
    ├──→ SSE chunks arrive:
    │       {delta: {content: "I'll analyze the auth module..."}}
    │       → emit({type: 'message-delta', content: "I'll analyze..."})
    │       → useChat.appendStream() → streamingContent += "I'll analyze..."
    │       → React re-renders with new text
    │
    │       {delta: {reasoning_content: "Looking at jwt.ts..."}}
    │       → emit({type: 'activity-think', content: "Looking at jwt.ts..."})
    │       → thinkingContent updated → thinking indicator shows
    │
    │       {delta: {content: "<read_file path='/workspace/src/auth/jwt.ts' />"}}
    │       → emit({type: 'message-delta', content: tool tag})
    │
    └──→ Stream ends → fullContent = complete response
```

#### Step 4: Tool Parsing

```
parseToolCalls(fullContent)
    │
    ├──→ Regex: /<read_file\s+path=["']([^"']+)["']\s*\/>/gi
    │   Match: <read_file path='/workspace/src/auth/jwt.ts' />
    │   Result: {name: 'read_file', args: {path: '/workspace/src/auth/jwt.ts'}}
    │
    └──→ emit({type: 'tool-call', toolCall: {id, name, args, status: 'pending'}})
```

#### Step 5: Permission Evaluation

```
Tool: read_file → permission key: "read"
evaluate(buildAgent.permission, "read", "read_file")
    │
    ├──→ Rule: {permission: "read", pattern: "*", action: "allow"}
    │   → MATCH → action = "allow"
    │
    └──→ Auto-approve (no dialog needed)
        → resolveToolApproval(toolId, "approved")
```

#### Step 6: Tool Execution

```
executeTool("read_file", {path: "/workspace/src/auth/jwt.ts"})
    │
    ├──→ readFile(path) via @tauri-apps/plugin-fs
    │   → Returns: "import jwt from 'jsonwebtoken';\n\nexport function verify..."
    │
    ├──→ emit({type: 'tool-result', toolCallId, result: fileContent})
    │
    ├──→ emit({type: 'activity-explore', query: path, kind: 'definition', ...})
    │
    └──→ hookBus.emit('PostToolUse', {toolName: 'read_file', durationMs: 42})
```

#### Step 7: Results → Next Turn

```
currentHistory.push({role: 'user', content: '[Tool result for read_file]\nimport jwt...'})
    │
    ├──→ emit('message-end') — current turn done
    │
    └──→ continue loop → buildMessages() includes tool result
        → Next LLM turn with file content in context
        → LLM produces edit_file tool call
        → ... (loop continues until no more tools)
```

#### Step 8: Final Turn (No Tools)

```
LLM response: "I've refactored the auth module. Here's what changed..."
    │
    ├──→ parseToolCalls() returns [] (no tools)
    │
    ├──→ appendStream('message-end'):
    │       ├──→ Create final ChatMessage with content, toolCalls, fileChanges
    │       ├──→ Add to messages[] and sessionMessages[sessionId]
    │       ├──→ Update session status → 'completed'
    │       └──→ Clear streaming state
    │
    └──→ hookBus.emit('Stop', {toolCallsExecuted: 3})
```

#### Step 9: Context Check & Compaction

```
compactSessionHistory(sessionId)
    │
    ├──→ computeContextStats(messages, maxContext)
    │       totalTokens: 45000, maxContext: 128000
    │       pressure: "none", needsCompaction: false
    │       → No compaction needed
    │
    └──→ (If pressure >85%: would trigger LLM summarization)
```

#### Step 10: Persistence

```
saveWorkspaceData() (debounced 100ms)
    │
    ├──→ localStorage.setItem('dalam.sessionMessages.v1', ...)
    ├──→ localStorage.setItem('dalam.chatSessions.v1', ...)
    │
    └──→ api.fs.writeFile('.dalam/sessions.json', ...)
        api.fs.writeFile('.dalam/config.json', ...)
```

#### Step 11: Post-Session Hooks

```
hookBus.emit('SessionEnd', {reason: 'completed', durationMs: 12500})
    │
    ├──→ onSessionEnd():
    │       ├──→ Persist to .dalam/session-history.json
    │       ├──→ Auto-extract memories from last exchange:
    │       │       extractMemoriesFromExchange() → heuristic finds:
    │       │       - "Refactored auth module" → project memory
    │       │       - "JWT uses bcrypt" → reference memory
    │       │       saveMemory() → SQLite + .dalam/memories/*.md
    │       ├──→ Skill crystallization: proposeSkillFromSession()
    │       │       toolsExecuted: 3 < 5 → SKIP (not complex enough)
    │       └──→ Gene reflection: reflectOnSession()
    │               No errors, clean session → minimal gene creation
    │
    └──→ (On next workspace load, if ≥24h: Dream Agent runs)
```

### 31.3 Data Flow Summary Table

| Phase | Entry Point | Key Functions | State Updated | Persisted To |
|---|---|---|---|---|
| User Input | `sendMessage()` | `autoSelectAgent`, `matchSkillInvocation` | `messages`, `isStreaming` | — |
| Session Start | `startSession()` | `api.agent.startSession`, `hookBus.emit` | `session`, `chatSessions` | localStorage |
| Prompt Assembly | `assembleContext()` | `loadGenePool`, `searchMemories`, `loadInstructions` | — (read only) | — |
| LLM Streaming | `streamChat()` | `streamOpenAI`/`streamAnthropic`, `parseSSEEvents` | `streamingContent`, `thinkingContent` | — |
| Tool Parsing | `parseToolCalls()` | regex extraction | `pendingToolCalls` | — |
| Permission | `evaluate()` | `canonicaliseBashCommand`, `evaluate` | `pendingToolCalls[].status` | — |
| Execution | `executeTool()` | `readFile`, `writeFile`, `Command.create` | `pendingToolCalls[].result` | — |
| Diff Approval | `approveDiff()` | `writeFile(path, newContent)` | `pendingToolCalls` | filesystem |
| Results | `appendStream()` | tool results as user message | `messages`, `sessionMessages` | — |
| Context Update | `appendStream('message-end')` | `computeContextStats`, `compactSessionHistory` | `compactionSummaries` | localStorage |
| Persistence | `saveWorkspaceData()` | `api.fs.writeFile`, `localStorage.setItem` | — | localStorage + `.dalam/` |
| Post-Session | `hookBus.emit('SessionEnd')` | `extractMemories`, `proposeSkillFromSession`, `reflectOnSession` | `memories`, `genes`, `skills` | SQLite + `.dalam/memories/*.md` |

### 31.4 Cross-System Interactions

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│   useChat    │────→│  dalamAPI    │────→│  Tauri IPC   │
│  (Store)     │     │  (Bridge)    │     │  (Rust)      │
└──────┬───────┘     └──────┬───────┘     └──────────────┘
       │                    │
       │                    ├────→ @tauri-apps/plugin-fs (file ops)
       │                    ├────→ @tauri-apps/plugin-shell (terminal)
       │                    ├────→ @tauri-apps/plugin-http (LLM API)
       │                    ├────→ @tauri-apps/plugin-sql (SQLite)
       │                    └────→ @tauri-apps/plugin-dialog (pickers)
       │
       ├────→ hookBus.emit() ──→ hookListeners
       │         │                    │
       │         │                    ├────→ memoryStore (save/search)
       │         │                    ├────→ skillCrystallizer (propose)
       │         │                    └────→ genes (reflect/add)
       │         │
       │         └────→ PostToolUse ──→ hookListeners (stats)
       │
       ├────→ useAgents (permission evaluation)
       │
       ├────→ usePermission (dialog state)
       │
       └────→ useWorkspace (file tree, tabs)

┌──────────────┐     ┌──────────────┐
│  memoryStore │────→│   SQLite     │
│  (CRUD)      │     │   FTS5       │
└──────┬───────┘     └──────────────┘
       │
       ├────→ .dalam/memories/*.md (source of truth)
       └────→ memoryGraph.ts (visualization)

┌──────────────┐     ┌──────────────┐
│  dreamAgent  │────→│  memoryStore │
│  (Background)│     │  (Purge/Merge│)
└──────────────┘     └──────────────┘
```

---

## 32. Workspace Initialization Flow

When a user opens or switches to a workspace, a multi-phase initialization sequence runs to set up memory, permissions, skills, configuration, sessions, and MCP servers. This section documents the complete flow.

### 32.1 Entry Points

Workspace initialization is triggered from:
1. **`openWorkspace()`** — User selects a new directory via file picker
2. **`loadWorkspace()`** — User loads an existing workspace
3. **`setActiveWorkspace(id)`** — User switches between previously opened workspaces
4. **`startSession()`** — Starts an agent session (calls `initWorkspaceMemory()` if workspace path is provided)

All paths converge into two core functions:
- `initWorkspaceMemory(api, workspacePath)` — Memory layer setup
- `loadWorkspaceConfigAndSessions(workspacePath)` — Configuration & session loading

### 32.2 `initWorkspaceMemory()` — Memory Layer Setup

```
initWorkspaceMemory(api, workspacePath)
    │
    ├──→ Step 1: Create .dalam/ directory
    │       Check: exists(joinPath(workspacePath, ".dalam"))
    │       If not: mkdir(".dalam")
    │
    ├──→ Step 2: Initialize SQLite database
    │       initDatabase(workspacePath)
    │       │
    │       ├──→ Load @tauri-apps/plugin-sql driver
    │       ├──→ Ensure .dalam/ directory exists
    │       ├──→ Open sqlite:<workspace>/.dalam/project.db
    │       ├──→ CREATE TABLE IF NOT EXISTS memories (...)
    │       ├──→ CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(...)
    │       ├──→ CREATE TRIGGER memories_ai (AFTER INSERT)
    │       ├──→ CREATE TRIGGER memories_ad (AFTER DELETE)
    │       ├──→ CREATE TRIGGER memories_au (AFTER UPDATE)
    │       ├──→ CREATE INDEX idx_mem_category
    │       ├──→ CREATE INDEX idx_mem_tier
    │       ├──→ CREATE INDEX idx_mem_stale
    │       └──→ CREATE INDEX idx_mem_accessed
    │
    ├──→ Step 3: Rebuild SQLite from markdown
    │       rebuildFromMarkdown(workspacePath)
    │       │
    │       ├──→ Read .dalam/memories/ directory
    │       ├──→ For each *.md file:
    │       │       ├──→ parseMarkdownMemory(content)
    │       │       │       ├──→ Extract YAML frontmatter (id, category, tier, tags, etc.)
    │       │       │       ├──→ Extract markdown body as content
    │       │       │       └──→ Return MemoryEntry object
    │       │       ├──→ SELECT id FROM memories WHERE id = ?
    │       │       ├──→ If exists: UPDATE memories SET ... WHERE id = ?
    │       │       └──→ If new: INSERT INTO memories (...)
    │       └──→ Return count of processed memories
    │
    ├──→ Step 4: Trigger dream cycle (background)
    │       triggerDreamCycleIfNeeded(workspacePath)
    │       │
    │       ├──→ Check localStorage: dalam.lastDreamTime.<workspacePath>
    │       ├──→ If last dream < 24 hours ago → return no-op
    │       ├──→ Cancel any existing pending dream
    │       ├──→ setTimeout(5000ms) — defers to not block startup
    │       └──→ runDreamCycle(workspacePath) in background:
    │               ├──→ Purge stale memories
    │               ├──→ Validate file references
    │               ├──→ LLM date adjustments
    │               ├──→ Deduplicate similar memories (Jaccard >0.40)
    │               ├──→ Consolidate redundant skills
    │               └──→ Update MEMORY.md index
    │
    └──→ Step 5: Create default memory.json (backward compat)
            Check: exists(".dalam/memory.json")
            If not: write default memory:
            {
              projectOverview: "An AI-native developer desktop environment.",
              keyFiles: [],
              buildCommands: ["npm run dev", "npm run build"],
              learnedRules: [
                "Always run build checks before declaring a task complete.",
                "Maintain typescript type safety.",
              ]
            }
```

### 32.3 `loadWorkspaceConfigAndSessions()` — Configuration & Sessions

After memory setup, this function loads all workspace-specific configuration. It includes a **concurrency guard** to prevent duplicate loads of the same workspace.

```
loadWorkspaceConfigAndSessions(workspacePath)
    │
    ├──→ Concurrency guard:
    │       If same workspace already loading → return existing promise
    │       If different workspace loading → start fresh
    │
    └──→ _doLoadWorkspaceConfigAndSessions(workspacePath)
            │
            ├──→ Step 1: Load always-allowed permissions from disk
            │       usePermission.getState().loadFromDisk()
            │       │
            │       ├──→ Read .dalam/config.json → extract alwaysAllowed field
            │       ├──→ Read localStorage: dalam.alwaysAllowed.v1
            │       └──→ Merge: disk + localStorage (localStorage overrides)
            │
            ├──→ Step 2: Load project-level skills
            │       loadProjectSkills(workspacePath, {listDir, readFile})
            │       │
            │       ├──→ List .dalam/skills/*/SKILL.md files
            │       ├──→ Parse YAML frontmatter (name, description)
            │       ├──→ Extract markdown body as skill content
            │       └──→ refreshProjectSkills(projectSkills)
            │
            ├──→ Step 3: Load configuration from .dalam/config.json
            │       │
            │       ├──→ If config.json EXISTS:
            │       │       ├──→ Merge project settings with current settings
            │       │       ├──→ Merge project providers with user providers
            │       │       ├──→ Merge project MCP servers with user MCP servers
            │       │       └──→ Auto-connect any enabled & disconnected servers
            │       │
            │       └──→ If config.json DOES NOT EXIST:
            │               ├──→ Create default config.json:
            │               │       { settings: {selectedModel, selectedProvider},
            │               │         providers: [], mcpServers: [] }
            │               └──→ Load user-scoped MCP servers from localStorage
            │
            ├──→ Step 4: Create default context.json (if missing)
            │       Default: { pinnedFiles: [],
            │                  ignorePatterns: ["node_modules", "dist", ".git", ".dalam"] }
            │
            └──→ Step 5: Load sessions from .dalam/sessions.json
                    │
                    ├──→ If sessions.json EXISTS:
                    │       ├──→ Parse JSON → chatSessions, sessionMessages,
                    │       │       sessionVersions, compactionSummaries
                    │       ├──→ Restore into useChat store
                    │       └──→ Load most recent session as active
                    │
                    └──→ If sessions.json DOES NOT EXIST:
                            ├──→ Create empty sessions.json:
                            │       { chatSessions: [], sessionMessages: {},
                            │         sessionVersions: {}, compactionSummaries: {} }
                            └──→ Clear useChat state
```

### 32.4 `.dalam/` Directory Structure

After initialization, the `.dalam/` directory contains:

```
.dalam/
├── project.db          # SQLite database (memory cache, gitignored)
├── config.json         # Project settings, providers, MCP servers, alwaysAllowed
├── sessions.json       # Chat sessions, messages, versions, compaction summaries
├── context.json        # Pinned files, ignore patterns
├── memory.json         # Workspace memory (backward compat, legacy)
├── memories/           # Memory entries as markdown files (git-friendly)
│   ├── mem_abc123.md
│   ├── mem_def456.md
│   └── ...
├── skills/             # Project-level skills
│   └── my-skill/
│       └── SKILL.md
└── session-history.json # Session summary archive (from hookListeners)
```

### 32.5 Database Schema Details

**`project.db`** is a local cache that can be rebuilt from markdown source files:

| Table | Type | Purpose |
|---|---|---|
| `memories` | B-tree | Main memory table with id, category, tier, content, summary, tags, timestamps |
| `memories_fts` | FTS5 | Full-text search index over content, summary, tags, category |

**Indexes:** `idx_mem_category`, `idx_mem_tier`, `idx_mem_stale`, `idx_mem_accessed`

**Triggers:**
- `memories_ai` — After INSERT: adds row to FTS5 index
- `memories_ad` — After DELETE: removes row from FTS5 index
- `memories_au` — After UPDATE: deletes old + inserts new in FTS5 index

### 32.6 Persistence Flow (`saveWorkspaceData()`)

All workspace data is saved via a **debounced** `saveWorkspaceData()` function (100ms debounce) to avoid excessive writes:

```
saveWorkspaceData()
    │
    ├──→ clearTimeout(previous timer)
    ├──→ setTimeout(100ms) → _doSaveWorkspaceData()
    │
    └──→ _doSaveWorkspaceData()
            │
            ├──→ Read activeWorkspaceId, find workspace path
            │
            ├──→ Write .dalam/sessions.json:
            │       { chatSessions, sessionMessages,
            │         sessionVersions, compactionSummaries }
            │
            └──→ Write .dalam/config.json:
                    { settings: {selectedModel, selectedProvider},
                      providers: [{id, enabled, apiKey, baseUrl}],
                      mcpServers: [project-scoped servers],
                      alwaysAllowed: [...permission rules] }
```

**localStorage Keys:**

| Key | Content |
|---|---|
| `dalam.workspaces.v1` | Workspace list & active ID |
| `dalam.chatSessions.v1` | Session summaries |
| `dalam.sessionMessages.v1` | Messages per session |
| `dalam.sessionVersions.v1` | Version checkpoints per session |
| `dalam.sessionAgents.v1` | Agent name per session |
| `dalam.compactionSummaries.v1` | Compacted history summaries |
| `dalam.enabledSkills.v1` | Enabled skill names |
| `dalam.mcpServers.v1` | User-scoped MCP server configs |
| `dalam.alwaysAllowed.v1` | Always-allowed permission rules |
| `dalam.providers.v1` | Model provider configurations |
| `dalam.lastDreamTime.<path>` | Timestamp of last dream cycle per workspace |
| `dalam.bundledSkillsStates.v1` | Enabled/disabled state for bundled skills |
| `dalam.userSkills.v1` | User-added custom skills |

### 32.7 Workspace Initialization Summary

| Phase | Function | Creates/Loads | Timing |
|---|---|---|---|
| Directory | `initWorkspaceMemory()` | `.dalam/` | Immediate |
| Database | `initDatabase()` | `.dalam/project.db` + schema | Immediate |
| Memory Rebuild | `rebuildFromMarkdown()` | SQLite rows from `*.md` files | Immediate |
| Dream Cycle | `triggerDreamCycleIfNeeded()` | Background consolidation | Deferred 5s |
| Default Memory | `initWorkspaceMemory()` | `.dalam/memory.json` | Immediate |
| Permissions | `loadFromDisk()` | `alwaysAllowed` map | Immediate |
| Project Skills | `loadProjectSkills()` | `.dalam/skills/*/SKILL.md` | Immediate |
| Config | `_doLoadWorkspaceConfigAndSessions()` | `.dalam/config.json` | Immediate |
| Context | `_doLoadWorkspaceConfigAndSessions()` | `.dalam/context.json` | Immediate |
| Sessions | `_doLoadWorkspaceConfigAndSessions()` | `.dalam/sessions.json` | Immediate |
| MCP Servers | Auto-connect loop | Connection state | After config |

---

*This document was generated by deep-scanning the entire Dalam codebase. Last updated: June 2026.*
