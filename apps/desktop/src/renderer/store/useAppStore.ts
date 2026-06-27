import { create } from "zustand";
import type {
  DalamAPI,
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
} from "@dalam/shared-types";
import { DEFAULT_SETTINGS } from "@dalam/shared-types";
import { createDalamAPI } from "@/lib/dalamAPI";
import { basename, toPosix, joinPath } from "@/lib/pathUtils";
import { ALL_AGENTS, PRIMARY_AGENTS, SUBAGENTS, getPrimaryAgent, mergeRulesets, evaluate, canonicaliseBashCommand, autoSelectAgent, recordAgentSelection } from "@/lib/agents";
import { skillRegistry, BUNDLED_SKILLS, matchSkillInvocation, renderSkillForPrompt, loadProjectSkills, refreshProjectSkills } from "@/lib/skills";
import { computeContextStats, selectMessagesForCompaction, pruneToolOutputs, buildCompactionPrompt, parseContextWindow } from "@/lib/contextManager";

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

// Comprehensive list of ALL tool names for display stripping (must match dalamAPI.ts KNOWN_TOOL_NAMES)
const ALL_TOOL_NAMES = [
  "read_file", "write_file", "edit_file", "list_dir", "grep_file", "search_files",
  "run_command", "git_status", "git_commit", "git_log",
  "clipboard_read", "clipboard_write", "notify", "system_info", "open_url",
  "launch_app", "reveal_in_finder",
  "get_env", "get_screen_info", "list_processes", "kill_process", "get_disk_space",
  "memory_save", "memory_search", "memory_delete", "memory_stats",
  "memory_maintain", "memory_extract", "memory_export", "memory_import",
  // Legacy aliases used by TAG_TO_TOOL
  "bash", "shell", "search", "grep", "webfetch", "websearch",
];
const KNOWN_TAG_NAMES = [...new Set(ALL_TOOL_NAMES)];

// Regex to strip ALL XML tool call tags (opening, closing, and self-closing) from content.
// Uses [^>]* to handle malformed attributes (e.g. unescaped quotes inside command values).
const XML_STRIP_RE = new RegExp(
  `<(${KNOWN_TAG_NAMES.join("|")})[^>]*>[\\s\\S]*?<\\/\\1>|<(${KNOWN_TAG_NAMES.join("|")})[^>]*\\/?>`,
  "gi"
);
const XML_CLOSING_TAG_RE = new RegExp(`<\\/(${KNOWN_TAG_NAMES.join("|")})>`, "gi");
const XML_MCP_STRIP_RE = /<mcp_[\s\S]*?<\/mcp_[^>]*>|<mcp_[^>]*\/>/gi;

/**
 * Strip all XML tool call tags from content (for display purposes).
 * Handles opening+closing pairs, self-closing tags, and closing-only tags.
 * Also handles malformed XML (unescaped quotes in attributes, broken tags).
 */
export function stripXmlToolCallTags(content: string): string {
  let result = content;
  // Strip opening+content+closing blocks: <tool ...>content</tool>
  // and self-closing tags: <tool .../>
  result = result.replace(XML_STRIP_RE, "");
  // Strip orphan closing tags that weren't paired above: </tool>
  result = result.replace(XML_CLOSING_TAG_RE, "");
  // Strip MCP tags
  result = result.replace(XML_MCP_STRIP_RE, "");
  // Strip Anthropic antml:function_calls / <invoke> blocks
  result = result.replace(/(?:antml:function_calls\s*)?<invoke[\s\S]*?<\/(?:antml:)?function_calls\s*>/gi, "");
  // Strip orphan antml tags
  result = result.replace(/<\/?antml:[^>]*>/gi, "");
  // Strip orphan <invoke> tags
  result = result.replace(/<\/?invoke[^>]*>/gi, "");
  // Strip incomplete XML tool tags at end of content (arriving across streaming deltas)
  // Matches: <run_command command="ls -la$  (no closing > or />)
  result = result.replace(new RegExp(`<(${KNOWN_TAG_NAMES.join("|")})[^>]*$`, "gi"), "");
  // Strip broken/malformed tag fragments from model output (e.g. ><]minimax[>][)
  result = result.replace(/>\]\s*<[^>]*>?\[</g, "");
  result = result.replace(/\]>\s*\[</g, "");
  result = result.replace(/<\]?\w+\[>?\]?\[?/g, "");
  // Clean up excessive whitespace left behind
  result = result.replace(/\n{3,}/g, "\n\n").trim();
  return result;
}

// Tool name → permission kind mappings (module-level to avoid recreation per event)
const EDIT_TOOLS = new Set(["edit_file", "edit", "write_file", "write", "create_file", "git_commit", "memory_delete", "memory_maintain", "memory_export", "memory_import", "memory_extract", "memory_save"]);
const BASH_TOOLS = new Set(["shell", "bash", "execute", "run_command", "launch_app"]);
const READ_TOOLS = new Set(["read_file", "list_dir", "grep_file", "search_files", "git_status", "git_log", "clipboard_read", "system_info", "memory_search", "memory_stats"]);

/**
 * Parse XML-style tool calls from assistant text content.
 * Returns extracted tool calls and the cleaned content with XML tags removed.
 */
export function parseXmlToolCalls(content: string): {
  toolCalls: import("@dalam/shared-types").ToolCall[];
  cleanedContent: string;
} {
  const toolCalls: import("@dalam/shared-types").ToolCall[] = [];
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
  }

  // Use the comprehensive strip function to clean all XML tags
  const cleanedContent = stripXmlToolCallTags(content);

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
    const api = createDalamAPI();
    try {
      const all = await api.settings.getAll();
      // Merge with existing settings (workspace-specific settings take priority)
      set((s) => ({
        settings: { ...all, ...s.settings },
        loaded: true,
      }));
      if (all.selectedModel) {
        useChat.getState().setSelectedModel(all.selectedModel);
      }
    } catch (err) {
      console.error("Failed to load settings, using defaults:", err);
      set({ loaded: true });
    }
  },
  async update(key, value) {
    const api = createDalamAPI();
    await api.settings.set(key, value as never);
    set((s) => ({ settings: { ...s.settings, [key]: value } }));
  },
  async updateSettings(updates) {
    const api = createDalamAPI();
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

// ─── Config Types ─────────────────────────────────────────────
/** Shape of a provider entry stored in .dalam/config.json */
interface ProjectProviderConfig {
  id: string;
  enabled?: boolean;
  apiKey?: string;
  baseUrl?: string;
}

/** Shape of .dalam/config.json */
interface WorkspaceConfig {
  settings?: Partial<AppSettings>;
  providers?: ProjectProviderConfig[];
  mcpServers?: McpServer[];
  alwaysAllowed?: Record<string, true>;
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
  } catch { /* ignore */ }
  return { workspaces: [], activeId: null };
}

