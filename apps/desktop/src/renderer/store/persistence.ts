import { createDalamAPI } from "@/lib/dalamAPI";
import { joinPath } from "@/lib/pathUtils";
import type { ChatSessionSummary, PrimaryAgentName } from "@dalam/shared-types";
import {
  useWorkspace,
  useChat,
  useSettings,
  useModelProviders,
  useSkillsMcp,
  usePermission,
} from "./useAppStore";

// ============================================================================
// Development-only console helpers
// ============================================================================
const devWarn = import.meta.env.DEV
  ? (...args: unknown[]) => console.warn(...args)
  : () => {};

// ─── Workspace Persistence ────────────────────────────────────
const WORKSPACES_STORAGE_KEY = "dalam.workspaces.v1";

export function loadPersistedWorkspaces(): { workspaces: import("@dalam/shared-types").Workspace[]; activeId: string | null } {
  try {
    const raw = localStorage.getItem(WORKSPACES_STORAGE_KEY);
    if (raw) {
      const data = JSON.parse(raw);
      return {
        workspaces: data.workspaces ?? [],
        activeId: data.activeId ?? null,
      };
    }
  } catch (err) { devWarn("[useChat] Failed to load persisted data:", err); }
  return { workspaces: [], activeId: null };
}

export function savePersistedWorkspaces(workspaces: import("@dalam/shared-types").Workspace[], activeId: string | null) {
  try {
    localStorage.setItem(WORKSPACES_STORAGE_KEY, JSON.stringify({ workspaces, activeId }));
  } catch (e) {
    if (import.meta.env.DEV) devWarn("[Store] localStorage.setItem(WORKSPACES_STORAGE_KEY, JSON.:", e);
  }
}

export async function initWorkspaceMemory(api: import("@dalam/shared-types").DalamAPI, workspacePath: string) {
  try {
    const { scopeSafeExists, scopeSafeMkdir } = await import("@/lib/dalamAPI");
    const dotDalam = joinPath(workspacePath, ".dalam");

    if (!(await scopeSafeExists(dotDalam))) {
      const created = await scopeSafeMkdir(dotDalam, { recursive: true });
      if (!created) {
        if (import.meta.env.DEV) devWarn("[Store] Cannot create .dalam directory — workspace path may not have filesystem scope:", workspacePath);
        return;
      }
    }

    // Initialize SQLite database for memory FTS5 search
    try {
      const { initDatabase } = await import("@/lib/database");
      await initDatabase(workspacePath);
      // Rebuild SQLite cache from markdown source files if needed
      const { rebuildFromMarkdown } = await import("@/lib/memoryStore");
      await rebuildFromMarkdown(workspacePath);

      // Trigger background memory dream consolidation cycle if needed
      const { triggerDreamCycleIfNeeded } = await import("@/lib/dreamAgent");
      triggerDreamCycleIfNeeded(workspacePath);
    } catch (e) {
      devWarn("Failed to initialize memory database:", e);
    }

    // Backward compatibility: ensure old memory.json exists if it was already in use
    const memoryPath = joinPath(dotDalam, "memory.json");
    let memoryExists = false;
    try {
      const { scopeSafeExists } = await import("@/lib/dalamAPI");
      memoryExists = await scopeSafeExists(memoryPath);
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e);
      if (!msg.includes("forbidden") && !msg.includes("scope")) throw e;
    }
    if (!memoryExists) {
      const defaultMemory = {
        projectOverview: "An AI-native developer desktop environment.",
        keyFiles: [],
        buildCommands: ["npm run dev", "npm run build"],
        learnedRules: [
          "Always run build checks before declaring a task complete.",
          "Maintain typescript type safety.",
        ],
      };
      try {
        await api.fs.writeFile(memoryPath, JSON.stringify(defaultMemory, null, 2));
      } catch (e) {
        const msg = (e as Error)?.message ?? String(e);
        if (!msg.includes("forbidden") && !msg.includes("scope")) {
          devWarn("Failed to create workspace memory.json:", e);
        }
      }
    }

    // Ensure context.json exists with defaults
    const contextPath = joinPath(dotDalam, "context.json");
    let contextExists = false;
    try {
      const { scopeSafeExists } = await import("@/lib/dalamAPI");
      contextExists = await scopeSafeExists(contextPath);
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e);
      if (!msg.includes("forbidden") && !msg.includes("scope")) throw e;
    }
    if (!contextExists) {
      const defaultContext = {
        pinnedFiles: [],
        ignorePatterns: ["node_modules", "dist", ".git", ".dalam"],
      };
      try {
        await api.fs.writeFile(contextPath, JSON.stringify(defaultContext, null, 2));
      } catch (e) {
        const msg = (e as Error)?.message ?? String(e);
        if (!msg.includes("forbidden") && !msg.includes("scope")) {
          devWarn("Failed to create workspace context.json:", e);
        }
      }
    }
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err);
    if (!msg.includes("forbidden") && !msg.includes("scope")) {
      devWarn("Failed to initialize workspace memory:", err);
    }
  }
}

