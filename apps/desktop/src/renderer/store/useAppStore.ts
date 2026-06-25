import { create } from "zustand";
import type {
  AcodeAPI,
  AgentInfo,
  AgentMode,
  AgentSession,
  AppSettings,
  ChatMessage,
  ChatSessionSummary,
  FileAttachment,
  FileChange,
  FileNode,
  GitStatus,
  McpServer,
  PermissionAction,
  PermissionRule,
  PrimaryAgentName,
  Skill,
  SkillInfo,
  StreamEvent,
  TerminalTab,
  TodoItem,
  Workspace,
} from "@acode/shared-types";
import { DEFAULT_SETTINGS } from "@acode/shared-types";
import { ensureAcodeAPI } from "@/lib/acodeAPI";
import { basename, toPosix, joinPath } from "@/lib/pathUtils";
import { ALL_AGENTS, PRIMARY_AGENTS, SUBAGENTS, getPrimaryAgent, mergeRulesets, evaluate, canonicaliseBashCommand, autoSelectAgent, recordAgentSelection, type PermissionKey } from "@/lib/agents";
import { skillRegistry, BUNDLED_SKILLS, matchSkillInvocation, renderSkillForPrompt, loadProjectSkills, refreshProjectSkills } from "@/lib/skills";
import { computeContextStats, selectMessagesForCompaction, pruneToolOutputs, buildCompactionPrompt, parseContextWindow, type ContextStats } from "@/lib/contextManager";

export { ALL_AGENTS, PRIMARY_AGENTS, SUBAGENTS, getPrimaryAgent };
export type { AgentInfo, AgentMode, PermissionAction, PermissionRule, PrimaryAgentName, SkillInfo, FileAttachment };
export { BUNDLED_SKILLS, skillRegistry, matchSkillInvocation, renderSkillForPrompt };

// ============================================================================
// XML Tool Call Parser
// ============================================================================
// Some models output tool calls as XML tags in their text response instead of
// using the proper tool-call protocol. This parser extracts those XML tags and
// converts them to ToolCall objects so they can be executed and displayed properly.

const XML_TOOL_CALL_RE = /<([a-zA-Z_][a-zA-Z0-9_-]*)((?:\s+[a-zA-Z_][a-zA-Z0-9_-]*="[^"]*")*)\s*\/?>/g;
const XML_ATTR_RE = /([a-zA-Z_][a-zA-Z0-9_-]*)="([^"]*)"/g;

// Known tool name mappings from XML tags to internal tool names
const TAG_TO_TOOL: Record<string, string> = {
  list_dir: "list_dir",
  read_file: "read_file",
  write_file: "write_file",
  edit_file: "edit_file",
  bash: "bash",
  shell: "bash",
  search: "file_search",
  grep: "grep",
  webfetch: "webfetch",
  websearch: "websearch",
  run_command: "bash",
};

// Tool name → permission kind mappings (module-level to avoid recreation per event)
const EDIT_TOOLS = new Set(["edit_file", "edit", "write_file", "write", "create_file"]);
const BASH_TOOLS = new Set(["shell", "bash", "execute", "run_command"]);
const NETWORK_TOOLS = new Set(["webfetch", "websearch"]);

interface ParsedXmlToolCall {
  toolCall: import("@acode/shared-types").ToolCall;
  rawMatch: string;
  matchIndex: number;
}

/**
 * Parse XML-style tool calls from assistant text content.
 * Returns extracted tool calls and the cleaned content with XML tags removed.
 */
export function parseXmlToolCalls(content: string): {
  toolCalls: import("@acode/shared-types").ToolCall[];
  cleanedContent: string;
} {
  const toolCalls: import("@acode/shared-types").ToolCall[] = [];
  const rawMatches: string[] = [];
  let match: RegExpExecArray | null;

  // Reset regex state
  XML_TOOL_CALL_RE.lastIndex = 0;

  while ((match = XML_TOOL_CALL_RE.exec(content)) !== null) {
    const [fullMatch, tagName, attrString] = match;
    const toolName = TAG_TO_TOOL[tagName] ?? tagName;

    // Skip if it's not a recognized tool and doesn't look like a tool call
    if (!TAG_TO_TOOL[tagName] && !attrString) continue;

    const args: Record<string, unknown> = {};
    if (attrString) {
      let attrMatch: RegExpExecArray | null;
      XML_ATTR_RE.lastIndex = 0;
      while ((attrMatch = XML_ATTR_RE.exec(attrString)) !== null) {
        args[attrMatch[1]] = attrMatch[2];
      }
    }

    // Check if this is a self-closing tag (ends with />)
    const isSelfClosing = fullMatch.endsWith("/>");

    // Extract content between opening and closing tags (only for non-self-closing)
    let tagContent = "";
    if (!isSelfClosing) {
      const closingTag = `</${tagName}>`;
      const closeIdx = content.indexOf(closingTag, match.index + fullMatch.length);
      if (closeIdx !== -1) {
        tagContent = content.slice(match.index + fullMatch.length, closeIdx);
      }
    }

    // If there's tag content, add it as "content" arg
    if (tagContent.trim()) {
      args.content = tagContent.trim();
    }

    toolCalls.push({
      id: "xml-tc-" + Math.random().toString(36).slice(2, 9),
      name: toolName,
      args,
      status: "completed" as const,
      result: tagContent || undefined,
    });
    rawMatches.push(fullMatch);
  }

  // Strip XML tool calls from content for clean display
  // Build a single regex that matches all found tool call tags
  let cleanedContent = content;
  if (rawMatches.length > 0) {
    // Escape special regex chars in raw matches and join with OR
    const escaped = rawMatches.map((m) => m.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    const stripRe = new RegExp(escaped.join("|"), "g");
    cleanedContent = content.replace(stripRe, "");
  }
  // Strip MCP tool call tags (not in TAG_TO_TOOL, dynamic server+tool names)
  cleanedContent = cleanedContent
    .replace(/<mcp_[\s\S]*?<\/mcp_[^>]*>/g, "")
    .replace(/<mcp_[^>]*\/>/g, "");
  // Clean up excessive whitespace left behind
  cleanedContent = cleanedContent.replace(/\n{3,}/g, "\n\n").trim();

  return { toolCalls, cleanedContent };
}

type CommandPaletteState = {
  open: boolean;
  query: string;
  setOpen: (open: boolean) => void;
  setQuery: (query: string) => void;
  toggle: () => void;
};

export const useCommandPalette = create<CommandPaletteState>((set) => ({
  open: false,
  query: "",
  setOpen: (open) => set((s) => ({ open, query: open ? s.query : "" })),
  setQuery: (query) => set({ query }),
  toggle: () => set((s) => ({ open: !s.open, query: "" })),
}));

type SettingsState = {
  settings: AppSettings;
  loaded: boolean;
  load: () => Promise<void>;
  update: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => Promise<void>;
  updateSettings: (updates: Partial<AppSettings>) => Promise<void>;
  effectiveTheme: () => "dark" | "light";
};

const SYSTEM_DARK_MQ = "(prefers-color-scheme: dark)";

export const useSettings = create<SettingsState>((set, get) => ({
  settings: { ...DEFAULT_SETTINGS },
  loaded: false,
  async load() {
    const api = ensureAcodeAPI();
    try {
      const all = await api.settings.getAll();
      set({ settings: all, loaded: true });
      if (all.selectedModel) {
        useChat.getState().setSelectedModel(all.selectedModel);
      }
    } catch (err) {
      console.error("Failed to load settings, using defaults:", err);
      set({ loaded: true });
    }
  },
  async update(key, value) {
    const api = ensureAcodeAPI();
    await api.settings.set(key, value as never);
    set((s) => ({ settings: { ...s.settings, [key]: value } }));
  },
  async updateSettings(updates) {
    const api = ensureAcodeAPI();
    for (const [key, value] of Object.entries(updates)) {
      await api.settings.set(key as keyof AppSettings, value as never);
    }
    set((s) => ({ settings: { ...s.settings, ...updates } }));
  },
  effectiveTheme() {
    const { theme } = get().settings;
    if (theme !== "system") return theme;
    if (typeof window === "undefined") return "dark";
    return window.matchMedia(SYSTEM_DARK_MQ).matches ? "dark" : "light";
  },
}));

export type OpenTab = {
  path: string;
  name: string;
  content: string;
  dirty: boolean;
  language: string;
  cursor?: { line: number; column: number };
};

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
  setActiveFile: (path: string | null) => void;
  openFile: (path: string) => Promise<void>;
  closeTab: (path: string) => void;
  updateTabContent: (path: string, content: string) => void;
  setCursor: (path: string, line: number, column: number) => void;
  markSaved: (path: string) => void;
  refreshFileTree: () => Promise<void>;
  createFile: (parentPath: string, name: string) => Promise<void>;
  createDirectory: (parentPath: string, name: string) => Promise<void>;
  deletePath: (path: string) => Promise<void>;
  renamePath: (path: string, newName: string) => Promise<void>;
};

function detectLanguage(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "ts" || ext === "tsx") return "typescript";
  if (ext === "js") return "javascript";
  if (ext === "json") return "json";
  if (ext === "md" || ext === "mdx") return "markdown";
  if (ext === "py") return "python";
  if (ext === "rs") return "rust";
  if (ext === "css") return "css";
  if (ext === "html") return "html";
  return "plaintext";
}

async function initWorkspaceMemory(api: AcodeAPI, workspacePath: string) {
  try {
    const { exists, mkdir } = await import("@tauri-apps/plugin-fs");
    const dotAcode = joinPath(workspacePath, ".acode");
    if (!(await exists(dotAcode))) {
      await mkdir(dotAcode);
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
      console.warn("Failed to initialize memory database:", e);
    }

    // Backward compatibility: ensure old memory.json exists if it was already in use
    const memoryPath = joinPath(dotAcode, "memory.json");
    if (!(await exists(memoryPath))) {
      const defaultMemory = {
        projectOverview: "An AI-native developer desktop environment.",
        keyFiles: [],
        buildCommands: ["npm run dev", "npm run build"],
        learnedRules: [
          "Always run build checks before declaring a task complete.",
          "Maintain typescript type safety.",
        ],
      };
      await api.fs.writeFile(memoryPath, JSON.stringify(defaultMemory, null, 2));
    }
  } catch (err) {
    console.warn("Failed to initialize workspace memory:", err);
  }
}

export const useWorkspace = create<WorkspaceState>((set, get) => ({
  workspaces: [],
  activeWorkspaceId: null,
  activeFilePath: null,
  fileTree: [],
  openTabs: [],
  loading: false,

  async openWorkspace() {
    const api = ensureAcodeAPI();
    set({ loading: true });
    try {
      const path = await api.system.openDirectoryPicker();
      if (!path) { set({ loading: false }); return; }
      await initWorkspaceMemory(api, path);
      const tree = await api.fs.listDir(path);
      const name = basename(path) || "workspace";
      const workspace: Workspace = {
        id: "ws-" + toPosix(path),
        path,
        name,
        tasks: [],
      };
      set((s) => ({
        workspaces: [...s.workspaces.filter((w) => w.id !== workspace.id), workspace],
        activeWorkspaceId: workspace.id,
        fileTree: tree,
        loading: false,
      }));
      await loadWorkspaceConfigAndSessions(path);
    } catch (err) {
      set({ loading: false });
      console.error("Failed to open workspace:", err);
    }
  },

  async loadWorkspace() {
    set({ loading: true });
    try {
      const api = ensureAcodeAPI();
      const path = await api.system.openDirectoryPicker();
      if (!path) { set({ loading: false }); return; }
      await initWorkspaceMemory(api, path);
      const tree = await api.fs.listDir(path);
      const workspace: Workspace = {
        id: "ws-" + toPosix(path),
        path,
        name: basename(path) || "workspace",
        tasks: [],
      };
      set((s) => ({
        workspaces: [...s.workspaces.filter((w) => w.path !== path), workspace],
        activeWorkspaceId: workspace.id,
        fileTree: tree,
        loading: false,
      }));
      await loadWorkspaceConfigAndSessions(path);
    } catch (err) {
      set({ loading: false });
      console.error("Failed to load workspace:", err);
    }
  },

  setActiveWorkspace(id) {
    set({ activeWorkspaceId: id });
    const ws = get().workspaces.find((w) => w.id === id);
    if (ws) {
      void loadWorkspaceConfigAndSessions(ws.path);
    }
  },
  setActiveFile(path) {
    set({ activeFilePath: path });
  },

  async openFile(path) {
    const { openTabs } = get();
    if (openTabs.find((t) => t.path === path)) {
      set({ activeFilePath: path });
      return;
    }
    try {
      const api = ensureAcodeAPI();
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
    } catch (err) {
      console.error("Failed to open file:", path, err);
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
      const api = ensureAcodeAPI();
      const tree = await api.fs.listDir(ws.path);
      set({ fileTree: tree });
    } catch (err) {
      console.error("Failed to refresh file tree:", err);
    }
  },

  async createFile(parentPath, name) {
    try {
      const api = ensureAcodeAPI();
      await api.fs.createFile(parentPath, name);
      await get().refreshFileTree();
    } catch (err) {
      console.warn("createFile failed:", err);
    }
  },

  async createDirectory(parentPath, name) {
    try {
      const api = ensureAcodeAPI();
      await api.fs.createDirectory(parentPath, name);
      await get().refreshFileTree();
    } catch (err) {
      console.warn("createDirectory failed:", err);
    }
  },

  async deletePath(path) {
    try {
      const api = ensureAcodeAPI();
      await api.fs.deletePath(path);
      set((s) => {
        const tabs = s.openTabs.filter((t) => t.path !== path);
        const active = s.activeFilePath === path ? tabs[tabs.length - 1]?.path ?? null : s.activeFilePath;
        return { openTabs: tabs, activeFilePath: active };
      });
      await get().refreshFileTree();
    } catch (err) {
      console.warn("deletePath failed:", err);
    }
  },

  async renamePath(path, newName) {
    try {
      const api = ensureAcodeAPI();
      const oldTabs = get().openTabs.filter((t) => t.path === path);
      await api.fs.renamePath(path, newName);
      if (oldTabs.length > 0) {
        const posixPath = toPosix(path);
        const dir = posixPath.substring(0, posixPath.lastIndexOf("/"));
        const newPath = dir + "/" + newName;
        set((s) => ({
          openTabs: s.openTabs.map((t) =>
            t.path === path ? { ...t, path: newPath, name: newName, language: detectLanguage(newPath) } : t
          ),
          activeFilePath: s.activeFilePath === path ? newPath : s.activeFilePath,
        }));
      }
      await get().refreshFileTree();
    } catch (err) {
      console.warn("renamePath failed:", err);
    }
  },
}));