function savePersistedWorkspaces(workspaces: Workspace[], activeId: string | null) {
  try {
    localStorage.setItem(WORKSPACES_STORAGE_KEY, JSON.stringify({ workspaces, activeId }));
  } catch { /* ignore */ }
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

async function initWorkspaceMemory(api: DalamAPI, workspacePath: string) {
  try {
    const { exists, mkdir } = await import("@tauri-apps/plugin-fs");
    const dotDalam = joinPath(workspacePath, ".dalam");
    if (!(await exists(dotDalam))) {
      await mkdir(dotDalam);
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
    const memoryPath = joinPath(dotDalam, "memory.json");
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
      const workspace: Workspace = {
        id: "ws-" + toPosix(path),
        path,
        name,
        tasks: [],
      };
      const newWorkspaces = [...get().workspaces.filter((w) => w.id !== workspace.id), workspace];
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
      console.error("Failed to open workspace:", err);
    }
  },

  async loadWorkspace() {
    set({ loading: true });
    try {
      const api = createDalamAPI();
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
      const newWorkspaces = [...get().workspaces.filter((w) => w.path !== path), workspace];
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
      console.error("Failed to load workspace:", err);
    }
  },

  setActiveWorkspace(id) {
    set({ activeWorkspaceId: id });
    savePersistedWorkspaces(get().workspaces, id);
    const ws = get().workspaces.find((w) => w.id === id);
    if (ws) {
      void loadWorkspaceConfigAndSessions(ws.path);
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
      const api = createDalamAPI();
      // Check if path is a directory — don't try to open directories as files
      const { stat } = await import("@tauri-apps/plugin-fs");
      try {
        const fileStat = await stat(path);
        if (fileStat.isDirectory) {
          console.warn("Cannot open directory as file:", path);
          return;
        }
      } catch {
        // stat failed — file might not exist, try reading anyway for a clearer error
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
      const api = createDalamAPI();
      const tree = await api.fs.listDir(ws.path);
      set({ fileTree: tree });
    } catch (err) {
      console.error("Failed to refresh file tree:", err);
    }
  },

  async loadFileTree(path) {
    try {
      const api = createDalamAPI();
      const tree = await api.fs.listDir(path);
      set({ fileTree: tree });
    } catch (err) {
      console.error("Failed to load file tree:", err);
    }
  },

  async createFile(parentPath, name) {
    try {
      const api = createDalamAPI();
      await api.fs.createFile(parentPath, name);
      await get().refreshFileTree();
    } catch (err) {
      console.warn("createFile failed:", err);
    }
  },

  async createDirectory(parentPath, name) {
    try {
      const api = createDalamAPI();
      await api.fs.createDirectory(parentPath, name);
      await get().refreshFileTree();
    } catch (err) {
      console.warn("createDirectory failed:", err);
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
      console.warn("deletePath failed:", err);
    }
  },

  async renamePath(path, newName) {
    try {
      const api = createDalamAPI();
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
  error: string | null;
  refresh: () => Promise<void>;
};

export const useGit = create<GitState>((set) => ({
  status: null,
  loading: false,
  error: null,
  async refresh() {
    const { activeWorkspaceId, workspaces } = useWorkspace.getState();
    const ws = workspaces.find((w) => w.id === activeWorkspaceId);
    if (!ws) {
      set({ status: null, error: null, loading: false });
      return;
    }
    const api = createDalamAPI();
    set({ loading: true, error: null });
    try {
      const status = await api.git.status(ws.path);
      set({ status, error: null });
    } catch (err) {
      const msg = (err as Error)?.message ?? "Unknown error";
      if (msg.includes("not a git repository") || msg.includes("not found") || msg.includes("No such file")) {
        set({ status: null, error: "not_initialized" });
      } else {
        set({ status: null, error: msg });
      }
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

const ENABLED_SKILLS_STORAGE = "dalam.enabledSkills.v1";
const SESSION_VERSIONS_KEY = "dalam.sessionVersions.v1";
const SESSION_MESSAGES_KEY = "dalam.sessionMessages.v1";
const SESSION_AGENTS_KEY = "dalam.sessionAgents.v1";
const SESSION_SUMMARIES_KEY = "dalam.chatSessions.v1";

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

function loadPersistedVersions(): Record<string, import("@dalam/shared-types").ChatVersion[]> {
  try {
    const raw = localStorage.getItem(SESSION_VERSIONS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function savePersistedVersions(versions: Record<string, import("@dalam/shared-types").ChatVersion[]>) {
  try { localStorage.setItem(SESSION_VERSIONS_KEY, JSON.stringify(versions)); } catch (e) { console.warn("Failed to save versions:", e); }
  void saveWorkspaceData();
}

function loadPersistedMessages(): Record<string, import("@dalam/shared-types").ChatMessage[]> {
  try {
    const raw = localStorage.getItem(SESSION_MESSAGES_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function savePersistedMessages(messages: Record<string, import("@dalam/shared-types").ChatMessage[]>) {
  try {
    localStorage.setItem(SESSION_MESSAGES_KEY, JSON.stringify(messages));
  } catch (e) {
    if (e instanceof DOMException && e.name === 'QuotaExceededError') {
      // Level 1: truncate tool results
      console.warn("[Storage] Quota exceeded — level 1: truncating tool results");
      const pruned = truncateToolResults(messages);
      try {
        localStorage.setItem(SESSION_MESSAGES_KEY, JSON.stringify(pruned));
      } catch {
        // Level 2: also trim message content in older messages
        console.warn("[Storage] Quota exceeded — level 2: trimming old message content");
        const pruned2 = trimOldMessages(pruned);
        try {
          localStorage.setItem(SESSION_MESSAGES_KEY, JSON.stringify(pruned2));
        } catch {
          // Level 3: drop oldest sessions entirely
          console.warn("[Storage] Quota exceeded — level 3: dropping oldest sessions");
          const pruned3 = dropOldestSessions(pruned2, 3);
          try {
            localStorage.setItem(SESSION_MESSAGES_KEY, JSON.stringify(pruned3));
          } catch {
            console.error("[Storage] Failed to save messages even after aggressive pruning");
          }
        }
      }
    } else {
      console.warn("Failed to save messages:", e);
    }
  }
  void saveWorkspaceData();
}

function truncateToolResults(messages: Record<string, import("@dalam/shared-types").ChatMessage[]>): Record<string, import("@dalam/shared-types").ChatMessage[]> {
  const result: Record<string, import("@dalam/shared-types").ChatMessage[]> = {};
  for (const [sessionId, msgs] of Object.entries(messages)) {
    result[sessionId] = msgs.map(m => {
      if (m.toolCalls && m.toolCalls.length > 0) {
        return { ...m, toolCalls: m.toolCalls.map(tc => ({ ...tc, result: tc.result ? tc.result.slice(0, 500) : undefined })) };
      }
      return m;
    });
  }
  return result;
}

function trimOldMessages(messages: Record<string, import("@dalam/shared-types").ChatMessage[]>): Record<string, import("@dalam/shared-types").ChatMessage[]> {
  const result: Record<string, import("@dalam/shared-types").ChatMessage[]> = {};
  const sessionIds = Object.keys(messages);
  for (const sessionId of sessionIds) {
    const msgs = messages[sessionId];
    const cutoff = msgs.length > 20 ? msgs.length - 20 : 0;
    result[sessionId] = msgs.map((m, i) => {
      if (i < cutoff && m.content && m.content.length > 2000) {
        return { ...m, content: m.content.slice(0, 2000) + "\n... [trimmed for storage]" };
      }
      return m;
    });
  }
  return result;
}

function dropOldestSessions(messages: Record<string, import("@dalam/shared-types").ChatMessage[]>, keepCount: number): Record<string, import("@dalam/shared-types").ChatMessage[]> {
  const entries = Object.entries(messages);
  if (entries.length <= keepCount) return messages;
  // Keep the most recent sessions (by last message timestamp)
  const sorted = entries.sort((a, b) => {
    const aLast = a[1][a[1].length - 1]?.timestamp ?? 0;
    const bLast = b[1][b[1].length - 1]?.timestamp ?? 0;
    return bLast - aLast;
  });
  const result: Record<string, import("@dalam/shared-types").ChatMessage[]> = {};
  for (const [id, msgs] of sorted.slice(0, keepCount)) {
    result[id] = msgs;
  }
  return result;
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

const COMPACTION_SUMMARIES_KEY = "dalam.compactionSummaries.v1";

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
  const api = createDalamAPI();
  const dotDalam = joinPath(workspacePath, ".dalam");
  const sessionsPath = joinPath(dotDalam, "sessions.json");
  const configPath = joinPath(dotDalam, "config.json");
  const contextPath = joinPath(dotDalam, "context.json");

  try {
    const { exists, mkdir } = await import("@tauri-apps/plugin-fs");

    // Ensure .dalam directory exists before checking files inside it
    if (!(await exists(dotDalam))) {
      try { await mkdir(dotDalam, { recursive: true }); } catch { /* may already exist or scope issue */ }
    }

    // Load always-allowed permissions from disk first (needed for tool permission evaluations)
    await usePermission.getState().loadFromDisk();

    // Load project-level skills from .dalam/skills/*/SKILL.md
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
            const projProv = (projConfig.providers as ProjectProviderConfig[] | undefined)?.find((pp) => pp.id === p.id);
            return projProv ? { ...p, ...projProv } : p;
          });
          useModelProviders.setState({ providers: nextProviders });
        }

        // Merge project-scoped MCP servers from config.json with user-scoped ones from localStorage
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
          ignorePatterns: ["node_modules", "dist", ".git", ".dalam"]
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
        // Guard: bail if a different workspace loaded while we were reading
        if (_workspaceLoadPath !== workspacePath) return;
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
          // Reconstruct a proper AgentSession from the stored ChatSessionSummary
          const restoredSession: import("@dalam/shared-types").AgentSession = {
            id: lastSession.id,
            workspacePath: lastSession.workspacePath,
            model: lastSession.model ?? useSettings.getState().settings.selectedModel,
            mode: lastSession.mode,
            startedAt: lastSession.startedAt,
            messages: data.sessionMessages?.[lastSession.id] || [],
            status: lastSession.status === "completed" ? "idle" : lastSession.status,
          };
          useChat.setState({
            session: restoredSession,
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

  const api = createDalamAPI();
  const dotDalam = joinPath(ws.path, ".dalam");
  const sessionsPath = joinPath(dotDalam, "sessions.json");
  const configPath = joinPath(dotDalam, "config.json");

  try {
    const { exists, mkdir } = await import("@tauri-apps/plugin-fs");
    if (!(await exists(dotDalam))) {
      await mkdir(dotDalam);
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
      if (await exists(configPath)) {
        existingConfig = JSON.parse(await api.fs.readFile(configPath));
      }
    } catch { /* ignore */ }
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

export type TodoStatus = TodoItem["status"];

type TaskPlanItem = {
  id: string;
  title: string;
  status: "pending" | "running" | "done" | "failed";
};

type ChatState = {
  session: AgentSession | null;
  messages: ChatMessage[];
  pendingToolCalls: import("@dalam/shared-types").ToolCall[];
  pendingActivities: import("@dalam/shared-types").PendingActivity[];
  streamingContent: string;
  thinkingContent: string;
  isStreaming: boolean;
  activeAgentName: PrimaryAgentName;
  selectedModelId: string;
  todos: TodoItem[];
  taskPlan: TaskPlanItem[] | null;
  taskPlanSummary: string | null;
  _pendingChanges: FileChange[];
  _userSelectedAgent: boolean;
  chatHistory: import("@dalam/shared-types").ChatMessage[][];
  chatHistoryIdx: number;
  chatSessions: ChatSessionSummary[];
  activeSessionId: string | null;
  sessionMessages: Record<string, ChatMessage[]>;
  sessionAgentName: Record<string, PrimaryAgentName>;
  planApproval: { planContent: string; status: "pending" | "approved" | "rejected" } | null;
  sessionVersions: Record<string, import("@dalam/shared-types").ChatVersion[]>;
  restoredVersionId: string | null;
  preRestoreMessages: import("@dalam/shared-types").ChatMessage[] | null;
  pendingAttachments: FileAttachment[];
  compactionSummaries: Record<string, string>;
  _compactingSessions: Set<string>;
  _safetyTimer: ReturnType<typeof setTimeout> | null;
  _sendInProgress: boolean;
  compactSessionHistory: (sessionId: string) => Promise<void>;
  setSelectedModel: (id: string) => void;
  startSession: (workspacePath: string, mode: import("@dalam/shared-types").AgentSessionMode) => Promise<void>;
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
  taskPlan: null,
  taskPlanSummary: null,
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
  _safetyTimer: null,
  _sendInProgress: false,

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
    const api = createDalamAPI();
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
      model,
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
      taskPlan: null,
      taskPlanSummary: null,
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
    savePersistedSessionSummaries(get().chatSessions);
    savePersistedMessages(get().sessionMessages);
    savePersistedAgents(get().sessionAgentName);
  },

  async abort(sessionId) {
    const api = createDalamAPI();
    // Clear safety timer on abort
    const currentTimer = get()._safetyTimer;
    if (currentTimer) clearTimeout(currentTimer);
    try {
      await api.agent.abort(sessionId);
    } finally {
      api.agent.cleanupStream(sessionId);
      // Always reset _sendInProgress when aborting — the send loop is being terminated
      set({ _sendInProgress: false });
      // Guard against race with newChat — if session was already cleared,
      // don't overwrite the fresh state with stale abort data
      const currentSession = get().session;
      const isStillOurSession = currentSession && currentSession.id === sessionId;
      if (isStillOurSession) {
        set({
          isStreaming: false,
          streamingContent: "",
          thinkingContent: "",
          pendingToolCalls: [],
          pendingActivities: [],
          _safetyTimer: null,
          chatSessions: get().chatSessions.map((s) =>
            s.id === sessionId ? { ...s, status: "aborted", lastActivityAt: Date.now() } : s
          ),
          session: { ...currentSession, status: "aborted" },
        });
      }
    }
  },

  async sendMessage(content) {
    const { isStreaming, _sendInProgress } = get();
    if (isStreaming || _sendInProgress) return;
    set({ _sendInProgress: true });

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
        const agentName = useAgents.getState().activeAgentName;
        const validModes = ["build", "plan", "yolo"];
        const sessionMode = validModes.includes(agentName) ? agentName as import("@dalam/shared-types").AgentSessionMode : "build" as import("@dalam/shared-types").AgentSessionMode;
        await get().startSession(targetWs ?? "", sessionMode);
      } catch (err) {
        console.error("Failed to start session:", err);
        set({ _sendInProgress: false });
        return;
      }
      // Re-check isStreaming after await to prevent race condition with concurrent sendMessage calls
      if (get().isStreaming) { set({ _sendInProgress: false }); return; }
      session = get().session;
      if (!session) { set({ _sendInProgress: false }); return; }
    }
    const { messages } = get();
    const api = createDalamAPI();
    // Ensure stream listener is registered for the current session
    api.agent.cleanupStream(session.id);
    api.agent.onStreamEvent(session.id, (event) => get().appendStream(event));

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

    // Safety timeout: fires 120s after the LAST stream event (reset on each event in appendStream).
    // This catches truly hung streams without killing active multi-turn agent loops.
    const SAFETY_TIMEOUT_MS = 120_000;
    const safetyTimer = setTimeout(() => {
      const state = get();
      if (state.isStreaming) {
        console.warn("[Chat] Safety timeout triggered — no stream events for 120s");
        const sid = state.activeSessionId;
        if (sid) api.agent.cleanupStream(sid);
        const systemMsg: ChatMessage = {
          id: "msg-" + Math.random().toString(36).slice(2, 9),
          role: "system",
          content: "Stream timed out after 120 seconds of inactivity. The agent may have encountered an issue.",
          timestamp: Date.now(),
        };
        set({
          isStreaming: false,
          _sendInProgress: false,
          streamingContent: "",
          thinkingContent: "",
          pendingToolCalls: [],
          pendingActivities: [],
          _safetyTimer: null,
          messages: [...state.messages, systemMsg],
          chatSessions: state.session
            ? state.chatSessions.map((cs) =>
                cs.id === state.session!.id
                  ? { ...cs, status: "completed", lastActivityAt: Date.now() }
                  : cs
              )
            : state.chatSessions,
        });
      }
    }, SAFETY_TIMEOUT_MS);
    set({ _safetyTimer: safetyTimer });

    try {
      const agentName = useAgents.getState().activeAgentName;
      await api.agent.sendPrompt(session.id, content, get().messages, agentName, pendingAttachments);
    } catch (err: unknown) {
      clearTimeout(safetyTimer);
      set({ _safetyTimer: null });
      const { isStreaming, session: currentSession } = get();
      // If appendStream already handled the error (streaming ended), don't add duplicate error message
      if (!isStreaming) { set({ _sendInProgress: false }); return; }
      const msg = err instanceof Error ? err.message : "Unknown error";
      const errorMsg: ChatMessage = {
        id: "err-" + Math.random().toString(36).slice(2, 9),
        role: "assistant",
        content: `**Error**: ${msg}\n\nCheck your provider settings and try again.`,
        timestamp: Date.now(),
      };
      const sessionId = currentSession?.id;
      if (!sessionId) { set({ _sendInProgress: false }); return; }
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
    // Clear safety timer on normal completion (message-end handles this)
    // Timer is cleared by the catch block on error; on success it's cleared
    // when streaming ends normally via the message-end handler
    set({ _sendInProgress: false });
  },

  appendStream(event) {
    const _log = (...args: unknown[]) => {
      try {
        if (typeof window !== "undefined" && (window as unknown as Record<string, unknown>).__DALAM_DEBUG) {
          console.log("[DALAM:store]", ...args);
        }
      } catch { /* ignore */ }
    };
    _log(`appendStream: ${event.type}`, event.type === "message-delta" ? `len=${event.content.length}` : event.type === "message-end" ? `msgId=${event.messageId}` : "");
    // Reset safety timer on every stream event — the agent loop is alive
    // as long as events keep flowing. This prevents the timer from killing
    // active multi-turn agent loops (tool approval waits, sequential LLM calls).
    const existingTimer = get()._safetyTimer;
    if (existingTimer) {
      clearTimeout(existingTimer);
      const SAFETY_TIMEOUT_MS = 120_000;
      const newTimer = setTimeout(() => {
        const state = get();
        if (state.isStreaming) {
          console.warn("[Chat] Safety timeout triggered — no stream events for 120s");
          const api = createDalamAPI();
          const sid = state.activeSessionId;
          if (sid) api.agent.cleanupStream(sid);
          const systemMsg: ChatMessage = {
            id: "msg-" + Math.random().toString(36).slice(2, 9),
            role: "system",
            content: "Stream timed out after 120 seconds of inactivity. The agent may have encountered an issue.",
            timestamp: Date.now(),
          };
          set({
            isStreaming: false,
            _sendInProgress: false,
            streamingContent: "",
            thinkingContent: "",
            pendingToolCalls: [],
            pendingActivities: [],
            _safetyTimer: null,
            messages: [...state.messages, systemMsg],
            chatSessions: state.session
              ? state.chatSessions.map((cs) =>
                  cs.id === state.session!.id
                    ? { ...cs, status: "completed", lastActivityAt: Date.now() }
                    : cs
                )
              : state.chatSessions,
          });
        }
      }, SAFETY_TIMEOUT_MS);
      set({ _safetyTimer: newTimer });
    }
    switch (event.type) {
      case "message-start": {
        const pending = get().pendingToolCalls;
        const hasUnresolved = pending.some(tc => tc.status === "awaiting-approval" || tc.status === "pending");
        set({
          streamingContent: "",
          thinkingContent: "",
          pendingActivities: [],
          _pendingChanges: [],
          // Don't clear taskPlan or todos here — they persist across turns within a session
          // They're only cleared when starting a completely new chat
          ...(hasUnresolved ? {} : { pendingToolCalls: [] }),
          isStreaming: true,
        });
        // Re-create safety timer for subsequent agent loop turns (tool results
        // delivered → message-end clears the timer → next turn needs protection).
        if (!get()._safetyTimer) {
          const SAFETY_TIMEOUT_MS = 120_000;
          const newTimer = setTimeout(() => {
            const state = get();
            if (state.isStreaming) {
              console.warn("[Chat] Safety timeout triggered during turn — no events for 120s");
              const api = createDalamAPI();
              const sid = state.activeSessionId;
              if (sid) api.agent.cleanupStream(sid);
              const systemMsg: ChatMessage = {
                id: "msg-" + Math.random().toString(36).slice(2, 9),
                role: "system",
                content: "Stream timed out after 120 seconds of inactivity. The agent may have encountered an issue.",
                timestamp: Date.now(),
              };
              set({
                isStreaming: false,
                streamingContent: "",
                thinkingContent: "",
                pendingToolCalls: [],
                pendingActivities: [],
                _safetyTimer: null,
                messages: [...state.messages, systemMsg],
              });
            }
          }, SAFETY_TIMEOUT_MS);
          set({ _safetyTimer: newTimer });
        }
        break;
      }
      case "message-delta":
        set((s) => {
          const newContent = s.streamingContent + event.content;
          // Only truncate display content if extremely large (200K+)
          // Tool parsing uses the raw content from the API, not this field
          if (newContent.length > 200000) {
            const trimmed = newContent.slice(-200000);
            const spaceIdx = trimmed.indexOf(" ");
            return { streamingContent: spaceIdx > 0 && spaceIdx < 200 ? trimmed.slice(spaceIdx + 1) : trimmed };
          }
          return { streamingContent: newContent };
        });
        break;
      case "diff-proposed": {
        const proposal = event.proposal;
        set((s) => {
          // Try to find the tool that matches this file path first
          let idx = s.pendingToolCalls.findIndex(
            tc => (tc.status === "awaiting-approval" || tc.status === "pending" || tc.status === "completed") &&
                  tc.args.path === proposal.filePath && !tc.diffId
          );
          // Fall back: try matching by tool name (write_file/edit_file) + any path arg
          if (idx === -1) {
            idx = s.pendingToolCalls.findIndex(
              tc => (tc.status === "awaiting-approval" || tc.status === "pending" || tc.status === "completed") &&
                    (tc.name === "write_file" || tc.name === "edit_file") &&
                    typeof tc.args.path === "string" && !tc.diffId
            );
          }
          // Last resort: pick the most recent pending tool that has no diff yet
          if (idx === -1) {
            for (let i = s.pendingToolCalls.length - 1; i >= 0; i--) {
              const tc = s.pendingToolCalls[i];
              if ((tc.status === "awaiting-approval" || tc.status === "pending" || tc.status === "completed") && !tc.diffId) {
                idx = i;
                break;
              }
            }
          }
          if (idx === -1) return s;
          const updated = [...s.pendingToolCalls];
          updated[idx] = { ...updated[idx], diffId: proposal.diffId, diff: proposal };
          return { pendingToolCalls: updated };
        });
        // Open diff view so user can preview the proposed change
        // Always open — even during streaming — so the diff is visible immediately
        useDiffView.getState().openFile({
          path: proposal.filePath,
          action: proposal.oldContent === "" ? "created" : "modified",
          additions: proposal.hunks.reduce((n: number, h: { newLines: number }) => n + h.newLines, 0),
          deletions: proposal.hunks.reduce((n: number, h: { oldLines: number }) => n + h.oldLines, 0),
        });
        break;
      }
      case "message-end": {
        const { messages, streamingContent, thinkingContent, _pendingChanges, todos, pendingToolCalls, pendingActivities, session: liveSession } = get();

        // Clear safety timeout if it exists — but ONLY when the turn is truly done.
        // During intermediate turns (tool calls just executed, agentic loop continues
        // with tool approval waits), extend the timer to 10 minutes so the agent
        // loop isn't killed while waiting for user approval.
        const existingTimer = get()._safetyTimer;
        if (existingTimer) {
          clearTimeout(existingTimer);
          const hasActiveToolCalls = pendingToolCalls.some(
            (tc) => tc.status === "awaiting-approval" || tc.status === "pending"
          );
          if (hasActiveToolCalls) {
            const TOOL_APPROVAL_TIMEOUT_MS = 600_000; // 10 min during tool approval
            const extendedTimer = setTimeout(() => {
              const state = get();
              if (state.isStreaming) {
                console.warn("[Chat] Safety timeout triggered during tool approval — no events for 10min");
                const api = createDalamAPI();
                const sid = state.activeSessionId;
                if (sid) api.agent.cleanupStream(sid);
                const systemMsg: ChatMessage = {
                  id: "msg-" + Math.random().toString(36).slice(2, 9),
                  role: "system",
                  content: "Agent loop timed out — no activity for 10 minutes during tool approval.",
                  timestamp: Date.now(),
                };
                set({
                  isStreaming: false,
                  streamingContent: "",
                  thinkingContent: "",
                  pendingToolCalls: [],
                  pendingActivities: [],
                  _safetyTimer: null,
                  messages: [...state.messages, systemMsg],
                });
              }
            }, TOOL_APPROVAL_TIMEOUT_MS);
            set({ _safetyTimer: extendedTimer });
          } else {
            set({ _safetyTimer: null });
          }
        }

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
          set({
            isStreaming: false,
            pendingToolCalls: [],
            pendingActivities: [],
            streamingContent: "",
            thinkingContent: "",
            chatSessions: liveSession
              ? get().chatSessions.map((cs) =>
                  cs.id === liveSession.id
                    ? { ...cs, status: "completed", lastActivityAt: Date.now() }
                    : cs
                )
              : get().chatSessions,
          });
          break;
        }

        // If there are pending tool calls, this is an intermediate turn (tools
        // were just executed). Save the current turn's content and clear transient
        // state so the agentic loop can continue streaming.
        if (allToolCalls.length > 0) {
          // Find the last user message to group this assistant turn under
          let lastUserMsgId: string | undefined;
          for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i].role === "user") { lastUserMsgId = messages[i].id; break; }
          }
          const intermediateMsg: ChatMessage = {
            id: event.messageId,
            role: "assistant",
            content: finalContent,
            timestamp: Date.now(),
            ...(lastUserMsgId ? { parentID: lastUserMsgId } : {}),
            ...(thinkingContent ? { thinking: thinkingContent } : {}),
            ...(_pendingChanges.length > 0 ? { fileChanges: [..._pendingChanges] } : {}),
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
        const currentTaskPlan = get().taskPlan;
        const currentTaskPlanSummary = get().taskPlanSummary;
        // Find the last user message to group this assistant turn under
        let lastUserMsgId: string | undefined;
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i].role === "user") { lastUserMsgId = messages[i].id; break; }
        }
        const assistantMsg: ChatMessage = {
          id: event.messageId,
          role: "assistant",
          content: finalContent,
          timestamp: Date.now(),
          ...(lastUserMsgId ? { parentID: lastUserMsgId } : {}),
          ...(thinkingContent ? { thinking: thinkingContent } : {}),
          ...(todos.length > 0 ? { todos: [...todos] } : {}),
          ...(_pendingChanges.length > 0 ? { fileChanges: [..._pendingChanges] } : {}),
          ...(allToolCalls.length > 0 ? { toolCalls: allToolCalls } : {}),
          ...(pendingActivities.length > 0 ? { activities: [...pendingActivities] } : {}),
          ...(currentTaskPlan && currentTaskPlan.length > 0 ? { taskPlan: currentTaskPlan, taskPlanSummary: currentTaskPlanSummary ?? undefined } : {}),
        };
        const sessionId = get().activeSessionId;
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
            : READ_TOOLS.has(tool.name)
              ? "read"
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
          const description = `Dalam (${useAgents.getState().activeAgentName} agent) wants to use \`${tool.name}\`.`;
          const activeSession = get().session;
          void usePermission.getState().ask({
            kind: permissionKey,
            title: tool.name,
            description,
            ...(commandStr ? { command: commandStr } : {}),
            ...(activeSession?.workspacePath ? { workspacePath: activeSession.workspacePath } : {}),
          }).then((decision) => {
            get().resolveToolApproval(tool.id, decision === "allow" || decision === "always" ? "approved" : "denied");
            // Persist "always allow" so future tools of the same kind are auto-approved
            if (decision === "always") {
              usePermission.getState().allowAlways({
                id: "perm-" + Math.random().toString(36).slice(2, 9),
                createdAt: Date.now(),
                kind: permissionKey,
                title: tool.name,
                description,
                ...(commandStr ? { command: commandStr } : {}),
                ...(activeSession?.workspacePath ? { workspacePath: activeSession.workspacePath } : {}),
              });
            }
          }).catch((err) => console.error("Permission dialog error:", err));
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
          thinkingContent: (s.thinkingContent + event.content).slice(-100000),
        }));
        break;
      }
      case "activity-explore": {
        set((s) => ({
          pendingActivities: [
            ...s.pendingActivities,
            {
              id: "pa-" + Math.random().toString(36).slice(2, 9),
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
              id: "pa-" + Math.random().toString(36).slice(2, 9),
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
              id: "pa-" + Math.random().toString(36).slice(2, 9),
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
        // Detect task plan and task completion events from the agent loop
        if (event.command === "task plan") {
          const resultText = event.result ?? "";
          const newTasks: TaskPlanItem[] = resultText.split("\n").filter(Boolean).map((line: string) => {
            const match = line.match(/^(\w+):\s*(.+)$/);
            return match ? { id: match[1], title: match[2], status: "pending" as const } : null;
          }).filter(Boolean) as TaskPlanItem[];
          if (newTasks.length > 0) {
            // Merge with existing task plan — preserve status of tasks that already exist
            set((s) => {
              const existing = s.taskPlan ?? [];
              const existingMap = new Map(existing.map(t => [t.id, t]));
              const merged = newTasks.map(t => existingMap.get(t.id) ?? t);
              return { taskPlan: merged, taskPlanSummary: null };
            });
          }
        } else if (event.command === "completed") {
          set((s) => ({
            taskPlan: s.taskPlan
              ? s.taskPlan.map((t) => t.status !== "done" ? { ...t, status: "done" as const } : t)
              : s.taskPlan,
            taskPlanSummary: event.result || "Task completed",
          }));
        } else if (event.command === "task budget exhausted") {
          set((s) => ({
            taskPlan: s.taskPlan
              ? s.taskPlan.map((t) => (t.status === "pending" || t.status === "running") ? { ...t, status: "failed" as const } : t)
              : s.taskPlan,
            taskPlanSummary: event.result,
          }));
        }
        // Only append non-meta bash activities to the visible activity feed
        const META_COMMANDS = new Set(["task plan", "completed", "task budget exhausted"]);
        if (!META_COMMANDS.has(event.command)) {
          set((s) => ({
            pendingActivities: [
              ...s.pendingActivities,
              { id: "pa-" + Math.random().toString(36).slice(2, 9), type: "bash" as const, command: event.command, result: event.result },
            ].slice(-500) as typeof s.pendingActivities,
          }));
        }
        break;
      }
      case "activity-plan": {
        set((s) => ({
          pendingActivities: [
            ...s.pendingActivities,
            { id: "pa-" + Math.random().toString(36).slice(2, 9), type: "plan" as const, plan: event.plan },
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
        const VALID_KINDS = ["bash", "edit", "mcp", "read"] as const;
        const permKind = (VALID_KINDS as readonly string[]).includes(event.kind) ? (event.kind as typeof VALID_KINDS[number]) : "bash";
        usePermission.getState().ask({
          kind: permKind,
          title: "Permission required",
          description: event.description ?? `Dalam wants to run: ${event.kind}`,
          ...(event.command ? { command: event.command } : {}),
        }).then((decision) => {
          if (event.toolCallId) {
            get().resolveToolApproval(event.toolCallId, decision === "allow" || decision === "always" ? "approved" : "denied");
          }
          // Persist "always allow" so future tools of the same kind are auto-approved
          if (decision === "always") {
            usePermission.getState().allowAlways({
              id: "perm-" + Math.random().toString(36).slice(2, 9),
              createdAt: Date.now(),
              kind: permKind,
              title: "Permission required",
              description: event.description ?? `Dalam wants to run: ${event.kind}`,
              ...(event.command ? { command: event.command } : {}),
            });
          }
        }).catch((err) => console.error("Permission dialog error:", err));
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
        let lastUserMsgId: string | undefined;
        for (let i = get().messages.length - 1; i >= 0; i--) {
          if (get().messages[i].role === "user") { lastUserMsgId = get().messages[i].id; break; }
        }
        const errorMsg: ChatMessage = {
          id: "err-" + Math.random().toString(36).slice(2, 9),
          role: "assistant",
          content: `**Error**: ${event.error}\n\nCheck your provider settings and try again.`,
          timestamp: Date.now(),
          ...(lastUserMsgId ? { parentID: lastUserMsgId } : {}),
        };
        const newSessionMessages = sessionId
          ? { ...get().sessionMessages, [sessionId]: [...(get().sessionMessages[sessionId] ?? []), errorMsg] }
          : get().sessionMessages;
        set((s) => {
          // Clear safety timer on error
          const timer = s._safetyTimer;
          if (timer) clearTimeout(timer);
          return {
            isStreaming: false,
            streamingContent: "",
            thinkingContent: "",
            pendingToolCalls: [],
            pendingActivities: [],
            _safetyTimer: null,
            messages: [...s.messages, errorMsg],
            sessionMessages: newSessionMessages,
            chatSessions: s.session
              ? s.chatSessions.map((cs) =>
                  cs.id === s.session!.id
                    ? { ...cs, status: "error", lastActivityAt: Date.now() }
                    : cs
                )
              : s.chatSessions,
          };
        });
        if (sessionId) {
          savePersistedMessages(newSessionMessages);
          savePersistedSessionSummaries(get().chatSessions);
        }
        break;
      }
      default:
        console.warn("Unknown stream event type:", (event as { type: string }).type);
        break;
    }
  },

  reset() {
    // Clear safety timer on reset
    const currentTimer = get()._safetyTimer;
    if (currentTimer) clearTimeout(currentTimer);
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
      _safetyTimer: null,
      _sendInProgress: false,
    });
  },

  setActiveSession(id) {
    const timer = get()._safetyTimer;
    if (timer) clearTimeout(timer);
    const { session, abort, sessionMessages, sessionAgentName, isStreaming } = get();
    // Only abort if the current session is actually streaming
    if (session && isStreaming) abort(session.id);
    if (!id) {
      if (useUI.getState().rightPanelTab === "terminal") {
        useUI.getState().setRightPanelOpen(false);
      }
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
        taskPlan: null,
        taskPlanSummary: null,
        _sendInProgress: false,
      });
      return;
    }
    const messages = sessionMessages[id] ?? [];
    const agent = sessionAgentName[id] ?? "build";
    useAgents.getState().setActiveAgent(agent);
    // Reconstruct the AgentSession object from stored data
    const chatSession = get().chatSessions.find((cs) => cs.id === id);
    if (!chatSession || !chatSession.workspacePath) {
      if (useUI.getState().rightPanelTab === "terminal") {
        useUI.getState().setRightPanelOpen(false);
      }
    } else {
      useTerminal.getState().ensureTabForCwd(chatSession.workspacePath);
    }
    const restoredSession: AgentSession | null = chatSession
      ? {
          id: chatSession.id,
          workspacePath: chatSession.workspacePath,
          model: chatSession.model ?? useSettings.getState().settings.selectedModel,
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
      taskPlan: null,
      taskPlanSummary: null,
      _sendInProgress: false,
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
    const timer = get()._safetyTimer;
    if (timer) clearTimeout(timer);
    const api = createDalamAPI();
    void get().abort(id).catch(() => {});
    api.agent.cleanupStream(id);
    set((s) => {
      const { [id]: _removed1, ...restVersions } = s.sessionVersions;
      const { [id]: _removed2, ...restMessages } = s.sessionMessages;
      const { [id]: _removed3, ...restAgents } = s.sessionAgentName;
      const { [id]: _removed4, ...restCompaction } = s.compactionSummaries;
      const newSessions = s.chatSessions.filter((cs) => cs.id !== id);
      savePersistedVersions(restVersions);
      savePersistedMessages(restMessages);
      savePersistedAgents(restAgents);
      savePersistedSessionSummaries(newSessions);
      savePersistedCompactionSummaries(restCompaction);
      
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
          _sendInProgress: false,
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
      chatSessions: s.chatSessions.map(cs =>
        cs.id === sessionId ? { ...cs, messageCount: (cs.messageCount ?? 0) + 1 } : cs
      ),
    }));
    savePersistedMessages(newSessionMessages);
  },

  saveVersion(sessionId, label) {
    const { messages, sessionVersions } = get();
    if (!messages.length) return;
    const versions = sessionVersions[sessionId] ?? [];
    const parentId = versions.length > 0 ? versions[versions.length - 1].id : undefined;
    const version: import("@dalam/shared-types").ChatVersion = {
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
    const { messages, sessionVersions, sessionMessages, isStreaming } = get();
    if (isStreaming) return; // Don't restore while streaming
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
      if (stats.needsCompaction) {
        // Select messages for compaction FIRST from original (un-pruned) messages
        const { toCompact } = selectMessagesForCompaction(messages, 6);
        if (toCompact.length > 0) {
          // Only prune tool outputs in the messages being compacted (preserve full outputs in kept messages)
          const prunedToCompact = stats.shouldPrune
            ? pruneToolOutputs(toCompact).pruned
            : toCompact;

          const api = createDalamAPI();
          const previousSummary = compactionSummaries[sessionId];

          // Use the structured SUMMARY_TEMPLATE format (Goal/Instructions/Discoveries/Accomplished)
          const compactionMessages = buildCompactionPrompt(prunedToCompact, previousSummary);

          const model = selectedModelId || useSettings.getState().settings.selectedModel;
          const summary = await api.agent.summarizeMessages(model, compactionMessages);
          if (summary) {
            // Replace compacted messages with summary + kept messages
            const { toKeep } = selectMessagesForCompaction(messages, 6);
            const summaryMsg: ChatMessage = {
              id: "compact-" + Math.random().toString(36).slice(2, 9),
              role: "system",
              content: `[Conversation summary]\n${summary}`,
              timestamp: Date.now(),
            };
            const compacted = [summaryMsg, ...toKeep];
            set((s) => {
              const nextSummaries = { ...s.compactionSummaries, [sessionId]: summary };
              const nextMessages = { ...s.sessionMessages, [sessionId]: compacted };
              savePersistedCompactionSummaries(nextSummaries);
              savePersistedMessages(nextMessages);
              return { compactionSummaries: nextSummaries, sessionMessages: nextMessages };
            });
          }
        }
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
    const api = createDalamAPI();
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
    if (useUI.getState().rightPanelTab === "terminal") {
      useUI.getState().setRightPanelOpen(false);
    }
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
      taskPlan: null,
      taskPlanSummary: null,
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
  ensureTabForCwd: (cwd: string) => void;
};

export const useTerminal = create<TerminalState>((set, get) => ({
  tabs: [{ id: "t-1", title: "zsh", cwd: "." }],
  activeTabId: "t-1",
  output: {},
  addTab(cwd) {
    set((s) => {
      const id = "t-" + Math.random().toString(36).slice(2, 9);
      const title = basename(cwd) || "zsh";
      return {
        tabs: [...s.tabs, { id, title, cwd }],
        activeTabId: id,
      };
    });
  },
  closeTab(id) {
    set((s) => {
      const remaining = s.tabs.filter((t) => t.id !== id);
      const newActive =
        s.activeTabId === id ? remaining[0]?.id ?? null : s.activeTabId;
      const { [id]: _removed, ...rest } = s.output;
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
  ensureTabForCwd(cwd) {
    const { tabs, setActiveTab, addTab } = get();
    const existing = tabs.find((t) => t.cwd === cwd);
    if (existing) {
      setActiveTab(existing.id);
    } else {
      if (tabs.length === 1 && tabs[0].id === "t-1" && tabs[0].cwd === ".") {
        set({
          tabs: [{ id: "t-1", title: basename(cwd) || "zsh", cwd }],
          activeTabId: "t-1",
        });
      } else {
        addTab(cwd);
      }
    }
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

const MCP_STORAGE_KEY = "dalam.mcpServers.v1";
const USER_SKILLS_STORAGE_KEY = "dalam.userSkills.v1";
const BUNDLED_SKILLS_STORAGE_KEY = "dalam.bundledSkillsStates.v1";

function saveMcpServers(servers: McpServer[]) {
  const userServers = servers
    .filter((m) => m.scope !== "project")
    .map(({ status: _status, tools: _tools, error: _error, ...rest }) => ({
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
  } catch { /* ignore */ }
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
  } catch { /* ignore */ }

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
  } catch { /* ignore */ }

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
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

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
            if (timeoutId !== undefined) clearTimeout(timeoutId);
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

      timeoutId = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          cleanup();
          child.kill().catch(() => {});
          reject(new Error("Timeout waiting for tools/list response (15s)"));
        }
      }, 15000);
    }).catch((err) => {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
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
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
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

const PROVIDERS_STORAGE_KEY = "dalam.providers.v1";

function loadProviders(): ModelProvider[] {
  try {
    const raw = localStorage.getItem(PROVIDERS_STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
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
      localStorage.removeItem(`dalam.provider.${id}`);
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

function normalizeBrowserUrl(input: string): string | null {
  const raw = input.trim();
  if (!raw) return "";
  // SSRF protection: check private/internal addresses even for protocol-prefixed URLs
  const privatePatterns = [
    /^https?:\/\/(localhost|127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|0\.|::1|\[::1\])/i,
    /^https?:\/\/metadata\.google\.internal/i,
    /^https?:\/\/instance-data\.local/i,
  ];
  if (privatePatterns.some((p) => p.test(raw))) return null;
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

  // SSRF protection: check private/internal addresses without protocol
  const hostname = host || raw;
  const privatePatternsNoProto = [
    /^127\./, /^10\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./,
    /^169\.254\./, /^0\./, /^localhost$/i, /^::1$/, /^\[::1\]$/,
    /^metadata\.google\.internal$/i, /^instance-data\.local$/i,
  ];
  if (privatePatternsNoProto.some(p => p.test(hostname))) {
    return null; // Block private/metadata addresses
  }

  return "https://www.google.com/search?q=" + encodeURIComponent(raw);
}

export const useUI = create<UIState>((set, _get) => ({
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
    const normalizedUrl = normalizeBrowserUrl(url);
    if (!normalizedUrl) return; // Invalid/blocked URL
    set((s) => ({
      browserTabs: s.browserTabs.map((t) => {
        if (t.id !== id) return t;
        const truncated = normalizedUrl.slice(0, 200);
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

export type PermissionKind = "bash" | "edit" | "mcp" | "read";

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

const ALWAYS_ALLOWED_KEY = "dalam.alwaysAllowed.v1";

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
  try { localStorage.setItem(ALWAYS_ALLOWED_KEY, JSON.stringify(data)); } catch { /* ignore */ }
  // Also persist to .dalam/config.json for project-level persistence
  void persistAlwaysAllowedToDisk(data);
}

async function persistAlwaysAllowedToDisk(data: Record<string, true>) {
  try {
    const ws = useWorkspace.getState();
    const activeWs = ws.workspaces.find((w) => w.id === ws.activeWorkspaceId);
    if (!activeWs) return;
    const api = createDalamAPI();
    const { exists, mkdir } = await import("@tauri-apps/plugin-fs");
    const dotDalam = joinPath(activeWs.path, ".dalam");
    if (!(await exists(dotDalam))) await mkdir(dotDalam);
    const configPath = joinPath(dotDalam, "config.json");
    let existing: WorkspaceConfig = {};
    try {
      if (await exists(configPath)) {
        existing = JSON.parse(await api.fs.readFile(configPath));
      }
    } catch { /* ignore */ }
    existing.alwaysAllowed = data;
    await api.fs.writeFile(configPath, JSON.stringify(existing, null, 2));
  } catch (e) { console.warn("Failed to persist alwaysAllowed to disk:", e); }
}

async function loadAlwaysAllowedFromDisk(): Promise<Record<string, true>> {
  try {
    const ws = useWorkspace.getState();
    const activeWs = ws.workspaces.find((w) => w.id === ws.activeWorkspaceId);
    if (!activeWs) return {};
    const api = createDalamAPI();
    const { exists } = await import("@tauri-apps/plugin-fs");
    const configPath = joinPath(activeWs.path, ".dalam", "config.json");
    if (await exists(configPath)) {
      const content = await api.fs.readFile(configPath);
      const config = JSON.parse(content);
      return config.alwaysAllowed || {};
    }
  } catch { /* ignore */ }
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