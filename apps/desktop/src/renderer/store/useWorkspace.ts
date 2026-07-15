import { create } from "zustand";
import type { Workspace, FileNode, McpServer, DalamAPI } from "@dalam/shared-types";
import { createDalamAPI } from "@/lib/dalamAPI";
import { basename, toPosix, joinPath, detectLanguage } from "@/lib/pathUtils";
import { loadProjectSkills, refreshProjectSkills } from "@/lib/skills";
import { useChat } from "./useChat";
import { useSettings } from "./useSettings";
import { useModelProviders } from "./useModelProviders";
import { useSkillsMcp, loadMcpServers } from "./useSkillsMcp";
import { usePermission } from "./usePermission";
import { useTerminal } from "./useTerminal";
import { useDiffView } from "./useDiffView";
const devWarn = import.meta.env.DEV
  ? (...args: unknown[]) => console.warn(...args)
  : () => {};

export type OpenTab = {
  path: string;
  name: string;
  content: string;
  dirty: boolean;
  language: string;
  cursor?: { line: number; column: number };
};

// ─── Config Types ─────────────────────────────────────────────
/** Shape of a provider entry stored in .dalam/config.json */
interface ProjectProviderConfig {
  id: string;
  enabled?: boolean;
  apiKey?: string;
  baseUrl?: string;
}

// ─── Workspace Persistence ────────────────────────────────────
const WORKSPACES_STORAGE_KEY = "dalam.workspaces.v1";