type GitState = {
  status: GitStatus | null;
  loading: boolean;
  refresh: () => Promise<void>;
};

export const useGit = create<GitState>((set) => ({
  status: null,
  loading: false,
  async refresh() {
    const api = ensureAcodeAPI();
    set({ loading: true });
    try {
      const status = await api.git.status(".");
      set({ status });
    } catch {
      set({ status: null });
    } finally {
      set({ loading: false });
    }
  },
}));

// ----------------------------------------------------------------------------
// Agent store — primary + subagent architecture
// ----------------------------------------------------------------------------

type AgentStoreState = {
  agents: AgentInfo[];
  activeAgentName: PrimaryAgentName;
  userRules: PermissionRule[];
  enabledSkills: Set<string>;
  selectedSubagent: string | null;

  setActiveAgent: (name: PrimaryAgentName) => void;
  upsertRule: (rule: PermissionRule) => void;
  removeRule: (permission: string, pattern: string) => void;
  resetRules: () => void;
  toggleSkill: (name: string) => void;
  selectSubagent: (name: string | null) => void;
  evaluatePermission: (permission: string, pattern: string) => "allow" | "deny" | "ask";
  loadSkills: () => SkillInfo[];
};

const ENABLED_SKILLS_STORAGE = "acode.enabledSkills.v1";
const SESSION_VERSIONS_KEY = "acode.sessionVersions.v1";
const SESSION_MESSAGES_KEY = "acode.sessionMessages.v1";
const SESSION_AGENTS_KEY = "acode.sessionAgents.v1";
const SESSION_SUMMARIES_KEY = "acode.chatSessions.v1";

function loadEnabledSkills(): Set<string> {
  if (typeof window === "undefined") return new Set();
  const defaults = ["accessibility-compliance", "explain", "code-review", "plan"];
  try {
    const raw = window.localStorage.getItem(ENABLED_SKILLS_STORAGE);
    if (!raw) return new Set(defaults);
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set(defaults);
    return new Set(parsed as string[]);
  } catch {
    return new Set(defaults);
  }
}

function saveEnabledSkills(s: Set<string>) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(ENABLED_SKILLS_STORAGE, JSON.stringify(Array.from(s)));
  } catch {
    /* ignore */
  }
}