const ENABLED_SKILLS_STORAGE = "dalam.enabledSkills.v1";
const SESSION_VERSIONS_KEY = "dalam.sessionVersions.v1";
const SESSION_MESSAGES_KEY = "dalam.sessionMessages.v1";
const SESSION_AGENTS_KEY = "dalam.sessionAgents.v1";
const SESSION_SUMMARIES_KEY = "dalam.chatSessions.v1";

export function loadEnabledSkills(): Set<string> {
  if (typeof window === "undefined") return new Set();
  const defaults = ["accessibility-compliance", "explain", "code-review", "plan"];
  try {
    const raw = window.localStorage.getItem(ENABLED_SKILLS_STORAGE);
    if (!raw) return new Set(defaults);
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set(defaults);
    return new Set(parsed as string[]);
  } catch (err) {
    devWarn("[useChat] Failed to load persisted data:", err);
    return new Set(defaults);
  }
}

export function saveEnabledSkills(s: Set<string>) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(ENABLED_SKILLS_STORAGE, JSON.stringify(Array.from(s)));
  } catch (err) {
    devWarn("[useChat] Failed to save enabled skills:", err);
  }
}

export function loadPersistedVersions(): Record<string, import("@dalam/shared-types").ChatVersion[]> {
  try {
    const raw = localStorage.getItem(SESSION_VERSIONS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (err) { devWarn("[useChat] Failed to load persisted data:", err); return {}; }
}

export function savePersistedVersions(versions: Record<string, import("@dalam/shared-types").ChatVersion[]>) {
  try { localStorage.setItem(SESSION_VERSIONS_KEY, JSON.stringify(versions)); } catch (e) { devWarn("Failed to save versions:", e); }
  _idbWriteThrough("versions", { id: "all", data: versions });
  void saveWorkspaceData();
}

export function loadPersistedMessages(): Record<string, import("@dalam/shared-types").ChatMessage[]> {
  try {
    const raw = localStorage.getItem(SESSION_MESSAGES_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (err) { devWarn("[useChat] Failed to load persisted data:", err); return {}; }
}

// Throttled message persistence: batches rapid localStorage writes during streaming.
let _saveMessagesTimer: ReturnType<typeof setTimeout> | null = null;
let _pendingMessagesRef: Record<string, import("@dalam/shared-types").ChatMessage[]> | null = null;
const SAVE_MESSAGES_DEBOUNCE_MS = 200;
if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", () => {
    flushSavePersistedMessages();
    flushSaveWorkspaceData();
  });
}
type MessagesMap = Record<string, import("@dalam/shared-types").ChatMessage[]>;

/**
 * Best-effort write-through to IndexedDB, mirroring whatever we just wrote to
 * localStorage. IndexedDB has a much larger quota than localStorage's ~5-10MB
 * cap, so this keeps a durable copy available even after localStorage starts
 * refusing writes. Failures are non-fatal — localStorage remains the source
 * of truth read on next `load()`, and idbGet() in `load()` will just fall
 * back to whatever was migrated/synced last time. Never throws.
 */
function _idbWriteThrough(storeName: "sessions" | "messages" | "versions" | "compaction", value: unknown): void {
  void import("@/lib/storage").then(({ idbPut, isIndexedDBAvailable }) => {
    if (!isIndexedDBAvailable()) return;
    return idbPut(storeName, value);
  }).catch((e) => {
    devWarn(`[Storage] IndexedDB write-through failed for ${storeName}:`, e);
  });
}

function _doSavePersistedMessages(messages: MessagesMap) {
  // Primary storage: IndexedDB (no quota limit)
  _idbWriteThrough("messages", { id: "all", data: messages });
  // Secondary: localStorage for quick reads (may fail on quota)
  try {
    localStorage.setItem(SESSION_MESSAGES_KEY, JSON.stringify(messages));
  } catch (e) {
    if (e instanceof DOMException && e.name === 'QuotaExceededError') {
      devWarn("[Storage] localStorage quota exceeded — IndexedDB is primary, this is expected");
      // Don't prune — IndexedDB is the source of truth now
    }
  }
}
export function savePersistedMessages(messages: MessagesMap) {
  _pendingMessagesRef = messages;
  if (_saveMessagesTimer) clearTimeout(_saveMessagesTimer);
  _saveMessagesTimer = setTimeout(() => {
    _saveMessagesTimer = null;
    if (_pendingMessagesRef) { const latest = _pendingMessagesRef; _pendingMessagesRef = null; _doSavePersistedMessages(latest); void saveWorkspaceData(); }
  }, SAVE_MESSAGES_DEBOUNCE_MS);
}
function flushSavePersistedMessages() {
  if (_saveMessagesTimer) { clearTimeout(_saveMessagesTimer); _saveMessagesTimer = null; }
  if (_pendingMessagesRef) { const latest = _pendingMessagesRef; _pendingMessagesRef = null; _doSavePersistedMessages(latest); void saveWorkspaceData(); }
}
/**
 * Save messages immediately (bypassing the debounce buffer), and cancel any
 * pending throttled save so it can't fire afterwards with stale data and
 * clobber this write. Use this for call sites that must write synchronously
 * relative to other state changes (e.g. deleting/archiving/restoring a
 * session) instead of calling `_doSavePersistedMessages` directly — a bare
 * direct call left `_pendingMessagesRef`/`_saveMessagesTimer` untouched, so a
 * throttled save already in flight from a *different* code path could fire
 * later with an older snapshot and silently undo the direct write.
 */
export function savePersistedMessagesImmediate(messages: MessagesMap) {
  if (_saveMessagesTimer) { clearTimeout(_saveMessagesTimer); _saveMessagesTimer = null; }
  _pendingMessagesRef = null;
  _doSavePersistedMessages(messages);
}

export function loadPersistedAgents(): Record<string, PrimaryAgentName> {
  try {
    const raw = localStorage.getItem(SESSION_AGENTS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (err) { devWarn("[useChat] Failed to load persisted data:", err); return {}; }
}

export function savePersistedAgents(agents: Record<string, PrimaryAgentName>) {
  try { localStorage.setItem(SESSION_AGENTS_KEY, JSON.stringify(agents)); } catch (e) { devWarn("Failed to save agents:", e); }
  void saveWorkspaceData();
}

export function loadPersistedSessionSummaries(): ChatSessionSummary[] {
  try {
    const raw = localStorage.getItem(SESSION_SUMMARIES_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (err) { devWarn("[useChat] Failed to load persisted data:", err); return []; }
}

const _pendingSummariesRef: { sessions: ChatSessionSummary[] } | null = null;
let _saveSummariesTimer: ReturnType<typeof setTimeout> | null = null;

export function savePersistedSessionSummaries(sessions: ChatSessionSummary[]) {
  if (_saveSummariesTimer) clearTimeout(_saveSummariesTimer);
  _saveSummariesTimer = setTimeout(() => {
    _saveSummariesTimer = null;
    try { localStorage.setItem(SESSION_SUMMARIES_KEY, JSON.stringify(sessions)); } catch (e) { devWarn("Failed to save session summaries:", e); }
    _idbWriteThrough("sessions", { id: "all", data: sessions });
    void saveWorkspaceData();
  }, 300);
}

const COMPACTION_SUMMARIES_KEY = "dalam.compactionSummaries.v1";

export function loadPersistedCompactionSummaries(): Record<string, string> {
  try {
    const raw = localStorage.getItem(COMPACTION_SUMMARIES_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (err) { devWarn("[useChat] Failed to load persisted data:", err); return {}; }
}

export function savePersistedCompactionSummaries(summaries: Record<string, string>) {
  try { localStorage.setItem(COMPACTION_SUMMARIES_KEY, JSON.stringify(summaries)); } catch (e) { devWarn("Failed to save compaction summaries:", e); }
  _idbWriteThrough("compaction", { sessionId: "all", data: summaries });
  void saveWorkspaceData();
}

// ─── Workspace Data (write-through to .dalam/sessions.json + .dalam/config.json) ──
let _saveWorkspaceDataTimer: ReturnType<typeof setTimeout> | null = null;

export async function saveWorkspaceData() {
  if (_saveWorkspaceDataTimer) clearTimeout(_saveWorkspaceDataTimer);
  _saveWorkspaceDataTimer = setTimeout(() => void _doSaveWorkspaceData(), 100);
}

/** Immediately flush any pending workspace data save (called on beforeunload). */
export function flushSaveWorkspaceData(): void {
  if (_saveWorkspaceDataTimer) {
    clearTimeout(_saveWorkspaceDataTimer);
    _saveWorkspaceDataTimer = null;
    void _doSaveWorkspaceData();
  }
}

/** Shape of .dalam/config.json */
interface WorkspaceConfig {
  settings?: Partial<import("@dalam/shared-types").AppSettings>;
  providers?: {
    id: string;
    enabled?: boolean;
    apiKey?: string;
    baseUrl?: string;
  }[];
  mcpServers?: import("@dalam/shared-types").McpServer[];
  alwaysAllowed?: Record<string, true>;
}

async function _doSaveWorkspaceData() {
  const activeWorkspaceId = useWorkspace.getState().activeWorkspaceId;
  if (!activeWorkspaceId) return;
  const ws = useWorkspace.getState().workspaces.find((w) => w.id === activeWorkspaceId);
  if (!ws) return;

  const api = createDalamAPI();
  const dotDalam = joinPath(ws.path, ".dalam");
  const sessionsPath = joinPath(dotDalam, "sessions.json");
  const configPath = joinPath(dotDalam, "config.json");

  try {
    const { scopeSafeExists, scopeSafeMkdir } = await import("@/lib/dalamAPI");
    try {
      if (!(await scopeSafeExists(dotDalam))) {
        await scopeSafeMkdir(dotDalam, { recursive: true });
      }
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e);
      if (!msg.includes("forbidden") && !msg.includes("scope") && import.meta.env.DEV) {
        devWarn("[Store] Failed to ensure .dalam directory:", e);
      }
      // Path outside Tauri scope — skip saving for this workspace
      return;
    }

    const chatState = useChat.getState();
    const sessionsData = {
      chatSessions: chatState.chatSessions,
      sessionMessages: chatState.sessionMessages,
      sessionVersions: chatState.sessionVersions,
      compactionSummaries: chatState.compactionSummaries,
    };
    await api.fs.writeFile(sessionsPath, JSON.stringify(sessionsData, null, 2));

    const currentSettings = useSettings.getState().settings;
    const currentProviders = useModelProviders.getState().providers;
    const providerConfigs = currentProviders.map(p => ({
      id: p.id,
      enabled: p.enabled,
      apiKey: p.apiKey,
      baseUrl: p.baseUrl,
    }));

    const projectMcpServers = useSkillsMcp.getState().mcpServers
      .filter((m) => m.scope === "project")
      .map(({ status: _status, tools: _tools, error: _error, ...rest }) => ({
        ...rest,
        // Preserve current connection status instead of forcing disconnected
        status: _status || "disconnected",
      }));

    // Read existing config first to preserve alwaysAllowed and other fields
    let existingConfig: WorkspaceConfig = {};
    try {
      const { scopeSafeExists, scopeSafeReadFile } = await import("@/lib/dalamAPI");
      if (await scopeSafeExists(configPath)) {
        const raw = await scopeSafeReadFile(configPath);
        if (raw) existingConfig = JSON.parse(raw);
      }
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e);
      if (!msg.includes("forbidden") && !msg.includes("scope") && import.meta.env.DEV) {
        devWarn("[Store] Failed to read existing config:", e);
      }
    }
    const configData = {
      ...existingConfig,
      settings: {
        selectedModel: currentSettings.selectedModel,
        selectedProvider: currentSettings.selectedProvider,
      },
      providers: providerConfigs,
      mcpServers: projectMcpServers,
      // Preserve alwaysAllowed from existing config (managed by usePermission)
      alwaysAllowed: existingConfig.alwaysAllowed ?? usePermission.getState().alwaysAllowed,
    };
    await api.fs.writeFile(configPath, JSON.stringify(configData, null, 2));

    // Save editor state (open tabs, active file, explorer state)
    const editorStatePath = joinPath(dotDalam, "editor.json");
    const wsState = useWorkspace.getState();
    const editorState = {
      openTabs: wsState.openTabs.map((t) => ({
        path: t.path,
        name: t.name,
        dirty: t.dirty,
        language: t.language,
        cursor: t.cursor,
      })),
      activeFilePath: wsState.activeFilePath,
    };
    await api.fs.writeFile(editorStatePath, JSON.stringify(editorState, null, 2));
  } catch (e) {
    devWarn("Failed to save workspace data:", e);
  }
}