function loadPersistedWorkspaces(): { workspaces: Workspace[]; activeId: string | null } {
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

function savePersistedWorkspaces(workspaces: Workspace[], activeId: string | null) {
  try {
    localStorage.setItem(WORKSPACES_STORAGE_KEY, JSON.stringify({ workspaces, activeId }));
  } catch (e) {
    if (import.meta.env.DEV) devWarn("[Store] localStorage.setItem(WORKSPACES_STORAGE_KEY, JSON.:", e);
  }
}

type WorkspaceState = {
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  activeFilePath: string | null;
  fileTree: FileNode[];
  openTabs: OpenTab[];
  loading: boolean;
  openWorkspace: () => Promise<void>;
  loadWorkspace: () => Promise<void>;
  setActiveWorkspace: (id: string) => void;
  removeWorkspace: (id: string) => void;
  reorderWorkspaces: (newOrder: Workspace[]) => void;
  setActiveFile: (path: string | null) => void;
  openFile: (path: string) => Promise<void>;
  closeTab: (path: string) => void;
  updateTabContent: (path: string, content: string) => void;
  setCursor: (path: string, line: number, column: number) => void;
  markSaved: (path: string) => void;
  refreshFileTree: () => Promise<void>;
  loadFileTree: (path: string) => Promise<void>;
  createFile: (parentPath: string, name: string) => Promise<void>;
  createDirectory: (parentPath: string, name: string) => Promise<void>;
  deletePath: (path: string) => Promise<void>;
  renamePath: (path: string, newName: string) => Promise<void>;
};

async function initWorkspaceMemory(api: DalamAPI, workspacePath: string) {
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

    try {
      const { initDatabase } = await import("@/lib/database");
      await initDatabase(workspacePath);
      const { rebuildFromMarkdown } = await import("@/lib/memoryStore");
      await rebuildFromMarkdown(workspacePath);
      const { triggerDreamCycleIfNeeded } = await import("@/lib/dreamAgent");
      triggerDreamCycleIfNeeded(workspacePath);
    } catch (e) {
      devWarn("Failed to initialize memory database:", e);
    }

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

const _initialWorkspaces = loadPersistedWorkspaces();

export const useWorkspace = create<WorkspaceState>((set, get) => ({
  workspaces: _initialWorkspaces.workspaces,
  activeWorkspaceId: _initialWorkspaces.activeId,
  activeFilePath: null,
  fileTree: [],
  openTabs: [],
  loading: false,

  async openWorkspace() {
    const api = createDalamAPI();
    set({ loading: true });
    try {
      const path = await api.system.openDirectoryPicker();
      if (!path) { set({ loading: false }); return; }
      await initWorkspaceMemory(api, path);
      const tree = await api.fs.listDir(path);
      const name = basename(path) || "workspace";
      const existing = get().workspaces.find((w) => w.path === path);
      const workspace: Workspace = {
        id: "ws-" + toPosix(path),
        path,
        name,
        addedAt: existing?.addedAt ?? Date.now(),
        tasks: [],
      };
      const newWorkspaces = [...get().workspaces.filter((w) => w.path !== path), workspace]
        .sort((a, b) => b.addedAt - a.addedAt);
      set({
        workspaces: newWorkspaces,
        activeWorkspaceId: workspace.id,
        fileTree: tree,
        openTabs: [],
        activeFilePath: null,
        loading: false,
      });
      savePersistedWorkspaces(newWorkspaces, workspace.id);
      await loadWorkspaceConfigAndSessions(path);
    } catch (err) {
      set({ loading: false });
      if (import.meta.env.DEV) console.error("Failed to open workspace:", err);
    }
  },

  async loadWorkspace() {
    return get().openWorkspace();
  },

  setActiveWorkspace(id) {
    const ws = get().workspaces.find((w) => w.id === id);
    void import("./events").then(({ eventBus }) => {
      eventBus.emit("workspace:switched", { workspaceId: id, path: ws?.path ?? "" });
    });
    set({ activeWorkspaceId: id, openTabs: [], activeFilePath: null, fileTree: [] });
    savePersistedWorkspaces(get().workspaces, id);
    if (ws) {
      void loadWorkspaceConfigAndSessions(ws.path);
      void get().loadFileTree(ws.path);
    }
  },
  removeWorkspace(id) {
    const { workspaces, activeWorkspaceId } = get();
    const newWorkspaces = workspaces.filter((w) => w.id !== id);
    const newActiveId = activeWorkspaceId === id
      ? (newWorkspaces[0]?.id ?? null)
      : activeWorkspaceId;
    set({
      workspaces: newWorkspaces,
      activeWorkspaceId: newActiveId,
      fileTree: [],
      openTabs: [],
      activeFilePath: null,
    });
    savePersistedWorkspaces(newWorkspaces, newActiveId);
    if (newActiveId) {
      const ws = newWorkspaces.find((w) => w.id === newActiveId);
      if (ws) {
        void loadWorkspaceConfigAndSessions(ws.path);
      }
    }
  },
  reorderWorkspaces(newOrder) {
    const { activeWorkspaceId } = get();
    set({ workspaces: newOrder });
    savePersistedWorkspaces(newOrder, activeWorkspaceId);
  },
  setActiveFile(path) {
    set({ activeFilePath: path });
  },

  async openFile(path) {
    const { openTabs } = get();
    if (openTabs.find((t) => t.path === path)) {
      set({ activeFilePath: path });
      void import("./events").then(({ eventBus }) => {
        eventBus.emit("workspace:file-opened", { path });
      });
      return;
    }
    try {
      const api = createDalamAPI();
      const { stat } = await import("@tauri-apps/plugin-fs");
      try {
        const fileStat = await stat(path);
        if (fileStat.isDirectory) {
          devWarn("Cannot open directory as file:", path);
          return;
        }
      } catch (e) {
        if (import.meta.env.DEV) devWarn("[Store] stat(path);:", e);
      }
      const content = await api.fs.readFile(path);
      const tab: OpenTab = {
        path,
        name: basename(path) || path,
        content,
        dirty: false,
        language: detectLanguage(path),
      };
      set((s) => ({
        openTabs: [...s.openTabs, tab],
        activeFilePath: path,
      }));
      void import("./events").then(({ eventBus }) => {
        eventBus.emit("workspace:file-opened", { path });
      });
    } catch (err) {
      if (import.meta.env.DEV) console.error("Failed to open file:", path, err);
    }
  },

  closeTab(path) {
    set((s) => {
      const tabs = s.openTabs.filter((t) => t.path !== path);
      const active =
        s.activeFilePath === path ? tabs[tabs.length - 1]?.path ?? null : s.activeFilePath;
      return { openTabs: tabs, activeFilePath: active };
    });
  },

  updateTabContent(path, content) {
    set((s) => ({
      openTabs: s.openTabs.map((t) =>
        t.path === path ? { ...t, content, dirty: true } : t
      ),
    }));
  },

  setCursor(path, line, column) {
    set((s) => ({
      openTabs: s.openTabs.map((t) =>
        t.path === path ? { ...t, cursor: { line, column } } : t
      ),
    }));
  },

  markSaved(path) {
    set((s) => ({
      openTabs: s.openTabs.map((t) =>
        t.path === path ? { ...t, dirty: false } : t
      ),
    }));
  },

  async refreshFileTree() {
    const { activeWorkspaceId, workspaces } = get();
    if (!activeWorkspaceId) return;
    const ws = workspaces.find((w) => w.id === activeWorkspaceId);
    if (!ws) return;
    try {
      const api = createDalamAPI();
      const tree = await api.fs.listDir(ws.path);
      set({ fileTree: tree });
    } catch (err) {
      if (import.meta.env.DEV) console.error("Failed to refresh file tree:", err);
    }
  },

  async loadFileTree(path) {
    try {
      const api = createDalamAPI();
      const tree = await api.fs.listDir(path);
      set({ fileTree: tree });
    } catch (err) {
      if (import.meta.env.DEV) console.error("Failed to load file tree:", err);
    }
  },

  async createFile(parentPath, name) {
    try {
      const api = createDalamAPI();
      await api.fs.createFile(parentPath, name);
      await get().refreshFileTree();
    } catch (err) {
      devWarn("createFile failed:", err);
    }
  },

  async createDirectory(parentPath, name) {
    try {
      const api = createDalamAPI();
      await api.fs.createDirectory(parentPath, name);
      await get().refreshFileTree();
    } catch (err) {
      devWarn("createDirectory failed:", err);
    }
  },

  async deletePath(path) {
    try {
      const api = createDalamAPI();
      await api.fs.deletePath(path);
      set((s) => {
        const tabs = s.openTabs.filter((t) => t.path !== path);
        const active = s.activeFilePath === path ? tabs[tabs.length - 1]?.path ?? null : s.activeFilePath;
        return { openTabs: tabs, activeFilePath: active };
      });
      await get().refreshFileTree();
    } catch (err) {
      devWarn("deletePath failed:", err);
    }
  },

  async renamePath(path, newName) {
    try {
      const api = createDalamAPI();
      const posixPath = toPosix(path);
      const dir = posixPath.substring(0, posixPath.lastIndexOf("/"));
      const newPath = dir + "/" + newName;
      const dirPrefix = posixPath + "/";
      const oldTabs = get().openTabs.filter((t) => {
        const tp = toPosix(t.path);
        return tp === posixPath || tp.startsWith(dirPrefix);
      });
      await api.fs.renamePath(path, newName);
      if (oldTabs.length > 0) {
        set((s) => ({
          openTabs: s.openTabs.map((t) => {
            const tp = toPosix(t.path);
            if (tp === posixPath) {
              return { ...t, path: newPath, name: newName, language: detectLanguage(newPath) };
            }
            if (tp.startsWith(dirPrefix)) {
              const relativePath = tp.slice(dirPrefix.length);
              const updatedPath = joinPath(newPath, relativePath);
              return { ...t, path: updatedPath, name: basename(updatedPath) || t.name, language: detectLanguage(updatedPath) };
            }
            return t;
          }),
          activeFilePath: s.activeFilePath
            ? (toPosix(s.activeFilePath) === posixPath
                ? newPath
                : toPosix(s.activeFilePath).startsWith(dirPrefix)
                  ? joinPath(newPath, toPosix(s.activeFilePath).slice(dirPrefix.length))
                  : s.activeFilePath)
            : s.activeFilePath,
        }));
      }
      await get().refreshFileTree();
    } catch (err) {
      devWarn("renamePath failed:", err);
    }
  },
}));

{
  let _viewModeListenerRegistered = false;
  try {
    void import("./events").then(({ eventBus }) => {
      if (_viewModeListenerRegistered) return;
      _viewModeListenerRegistered = true;
      eventBus.on("ui:view-mode-changed", ({ mode }) => {
        if (mode === "chat") {
          useWorkspace.setState({ openTabs: [], activeFilePath: null });
        }
        if (mode === "editor") {
          const wsId = useWorkspace.getState().activeWorkspaceId;
          const ws = useWorkspace.getState().workspaces.find((w) => w.id === wsId);
          if (ws) {
            void useWorkspace.getState().loadFileTree(ws.path);
          }
        }
      });
    });
  } catch (err) {
    devWarn("[Store] Failed to register view-mode-changed listener:", err);
  }
}

let _workspaceLoadPromise: Promise<void> | null = null;
let _workspaceLoadPath: string | null = null;

export async function loadWorkspaceConfigAndSessions(workspacePath: string) {
  if (_workspaceLoadPromise && _workspaceLoadPath === workspacePath) {
    return _workspaceLoadPromise;
  }
  _workspaceLoadPath = workspacePath;
  _workspaceLoadPromise = _doLoadWorkspaceConfigAndSessions(workspacePath);
  try {
    await _workspaceLoadPromise;
  } finally {
    if (_workspaceLoadPath === workspacePath) {
      _workspaceLoadPromise = null;
      _workspaceLoadPath = null;
    }
  }
}

async function _doLoadWorkspaceConfigAndSessions(workspacePath: string) {
  const api = createDalamAPI();
  const dotDalam = joinPath(workspacePath, ".dalam");
  const sessionsPath = joinPath(dotDalam, "sessions.json");
  const configPath = joinPath(dotDalam, "config.json");
  const contextPath = joinPath(dotDalam, "context.json");

  try {
    const { scopeSafeExists } = await import("@/lib/dalamAPI");

    try {
      if (!(await scopeSafeExists(workspacePath))) return;
    } catch (e) {
      if (import.meta.env.DEV) devWarn("[Store] Workspace path inaccessible:", e);
      return;
    }

    try {
      const { scopeSafeExists, scopeSafeMkdir } = await import("@/lib/dalamAPI");
      if (!(await scopeSafeExists(dotDalam))) {
        await scopeSafeMkdir(dotDalam, { recursive: true });
      }
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e);
      if (!msg.includes("forbidden") && !msg.includes("scope") && import.meta.env.DEV) {
        devWarn("[Store] Failed to ensure .dalam directory:", e);
      }
      return;
    }

    await usePermission.getState().loadFromDisk();

    try {
      const projectSkills = await loadProjectSkills(workspacePath, {
        listDir: async (path: string) => {
          const nodes = await api.fs.listDir(path);
          return nodes.map((n) => ({ name: n.name, path: n.path, type: n.type }));
        },
        readFile: api.fs.readFile,
      });
      await refreshProjectSkills(projectSkills);
    } catch (e) {
      devWarn("Failed to load project skills:", e);
    }

    if (await scopeSafeExists(configPath)) {
      try {
        const content = await api.fs.readFile(configPath);
        const projConfig = JSON.parse(content);
        if (projConfig.settings) {
          const currentSettings = useSettings.getState().settings;
          const mergedSettings = { ...currentSettings, ...projConfig.settings };
          useSettings.setState({ settings: mergedSettings });
          try { localStorage.setItem("dalam.settings.v1", JSON.stringify(mergedSettings)); } catch (e) { devWarn("[Storage] Failed to save merged settings:", e); }
        }
        if (projConfig.providers) {
          const { providers } = useModelProviders.getState();
          const nextProviders = providers.map(p => {
            const projProv = (projConfig.providers as ProjectProviderConfig[] | undefined)?.find((pp) => pp.id === p.id);
            return projProv ? { ...p, ...projProv } : p;
          });
          useModelProviders.setState({ providers: nextProviders });
          try { localStorage.setItem("dalam.providers.v1", JSON.stringify(nextProviders)); } catch (e) { devWarn("[Storage] Failed to save merged providers:", e); }
        }

        const currentServers = useSkillsMcp.getState().mcpServers;
        const projectMcpServers: McpServer[] = (projConfig.mcpServers || [])
          .filter((m: unknown) => m && typeof m === "object" && "name" in m && typeof (m as McpServer).name === "string")
          .map((m: unknown) => {
            const server = m as McpServer;
            const existing = currentServers.find((s) => s.name === server.name && s.scope === "project");
            return {
              ...server,
              scope: "project" as const,
              status: existing ? existing.status : ("disconnected" as const),
              tools: existing ? existing.tools : undefined,
              error: existing ? existing.error : undefined,
          };
        });

        const globalMcpServers = loadMcpServers().map((m: McpServer) => {
          const existing = currentServers.find((s) => s.name === m.name && s.scope !== "project");
          return {
            ...m,
            status: existing ? existing.status : ("disconnected" as const),
            tools: existing ? existing.tools : undefined,
            error: existing ? existing.error : undefined,
          };
        });

        const finalServers = [...globalMcpServers, ...projectMcpServers];
        useSkillsMcp.setState({ mcpServers: finalServers });

        finalServers.forEach((server) => {
          if (server.enabled && server.status === "disconnected") {
            void useSkillsMcp.getState().connectMcpServer(server.name).catch((err) => {
              if (import.meta.env.DEV) console.error(`Failed to auto-connect to MCP server ${server.name}:`, err);
            });
          }
        });
      } catch (e) {
        devWarn("Failed to load workspace config.json:", e);
      }
    } else {
      try {
        const currentSettings = useSettings.getState().settings;
        const defaultProjConfig = {
          settings: {
            selectedModel: currentSettings.selectedModel,
            selectedProvider: currentSettings.selectedProvider,
          },
          providers: [],
          mcpServers: [],
        };
        await api.fs.writeFile(configPath, JSON.stringify(defaultProjConfig, null, 2));

        const currentServers = useSkillsMcp.getState().mcpServers;
        const globalMcpServers = loadMcpServers().map((m: McpServer) => {
          const existing = currentServers.find((s) => s.name === m.name && s.scope !== "project");
          return {
            ...m,
            status: existing ? existing.status : ("disconnected" as const),
            tools: existing ? existing.tools : undefined,
            error: existing ? existing.error : undefined,
          };
        });
        useSkillsMcp.setState({ mcpServers: globalMcpServers });

        globalMcpServers.forEach((server) => {
          if (server.enabled && server.status === "disconnected") {
            void useSkillsMcp.getState().connectMcpServer(server.name).catch((err) => {
              if (import.meta.env.DEV) console.error(`Failed to auto-connect to MCP server ${server.name}:`, err);
            });
          }
        });
      } catch (e) {
        devWarn("Failed to create default workspace config.json:", e);
      }
    }

    if (!(await scopeSafeExists(contextPath))) {
      try {
        const defaultContext = {
          pinnedFiles: [],
          ignorePatterns: ["node_modules", "dist", ".git", ".dalam"]
        };
        await api.fs.writeFile(contextPath, JSON.stringify(defaultContext, null, 2));
      } catch (e) {
        devWarn("Failed to create default workspace context.json:", e);
      }
    }

    if (await scopeSafeExists(sessionsPath)) {
      try {
        const content = await api.fs.readFile(sessionsPath);
        const data = JSON.parse(content);
        if (_workspaceLoadPath !== workspacePath) return;
        if (useChat.getState()._suppressSessionRestore) {
          const existingSessions = useChat.getState().chatSessions.filter(
            (s) => s.workspacePath !== workspacePath
          );
          const newSessions = data.chatSessions || [];
          const existingIds = new Set(existingSessions.map((s) => s.id));
          const uniqueNewSessions = newSessions.filter((s: { id: string }) => !existingIds.has(s.id));
          const chatState = useChat.getState();
          useChat.setState({
            chatSessions: [...existingSessions, ...uniqueNewSessions],
            sessionMessages: { ...chatState.sessionMessages, ...(data.sessionMessages || {}) },
            sessionVersions: { ...chatState.sessionVersions, ...(data.sessionVersions || {}) },
            compactionSummaries: { ...chatState.compactionSummaries, ...(data.compactionSummaries || {}) },
          });
          return;
        }
        const currentSessions = useChat.getState().chatSessions.filter(
          (s) => s.workspacePath !== workspacePath
        );
        const newSessions = data.chatSessions || [];
        const existingIds = new Set(currentSessions.map((s) => s.id));
        const uniqueNewSessions = newSessions.filter((s: { id: string }) => !existingIds.has(s.id));
        const chatState2 = useChat.getState();
        useChat.setState({
          chatSessions: [...currentSessions, ...uniqueNewSessions],
          sessionMessages: { ...chatState2.sessionMessages, ...(data.sessionMessages || {}) },
          sessionVersions: { ...chatState2.sessionVersions, ...(data.sessionVersions || {}) },
          compactionSummaries: { ...chatState2.compactionSummaries, ...(data.compactionSummaries || {}) },
        });
        const lastSession = data.chatSessions
          ? [...data.chatSessions].sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0))[0]
          : undefined;
        if (lastSession) {
          const restoredSession: import("@dalam/shared-types").AgentSession = {
            id: lastSession.id,
            workspacePath: lastSession.workspacePath,
            model: lastSession.model ?? useSettings.getState().settings.selectedModel,
            mode: lastSession.mode,
            startedAt: lastSession.startedAt,
            messages: data.sessionMessages?.[lastSession.id] || [],
            status: (lastSession.status === "completed" || lastSession.status === "aborted" || lastSession.status === "error") ? "idle" : lastSession.status,
          };
          useChat.setState({
            activeSessionId: lastSession.id,
            session: restoredSession,
            messages: data.sessionMessages?.[lastSession.id] || [],
            _sendInProgress: false,
            isStreaming: false,
            streamingContent: "",
            thinkingContent: "",
            pendingToolCalls: [],
            pendingActivities: [],
            pendingAttachments: [],
            restoredVersionId: null,
            preRestoreMessages: null,
            messageQueue: [],
            todos: [],
            _pendingChanges: [],
            subAgents: [],
          });
          try {
            useTerminal.getState().restoreForSession(lastSession.id);
          } catch (e) {
            if (import.meta.env.DEV) devWarn("[Store] useTerminal.getState().restoreForSession(lastSessi:", e);
          }
          try {
            useDiffView.getState().close();
          } catch (e) {
            if (import.meta.env.DEV) devWarn("[Store] useDiffView.getState().close();:", e);
          }
        } else {
          useChat.setState({
            session: null,
            messages: [],
          });
        }
      } catch (e) {
        devWarn("Failed to load workspace sessions.json:", e);
      }
    } else {
      try {
        const emptySessions = {
          chatSessions: [],
          sessionMessages: {},
          sessionVersions: {},
          compactionSummaries: {},
        };
        await api.fs.writeFile(sessionsPath, JSON.stringify(emptySessions, null, 2));
        const otherSessions = useChat.getState().chatSessions.filter(
          (s) => s.workspacePath !== workspacePath
        );
        useChat.setState({
          chatSessions: otherSessions,
          session: null,
          messages: [],
        });
      } catch (e) {
        devWarn("Failed to create default workspace sessions.json:", e);
      }
    }
    const editorStatePath = joinPath(dotDalam, "editor.json");
    if (await scopeSafeExists(editorStatePath)) {
      try {
        const content = await api.fs.readFile(editorStatePath);
        const editorData = JSON.parse(content);
        if (editorData.openTabs && Array.isArray(editorData.openTabs)) {
          const validTabs: typeof editorData.openTabs = [];
          for (const tab of editorData.openTabs) {
            if (tab.path && tab.name) {
              try {
                const { exists: fileExists } = await import("@tauri-apps/plugin-fs");
                if (await fileExists(tab.path)) {
                  const content = await api.fs.readFile(tab.path);
                  validTabs.push({
                    ...tab,
                    content,
                    dirty: false,
                    language: detectLanguage(tab.path),
                  });
                }
              } catch (e) {
                if (import.meta.env.DEV) devWarn("[Store] import(\"@tauri-apps/plugin-fs\");:", e);
              }
            }
          }
          if (validTabs.length > 0) {
            useWorkspace.setState({
              openTabs: validTabs,
              activeFilePath: editorData.activeFilePath && validTabs.find((t: { path: string }) => t.path === editorData.activeFilePath)
                ? editorData.activeFilePath
                : validTabs[validTabs.length - 1]?.path ?? null,
            });
          }
        }
      } catch (e) {
        devWarn("Failed to load editor state:", e);
      }
    }
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err);
    if (msg.includes("forbidden") || msg.includes("scope")) {
      console.debug("[Workspace] Skipped inaccessible workspace:", workspacePath);
    } else {
      devWarn("Failed to load workspace:", workspacePath, err);
    }
  }
}

let _saveWorkspaceDataTimer: ReturnType<typeof setTimeout> | null = null;

export async function saveWorkspaceData() {
  if (_saveWorkspaceDataTimer) clearTimeout(_saveWorkspaceDataTimer);
  _saveWorkspaceDataTimer = setTimeout(() => void _doSaveWorkspaceData(), 100);
}

export function flushSaveWorkspaceData(): void {
  if (_saveWorkspaceDataTimer) {
    clearTimeout(_saveWorkspaceDataTimer);
    _saveWorkspaceDataTimer = null;
    void _doSaveWorkspaceData();
  }
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
        status: _status || "disconnected",
      }));

    let existingConfig: Record<string, unknown> = {};
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
      alwaysAllowed: existingConfig.alwaysAllowed ?? usePermission.getState().alwaysAllowed,
    };
    await api.fs.writeFile(configPath, JSON.stringify(configData, null, 2));

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