function loadPersistedVersions(): Record<string, import("@acode/shared-types").ChatVersion[]> {
  try {
    const raw = localStorage.getItem(SESSION_VERSIONS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function savePersistedVersions(versions: Record<string, import("@acode/shared-types").ChatVersion[]>) {
  try { localStorage.setItem(SESSION_VERSIONS_KEY, JSON.stringify(versions)); } catch (e) { console.warn("Failed to save versions:", e); }
  void saveWorkspaceData();
}

function loadPersistedMessages(): Record<string, import("@acode/shared-types").ChatMessage[]> {
  try {
    const raw = localStorage.getItem(SESSION_MESSAGES_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function savePersistedMessages(messages: Record<string, import("@acode/shared-types").ChatMessage[]>) {
  try { localStorage.setItem(SESSION_MESSAGES_KEY, JSON.stringify(messages)); } catch (e) { console.warn("Failed to save messages:", e); }
  void saveWorkspaceData();
}

function loadPersistedAgents(): Record<string, PrimaryAgentName> {
  try {
    const raw = localStorage.getItem(SESSION_AGENTS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function savePersistedAgents(agents: Record<string, PrimaryAgentName>) {
  try { localStorage.setItem(SESSION_AGENTS_KEY, JSON.stringify(agents)); } catch (e) { console.warn("Failed to save agents:", e); }
  void saveWorkspaceData();
}

function loadPersistedSessionSummaries(): ChatSessionSummary[] {
  try {
    const raw = localStorage.getItem(SESSION_SUMMARIES_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function savePersistedSessionSummaries(sessions: ChatSessionSummary[]) {
  try { localStorage.setItem(SESSION_SUMMARIES_KEY, JSON.stringify(sessions)); } catch (e) { console.warn("Failed to save session summaries:", e); }
  void saveWorkspaceData();
}

const COMPACTION_SUMMARIES_KEY = "acode.compactionSummaries.v1";

function loadPersistedCompactionSummaries(): Record<string, string> {
  try {
    const raw = localStorage.getItem(COMPACTION_SUMMARIES_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function savePersistedCompactionSummaries(summaries: Record<string, string>) {
  try { localStorage.setItem(COMPACTION_SUMMARIES_KEY, JSON.stringify(summaries)); } catch (e) { console.warn("Failed to save compaction summaries:", e); }
  void saveWorkspaceData();
}

// Concurrency guard: track workspace loading to prevent duplicate loads
let _workspaceLoadPromise: Promise<void> | null = null;
let _workspaceLoadPath: string | null = null;

export async function loadWorkspaceConfigAndSessions(workspacePath: string) {
  // If the same workspace is already loading, return the existing promise
  if (_workspaceLoadPromise && _workspaceLoadPath === workspacePath) {
    return _workspaceLoadPromise;
  }
  // If a different workspace is loading, let it complete but start ours fresh
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
  const api = ensureAcodeAPI();
  const dotAcode = joinPath(workspacePath, ".acode");
  const sessionsPath = joinPath(dotAcode, "sessions.json");
  const configPath = joinPath(dotAcode, "config.json");
  const contextPath = joinPath(dotAcode, "context.json");

  try {
    const { exists } = await import("@tauri-apps/plugin-fs");

    // Load always-allowed permissions from disk first (needed for tool permission evaluations)
    await usePermission.getState().loadFromDisk();

    // Load project-level skills from .acode/skills/*/SKILL.md
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
      console.warn("Failed to load project skills:", e);
    }

    // Load configuration
    if (await exists(configPath)) {
      try {
        const content = await api.fs.readFile(configPath);
        const projConfig = JSON.parse(content);
        if (projConfig.settings) {
          const currentSettings = useSettings.getState().settings;
          useSettings.setState({ settings: { ...currentSettings, ...projConfig.settings } });
        }
        if (projConfig.providers) {
          const { providers } = useModelProviders.getState();
          const nextProviders = providers.map(p => {
            const projProv = projConfig.providers.find((pp: any) => pp.id === p.id);
            return projProv ? { ...p, ...projProv } : p;
          });
          useModelProviders.setState({ providers: nextProviders });
        }

        // Merge project-scoped MCP servers from config.json with user-scoped ones from localStorage
        const currentServers = useSkillsMcp.getState().mcpServers;
        const projectMcpServers: McpServer[] = (projConfig.mcpServers || []).map((m: any) => {
          const existing = currentServers.find((s) => s.name === m.name && s.scope === "project");
          return {
            ...m,
            scope: "project" as const,
            status: existing ? existing.status : ("disconnected" as const),
            tools: existing ? existing.tools : undefined,
            error: existing ? existing.error : undefined,
          };
        });

        const globalMcpServers = loadMcpServers().map((m: any) => {
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

        // Auto-connect any enabled & disconnected servers
        finalServers.forEach((server) => {
          if (server.enabled && server.status === "disconnected") {
            void useSkillsMcp.getState().connectMcpServer(server.name).catch((err) =>
              console.error(`Failed to auto-connect to MCP server ${server.name}:`, err)
            );
          }
        });
      } catch (e) {
        console.warn("Failed to load workspace config.json:", e);
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
        const globalMcpServers = loadMcpServers().map((m: any) => {
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
            void useSkillsMcp.getState().connectMcpServer(server.name).catch((err) =>
              console.error(`Failed to auto-connect to MCP server ${server.name}:`, err)
            );
          }
        });
      } catch (e) {
        console.warn("Failed to create default workspace config.json:", e);
      }
    }

    // Load context
    if (!(await exists(contextPath))) {
      try {
        const defaultContext = {
          pinnedFiles: [],
          ignorePatterns: ["node_modules", "dist", ".git", ".acode"]
        };
        await api.fs.writeFile(contextPath, JSON.stringify(defaultContext, null, 2));
      } catch (e) {
        console.warn("Failed to create default workspace context.json:", e);
      }
    }

    // Load sessions
    if (await exists(sessionsPath)) {
      try {
        const content = await api.fs.readFile(sessionsPath);
        const data = JSON.parse(content);
        useChat.setState({
          chatSessions: data.chatSessions || [],
          sessionMessages: data.sessionMessages || {},
          sessionVersions: data.sessionVersions || {},
          compactionSummaries: data.compactionSummaries || {},
        });
        const lastSession = data.chatSessions
          ? [...data.chatSessions].sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0))[0]
          : undefined;
        if (lastSession) {
          useChat.setState({
            session: lastSession,
            messages: data.sessionMessages?.[lastSession.id] || [],
          });
        } else {
          useChat.setState({
            session: null,
            messages: [],
          });
        }
      } catch (e) {
        console.warn("Failed to load workspace sessions.json:", e);
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
        useChat.setState({
          chatSessions: [],
          sessionMessages: {},
          sessionVersions: {},
          compactionSummaries: {},
          session: null,
          messages: [],
        });
      } catch (e) {
        console.warn("Failed to create default workspace sessions.json:", e);
      }
    }
  } catch (err) {
    console.warn("Failed to check workspace paths in loadWorkspaceConfigAndSessions:", err);
  }
}

let _saveWorkspaceDataTimer: ReturnType<typeof setTimeout> | null = null;

export async function saveWorkspaceData() {
  if (_saveWorkspaceDataTimer) clearTimeout(_saveWorkspaceDataTimer);
  _saveWorkspaceDataTimer = setTimeout(() => void _doSaveWorkspaceData(), 100);
}

async function _doSaveWorkspaceData() {
  const activeWorkspaceId = useWorkspace.getState().activeWorkspaceId;
  if (!activeWorkspaceId) return;
  const ws = useWorkspace.getState().workspaces.find((w) => w.id === activeWorkspaceId);
  if (!ws) return;

  const api = ensureAcodeAPI();
  const dotAcode = joinPath(ws.path, ".acode");
  const sessionsPath = joinPath(dotAcode, "sessions.json");
  const configPath = joinPath(dotAcode, "config.json");

  try {
    const { exists, mkdir } = await import("@tauri-apps/plugin-fs");
    if (!(await exists(dotAcode))) {
      await mkdir(dotAcode);
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
      .map(({ status, tools, error, ...rest }) => ({
        ...rest,
        // Preserve current connection status instead of forcing disconnected
        status: status || "disconnected",
      }));

    // Read existing config first to preserve alwaysAllowed and other fields
    let existingConfig: any = {};
    try {
      if (await exists(configPath)) {
        existingConfig = JSON.parse(await api.fs.readFile(configPath));
      }
    } catch {}
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
  } catch (e) {
    console.warn("Failed to save workspace data:", e);
  }
}

export const useAgents = create<AgentStoreState>((set, get) => ({
  agents: ALL_AGENTS,
  activeAgentName: "build",
  userRules: [],
  enabledSkills: loadEnabledSkills(),
  selectedSubagent: null,

  setActiveAgent(name) {
    set({ activeAgentName: name });
    useChat.setState({ activeAgentName: name, _userSelectedAgent: true });
    // Persist agent name for the active session
    const { activeSessionId, sessionAgentName } = useChat.getState();
    if (activeSessionId) {
      const updated = { ...sessionAgentName, [activeSessionId]: name };
      useChat.setState({ sessionAgentName: updated });
      savePersistedAgents(updated);
    }
  },
  upsertRule(rule) {
    set((s) => {
      const idx = s.userRules.findIndex(
        (r) => r.permission === rule.permission && r.pattern === rule.pattern
      );
      const next = [...s.userRules];
      if (idx >= 0) next[idx] = rule;
      else next.push(rule);
      return { userRules: next };
    });
  },
  removeRule(permission, pattern) {
    set((s) => ({
      userRules: s.userRules.filter(
        (r) => !(r.permission === permission && r.pattern === pattern)
      ),
    }));
  },
  resetRules() {
    set({ userRules: [] });
  },
  toggleSkill(name) {
    set((s) => {
      const next = new Set(s.enabledSkills);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      saveEnabledSkills(next);
      return { enabledSkills: next };
    });
  },
  selectSubagent(name) {
    set({ selectedSubagent: name });
  },
  evaluatePermission(permission, pattern) {
    const { activeAgentName, userRules } = get();
    const agent = getPrimaryAgent(activeAgentName);
    const merged = mergeRulesets(agent.permission, userRules);
    return evaluate(merged, permission, pattern);
  },
  loadSkills() {
    return skillRegistry.list();
  },
}));

export function useActiveAgent(): AgentInfo {
  const name = useAgents((s) => s.activeAgentName);
  return getPrimaryAgent(name);
}

export function usePermissionAction(permission: PermissionKey, pattern: string = "*") {
  const activeAgentName = useAgents((s) => s.activeAgentName);
  const userRules = useAgents((s) => s.userRules);
  const agent = getPrimaryAgent(activeAgentName);
  const merged = mergeRulesets(agent.permission, userRules);
  return evaluate(merged, permission, pattern);
}

export type TodoStatus = TodoItem["status"];

type ChatState = {
  session: AgentSession | null;
  messages: ChatMessage[];
  pendingToolCalls: import("@acode/shared-types").ToolCall[];
  pendingActivities: import("@acode/shared-types").PendingActivity[];
  streamingContent: string;
  thinkingContent: string;
  isStreaming: boolean;
  activeAgentName: PrimaryAgentName;
  selectedModelId: string;
  todos: TodoItem[];
  _pendingChanges: FileChange[];
  _userSelectedAgent: boolean;
  chatHistory: import("@acode/shared-types").ChatMessage[][];
  chatHistoryIdx: number;
  chatSessions: ChatSessionSummary[];
  activeSessionId: string | null;
  sessionMessages: Record<string, ChatMessage[]>;
  sessionAgentName: Record<string, PrimaryAgentName>;
  planApproval: { planContent: string; status: "pending" | "approved" | "rejected" } | null;
  sessionVersions: Record<string, import("@acode/shared-types").ChatVersion[]>;
  restoredVersionId: string | null;
  preRestoreMessages: import("@acode/shared-types").ChatMessage[] | null;
  pendingAttachments: FileAttachment[];
  compactionSummaries: Record<string, string>;
  _compactingSessions: Set<string>;
  compactSessionHistory: (sessionId: string) => Promise<void>;
  setSelectedModel: (id: string) => void;
  startSession: (workspacePath: string, mode: import("@acode/shared-types").AgentSessionMode) => Promise<void>;
  sendMessage: (content: string) => Promise<void>;
  saveVersion: (sessionId: string, label: string) => void;
  restoreVersion: (sessionId: string, versionId: string) => void;
  deleteVersion: (sessionId: string, versionId: string) => void;
  cancelVersionRestore: () => void;
  confirmVersionRestore: () => void;
  abort: (sessionId: string) => Promise<void>;
  appendStream: (event: StreamEvent) => void;
  setTodos: (todos: TodoItem[]) => void;
  updateTodo: (id: string, patch: Partial<TodoItem>) => void;
  resolveToolApproval: (toolCallId: string, decision: "approved" | "denied", result?: string) => Promise<void>;
  openFile: (path: string) => void;
  newChat: () => void;
  goBackChat: () => boolean;
  goForwardChat: () => boolean;
  reset: () => void;
  setActiveSession: (id: string | null) => void;
  renameSession: (id: string, title: string) => void;
  setSessionStatus: (id: string, status: ChatSessionSummary["status"]) => void;
  removeSession: (id: string) => void;
  approvePlan: () => void;
  rejectPlan: () => void;
  addPendingAttachment: (file: FileAttachment) => void;
  removePendingAttachment: (id: string) => void;
  clearPendingAttachments: () => void;
  injectSystemMessage: (content: string) => void;
};

export const useChat = create<ChatState>((set, get) => ({
  session: null,
  messages: [],
  pendingToolCalls: [],
  pendingActivities: [],
  streamingContent: "",
  thinkingContent: "",
  isStreaming: false,
  activeAgentName: "build",
  selectedModelId: "",
  todos: [],
  _pendingChanges: [],
  _userSelectedAgent: false,
  chatHistory: [],
  chatHistoryIdx: -1,
  chatSessions: loadPersistedSessionSummaries(),
  activeSessionId: null,
  sessionMessages: loadPersistedMessages(),
  sessionAgentName: loadPersistedAgents(),
  planApproval: null,
  sessionVersions: loadPersistedVersions(),
  restoredVersionId: null,
  preRestoreMessages: null,
  pendingAttachments: [],
  compactionSummaries: loadPersistedCompactionSummaries(),
  _compactingSessions: new Set<string>(),

  async setSelectedModel(id) {
    set({ selectedModelId: id });
    if (id) {
      const currentSettings = useSettings.getState().settings;
      if (currentSettings.selectedModel === id) {
        return;
      }
      const { providers } = useModelProviders.getState();
      let matchedProvider: string | undefined;
      for (const p of providers) {
        const m = p.models.find((m) => m.modelId === id);
        if (m) {
          matchedProvider = p.id;
          break;
        }
      }
      await useSettings.getState().updateSettings({
        selectedModel: id,
        ...(matchedProvider ? { selectedProvider: matchedProvider } : {}),
      });
    }
  },
  setTodos(todos) { set({ todos }); },
  updateTodo(id, patch) {
    set((s) => ({ todos: s.todos.map((t) => (t.id === id ? { ...t, ...patch } : t)) }));
  },

  openFile(path) {
    // Look up the actual FileChange from pending tool calls or message fileChanges
    const { pendingToolCalls, messages } = get();
    let change: FileChange | null = null;
    // Check pending tool calls for a diff
    for (const tc of pendingToolCalls) {
      if (tc.diff && tc.diff.filePath === path) {
        change = { path, action: "modified", additions: tc.diff.hunks.reduce((n, h) => n + h.newLines, 0), deletions: tc.diff.hunks.reduce((n, h) => n + h.oldLines, 0) };
        break;
      }
    }
    // Check message fileChanges
    if (!change) {
      for (let i = messages.length - 1; i >= 0; i--) {
        const fc = messages[i].fileChanges;
        if (fc) {
          const found = fc.find((c) => c.path === path);
          if (found) { change = found; break; }
        }
      }
    }
    if (!change) {
      change = { path, action: "modified", additions: 0, deletions: 0 };
    }
    useDiffView.getState().openFile(change);
    useDiffView.getState().setOpen(true);
  },

  async startSession(workspacePath, mode) {
    const api = ensureAcodeAPI();
    if (workspacePath) {
      await initWorkspaceMemory(api, workspacePath);
    }
    const model = useSettings.getState().settings.selectedModel;
    const { sessionId } = await api.agent.startSession({ workspacePath, model, mode });
    const now = Date.now();
    const activeAgentName = useAgents.getState().activeAgentName;
    // Reset user agent selection flag for the new session
    set({ _userSelectedAgent: false });
    const wsName =
      useWorkspace.getState().workspaces.find((w) => w.path === workspacePath)?.name ??
      basename(workspacePath) ??
      workspacePath;
    const summary: ChatSessionSummary = {
      id: sessionId,
      workspacePath,
      workspaceName: wsName,
      title: "New task",
      agentName: activeAgentName,
      mode,
      startedAt: now,
      lastActivityAt: now,
      messageCount: 0,
      status: "idle",
      versionCount: 0,
    };
    set({
      session: {
        id: sessionId,
        workspacePath,
        model,
        mode,
        startedAt: now,
        messages: [],
        status: "idle",
      },
      messages: [],
      pendingToolCalls: [],
      pendingActivities: [],
      todos: [],
      streamingContent: "",
      thinkingContent: "",
      _pendingChanges: [],
      chatSessions: [
        ...get().chatSessions.filter((s) => s.id !== sessionId),
        summary,
      ],
      activeSessionId: sessionId,
      sessionMessages: { ...get().sessionMessages, [sessionId]: [] },
      sessionAgentName: { ...get().sessionAgentName, [sessionId]: activeAgentName },
    });
    // Clean up previous stream listener to prevent ghost events
    api.agent.cleanupStream(sessionId);
    // Register stream listener for this session (single registration)
    api.agent.onStreamEvent(sessionId, (event) => get().appendStream(event));
    savePersistedSessionSummaries(get().chatSessions);
    savePersistedMessages(get().sessionMessages);
    savePersistedAgents(get().sessionAgentName);
  },

  async abort(sessionId) {
    const api = ensureAcodeAPI();
    try {
      await api.agent.abort(sessionId);
    } finally {
      api.agent.cleanupStream(sessionId);
      // Guard against race with newChat — if session was already cleared,
      // don't overwrite the fresh state with stale abort data
      const currentSession = get().session;
      const isStillOurSession = currentSession && currentSession.id === sessionId;
      set({
        isStreaming: false,
        streamingContent: "",
        thinkingContent: "",
        pendingToolCalls: [],
        pendingActivities: [],
        ...(isStillOurSession ? {
          chatSessions: get().chatSessions.map((s) =>
            s.id === sessionId ? { ...s, status: "aborted", lastActivityAt: Date.now() } : s
          ),
          session: { ...currentSession, status: "aborted" },
        } : {}),
      });
    }
  },

  async sendMessage(content) {
    const { isStreaming } = get();
    if (isStreaming) return;

    // Auto-select agent based on prompt content (evolver-inspired adaptive routing)
    // Only auto-select if user hasn't explicitly chosen an agent for this session
    const currentAgent = useAgents.getState().activeAgentName;
    const selectedAgent = autoSelectAgent(content, currentAgent);
    if (selectedAgent !== currentAgent && !get()._userSelectedAgent) {
      useAgents.getState().setActiveAgent(selectedAgent);
    }
    // Note: _userSelectedAgent is NOT reset here. It persists for the session
    // so that user's explicit agent choice isn't overridden by auto-select on
    // subsequent messages. It is reset when starting a new session.

    let { session } = get();
    if (!session) {
      const targetWs = useWorkspace.getState().activeWorkspaceId
        ? useWorkspace.getState().workspaces.find(
            (w) => w.id === useWorkspace.getState().activeWorkspaceId
          )?.path
        : undefined;
      try {
        await get().startSession(targetWs ?? "", useAgents.getState().activeAgentName as import("@acode/shared-types").AgentSessionMode);
      } catch (err) {
        console.error("Failed to start session:", err);
        return;
      }
      session = get().session;
      if (!session) return;
    }
    const { messages } = get();
    const api = ensureAcodeAPI();

    const { pendingAttachments } = get();
    const userMsg: ChatMessage = {
      id: "msg-" + Math.random().toString(36).slice(2, 9),
      role: "user",
      content,
      timestamp: Date.now(),
      ...(pendingAttachments.length > 0 ? { attachments: pendingAttachments } : {}),
    };
    set({
      messages: [...messages, userMsg],
      isStreaming: true,
      streamingContent: "",
      thinkingContent: "",
      pendingToolCalls: [],
      pendingActivities: [],
      pendingAttachments: [],
      restoredVersionId: null,
      preRestoreMessages: null,
      chatSessions: get().chatSessions.map((s) =>
        s.id === session!.id
          ? {
              ...s,
              status: "running",
              lastActivityAt: Date.now(),
              messageCount: messages.length + 1,
              preview: content.length > 60 ? content.slice(0, 57) + "…" : content,
              title:
                s.title && s.title !== "New task"
                  ? s.title
                  : content.length > 50
                    ? content.slice(0, 47) + "…"
                    : content,
          }
          : s
      ),
      sessionMessages: { ...get().sessionMessages, [session!.id]: [...(get().sessionMessages[session!.id] ?? []), userMsg] },
    });
    // Save version AFTER user message is added so the snapshot includes it
    get().saveVersion(session.id, content.length > 60 ? content.slice(0, 57) + "…" : content);
    try {
      const agentName = useAgents.getState().activeAgentName;
      await api.agent.sendPrompt(session.id, content, get().messages, agentName, pendingAttachments);
    } catch (err: unknown) {
      const { isStreaming, session: currentSession } = get();
      // If appendStream already handled the error (streaming ended), don't add duplicate error message
      if (!isStreaming) return;
      const msg = err instanceof Error ? err.message : "Unknown error";
      const errorMsg: ChatMessage = {
        id: "err-" + Math.random().toString(36).slice(2, 9),
        role: "assistant",
        content: `**Error**: ${msg}\n\nCheck your provider settings and try again.`,
        timestamp: Date.now(),
      };
      const sessionId = currentSession?.id;
      if (!sessionId) return;
      const newSessionMessages = { ...get().sessionMessages, [sessionId]: [...(get().sessionMessages[sessionId] ?? []), errorMsg] };
      set({
        isStreaming: false,
        streamingContent: "",
        thinkingContent: "",
        pendingToolCalls: [],
        pendingActivities: [],
        messages: [...get().messages, errorMsg],
        sessionMessages: newSessionMessages,
        chatSessions: get().chatSessions.map((s) =>
          s.id === sessionId ? { ...s, status: "error", lastActivityAt: Date.now() } : s
        ),
      });
      savePersistedMessages(newSessionMessages);
      savePersistedSessionSummaries(get().chatSessions);
    }
  },

  appendStream(event) {
    switch (event.type) {
      case "message-start": {
        // Only reset pendingToolCalls if they are all resolved (completed/failed/denied).
        // Don't clear tools that are still awaiting approval from a previous turn.
        const pending = get().pendingToolCalls;
        const hasUnresolved = pending.some(tc => tc.status === "awaiting-approval" || tc.status === "pending");
        set({
          streamingContent: "",
          thinkingContent: "",
          pendingActivities: [],
          ...(hasUnresolved ? {} : { pendingToolCalls: [] }),
          isStreaming: true,
        });
        break;
      }
      case "message-delta":
        set((s) => {
          const newContent = s.streamingContent + event.content;
          // Truncate at word boundary to avoid splitting XML tags, markdown fences, etc.
          if (newContent.length > 50000) {
            const trimmed = newContent.slice(-50000);
            // Find the first space to avoid cutting mid-word/mid-tag
            const spaceIdx = trimmed.indexOf(" ");
            return { streamingContent: spaceIdx > 0 && spaceIdx < 200 ? trimmed.slice(spaceIdx + 1) : trimmed };
          }
          return { streamingContent: newContent };
        });
        break;
      case "diff-proposed": {
        const proposal = event.proposal;
        set((s) => {
          let idx = -1;
          for (let i = s.pendingToolCalls.length - 1; i >= 0; i--) {
            const tc = s.pendingToolCalls[i];
            if (tc.status === "awaiting-approval" || tc.status === "pending") {
              idx = i;
              break;
            }
          }
          if (idx === -1) return s;
          const updated = [...s.pendingToolCalls];
          updated[idx] = { ...updated[idx], diffId: proposal.diffId, diff: proposal };
          return { pendingToolCalls: updated };
        });
        // Open diff view so user can preview the proposed change,
        // but only if not streaming to avoid hijacking the terminal tab
        if (!get().isStreaming) {
          useDiffView.getState().openFile({
            path: proposal.filePath,
            action: "modified",
            additions: proposal.hunks.reduce((n: number, h: { newLines: number }) => n + h.newLines, 0),
            deletions: proposal.hunks.reduce((n: number, h: { oldLines: number }) => n + h.oldLines, 0),
          });
        }
        break;
      }
      case "message-end": {
        const { messages, streamingContent, thinkingContent, _pendingChanges, todos, pendingToolCalls, pendingActivities, session: liveSession } = get();

        // Tools are already populated in pendingToolCalls via tool-call events
        // emitted by the API layer. Use them as the single source of truth.
        // Clean XML tool call tags from display content only.
        let finalContent = streamingContent;
        const allToolCalls = pendingToolCalls;
        const { toolCalls: xmlToolCalls, cleanedContent } = parseXmlToolCalls(streamingContent);
        if (xmlToolCalls.length > 0 || cleanedContent !== streamingContent) {
          finalContent = cleanedContent;
        }

        // Skip creating a message if there's nothing to show (e.g., error already
        // handled the turn and cleared streamingContent)
        if (!finalContent && allToolCalls.length === 0 && pendingActivities.length === 0 && !thinkingContent) {
          set({ isStreaming: false, pendingToolCalls: [], pendingActivities: [], streamingContent: "", thinkingContent: "" });
          break;
        }

        // If there are pending tool calls, this is an intermediate turn (tools
        // were just executed). Save the current turn's content and clear transient
        // state so the agentic loop can continue streaming.
        if (allToolCalls.length > 0) {
          const intermediateMsg: ChatMessage = {
            id: event.messageId,
            role: "assistant",
            content: finalContent,
            timestamp: Date.now(),
            ...(thinkingContent ? { thinking: thinkingContent } : {}),
            ...(allToolCalls.length > 0 ? { toolCalls: allToolCalls } : {}),
            ...(pendingActivities.length > 0 ? { activities: [...pendingActivities] } : {}),
          };
          const sessionId = get().activeSessionId;
          const newSessionMessages = sessionId
            ? { ...get().sessionMessages, [sessionId]: [...(get().sessionMessages[sessionId] ?? []), intermediateMsg] }
            : get().sessionMessages;
          set({
            messages: [...get().messages, intermediateMsg],
            sessionMessages: newSessionMessages,
            streamingContent: "",
            thinkingContent: "",
            _pendingChanges: [],
            pendingToolCalls: [],
            pendingActivities: [],
          });
          if (sessionId) savePersistedMessages(newSessionMessages);
          break;
        }

        const planComplete = useAgents.getState().activeAgentName === "plan" && finalContent.includes("[PLAN_COMPLETE]");
        const assistantMsg: ChatMessage = {
          id: event.messageId,
          role: "assistant",
          content: finalContent,
          timestamp: Date.now(),
          ...(thinkingContent ? { thinking: thinkingContent } : {}),
          ...(todos.length > 0 ? { todos: [...todos] } : {}),
          ...(_pendingChanges.length > 0 ? { fileChanges: [..._pendingChanges] } : {}),
          ...(allToolCalls.length > 0 ? { toolCalls: allToolCalls } : {}),
          ...(pendingActivities.length > 0 ? { activities: [...pendingActivities] } : {}),
        };
        const api = ensureAcodeAPI();
        const sessionId = get().activeSessionId;
        if (sessionId) api.agent.cleanupStream(sessionId);
        const newSessionMessages = sessionId
          ? { ...get().sessionMessages, [sessionId]: [...(get().sessionMessages[sessionId] ?? []), assistantMsg] }
          : get().sessionMessages;
        set({
          messages: [...messages, assistantMsg],
          sessionMessages: newSessionMessages,
          streamingContent: "",
          thinkingContent: "",
          isStreaming: false,
          _pendingChanges: [],
          pendingToolCalls: [],
          pendingActivities: [],
          ...(planComplete ? { planApproval: { planContent: finalContent, status: "pending" } } : {}),
          chatSessions: liveSession
            ? get().chatSessions.map((s) =>
                s.id === liveSession.id
                  ? { ...s, status: "completed", lastActivityAt: Date.now() }
                  : s
              )
            : get().chatSessions,
        });
        savePersistedMessages(newSessionMessages);
        savePersistedSessionSummaries(get().chatSessions);
        if (sessionId) {
          void get().compactSessionHistory(sessionId);
          // Record successful agent selection for learning
          const lastUserMsg = messages.filter(m => m.role === "user").pop();
          if (lastUserMsg) {
            recordAgentSelection(lastUserMsg.content, useAgents.getState().activeAgentName, true);
          }
        }
        break;
      }
      case "tool-call": {
        const tool = event.toolCall;
        const existing = get().pendingToolCalls.some((tc) => tc.id === tool.id);
        if (existing) break;
        // Canonicalize bash commands for permission matching
        const isBashTool = tool.name === "shell" || tool.name === "bash" || tool.name === "execute";
        const commandStr = typeof tool.args.command === "string" ? tool.args.command : "";
        const canonicalPattern = isBashTool && commandStr ? canonicaliseBashCommand(commandStr) : tool.name;
        // Map tool names to permission keys
        const permissionKey: PermissionKind = EDIT_TOOLS.has(tool.name)
          ? "edit"
          : BASH_TOOLS.has(tool.name)
            ? "bash"
            : NETWORK_TOOLS.has(tool.name)
              ? "network"
              : tool.name.startsWith("mcp_")
                ? "mcp"
                : "edit";
        const agentAction = useAgents.getState().evaluatePermission(permissionKey, canonicalPattern);
        const needsApproval = agentAction === "ask";
        const denied = agentAction === "deny";
        // Auto-denied tools: mark as failed and don't add to pendingToolCalls
        if (denied) {
          const deniedTool = { ...tool, status: "failed" as const, result: "Denied by permission policy" };
          set((s) => ({ pendingToolCalls: [...s.pendingToolCalls, deniedTool] }));
          // Auto-remove denied tools from UI after a short delay
          setTimeout(() => {
            set((s) => ({ pendingToolCalls: s.pendingToolCalls.filter((tc) => tc.id !== tool.id) }));
          }, 2000);
          break;
        }
        const annotated: typeof tool = needsApproval
          ? { ...tool, status: "awaiting-approval" as const }
          : tool;
        set((s) => ({ pendingToolCalls: [...s.pendingToolCalls, annotated] }));
        if (needsApproval) {
          const description = `ACode (${useAgents.getState().activeAgentName} agent) wants to use \`${tool.name}\`.`;
          const activeSession = get().session;
          void usePermission.getState().ask({
            kind: permissionKey,
            title: tool.name,
            description,
            ...(commandStr ? { command: commandStr } : {}),
            ...(activeSession?.workspacePath ? { workspacePath: activeSession.workspacePath } : {}),
          }).then((decision) => {
            get().resolveToolApproval(tool.id, decision === "allow" || decision === "always" ? "approved" : "denied");
          });
        } else {
          get().resolveToolApproval(tool.id, "approved");
        }
        break;
      }
      case "tool-result":
        set((s) => ({
          pendingToolCalls: s.pendingToolCalls.map((tc) =>
            tc.id === event.toolCallId
              ? {
                  ...tc,
                  status: typeof event.result === "string" && event.result.startsWith("Error:") ? "failed" as const : "completed" as const,
                  result: event.result,
                }
              : tc
          ),
        }));
        break;
      case "file-changed": {
        const { isStreaming } = get();
        if (isStreaming) {
          set((s) => ({
            _pendingChanges: [...(s._pendingChanges ?? []), event.change],
          }));
        } else {
          // Find the last assistant message to attach file changes to.
          // Walk backwards to find it even if tool results are at the end.
          set((s) => {
            let lastAssistantIdx = -1;
            for (let i = s.messages.length - 1; i >= 0; i--) {
              if (s.messages[i].role === "assistant") {
                lastAssistantIdx = i;
                break;
              }
            }
            if (lastAssistantIdx === -1) return s;
            return {
              messages: s.messages.map((m, i) =>
                i === lastAssistantIdx
                  ? { ...m, fileChanges: [...(m.fileChanges ?? []), event.change] }
                  : m
              ),
            };
          });
        }
        // Only open diff view when not streaming — during streaming, changes
        // accumulate in _pendingChanges and open when the turn completes
        if (!get().isStreaming) {
          useDiffView.getState().openFile(event.change);
        }
        break;
      }
      case "todo-update": {
        set((s) => {
          const last = s.messages[s.messages.length - 1];
          const updatedMessages = last && last.role === "assistant"
            ? s.messages.map((m, i) =>
                i === s.messages.length - 1
                  ? { ...m, todos: event.todos }
                  : m
              )
            : s.messages;
          return { todos: event.todos, messages: updatedMessages };
        });
        break;
      }
      case "activity-think": {
        set((s) => ({
          pendingActivities: [...s.pendingActivities, { type: "think" as const, content: event.content }].slice(-500) as typeof s.pendingActivities,
          thinkingContent: (s.thinkingContent + (s.thinkingContent ? "\n" : "") + event.content).slice(-100000),
        }));
        break;
      }
      case "activity-explore": {
        set((s) => ({
          pendingActivities: [
            ...s.pendingActivities,
            {
              type: "explore" as const,
              query: event.query,
              ...(event.kind ? { kind: event.kind } : {}),
              matches: event.matches,
            },
          ].slice(-500) as typeof s.pendingActivities,
        }));
        break;
      }
      case "activity-read": {
        set((s) => ({
          pendingActivities: [
            ...s.pendingActivities,
            {
              type: "read" as const,
              path: event.path,
              content: event.content,
              ...(event.lineRange ? { lineRange: event.lineRange } : {}),
            },
          ].slice(-500) as typeof s.pendingActivities,
        }));
        break;
      }
      case "activity-skill": {
        set((s) => ({
          pendingActivities: [
            ...s.pendingActivities,
            {
              type: "skill" as const,
              name: event.name,
              content: event.content,
              ...(event.args ? { args: event.args } : {}),
            },
          ].slice(-500) as typeof s.pendingActivities,
        }));
        break;
      }
      case "activity-bash": {
        set((s) => ({
          pendingActivities: [
            ...s.pendingActivities,
            { type: "bash" as const, command: event.command, result: event.result },
          ].slice(-500) as typeof s.pendingActivities,
        }));
        break;
      }
      case "activity-plan": {
        set((s) => ({
          pendingActivities: [
            ...s.pendingActivities,
            { type: "plan" as const, plan: event.plan },
          ].slice(-500) as typeof s.pendingActivities,
        }));
        break;
      }
      case "thinking":
        set((s) => ({ thinkingContent: (s.thinkingContent + (s.thinkingContent ? "\n" : "") + event.content).slice(-100000) }));
        break;
      case "status":
        set((s) => ({
          session: s.session ? { ...s.session, status: event.status } : s.session,
          chatSessions: s.session
            ? s.chatSessions.map((cs) =>
                cs.id === s.session!.id
                  ? { ...cs, status: event.status, lastActivityAt: Date.now() }
                  : cs
              )
            : s.chatSessions,
        }));
        break;
      case "ask-permission": {
        const permKind = (["bash", "edit", "network", "mcp"] as const).includes(event.kind as any) ? (event.kind as "bash" | "edit" | "network" | "mcp") : "bash";
        usePermission.getState().ask({
          kind: permKind,
          title: "Permission required",
          description: event.description ?? `ACode wants to run: ${event.kind}`,
          ...(event.command ? { command: event.command } : {}),
        }).then((decision) => {
          if (event.toolCallId) {
            get().resolveToolApproval(event.toolCallId, decision === "allow" || decision === "always" ? "approved" : "denied");
          }
        });
        break;
      }
      case "ask-question": {
        void useQuestion.getState().ask({
          header: event.header,
          question: event.question,
          options: event.options,
        }).catch((err) => console.error("ask-question error:", err));
        break;
      }
      case "error": {
        const sessionId = get().activeSessionId;
        const errorMsg: ChatMessage = {
          id: "err-" + Math.random().toString(36).slice(2, 9),
          role: "assistant",
          content: `**Error**: ${event.error}\n\nCheck your provider settings and try again.`,
          timestamp: Date.now(),
        };
        const newSessionMessages = sessionId
          ? { ...get().sessionMessages, [sessionId]: [...(get().sessionMessages[sessionId] ?? []), errorMsg] }
          : get().sessionMessages;
        set((s) => ({
          isStreaming: false,
          streamingContent: "",
          thinkingContent: "",
          pendingToolCalls: [],
          pendingActivities: [],
          messages: [...s.messages, errorMsg],
          sessionMessages: newSessionMessages,
          chatSessions: s.session
            ? s.chatSessions.map((cs) =>
                cs.id === s.session!.id
                  ? { ...cs, status: "error", lastActivityAt: Date.now() }
                  : cs
              )
            : s.chatSessions,
        }));
        if (sessionId) {
          savePersistedMessages(newSessionMessages);
          savePersistedSessionSummaries(get().chatSessions);
        }
        break;
      }
      default:
        console.warn("Unknown stream event type:", (event as any).type);
        break;
    }
  },

  reset() {
    set({
      session: null,
      messages: [],
      streamingContent: "",
      thinkingContent: "",
      isStreaming: false,
      pendingToolCalls: [],
      pendingActivities: [],
      todos: [],
      _pendingChanges: [],
      activeSessionId: null,
      restoredVersionId: null,
      preRestoreMessages: null,
    });
  },

  setActiveSession(id) {
    const { session, abort, sessionMessages, sessionAgentName, isStreaming } = get();
    // Only abort if the current session is actually streaming
    if (session && isStreaming) abort(session.id);
    if (!id) {
      set({
        activeSessionId: null,
        messages: [],
        isStreaming: false,
        streamingContent: "",
        thinkingContent: "",
        pendingToolCalls: [],
        pendingActivities: [],
        pendingAttachments: [],
        restoredVersionId: null,
        preRestoreMessages: null,
      });
      return;
    }
    const messages = sessionMessages[id] ?? [];
    const agent = sessionAgentName[id] ?? "build";
    useAgents.getState().setActiveAgent(agent);
    // Reconstruct the AgentSession object from stored data
    const chatSession = get().chatSessions.find((cs) => cs.id === id);
    const restoredSession: AgentSession | null = chatSession
      ? {
          id: chatSession.id,
          workspacePath: chatSession.workspacePath,
          model: useSettings.getState().settings.selectedModel,
          mode: chatSession.mode,
          startedAt: chatSession.startedAt,
          messages,
          status: chatSession.status === "completed" ? "idle" : chatSession.status,
        }
      : null;
    set({
      activeSessionId: id,
      session: restoredSession,
      messages,
      isStreaming: false,
      streamingContent: "",
      thinkingContent: "",
      pendingToolCalls: [],
      pendingActivities: [],
      pendingAttachments: [],
      restoredVersionId: null,
      planApproval: null,
      preRestoreMessages: null,
    });
  },

  renameSession(id, title) {
    set((s) => {
      const newSessions = s.chatSessions.map((cs) =>
        cs.id === id ? { ...cs, title } : cs
      );
      savePersistedSessionSummaries(newSessions);
      return { chatSessions: newSessions };
    });
  },

  setSessionStatus(id, status) {
    set((s) => {
      const newSessions = s.chatSessions.map((cs) =>
        cs.id === id ? { ...cs, status, lastActivityAt: Date.now() } : cs
      );
      savePersistedSessionSummaries(newSessions);
      return { chatSessions: newSessions };
    });
  },

  removeSession(id) {
    const api = ensureAcodeAPI();
    void get().abort(id).catch(() => {});
    api.agent.cleanupStream(id);
    set((s) => {
      const { [id]: _, ...restVersions } = s.sessionVersions;
      const { [id]: __, ...restMessages } = s.sessionMessages;
      const { [id]: ___, ...restAgents } = s.sessionAgentName;
      const { [id]: ____, ...restCompaction } = s.compactionSummaries;
      const newSessions = s.chatSessions.filter((cs) => cs.id !== id);
      savePersistedVersions(restVersions);
      savePersistedMessages(restMessages);
      savePersistedAgents(restAgents);
      savePersistedSessionSummaries(newSessions);
      
      const isActive = s.activeSessionId === id;
      return {
        chatSessions: newSessions,
        activeSessionId: isActive ? null : s.activeSessionId,
        sessionVersions: restVersions,
        sessionMessages: restMessages,
        sessionAgentName: restAgents,
        compactionSummaries: restCompaction,
        ...(isActive ? {
          messages: [],
          isStreaming: false,
          streamingContent: "",
          thinkingContent: "",
          pendingToolCalls: [],
          pendingActivities: [],
          pendingAttachments: [],
          restoredVersionId: null,
          preRestoreMessages: null,
          session: null,
        } : {}),
      };
    });
  },

  approvePlan() {
    const { planApproval } = get();
    if (!planApproval) return;
    set({ planApproval: null });
    // Switch to build mode — permissions auto-approve for file writes
    useAgents.getState().setActiveAgent("build");
    const planMsg = planApproval.planContent.replace(/\[PLAN_COMPLETE\]/g, "").trim();
    // Save the plan as a version checkpoint before switching
    const { activeSessionId } = get();
    if (activeSessionId) {
      get().saveVersion(activeSessionId, "Plan approved");
    }
    const result = get().sendMessage(`Plan approved. Now execute this plan step by step. Write each step as you complete it:\n\n${planMsg}`);
    if (result instanceof Promise) {
      result.catch((err) => {
        console.error("Failed to send plan approval message:", err);
      });
    }
  },

  rejectPlan() {
    const { planApproval, activeSessionId } = get();
    if (planApproval && activeSessionId) {
      // Save the rejected plan as a version so user can go back
      get().saveVersion(activeSessionId, "Plan rejected — replan");
    }
    set({ planApproval: null });
    // Keep user in plan mode so they can provide feedback and the AI can replan
  },

  addPendingAttachment(file) {
    set((s) => ({ pendingAttachments: [...s.pendingAttachments, file] }));
  },

  removePendingAttachment(id) {
    set((s) => ({ pendingAttachments: s.pendingAttachments.filter((a) => a.id !== id) }));
  },

  clearPendingAttachments() {
    set({ pendingAttachments: [] });
  },

  injectSystemMessage(content) {
    const sessionId = get().activeSessionId;
    if (!sessionId) return;
    const sysMsg: ChatMessage = {
      id: "sys-" + Math.random().toString(36).slice(2, 9),
      role: "system",
      content,
      timestamp: Date.now(),
    };
    const newSessionMessages = {
      ...get().sessionMessages,
      [sessionId]: [...(get().sessionMessages[sessionId] ?? []), sysMsg]
    };
    set((s) => ({
      messages: [...s.messages, sysMsg],
      sessionMessages: newSessionMessages,
    }));
    savePersistedMessages(newSessionMessages);
  },

  saveVersion(sessionId, label) {
    const { messages, sessionVersions } = get();
    if (!messages.length) return;
    const versions = sessionVersions[sessionId] ?? [];
    const parentId = versions.length > 0 ? versions[versions.length - 1].id : undefined;
    const version: import("@acode/shared-types").ChatVersion = {
      id: "ver-" + Math.random().toString(36).slice(2, 9),
      sessionId,
      label,
      messages: [...messages],
      timestamp: Date.now(),
      parentVersionId: parentId,
    };
    // Cap at 50 versions per session to prevent localStorage bloat
    const newVersions = [...versions, version].slice(-50);
    const newSessionVersions = { ...sessionVersions, [sessionId]: newVersions };
    set({
      sessionVersions: newSessionVersions,
      chatSessions: get().chatSessions.map((s) =>
        s.id === sessionId ? { ...s, versionCount: newVersions.length } : s
      ),
    });
    savePersistedVersions(newSessionVersions);
    savePersistedSessionSummaries(get().chatSessions);
  },

  restoreVersion(sessionId, versionId) {
    const { messages, sessionVersions, sessionMessages } = get();
    const versions = sessionVersions[sessionId];
    if (!versions) return;
    const version = versions.find((v) => v.id === versionId);
    if (!version) return;
    const newSessionMessages = { ...sessionMessages, [sessionId]: [...version.messages] };
    set({
      preRestoreMessages: [...messages],
      messages: [...version.messages],
      sessionMessages: newSessionMessages,
      restoredVersionId: versionId,
      streamingContent: "",
      thinkingContent: "",
      pendingToolCalls: [],
      pendingActivities: [],
      planApproval: null,
    });
    savePersistedMessages(newSessionMessages);
    useWorkspace.getState().setActiveFile(null);
  },

  confirmVersionRestore() {
    set({ restoredVersionId: null, preRestoreMessages: null });
  },

  cancelVersionRestore() {
    const { preRestoreMessages, activeSessionId, sessionMessages } = get();
    if (!preRestoreMessages || !activeSessionId) return;
    const newSessionMessages = { ...sessionMessages, [activeSessionId]: [...preRestoreMessages] };
    set({
      messages: [...preRestoreMessages],
      sessionMessages: newSessionMessages,
      restoredVersionId: null,
      preRestoreMessages: null,
    });
    savePersistedMessages(newSessionMessages);
  },

  deleteVersion(sessionId, versionId) {
    set((s) => {
      const versions = (s.sessionVersions[sessionId] ?? []).filter((v) => v.id !== versionId);
      const newSessionVersions = { ...s.sessionVersions, [sessionId]: versions };
      savePersistedVersions(newSessionVersions);
      return {
        sessionVersions: newSessionVersions,
        chatSessions: s.chatSessions.map((ss) =>
          ss.id === sessionId ? { ...ss, versionCount: versions.length } : ss
        ),
        ...(s.restoredVersionId === versionId ? { restoredVersionId: null, preRestoreMessages: null } : {}),
      };
    });
  },

  async compactSessionHistory(sessionId) {
    const { sessionMessages, selectedModelId, compactionSummaries, _compactingSessions } = get();
    if (_compactingSessions.has(sessionId)) return;
    const messages = sessionMessages[sessionId];
    if (!messages || messages.length <= 6) return;

    // Create new Set first to avoid mutating the existing one
    const nextCompacting = new Set(_compactingSessions);
    nextCompacting.add(sessionId);
    set({ _compactingSessions: nextCompacting });

    try {
      // Look up the model's actual context window
      const modelId = selectedModelId || useSettings.getState().settings.selectedModel;
      const allModels = useModelProviders.getState().getAllModels();
      const found = allModels.find((m) => m.model.modelId === modelId);
      const maxContext = parseContextWindow(found?.model.contextWindow);

      // Use context manager to determine what to compact
      const stats = computeContextStats(messages, maxContext);
      if (!stats.needsCompaction) return;

      // Prune old tool outputs before summarization to reduce input size
      const activeMessages = stats.shouldPrune
        ? pruneToolOutputs(messages).pruned
        : messages;

      const { toCompact } = selectMessagesForCompaction(activeMessages, 6);
      if (toCompact.length === 0) return;

      const api = ensureAcodeAPI();
      const previousSummary = compactionSummaries[sessionId];

      // Use the structured SUMMARY_TEMPLATE format (Goal/Instructions/Discoveries/Accomplished)
      // Pass raw ChatMessage[] directly — buildCompactionPrompt handles role mapping internally
      const compactionMessages = buildCompactionPrompt(toCompact, previousSummary);

      const model = selectedModelId || useSettings.getState().settings.selectedModel;
      const summary = await api.agent.summarizeMessages(model, compactionMessages);
      if (summary) {
        set((s) => {
          const next = { ...s.compactionSummaries, [sessionId]: summary };
          savePersistedCompactionSummaries(next);
          return { compactionSummaries: next };
        });
      }
    } catch (e) {
      console.warn("Background compaction failed:", e);
    } finally {
      const remaining = new Set(get()._compactingSessions);
      remaining.delete(sessionId);
      set({ _compactingSessions: remaining });
    }
  },

  async resolveToolApproval(toolCallId, decision, result) {
    const api = ensureAcodeAPI();
    const sessionId = get().activeSessionId;
    const tool = get().pendingToolCalls.find((tc) => tc.id === toolCallId);
    if (decision === "approved" && sessionId && tool?.diffId) {
      try {
        await api.agent.approveDiff(sessionId, tool.diffId);
      } catch (err) {
        console.error("Failed to approve diff:", err);
        set((s) => ({
          pendingToolCalls: s.pendingToolCalls.map((tc) =>
            tc.id === toolCallId ? { ...tc, status: "failed" as const, result: `Diff approval failed: ${err}` } : tc
          ),
        }));
        return;
      }
    } else if (decision === "denied" && sessionId && tool?.diffId) {
      try {
        await api.agent.rejectDiff(sessionId, tool.diffId);
      } catch (err) {
        console.error("Failed to reject diff:", err);
      }
    }
    set((s) => ({
      pendingToolCalls: s.pendingToolCalls.map((tc) =>
        tc.id === toolCallId
          ? {
              ...tc,
              status: decision === "approved" ? "completed" : "failed",
              result: result ?? (decision === "denied" ? "Denied by user" : undefined),
            }
          : tc
      ),
    }));
  },

  newChat() {
    const { session, abort, messages } = get();
    if (session && messages.length > 0) {
      get().saveVersion(session.id, "Session checkpoint");
    }
    if (session) abort(session.id);
    const { chatHistory, chatHistoryIdx, chatSessions } = get();
    const trimmedHistory = chatHistoryIdx >= 0
      ? chatHistory.slice(0, chatHistoryIdx + 1)
      : chatHistory;
    const newHistory = messages.length > 0
      ? [...trimmedHistory, messages].slice(-20)
      : trimmedHistory;
    const finalizedSessions = session && messages.length > 0
      ? chatSessions.map((cs) =>
          cs.id === session.id
            ? {
                ...cs,
                status: cs.status === "running" ? ("completed" as const) : cs.status,
                lastActivityAt: Date.now(),
              }
            : cs
        )
      : chatSessions;
    set({
      chatHistory: newHistory,
      chatHistoryIdx: -1,
      messages: [],
      pendingToolCalls: [],
      pendingActivities: [],
      streamingContent: "",
      thinkingContent: "",
      isStreaming: false,
      _pendingChanges: [],
      pendingAttachments: [],
      session: null,
      activeSessionId: null,
      chatSessions: finalizedSessions,
      planApproval: null,
      restoredVersionId: null,
      preRestoreMessages: null,
    });
    savePersistedSessionSummaries(finalizedSessions);
  },

  goBackChat() {
    const { isStreaming, chatHistory, chatHistoryIdx, messages } = get();
    if (isStreaming) return false;
    const msgs = messages ?? [];
    if (chatHistoryIdx === -1) {
      if (chatHistory.length === 0) return false;
      const lastHist = chatHistory[chatHistory.length - 1];
      const matchesLast = lastHist && lastHist.length === msgs.length && lastHist.every((m, i) => m.id === msgs[i]?.id);
      const newHistory = msgs.length > 0 && !matchesLast ? [...chatHistory, msgs] : chatHistory;
      const targetIdx = msgs.length > 0 && !matchesLast ? Math.max(0, newHistory.length - 2) : newHistory.length - 1;
      if (targetIdx < 0 || targetIdx >= newHistory.length) return false;
      set({
        chatHistory: newHistory,
        chatHistoryIdx: targetIdx,
        messages: newHistory[targetIdx] ?? [],
        pendingToolCalls: [],
        streamingContent: "",
        thinkingContent: "",
        isStreaming: false,
        _pendingChanges: [],
      });
      return true;
    }
    if (chatHistoryIdx <= 0) return false;
    const newIdx = chatHistoryIdx - 1;
    set({
      chatHistoryIdx: newIdx,
      messages: chatHistory[newIdx] ?? [],
      pendingToolCalls: [],
      streamingContent: "",
      thinkingContent: "",
      isStreaming: false,
      _pendingChanges: [],
    });
    return true;
  },

  goForwardChat() {
    const { isStreaming, chatHistory, chatHistoryIdx } = get();
    if (isStreaming) return false;
    if (chatHistoryIdx < 0 || chatHistoryIdx >= chatHistory.length - 1) return false;
    const newIdx = chatHistoryIdx + 1;
    set({
      chatHistoryIdx: newIdx,
      messages: chatHistory[newIdx] ?? [],
      pendingToolCalls: [],
      streamingContent: "",
      thinkingContent: "",
      isStreaming: false,
      _pendingChanges: [],
    });
    return true;
  },
}));

type TerminalState = {
  tabs: TerminalTab[];
  activeTabId: string | null;
  output: Record<string, string>;
  addTab: (cwd: string) => void;
  closeTab: (id: string) => void;
  setActiveTab: (id: string) => void;
  appendOutput: (id: string, data: string) => void;
};

export const useTerminal = create<TerminalState>((set) => ({
  tabs: [{ id: "t-1", title: "zsh", cwd: process.cwd() }],
  activeTabId: "t-1",
  output: {},
  addTab(cwd) {
    set((s) => {
      const id = "t-" + Math.random().toString(36).slice(2, 9);
      return {
        tabs: [...s.tabs, { id, title: "zsh", cwd }],
        activeTabId: id,
      };
    });
  },
  closeTab(id) {
    set((s) => {
      const remaining = s.tabs.filter((t) => t.id !== id);
      const newActive =
        s.activeTabId === id ? remaining[0]?.id ?? null : s.activeTabId;
      const { [id]: _, ...rest } = s.output;
      return { tabs: remaining, activeTabId: newActive, output: rest };
    });
  },
  setActiveTab(id) {
    set({ activeTabId: id });
  },
  appendOutput(id, data) {
    set((s) => ({
      output: { ...s.output, [id]: ((s.output[id] ?? "") + data).slice(-102400) },
    }));
  },
}));

type SkillsMcpState = {
  skills: Skill[];
  mcpServers: McpServer[];
  toggleSkill: (name: string) => void;
  toggleMcp: (name: string) => void;
  addSkill: (skill: Omit<Skill, "enabled" | "source">) => void;
  removeSkill: (name: string) => void;
  addMcpServer: (server: Omit<McpServer, "enabled" | "status">) => void;
  removeMcpServer: (name: string) => void;
  connectMcpServer: (name: string) => Promise<void>;
  disconnectMcpServer: (name: string) => Promise<void>;
};

const MCP_STORAGE_KEY = "acode.mcpServers.v1";
const USER_SKILLS_STORAGE_KEY = "acode.userSkills.v1";
const BUNDLED_SKILLS_STORAGE_KEY = "acode.bundledSkillsStates.v1";

function saveMcpServers(servers: McpServer[]) {
  const userServers = servers
    .filter((m) => m.scope !== "project")
    .map(({ status, tools, error, ...rest }) => ({
      ...rest,
      status: "disconnected" as const,
    }));
  localStorage.setItem(MCP_STORAGE_KEY, JSON.stringify(userServers));
  void saveWorkspaceData();
}

function loadMcpServers(): McpServer[] {
  try {
    const raw = localStorage.getItem(MCP_STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return [];
}

function loadSkills(): Skill[] {
  const registrySkills = skillRegistry.list();
  const defaultBundledStates = BUNDLED_SKILLS.reduce((acc, bs) => {
    acc[bs.name] = true;
    return acc;
  }, {} as Record<string, boolean>);

  let loadedBundledStates = defaultBundledStates;
  try {
    const raw = localStorage.getItem(BUNDLED_SKILLS_STORAGE_KEY);
    if (raw) {
      loadedBundledStates = { ...defaultBundledStates, ...JSON.parse(raw) };
    }
  } catch {}

  const mappedRegistrySkills: Skill[] = registrySkills.map((rs) => {
    const isBundled = rs.source === "bundled";
    const isProject = rs.source === "project";
    return {
      name: rs.name,
      description: rs.description,
      prompt: rs.content,
      enabled: isProject ? true : (loadedBundledStates[rs.name] ?? true),
      scope: isProject ? "workspace" : "global",
      source: isProject ? "project" : isBundled ? "bundled" : "user",
    };
  });

  let userSkills: Skill[] = [];
  try {
    const raw = localStorage.getItem(USER_SKILLS_STORAGE_KEY);
    if (raw) {
      userSkills = JSON.parse(raw);
    }
  } catch {}

  const merged = [...mappedRegistrySkills];
  for (const us of userSkills) {
    const idx = merged.findIndex((m) => m.name.toLowerCase() === us.name.toLowerCase());
    if (idx >= 0) {
      merged[idx] = us;
    } else {
      merged.push(us);
    }
  }

  return merged;
}

const queryStdioTools = async (commandName: string, commandArgs: string[], env?: Record<string, string>): Promise<{ name: string; description: string }[]> => {
  const { Command } = await import("@tauri-apps/plugin-shell");
  const cmd = Command.create(commandName, commandArgs, { env });
  let outputBuffer = "";

  return new Promise<{ name: string; description: string }[]>((resolve, reject) => {
    let resolved = false;

    const stdoutHandler = (data: string) => {
      outputBuffer += data;
      // Try to parse the entire buffer as a single JSON-RPC message
      // (MCP responses may be multi-line JSON)
      const trimmed = outputBuffer.trim();
      if (trimmed.startsWith("{")) {
        try {
          const parsed = JSON.parse(trimmed);
          if (parsed.result?.tools || parsed.tools) {
            resolved = true;
            cleanup();
            resolve(parsed.result?.tools || parsed.tools);
            outputBuffer = "";
          }
        } catch {
          // Incomplete JSON — wait for more data
        }
      }
    };

    const stderrHandler = (data: string) => {
      console.warn("MCP Server Stderr:", data);
    };

    const cleanup = () => {
      cmd.stdout.removeListener("data", stdoutHandler);
      cmd.stderr.removeListener("data", stderrHandler);
    };

    cmd.stdout.on("data", stdoutHandler);
    cmd.stderr.on("data", stderrHandler);

    void cmd.spawn().then(async (child) => {
      const req = JSON.stringify({ jsonrpc: "2.0", method: "tools/list", params: {}, id: 1 }) + "\n";
      await child.write(req);

      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          cleanup();
          child.kill().catch(() => {});
          reject(new Error("Timeout waiting for tools/list response (15s)"));
        }
      }, 15000);
    }).catch((err) => {
      cleanup();
      reject(err);
    });
  });
};

export const useSkillsMcp = create<SkillsMcpState>((set, get) => ({
  skills: loadSkills(),
  mcpServers: loadMcpServers(),
  toggleSkill(name) {
    set((s) => {
      const nextSkills = s.skills.map((sk) =>
        sk.name === name ? { ...sk, enabled: !sk.enabled } : sk
      );
      const bundledStates: Record<string, boolean> = {};
      const userSkillsOnly: Skill[] = [];
      nextSkills.forEach((sk) => {
        if (sk.source === "bundled") {
          bundledStates[sk.name] = sk.enabled;
        } else {
          userSkillsOnly.push(sk);
        }
      });
      localStorage.setItem(BUNDLED_SKILLS_STORAGE_KEY, JSON.stringify(bundledStates));
      localStorage.setItem(USER_SKILLS_STORAGE_KEY, JSON.stringify(userSkillsOnly));
      return { skills: nextSkills };
    });
  },
  toggleMcp(name) {
    set((s) => {
      const next = s.mcpServers.map((m) =>
        m.name === name ? { ...m, enabled: !m.enabled } : m
      );
      saveMcpServers(next);
      return { mcpServers: next };
    });
    const server = get().mcpServers.find((m) => m.name === name);
    if (server) {
      if (server.enabled) {
        get().connectMcpServer(name);
      } else {
        get().disconnectMcpServer(name);
      }
    }
  },
  addSkill(skill) {
    set((s) => {
      if (s.skills.some((sk) => sk.name === skill.name)) return s;
      const nextSkills = [...s.skills, { ...skill, enabled: true, source: "user" as const }];
      const userSkillsOnly = nextSkills.filter(sk => sk.source === "user");
      localStorage.setItem(USER_SKILLS_STORAGE_KEY, JSON.stringify(userSkillsOnly));
      return { skills: nextSkills };
    });
  },
  removeSkill(name) {
    set((s) => {
      const nextSkills = s.skills.filter((sk) => sk.name !== name);
      const userSkillsOnly = nextSkills.filter(sk => sk.source === "user");
      localStorage.setItem(USER_SKILLS_STORAGE_KEY, JSON.stringify(userSkillsOnly));
      return { skills: nextSkills };
    });
  },
  addMcpServer(server) {
    set((s) => {
      if (s.mcpServers.some((m) => m.name === server.name)) return s;
      const newServer: McpServer = { scope: "user", ...server, enabled: true, status: "disconnected" };
      const next = [...s.mcpServers, newServer];
      saveMcpServers(next);
      return { mcpServers: next };
    });
    get().connectMcpServer(server.name);
  },
  removeMcpServer(name) {
    set((s) => {
      const next = s.mcpServers.filter((m) => m.name !== name);
      saveMcpServers(next);
      return { mcpServers: next };
    });
  },
  async connectMcpServer(name) {
    set((s) => ({
      mcpServers: s.mcpServers.map((m) =>
        m.name === name ? { ...m, status: "connecting", error: undefined } : m
      ),
    }));

    const server = get().mcpServers.find((m) => m.name === name);
    if (!server) return;

    try {
      let tools: { name: string; description: string }[] = [];
      if (server.transport === "http") {
        const url = server.url;
        if (!url) throw new Error("HTTP Endpoint URL is required");
        const resp = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", params: {}, id: 1 }),
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const json = await resp.json();
        tools = json.result?.tools || json.tools || [];
      } else {
        const command = server.command;
        if (!command) throw new Error("Stdio command is required");
        tools = await queryStdioTools(command, server.args ?? [], server.env);
      }

      set((s) => ({
        mcpServers: s.mcpServers.map((m) =>
          m.name === name ? { ...m, status: "connected", tools, error: undefined } : m
        ),
      }));
    } catch (err: any) {
      const errorMsg = err?.message || String(err);
      console.error(`MCP server "${name}" connection failed:`, errorMsg);
      set((s) => ({
        mcpServers: s.mcpServers.map((m) =>
          m.name === name ? { ...m, status: "error", error: errorMsg } : m
        ),
      }));
    }
  },
  async disconnectMcpServer(name) {
    set((s) => ({
      mcpServers: s.mcpServers.map((m) =>
        m.name === name ? { ...m, status: "disconnected", tools: [] } : m
      ),
    }));
  },
}));

// Automatically sync useSkillsMcp state with skillRegistry updates
skillRegistry.subscribe(() => {
  useSkillsMcp.setState({ skills: loadSkills() });
});

export type SettingsTab =
  | "general"
  | "code-preview"
  | "models"
  | "agents"
  | "permissions"
  | "instructions"
  | "skills"
  | "mcp"
  | "memory-graph"
  | "plugins"
  | "commands"
  | "indexing"
  | "onboard";

export type ModelProvider = {
  id: string;
  name: string;
  type: "built-in" | "custom";
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
  apiFormat: "openai" | "anthropic";
  models: { name: string; modelId: string; contextWindow: string; connected?: boolean; enabled?: boolean }[];
};

const PROVIDERS_STORAGE_KEY = "acode.providers.v1";

function loadProviders(): ModelProvider[] {
  try {
    const raw = localStorage.getItem(PROVIDERS_STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return DEFAULT_PROVIDERS;
}

function saveProviders(providers: ModelProvider[]) {
  localStorage.setItem(PROVIDERS_STORAGE_KEY, JSON.stringify(providers));
  void saveWorkspaceData();
}

const DEFAULT_PROVIDERS: ModelProvider[] = [
  {
    id: "openai",
    name: "OpenAI",
    type: "built-in",
    enabled: false,
    baseUrl: "https://api.openai.com/v1",
    apiKey: "",
    apiFormat: "openai",
    models: [
      { name: "GPT-4o", modelId: "gpt-4o", contextWindow: "128k" },
      { name: "GPT-4o mini", modelId: "gpt-4o-mini", contextWindow: "128k" },
      { name: "GPT-4.1", modelId: "gpt-4.1", contextWindow: "1m" },
      { name: "GPT-4.1 mini", modelId: "gpt-4.1-mini", contextWindow: "1m" },
      { name: "o3", modelId: "o3", contextWindow: "200k" },
      { name: "o4-mini", modelId: "o4-mini", contextWindow: "200k" },
    ],
  },
  {
    id: "anthropic",
    name: "Anthropic",
    type: "built-in",
    enabled: false,
    baseUrl: "https://api.anthropic.com",
    apiKey: "",
    apiFormat: "anthropic",
    models: [
      { name: "Claude Sonnet 4", modelId: "claude-sonnet-4-20250514", contextWindow: "200k" },
      { name: "Claude Opus 4", modelId: "claude-opus-4-20250514", contextWindow: "200k" },
      { name: "Claude 3.5 Haiku", modelId: "claude-3-5-haiku-20241022", contextWindow: "200k" },
    ],
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    type: "built-in",
    enabled: false,
    baseUrl: "https://api.deepseek.com/v1",
    apiKey: "",
    apiFormat: "openai",
    models: [
      { name: "DeepSeek V3", modelId: "deepseek-chat", contextWindow: "64k" },
      { name: "DeepSeek R1", modelId: "deepseek-reasoner", contextWindow: "64k" },
    ],
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    type: "built-in",
    enabled: false,
    baseUrl: "https://openrouter.ai/api/v1",
    apiKey: "",
    apiFormat: "openai",
    models: [
      { name: "Nemotron 3 Ultra 550B (Free)", modelId: "nvidia/nemotron-3-ultra-550b-a55b:free", contextWindow: "1m" },
      { name: "North Mini Code (Free)", modelId: "cohere/north-mini-code:free", contextWindow: "256k" },
      { name: "Qwen 3 Next 80B (Free)", modelId: "qwen/qwen3-next-80b-a3b-instruct:free", contextWindow: "262k" },
      { name: "Llama 3.3 70B (Free)", modelId: "meta-llama/llama-3.3-70b-instruct:free", contextWindow: "131k" },
      { name: "Claude Sonnet 4", modelId: "anthropic/claude-sonnet-4", contextWindow: "200k" },
      { name: "GPT-4o", modelId: "openai/gpt-4o", contextWindow: "128k" },
      { name: "Gemini 2.5 Pro", modelId: "google/gemini-2.5-pro-preview", contextWindow: "1m" },
      { name: "DeepSeek R1", modelId: "deepseek/deepseek-r1", contextWindow: "128k" },
      { name: "Llama 4 Maverick", modelId: "meta-llama/llama-4-maverick", contextWindow: "1m" },
    ],
  },
  {
    id: "groq",
    name: "Groq",
    type: "built-in",
    enabled: false,
    baseUrl: "https://api.groq.com/openai/v1",
    apiKey: "",
    apiFormat: "openai",
    models: [
      { name: "Llama 3.3 70B", modelId: "llama-3.3-70b-versatile", contextWindow: "128k" },
      { name: "Llama 3.1 8B", modelId: "llama-3.1-8b-instant", contextWindow: "128k" },
      { name: "Gemma 2 9B", modelId: "gemma2-9b-it", contextWindow: "8k" },
      { name: "Mixtral 8x7B", modelId: "mixtral-8x7b-32768", contextWindow: "32k" },
    ],
  },
  {
    id: "nvidia",
    name: "NVIDIA NIM",
    type: "built-in",
    enabled: false,
    baseUrl: "https://integrate.api.nvidia.com/v1",
    apiKey: "",
    apiFormat: "openai",
    models: [
      { name: "MiniMax M3", modelId: "minimaxai/minimax-m3", contextWindow: "128k" },
      { name: "GLM-5.1", modelId: "z-ai/glm-5.1", contextWindow: "128k" },
      { name: "Kimi K2.6", modelId: "moonshotai/kimi-k2.6", contextWindow: "128k" },
      { name: "Step 3.7 Flash", modelId: "stepfun-ai/step-3.7-flash", contextWindow: "128k" },
      { name: "Llama 3.3 70B", modelId: "meta/llama-3.3-70b-instruct", contextWindow: "128k" },
      { name: "Llama 3.1 70B", modelId: "meta/llama-3.1-70b-instruct", contextWindow: "128k" },
      { name: "Mistral Large", modelId: "mistralai/mistral-large-2-instruct", contextWindow: "32k" },
      { name: "Mistral Medium 3.5", modelId: "mistralai/mistral-medium-3.5-128b", contextWindow: "128k" },
    ],
  },
  {
    id: "ollama",
    name: "Ollama (Local)",
    type: "built-in",
    enabled: false,
    baseUrl: "http://localhost:11434/v1",
    apiKey: "ollama",
    apiFormat: "openai",
    models: [
      { name: "Llama 3.3 70B", modelId: "llama3.3:70b", contextWindow: "128k" },
      { name: "Llama 3.1 8B", modelId: "llama3.1:8b", contextWindow: "128k" },
      { name: "CodeLlama 13B", modelId: "codellama:13b", contextWindow: "16k" },
      { name: "Mistral 7B", modelId: "mistral:7b", contextWindow: "32k" },
    ],
  },
];

type ModelProvidersState = {
  providers: ModelProvider[];
  addProvider: (provider: Omit<ModelProvider, "id">) => void;
  removeProvider: (id: string) => void;
  toggleProvider: (id: string) => void;
  updateProvider: (id: string, updates: Partial<ModelProvider>) => void;
  addModel: (providerId: string, model: { name: string; modelId: string; contextWindow: string }) => void;
  removeModel: (providerId: string, modelId: string) => void;
  getAllModels: () => { providerName: string; model: { name: string; modelId: string; contextWindow: string; connected?: boolean } }[];
};

export const useModelProviders = create<ModelProvidersState>((set, get) => ({
  providers: loadProviders(),
  addProvider(provider) {
    const id = provider.name.toLowerCase().replace(/[^a-z0-9]/g, "-") + "-" + Date.now().toString(36);
    set((s) => {
      const next = [...s.providers, { ...provider, id }];
      saveProviders(next);
      return { providers: next };
    });
  },
  removeProvider(id) {
    set((s) => {
      const next = s.providers.filter((p) => p.id !== id);
      saveProviders(next);
      localStorage.removeItem(`acode.provider.${id}`);
      return { providers: next };
    });
  },
  toggleProvider(id) {
    set((s) => {
      const next = s.providers.map((p) => p.id === id ? { ...p, enabled: !p.enabled } : p);
      saveProviders(next);
      return { providers: next };
    });
  },
  updateProvider(id, updates) {
    set((s) => {
      const next = s.providers.map((p) => p.id === id ? { ...p, ...updates } : p);
      saveProviders(next);
      return { providers: next };
    });
  },
  addModel(providerId, model) {
    set((s) => {
      const next = s.providers.map((p) =>
        p.id === providerId ? { ...p, models: [...p.models, { ...model, connected: false }] } : p
      );
      saveProviders(next);
      return { providers: next };
    });
  },
  removeModel(providerId, modelId) {
    set((s) => {
      const next = s.providers.map((p) =>
        p.id === providerId ? { ...p, models: p.models.filter((m) => m.modelId !== modelId) } : p
      );
      saveProviders(next);
      return { providers: next };
    });
  },
  getAllModels() {
    const { providers } = get();
    const result: { providerName: string; model: { name: string; modelId: string; contextWindow: string; connected?: boolean } }[] = [];
    for (const p of providers) {
      if (!p.enabled) continue;
      for (const m of p.models) {
        result.push({ providerName: p.name, model: m });
      }
    }
    return result;
  },
}));

type SettingsViewState = {
  openState: boolean;
  activeTab: SettingsTab;
  selectedProviderId: string | null;
  open: (tab?: SettingsTab) => void;
  close: () => void;
  setActiveTab: (tab: SettingsTab) => void;
  setSelectedProvider: (id: string | null) => void;
};

export const useSettingsView = create<SettingsViewState>((set) => ({
  openState: false,
  activeTab: "general",
  selectedProviderId: null,
  open: (tab) => set({ openState: true, activeTab: tab ?? "general", selectedProviderId: null }),
  close: () => set({ openState: false }),
  setActiveTab: (tab) => set({ activeTab: tab }),
  setSelectedProvider: (id) => set({ selectedProviderId: id }),
}));

type ShortcutsState = {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
};

export const useShortcuts = create<ShortcutsState>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
  toggle: () => set((s) => ({ open: !s.open })),
}));

// ---- UI state (panel visibility) -------------------------------------------

export type BrowserTab = {
  id: string;
  title: string;
  url: string;
  history: string[];
  historyIdx: number;
  loading: boolean;
};

type UIState = {
  sidebarOpen: boolean;
  rightPanelOpen: boolean;
  browserTabs: BrowserTab[];
  activeBrowserTabId: string | null;
  rightPanelTab: "git" | "diff" | "review" | "browser" | "progress" | "terminal";
  setSidebarOpen: (open: boolean) => void;
  toggleSidebar: () => void;
  setRightPanelOpen: (open: boolean) => void;
  toggleRightPanel: () => void;
  setRightPanelTab: (tab: "git" | "diff" | "review" | "browser" | "progress" | "terminal") => void;
  addBrowserTab: (tab?: Partial<BrowserTab>) => string;
  removeBrowserTab: (id: string) => void;
  setActiveBrowserTab: (id: string) => void;
  navigateBrowser: (id: string, url: string) => void;
  goBackBrowser: (id: string) => void;
  goForwardBrowser: (id: string) => void;
  refreshBrowser: (id: string) => void;
  updateBrowserTab: (id: string, patch: Partial<BrowserTab>) => void;
};

function deriveTitleFromUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.hostname.startsWith("www.google.com") && u.pathname === "/search") {
      const q = u.searchParams.get("q") ?? "";
      return q ? `Google — ${q}` : "Google";
    }
    return u.hostname.replace(/^www\./, "") + (u.pathname !== "/" ? u.pathname : "");
  } catch {
    return url;
  }
}

function normalizeBrowserUrl(input: string): string {
  const raw = input.trim();
  if (!raw) return "";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return raw;
  if (/^(localhost|127\.|10\.|192\.168\.|::1)/i.test(raw)) return "http://" + raw;
  if (/\s/.test(raw)) return "https://www.google.com/search?q=" + encodeURIComponent(raw);
  let host = raw.replace(/^www\./i, "");
  const slash = host.search("/");
  const tail = slash >= 0 ? host.slice(slash) : "";
  host = slash >= 0 ? host.slice(0, slash) : host;
  const TLDs = ["com","org","net","io","co","dev","ai","app","me","us","uk","de","fr","jp","cn","ru","br","in","info","biz","xyz","tech","cloud","gg","tv","fm","sh","ly"];
  const lastDot = host.lastIndexOf(".");
  if (lastDot > 0) {
    const tld = host.slice(lastDot + 1).toLowerCase();
    if (TLDs.includes(tld) || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
      return "https://" + raw.replace(/^https?:\/\//i, "");
    }
  }
  if (/^\d{1,3}(\.\d{1,3}){0,3}$/.test(host)) return "http://" + raw.replace(/^https?:\/\//i, "");
  if (/^[\w-]+$/.test(host)) return "https://" + host + ".com" + tail;
  if (host.includes(".")) return "https://" + raw.replace(/^https?:\/\//i, "");
  return "https://www.google.com/search?q=" + encodeURIComponent(raw);
}

export const useUI = create<UIState>((set, get) => ({
  sidebarOpen: true,
  rightPanelOpen: false,
  browserTabs: [],
  activeBrowserTabId: null,
  rightPanelTab: "git",
  setSidebarOpen: (open) => set({ sidebarOpen: open }),
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  setRightPanelOpen: (open) => set({ rightPanelOpen: open }),
  toggleRightPanel: () => set((s) => ({ rightPanelOpen: !s.rightPanelOpen })),
  setRightPanelTab: (tab) => set({ rightPanelTab: tab }),
  addBrowserTab: (tab) => {
    const id = "bt-" + Math.random().toString(36).slice(2, 9);
    const newTab: BrowserTab = {
      id,
      title: tab?.title ?? "New tab",
      url: tab?.url ?? "",
      history: tab?.url ? [tab.url] : [],
      historyIdx: tab?.url ? 0 : -1,
      loading: false,
    };
    set((s) => ({
      browserTabs: [...s.browserTabs, newTab],
      activeBrowserTabId: id,
    }));
    return id;
  },
  removeBrowserTab: (id) => {
    set((s) => {
      const remaining = s.browserTabs.filter((t) => t.id !== id);
      const newActive = s.activeBrowserTabId === id
        ? (remaining[remaining.length - 1]?.id ?? null)
        : s.activeBrowserTabId;
      return { browserTabs: remaining, activeBrowserTabId: newActive };
    });
  },
  setActiveBrowserTab: (id) => set({ activeBrowserTabId: id }),
  navigateBrowser: (id, url) => {
    const normalized = normalizeBrowserUrl(url);
    if (!normalized) return;
    set((s) => ({
      browserTabs: s.browserTabs.map((t) => {
        if (t.id !== id) return t;
        const truncated = normalized.slice(0, 200);
        return {
          ...t,
          url: truncated,
          title: deriveTitleFromUrl(truncated),
          history: t.history[t.historyIdx] === truncated
            ? t.history
            : [...t.history.slice(0, t.historyIdx + 1), truncated],
          historyIdx: t.historyIdx + 1,
          loading: false,
        };
      }),
    }));
  },
  goBackBrowser: (id) => {
    set((s) => ({
      browserTabs: s.browserTabs.map((t) => {
        if (t.id !== id || t.historyIdx <= 0) return t;
        const newIdx = t.historyIdx - 1;
        return { ...t, historyIdx: newIdx, url: t.history[newIdx], title: deriveTitleFromUrl(t.history[newIdx]) };
      }),
    }));
  },
  goForwardBrowser: (id) => {
    set((s) => ({
      browserTabs: s.browserTabs.map((t) => {
        if (t.id !== id || t.historyIdx >= t.history.length - 1) return t;
        const newIdx = t.historyIdx + 1;
        return { ...t, historyIdx: newIdx, url: t.history[newIdx], title: deriveTitleFromUrl(t.history[newIdx]) };
      }),
    }));
  },
  refreshBrowser: (id) => {
    // Force iframe reload by appending a cache-bust query param
    set((s) => ({
      browserTabs: s.browserTabs.map((t) => {
        if (t.id !== id) return t;
        // Strip any existing _r= param then add a fresh one
        const base = t.url.replace(/[?&]_r=\d+/, "");
        const sep = base.includes("?") ? "&" : "?";
        const refreshedUrl = base + sep + "_r=" + Date.now();
        return { ...t, url: refreshedUrl, loading: true };
      }),
    }));
    // Fallback timeout in case onLoad doesn't fire (e.g., blocked by sandbox)
    setTimeout(() => {
      useUI.setState((s2) => ({
        browserTabs: s2.browserTabs.map((t) => t.id === id ? { ...t, loading: false } : t),
      }));
    }, 5000);
  },
  updateBrowserTab: (id, patch) => {
    set((s) => ({
      browserTabs: s.browserTabs.map((t) => (t.id === id ? { ...t, ...patch } : t)),
    }));
  },
}));

// ---- Permission system ----------------------------------------------------

export type PermissionKind = "bash" | "edit" | "network" | "mcp";

export type PermissionRequest = {
  id: string;
  kind: PermissionKind;
  title: string;
  description: string;
  command?: string;
  output?: string;
  workspacePath?: string;
  createdAt: number;
};

const ALWAYS_ALLOWED_KEY = "acode.alwaysAllowed.v1";

function loadAlwaysAllowed(): Record<string, true> {
  try {
    const raw = localStorage.getItem(ALWAYS_ALLOWED_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    const result: Record<string, true> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (v === true) result[k] = true;
    }
    return result;
  } catch { return {}; }
}

function saveAlwaysAllowed(data: Record<string, true>) {
  try { localStorage.setItem(ALWAYS_ALLOWED_KEY, JSON.stringify(data)); } catch {}
  // Also persist to .acode/config.json for project-level persistence
  void persistAlwaysAllowedToDisk(data);
}

async function persistAlwaysAllowedToDisk(data: Record<string, true>) {
  try {
    const ws = useWorkspace.getState();
    const activeWs = ws.workspaces.find((w) => w.id === ws.activeWorkspaceId);
    if (!activeWs) return;
    const api = ensureAcodeAPI();
    const { exists, mkdir } = await import("@tauri-apps/plugin-fs");
    const dotAcode = joinPath(activeWs.path, ".acode");
    if (!(await exists(dotAcode))) await mkdir(dotAcode);
    const configPath = joinPath(dotAcode, "config.json");
    let existing: any = {};
    try {
      if (await exists(configPath)) {
        existing = JSON.parse(await api.fs.readFile(configPath));
      }
    } catch {}
    existing.alwaysAllowed = data;
    await api.fs.writeFile(configPath, JSON.stringify(existing, null, 2));
  } catch (e) { console.warn("Failed to persist alwaysAllowed to disk:", e); }
}

async function loadAlwaysAllowedFromDisk(): Promise<Record<string, true>> {
  try {
    const ws = useWorkspace.getState();
    const activeWs = ws.workspaces.find((w) => w.id === ws.activeWorkspaceId);
    if (!activeWs) return {};
    const api = ensureAcodeAPI();
    const { exists } = await import("@tauri-apps/plugin-fs");
    const configPath = joinPath(activeWs.path, ".acode", "config.json");
    if (await exists(configPath)) {
      const content = await api.fs.readFile(configPath);
      const config = JSON.parse(content);
      return config.alwaysAllowed || {};
    }
  } catch {}
  return {};
}

type PermissionState = {
  request: PermissionRequest | null;
  alwaysAllowed: Record<string, true>;
  ask: (req: Omit<PermissionRequest, "id" | "createdAt">) => Promise<"allow" | "always" | "deny">;
  allowAlways: (req: PermissionRequest) => void;
  resolve: (decision: "allow" | "always" | "deny") => void;
  cancel: () => void;
  loadFromDisk: () => Promise<void>;
};

export const usePermission = create<PermissionState>((set, get) => {
  let pendingResolve: ((d: "allow" | "always" | "deny") => void) | null = null;

  const ask: PermissionState["ask"] = (req) => {
    const key = `${req.workspacePath ?? ""}::${req.kind}::${req.command ?? ""}`;
    if (get().alwaysAllowed[key]) {
      return Promise.resolve("allow" as const);
    }
    // Reject any previous pending request to avoid promise leaks
    if (pendingResolve) { pendingResolve("deny"); pendingResolve = null; }
    const full: PermissionRequest = {
      ...req,
      id: "perm-" + Math.random().toString(36).slice(2, 9),
      createdAt: Date.now(),
    };
    set({ request: full });
    return new Promise<"allow" | "always" | "deny">((resolve) => {
      pendingResolve = resolve;
    });
  };

  return {
    request: null,
    alwaysAllowed: loadAlwaysAllowed(),
    ask,
    allowAlways(req) {
      const key = `${req.workspacePath ?? ""}::${req.kind}::${req.command ?? ""}`;
      const next: Record<string, true> = { ...get().alwaysAllowed, [key]: true };
      set({ alwaysAllowed: next });
      saveAlwaysAllowed(next);
    },
    resolve(decision) {
      const r = pendingResolve;
      pendingResolve = null;
      r?.(decision);
      set({ request: null });
    },
    cancel() {
      const r = pendingResolve;
      pendingResolve = null;
      r?.("deny");
      set({ request: null });
    },
    async loadFromDisk() {
      try {
        const diskData = await loadAlwaysAllowedFromDisk();
        const localData = loadAlwaysAllowed();
        // Merge disk + localStorage (localStorage overrides disk for same key)
        const merged: Record<string, true> = { ...diskData, ...localData };
        set({ alwaysAllowed: merged });
      } catch (e) {
        console.warn("Failed to load permissions from disk:", e);
      }
    },
  };
});

export async function withPermission<T>(
  params: {
    kind: PermissionKind;
    title: string;
    description: string;
    command?: string;
    output?: string;
    workspacePath?: string;
  },
  run: () => Promise<T> | T
): Promise<T | null> {
  const action = useAgents.getState().evaluatePermission(params.kind, params.command ?? "*");
  if (action === "allow") return await run();
  if (action === "deny") return null;
  const decision = await usePermission.getState().ask(params);
  if (decision === "deny") return null;
  if (decision === "always") {
    usePermission.getState().allowAlways({
      id: "",
      createdAt: Date.now(),
      ...params,
    });
  }
  return await run();
}

// ---- Question overlay (AskUserQuestion) ------------------------------------

export type QuestionOption = {
  label: string;
  description: string;
  preview?: string;
};

export type QuestionRequest = {
  id: string;
  header: string;
  question: string;
  options: QuestionOption[];
  allowFreeText?: boolean;
  workspaceName?: string;
  branch?: string;
  createdAt: number;
};

type QuestionState = {
  request: QuestionRequest | null;
  ask: (req: Omit<QuestionRequest, "id" | "createdAt">) => Promise<{ selectedLabel: string; customText?: string } | null>;
  resolve: (answer: { selectedLabel: string; customText?: string } | null) => void;
};

export const useQuestion = create<QuestionState>((set) => {
  let pendingResolve: ((a: { selectedLabel: string; customText?: string } | null) => void) | null = null;
  const ask: QuestionState["ask"] = (req) => {
    if (pendingResolve) { pendingResolve(null); pendingResolve = null; }
    const full: QuestionRequest = {
      ...req,
      id: "q-" + Math.random().toString(36).slice(2, 9),
      createdAt: Date.now(),
    };
    set({ request: full });
    return new Promise<{ selectedLabel: string; customText?: string } | null>((resolve) => {
      pendingResolve = resolve;
    });
  };
  return {
    request: null,
    ask,
    resolve(answer) {
      const r = pendingResolve;
      pendingResolve = null;
      r?.(answer);
      set({ request: null });
    },
  };
});

// ---- Diff view (right-panel file viewer) ----------------------------------

type DiffViewState = {
  open: boolean;
  current: FileChange | null;
  history: FileChange[];
  forwardStack: FileChange[];
  setOpen: (open: boolean) => void;
  openFile: (change: FileChange) => void;
  close: () => void;
  next: () => void;
  prev: () => void;
};

export const useDiffView = create<DiffViewState>((set, get) => ({
  open: false,
  current: null,
  history: [],
  forwardStack: [],
  setOpen(open) { set((s) => open && !s.current ? s : { open }); },
  openFile(change) {
    set((s) => ({
      open: true,
      current: change,
      // Only push to history if navigating to a different file
      history: s.current && s.current.path !== change.path
        ? [...s.history, s.current]
        : s.history,
      forwardStack: [],
    }));
    // Open the right panel and switch to diff tab so the user sees the diff
    const ui = useUI.getState();
    if (!ui.rightPanelOpen) ui.setRightPanelOpen(true);
    ui.setRightPanelTab("diff");
  },
  close() {
    set({ open: false, current: null, history: [], forwardStack: [] });
  },
  next() {
    const { forwardStack, current, history } = get();
    if (forwardStack.length === 0) return;
    const next = forwardStack[forwardStack.length - 1];
    set({
      current: next,
      forwardStack: forwardStack.slice(0, -1),
      history: current ? [...history, current] : history,
    });
  },
  prev() {
    const { history, current, forwardStack } = get();
    if (history.length === 0) return;
    const prev = history[history.length - 1];
    set({
      current: prev,
      history: history.slice(0, -1),
      forwardStack: current ? [...forwardStack, current] : forwardStack,
    });
  },
}));