import { create } from "zustand";
import { logPermission } from "../lib/security";
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
  ToolCall,
  Workspace,
} from "@dalam/shared-types";
import { DEFAULT_SETTINGS } from "@dalam/shared-types";
import { createDalamAPI } from "@/lib/dalamAPI";
import { mcpHttpSessions } from "@/lib/dalamAPI";
import type { SubAgentState } from "@dalam/shared-types";
import { startRecording, stopRecording, recordUserMessage, recordAssistantMessage } from "@/lib/trajectoryRecorder";
import { basename, toPosix, joinPath, detectLanguage } from "@/lib/pathUtils";
import { ALL_AGENTS, PRIMARY_AGENTS, SUBAGENTS, getPrimaryAgent, mergeRulesets, evaluate, canonicaliseBashCommand } from "@/lib/agents";
import { skillRegistry, BUNDLED_SKILLS, matchSkillInvocation, renderSkillForPrompt, loadProjectSkills, refreshProjectSkills } from "@/lib/skills";
import { computeContextStats, selectMessagesForCompaction, pruneToolOutputs, tier1PruneToolOutputs, buildCompactionPrompt, parseContextWindow, CTX } from "@/lib/contextManager";
import {
  agentReducer,
  createInitialRuntimeState,
  type AgentRuntimeState,
} from "@/lib/agentRuntimeContract";

export { ALL_AGENTS, PRIMARY_AGENTS, SUBAGENTS, getPrimaryAgent };
export type { AgentInfo, AgentMode, PermissionAction, PermissionRule, PrimaryAgentName, SkillInfo, FileAttachment };
export { BUNDLED_SKILLS, skillRegistry, matchSkillInvocation, renderSkillForPrompt };
export { exportTrajectories, getTrajectoryStats } from "@/lib/trajectoryRecorder";

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
  task: "task",
  create_file: "create_file",
};

// Comprehensive list of ALL tool names for display stripping (must match dalamAPI.ts KNOWN_TOOL_NAMES)
const ALL_TOOL_NAMES = [
  "read_file", "write_file", "edit_file", "list_dir", "grep_file", "search_files",
  "run_command", "git_status", "git_commit", "git_log", "git_branch", "git_checkout", "git_diff_file",
  "clipboard_read", "clipboard_write", "notify", "system_info", "open_url",
  "launch_app", "reveal_in_finder",
  "get_env", "get_screen_info", "list_processes", "kill_process", "get_disk_space",
  "memory_save", "memory_search", "memory_delete", "memory_stats",
  "memory_maintain", "memory_extract", "memory_export", "memory_import",
  "task", "open_panel", "screenshot", "browser_navigate", "run_preview", "browser_execute", "create_task_plan", "question",
  // UI control tools
  "set_theme", "toggle_theme", "set_view_mode", "toggle_view_mode",
  "toggle_right_panel", "toggle_bottom_panel", "set_right_panel_tab", "set_bottom_panel_tab",
  "new_terminal", "terminal_write", "create_file", "execute",
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
const XML_INCOMPLETE_TAG_RE = new RegExp(`<(${KNOWN_TAG_NAMES.join("|")})[^>]*$`, "gi");
// Strip model output tags WITH their content (e.g. <thinking>...</thinking>)
const XML_MODEL_OUTPUT_CONTENT_RE = /<(?:user|assistant|system|thinking|think|thought|reasoning|reasoning_content|analysis|plan|response|output|result|content|message|final)[^>]*>[\s\S]*?<\/(?:user|assistant|system|thinking|think|thought|reasoning|reasoning_content|analysis|plan|response|output|result|content|message|final)\s*>/gi;
const XML_MODEL_OUTPUT_RE = /<\/?(?:user|assistant|system|thinking|think|thought|reasoning|reasoning_content|analysis|plan|response|output|result|content|message|final)[^>]*>/gi;
const XML_MODEL_OUTPUT_CLOSE_RE = /<\/?(?:user|assistant|system|thinking|think|thought|reasoning|reasoning_content|analysis|plan|response|output|result|content|message|final)\s*>/gi;
// Strip skill invocation / structured plan XML tags emitted by models in Plan mode.
const XML_SKILL_INVOCATION_RE = /<skill_invocation[\s\S]*?<\/skill_invocation>|<skill_invocation[^>]*\/>/gi;
const XML_STRUCTURED_TAG_RE = /<\/?(?:parameter|goal|subgoal|steps|step|constraint|context|scope)[^>]*>[\s\S]*?<\/(?:parameter|goal|subgoal|steps|step|constraint|context|scope)>|<\/?(?:parameter|goal|subgoal|steps|step|constraint|context|scope)[^>]*\/>/gi;
const XML_STRUCTURED_ORPHAN_CLOSE_RE = /<\/(?:parameter|goal|subgoal|steps|step|constraint|context|scope)>/gi;

/**
 * Strip all XML tool call tags from content (for display purposes).
 * Handles opening+closing pairs, self-closing tags, and closing-only tags.
 * Also handles malformed XML (unescaped quotes in attributes, broken tags).
 */
export function stripXmlToolCallTags(content: string): string {
  // Fast path: skip all regex if content has no angle brackets
  if (!content.includes("<") && !content.match(/\bquestion\s+question=/)) return content;
  let result = content;
  // Strip opening+content+closing blocks: <tool ...>content</tool>
  // and self-closing tags: <tool .../>
  result = result.replace(XML_STRIP_RE, "");
  // Strip orphan closing tags that weren't paired above: </tool>
  result = result.replace(XML_CLOSING_TAG_RE, "");
  // Strip MCP tags
  result = result.replace(XML_MCP_STRIP_RE, "");
  // Strip malformed question tags without opening < (LLM output quirk)
  result = result.replace(/\bquestion\s+question="[^"]*"\s+options="[^"]*"\s*\/?>/g, "");
  // Strip Anthropic antml:function_calls / <invoke> blocks
  result = result.replace(/(?:antml:function_calls\s*)?<invoke[\s\S]*?<\/(?:antml:)?function_calls\s*>/gi, "");
  // Strip generic <function_calls> blocks (Llama, Mistral, vLLM, OpenAI leaks)
  result = result.replace(/<function_calls[\s\S]*?<\/function_calls>/gi, "");
  result = result.replace(/<\/?function_calls[^>]*>/gi, "");
  // Strip orphan antml tags
  result = result.replace(/<\/?antml:[^>]*>/gi, "");
  // Strip orphan <invoke> tags
  result = result.replace(/<\/?invoke[^>]*>/gi, "");
  // Strip incomplete XML tool tags at end of content (arriving across streaming deltas)
  // Matches: <run_command command="ls -la$  (no closing > or />)
  result = result.replace(XML_INCOMPLETE_TAG_RE, "");
  // Strip DeepSeek special tokens (unicode bracket tokens)
  result = result.replace(/<\uff5c[\s\S]*?\uff5c>/g, "");
  // Strip OpenAI internal channel tokens WITH their content (e.g. <|channel|>leaked text<|end|>)
  result = result.replace(/<\|(?:channel|message|system_call)\|>[\s\S]*?<\|(?:channel|message|end|system_call)\|>/gi, "");
  result = result.replace(/<\|start\|>[\s\S]*?<\|end\|>/gi, "");
  // Strip any remaining OpenAI internal channel/message token markers
  result = result.replace(/<\|(?:channel|message|start|end|system_call)\|>/gi, "");
  // Strip incomplete think/streaming tags at end of content
  result = result.replace(/<think[^>]*$/gi, "");
  result = result.replace(/<function_calls[^>]*$/gi, "");
  // Strip broken/malformed tag fragments from model output (e.g. ><]minimax[>][)
  result = result.replace(/>\]\s*<[^>]*>?\[</g, "");
  result = result.replace(/\]>\s*\[</g, "");
  result = result.replace(/<\]?\w+\[>?\]?\[?/g, "");
  // Strip skill invocation / structured plan XML blocks (Plan mode)
  result = result.replace(XML_SKILL_INVOCATION_RE, "");
  result = result.replace(XML_STRUCTURED_TAG_RE, "");
  result = result.replace(XML_STRUCTURED_ORPHAN_CLOSE_RE, "");
  // Strip model output tags WITH their content (e.g. <thinking>...</thinking>)
  result = result.replace(XML_MODEL_OUTPUT_CONTENT_RE, "");
  // Strip remaining model output tag markers
  result = result.replace(XML_MODEL_OUTPUT_RE, "");
  // Strip orphan closing tags for the above
  result = result.replace(XML_MODEL_OUTPUT_CLOSE_RE, "");
  // Strip incomplete skill/structured tags at end of content (streaming)
  result = result.replace(/<skill_invocation[^>]*$/gi, "");
  result = result.replace(/<\/?(?:parameter|goal|subgoal|steps|step|constraint|context|scope)[^>]*$/gi, "");
  // Clean up excessive whitespace left behind
  // Collapse 3+ consecutive newlines into 2
  result = result.replace(/\n{3,}/g, "\n\n");
  // If the entire remaining content is just whitespace, return empty string
  // (this handles cases where only tool calls were in the content and they've all been stripped)
  if (result.trim() === "") result = "";
  return result;
}

// Tool name → permission kind mappings (module-level to avoid recreation per event)
const EDIT_TOOLS = new Set(["edit_file", "edit", "write_file", "write", "create_file", "git_commit", "memory_delete", "memory_maintain", "memory_export", "memory_import", "memory_save"]);
const BASH_TOOLS = new Set(["shell", "bash", "execute", "run_command", "launch_app", "kill_process", "new_terminal", "terminal_write", "browser_navigate", "browser_execute", "run_preview", "open_url", "reveal_in_finder"]);
const READ_TOOLS = new Set(["read_file", "list_dir", "grep_file", "search_files", "git_status", "git_log", "git_branch", "git_diff_file", "clipboard_read", "system_info", "memory_search", "memory_stats", "memory_extract", "task", "question", "open_panel", "screenshot", "notify", "get_env", "get_screen_info", "list_processes", "get_disk_space", "set_theme", "toggle_theme", "set_view_mode", "toggle_view_mode", "toggle_right_panel", "toggle_bottom_panel", "set_right_panel_tab", "set_bottom_panel_tab"]);

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
      id: "xml-tc-" + crypto.randomUUID(),
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
        settings: { ...s.settings, ...all },
        loaded: true,
      }));
      if (all.selectedModel) {
        // Use event bus instead of direct getState() call to avoid circular dependency
        import("./events").then(({ eventBus }) => {
          eventBus.emit("chat:model-selected", { modelId: all.selectedModel! });
        });
      }
    } catch (err) {
      if (import.meta.env.DEV) console.error("Failed to load settings, using defaults:", err);
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
    const results = await Promise.allSettled(
      Object.entries(updates).map(([key, value]) =>
        api.settings.set(key as keyof AppSettings, value as never)
      )
    );
    for (let i = 0; i < results.length; i++) {
      if (results[i].status === "rejected") {
        console.warn(`Failed to save setting ${Object.keys(updates)[i]}:`, (results[i] as PromiseRejectedResult).reason);
      }
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
  } catch (err) { console.warn("[useChat] Failed to load persisted data:", err); }
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
    const { exists, mkdir } = await import("@tauri-apps/plugin-fs");
    const dotDalam = joinPath(workspacePath, ".dalam");
    if (!(await exists(dotDalam))) {
      await mkdir(dotDalam, { recursive: true });
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
            // Store cancel function keyed by workspace for cancellation propagation
            // This is called via abort() which routes through cancelSessionOperations
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
    // Abort any active streaming session before switching
    // Use event bus to avoid circular dependency
    const ws = get().workspaces.find((w) => w.id === id);
    import("./events").then(({ eventBus }) => {
      eventBus.emit("workspace:switched", { workspaceId: id, path: ws?.path ?? "" });
    });
    // Clear all open tabs and file tree when switching projects (VS Code behavior)
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
      // Auto-switch to editor mode when opening a file
      // Use event bus to avoid circular dependency
      import("./events").then(({ eventBus }) => {
        eventBus.emit("workspace:file-opened", { path });
      });
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
      // Auto-switch to editor mode when opening a file
      // Use event bus to avoid circular dependency
      import("./events").then(({ eventBus }) => {
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

// Subscribe to view mode changes to handle cross-store logic
// This replaces the direct getState() calls that caused circular dependencies
{
  let _viewModeListenerRegistered = false;
  try {
    import("./events").then(({ eventBus }) => {
      if (_viewModeListenerRegistered) return;
      _viewModeListenerRegistered = true;
      eventBus.on("ui:view-mode-changed", ({ mode }) => {
        if (mode === "chat") {
          // When switching to chat mode, close all open editor tabs
          useWorkspace.setState({ openTabs: [], activeFilePath: null });
        }
        if (mode === "editor") {
          // When switching to editor mode, load file tree for the active workspace
          const wsId = useWorkspace.getState().activeWorkspaceId;
          const ws = useWorkspace.getState().workspaces.find((w) => w.id === wsId);
          if (ws) {
            void useWorkspace.getState().loadFileTree(ws.path);
          }
        }
      });
    });
  } catch (err) {
    console.warn("[Store] Failed to register view-mode-changed listener:", err);
  }
}

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
  } catch (err) {
    console.warn("[useChat] Failed to load persisted data:", err);
    return new Set(defaults);
  }
}

function saveEnabledSkills(s: Set<string>) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(ENABLED_SKILLS_STORAGE, JSON.stringify(Array.from(s)));
  } catch (err) {
    console.warn("[useChat] Failed to load persisted data:", err);
  }
}

function loadPersistedVersions(): Record<string, import("@dalam/shared-types").ChatVersion[]> {
  try {
    const raw = localStorage.getItem(SESSION_VERSIONS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (err) { console.warn("[useChat] Failed to load persisted data:", err); return {}; }
}

function savePersistedVersions(versions: Record<string, import("@dalam/shared-types").ChatVersion[]>) {
  try { localStorage.setItem(SESSION_VERSIONS_KEY, JSON.stringify(versions)); } catch (e) { console.warn("Failed to save versions:", e); }
  void saveWorkspaceData();
}

function loadPersistedMessages(): Record<string, import("@dalam/shared-types").ChatMessage[]> {
  try {
    const raw = localStorage.getItem(SESSION_MESSAGES_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (err) { console.warn("[useChat] Failed to load persisted data:", err); return {}; }
}

// Throttled message persistence: batches rapid localStorage writes during streaming.
let _saveMessagesTimer: ReturnType<typeof setTimeout> | null = null;
let _pendingMessagesRef: Record<string, import("@dalam/shared-types").ChatMessage[]> | null = null;
const SAVE_MESSAGES_DEBOUNCE_MS = 200;
if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", () => flushSavePersistedMessages());
}
type MessagesMap = Record<string, import("@dalam/shared-types").ChatMessage[]>;
function _doSavePersistedMessages(messages: MessagesMap) {
  try {
    localStorage.setItem(SESSION_MESSAGES_KEY, JSON.stringify(messages));
  } catch (e) {
    if (e instanceof DOMException && e.name === 'QuotaExceededError') {
      console.warn("[Storage] Quota exceeded - truncating tool results");
      const pruned = truncateToolResults(messages);
      let recovered = false;
      try { localStorage.setItem(SESSION_MESSAGES_KEY, JSON.stringify(pruned)); recovered = true; } catch {
        console.warn("[Storage] Quota exceeded - trimming old message content");
        const pruned2 = trimOldMessages(pruned);
        try { localStorage.setItem(SESSION_MESSAGES_KEY, JSON.stringify(pruned2)); recovered = true; } catch {
          console.warn("[Storage] Quota exceeded - dropping oldest sessions");
          const pruned3 = dropOldestSessions(pruned2, 3);
          try { localStorage.setItem(SESSION_MESSAGES_KEY, JSON.stringify(pruned3)); recovered = true; } catch {
            if (import.meta.env.DEV) console.error("[Storage] Failed to save messages even after aggressive pruning");
          }
        }
      }
      // Notify user about storage pruning
      void import("../components/ui/toastStore").then(({ useToasts }) => {
        useToasts.getState().push({
          kind: "warning",
          title: "Storage space low",
          description: recovered
            ? "Recovered space by pruning old data. Consider exporting sessions."
            : "Could not save data. Please export and clear old sessions.",
          durationMs: 10000,
        });
      });
    } else {
      console.warn("Failed to save messages:", e);
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
  } catch (err) { console.warn("[useChat] Failed to load persisted data:", err); return {}; }
}

function savePersistedAgents(agents: Record<string, PrimaryAgentName>) {
  try { localStorage.setItem(SESSION_AGENTS_KEY, JSON.stringify(agents)); } catch (e) { console.warn("Failed to save agents:", e); }
  void saveWorkspaceData();
}

function loadPersistedSessionSummaries(): ChatSessionSummary[] {
  try {
    const raw = localStorage.getItem(SESSION_SUMMARIES_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (err) { console.warn("[useChat] Failed to load persisted data:", err); return []; }
}

export function savePersistedSessionSummaries(sessions: ChatSessionSummary[]) {
  try { localStorage.setItem(SESSION_SUMMARIES_KEY, JSON.stringify(sessions)); } catch (e) { console.warn("Failed to save session summaries:", e); }
  void saveWorkspaceData();
}

const COMPACTION_SUMMARIES_KEY = "dalam.compactionSummaries.v1";

function loadPersistedCompactionSummaries(): Record<string, string> {
  try {
    const raw = localStorage.getItem(COMPACTION_SUMMARIES_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (err) { console.warn("[useChat] Failed to load persisted data:", err); return {}; }
}

function savePersistedCompactionSummaries(summaries: Record<string, string>) {
  try { localStorage.setItem(COMPACTION_SUMMARIES_KEY, JSON.stringify(summaries)); } catch (e) { console.warn("Failed to save compaction summaries:", e); }
  void saveWorkspaceData();
}

// Compaction throttle: avoid redundant computeContextStats + summarization calls
const _lastCompactionAttempt: Record<string, number> = {};
const COMPACTION_THROTTLE_MS = 30_000;
const COMPACTION_MIN_MESSAGES = 10;

// Two-tier compaction tracking (Hermes pre-emptive pattern)
// Tier 1: lightweight tool output pruning at 50% context usage (no LLM)
// Tier 2: full LLM summarization at 85% context usage
const _compactionTier: Record<string, number> = {}; // sessionId → last tier applied (0 = none, 1 = pruned, 2 = compacted)

// Anti-thrashing: track compaction effectiveness to skip ineffective compactions.
// Inspired by Hermes' ineffective compression detection: if savings are below
// a minimum threshold, skip future compactions for this session temporarily.
// Negative = ineffective (abs = original msg count); positive = compacted msg count
const _lastCompactionCounts: Record<string, number> = {};
const COMPACTION_MIN_SAVINGS_PERCENT = 5; // Minimum 5% reduction to consider compaction effective
const ANTI_THRASH_SKIP_MS = 60_000; // Skip compaction for 60s after ineffective attempt
const _antiThrashTimestamps: Record<string, number> = {}; // sessionId → timestamp of last skip

// ============================================================================
// Safety Timer Helper — eliminates 3× duplicated timer logic in sendMessage/appendStream
// ============================================================================
const SAFETY_TIMEOUT_MS = 120_000;
const TOOL_APPROVAL_TIMEOUT_MS = 600_000; // 10 min during tool approval

function _createSafetyTimer(
  get: () => ChatState,
  set: (partial: Partial<ChatState> | ((s: ChatState) => Partial<ChatState>)) => void,
  mode: "normal" | "turn" | "tool-approval" = "normal"
): ReturnType<typeof setTimeout> {
  const timeout = mode === "tool-approval" ? TOOL_APPROVAL_TIMEOUT_MS : SAFETY_TIMEOUT_MS;
  return setTimeout(() => {
    const state = get();
    if (!state.isStreaming) return;
    console.warn(`[Chat] Safety timeout triggered (${mode}) — no stream events for ${timeout / 1000}s`);
    const api = createDalamAPI();
    const sid = state.activeSessionId;
    if (sid) api.agent.cleanupStream(sid);
    const systemMsg: ChatMessage = {
      id: "msg-" + crypto.randomUUID(),
      role: "system",
      content: mode === "tool-approval"
        ? "Agent loop timed out — no activity for 10 minutes during tool approval."
        : "Stream timed out after 120 seconds of inactivity. The agent may have encountered an issue.",
      timestamp: Date.now(),
    };
    // Clear any pending auto-remove timers to prevent orphaned callbacks
    get()._autoRemoveTimers.forEach((t) => clearTimeout(t));
    const updatedSessions = state.session
      ? state.chatSessions.map((cs) =>
          cs.id === state.session!.id
            ? { ...cs, status: "completed" as const, lastActivityAt: Date.now(), lastVisitedAt: Date.now() }
            : cs
        )
      : state.chatSessions;
    const updatedSessionMessages = sid
      ? { ...state.sessionMessages, [sid]: [...(state.sessionMessages[sid] ?? []), systemMsg] }
      : state.sessionMessages;
    set({
      isStreaming: false,
      streamingStartedAt: null,
      _sendInProgress: false,
      _autoRemoveTimers: new Set<ReturnType<typeof setTimeout>>(),
      streamingContent: "",
      thinkingContent: "",
      pendingToolCalls: [],
      pendingActivities: [],
      _safetyTimer: null,
      _pendingChanges: [],
      messages: [...state.messages, systemMsg],
      chatSessions: updatedSessions,
      sessionMessages: updatedSessionMessages,
    });
    savePersistedSessionSummaries(updatedSessions);
    savePersistedMessages(updatedSessionMessages);
  }, timeout);
}

// ============================================================================
// Doom Loop / Death Spiral Detection (inspired by Hermes ToolCallGuardrailController)
// Warns at doomLoopThreshold (configurable in Settings > General),
// hard-stops at 2× that value.
// ============================================================================
const DOOM_LOOP_THRESHOLD = 5; // fallback default if setting is unset
interface ToolCallRecord { name: string; args: string; }
const _toolCallHistory: Record<string, ToolCallRecord[]> = {};
const _toolFailureCounts: Record<string, Record<string, number>> = {};

type DoomLoopResult = { message: string; severity: "warn" | "halt" };

function _checkDoomLoop(sessionId: string, toolName: string, toolArgs: Record<string, unknown>): DoomLoopResult | null {
  const sig = `${toolName}:${JSON.stringify(toolArgs, Object.keys(toolArgs).sort())}`;
  const failures = { ...(_toolFailureCounts[sessionId] ?? {}) };
  const currentCount = (failures[sig] ?? 0) + 1;
  failures[sig] = currentCount;
  _toolFailureCounts[sessionId] = failures;
  // Read threshold from user settings (configurable in Settings > General)
  const threshold = useSettings.getState().settings.doomLoopThreshold ?? DOOM_LOOP_THRESHOLD;
  const haltThreshold = threshold * 2;
  if (currentCount >= haltThreshold) {
    return { message: `Doom loop HALTED: tool "${toolName}" has failed ${currentCount} times consecutively with identical arguments. The agentic loop has been stopped.`, severity: "halt" };
  }
  if (currentCount >= threshold) {
    return { message: `Doom loop detected: tool "${toolName}" has failed ${currentCount} times consecutively with identical arguments. The agent appears stuck in a death spiral.`, severity: "warn" };
  }
  return null;
}

function _recordToolFailure(sessionId: string, toolName: string, toolArgs: Record<string, unknown>) {
  // Periodically prune stale sessions to prevent unbounded memory growth
  _pruneDoomLoopMaps();
  const history = [...(_toolCallHistory[sessionId] ?? [])];
  history.push({ name: toolName, args: JSON.stringify(toolArgs, Object.keys(toolArgs).sort()) });
  _toolCallHistory[sessionId] = history.slice(-50);
  // Cap _toolFailureCounts to prevent unbounded growth across sessions
  const failures = { ...(_toolFailureCounts[sessionId] ?? {}) };
  const keys = Object.keys(failures);
  if (keys.length > 100) {
    // Remove oldest entries (keep most recent 50)
    const toRemove = keys.slice(0, keys.length - 50);
    for (const k of toRemove) delete failures[k];
    _toolFailureCounts[sessionId] = failures;
  }
}

// Global cap: if too many sessions accumulate, prune the oldest ones
const MAX_SESSIONS_IN_DOOM_MAPS = 20;
function _pruneDoomLoopMaps() {
  const sessionIds = Object.keys(_toolCallHistory);
  if (sessionIds.length > MAX_SESSIONS_IN_DOOM_MAPS) {
    const toRemove = sessionIds.slice(0, sessionIds.length - MAX_SESSIONS_IN_DOOM_MAPS);
    for (const id of toRemove) {
      delete _toolCallHistory[id];
      delete _toolFailureCounts[id];
    }
  }
}

function _clearToolFailure(sessionId: string, toolName: string, toolArgs: Record<string, unknown>) {
  const sig = `${toolName}:${JSON.stringify(toolArgs, Object.keys(toolArgs).sort())}`;
  const failures = { ...(_toolFailureCounts[sessionId] ?? {}) };
  delete failures[sig];
  _toolFailureCounts[sessionId] = failures;
}

function _clearDoomLoopState(sessionId: string) {
  delete _toolCallHistory[sessionId];
  delete _toolFailureCounts[sessionId];
  delete _contextOverflowRetries[sessionId];
  delete _contextBudgetFactor[sessionId];
}

// ============================================================================
// Context Overflow Detection (inspired by OpenCode's auto-retry pattern)
// ============================================================================
const CONTEXT_OVERFLOW_PATTERNS = [
  /context[_ ]length[_ ]exceeded/i,
  /maximum[_ ]context[_ ]length/i,
  /context[_ ]window/i,
  /prompt[_ ]is[_ ]too[_ ]long/i,
  /request[_ ]too[_ ]large/i,
  /content[_ ]too[_ ]large/i,
  /tokens[_ ]exceed/i,
  /input[_ ]is[_ ]too[_ ]long/i,
  /context[_ ]overflow/i,
  /max[_ ]context[_ ]tokens/i,
  /number[_ ]of[_ ]tokens.*exceed/i,
  /this[_ ]model.*maximum.*context/i,
];

function _isContextOverflowError(errorMsg: string): boolean {
  return CONTEXT_OVERFLOW_PATTERNS.some((p) => p.test(errorMsg));
}

const _contextOverflowRetries: Record<string, number> = {};
const MAX_CONTEXT_OVERFLOW_RETRIES = 2;

// Context budget factor: reduced on each overflow retry to prevent infinite loops.
// Starts at 1.0 (full budget) and is reduced by CONTEXT_BUDGET_REDUCTION_PER_RETRY on each retry.
// Floors at MIN_CONTEXT_BUDGET_FACTOR to leave some minimal context for the model.
const _contextBudgetFactor: Record<string, number> = {};
const CONTEXT_BUDGET_REDUCTION_PER_RETRY = 0.2; // 20% reduction per retry
const MIN_CONTEXT_BUDGET_FACTOR = 0.3;

function _reduceContextBudget(sessionId: string): void {
  const current = _contextBudgetFactor[sessionId] ?? 1.0;
  _contextBudgetFactor[sessionId] = Math.max(MIN_CONTEXT_BUDGET_FACTOR, current - CONTEXT_BUDGET_REDUCTION_PER_RETRY);
}

function _clearContextOverflowRetries(sessionId: string) {
  delete _contextOverflowRetries[sessionId];
  delete _contextBudgetFactor[sessionId];
}

/**
 * Shared context overflow retry logic.
 * Returns true if retry was initiated, false otherwise.
 */
function _handleContextOverflowRetry(sessionId: string): boolean {
  const retryCount = _contextOverflowRetries[sessionId] ?? 0;
  if (retryCount >= MAX_CONTEXT_OVERFLOW_RETRIES) {
    delete _contextOverflowRetries[sessionId];
    // Surface actionable error instead of silent failure
    const errorMsg: ChatMessage = {
      id: "sys-" + crypto.randomUUID(),
      role: "system",
      content: `Context window overflow after ${MAX_CONTEXT_OVERFLOW_RETRIES} retries. Try starting a new session or using /compact manually.`,
      timestamp: Date.now(),
    };
    const store = useChat.getState();
    useChat.setState({ messages: [...store.messages, errorMsg], _sendInProgress: false });
    return false;
  }
  _contextOverflowRetries[sessionId] = retryCount + 1;
  // Reduce context budget on each retry to break overflow loops
  _reduceContextBudget(sessionId);
  const store = useChat.getState();
  const infoMsg: ChatMessage = { id: "sys-" + crypto.randomUUID(), role: "system", content: `Context window exceeded. Reducing budget and retrying... (attempt ${retryCount + 1}/${MAX_CONTEXT_OVERFLOW_RETRIES})`, timestamp: Date.now() };
  const infoSM = { ...store.sessionMessages, [sessionId]: [...(store.sessionMessages[sessionId] ?? []), infoMsg] };
  useChat.setState({ messages: [...store.messages, infoMsg], sessionMessages: infoSM });
  savePersistedMessages(infoSM);
  const lastUserMsg = [...store.messages].reverse().find((m) => m.role === "user");
  if (!lastUserMsg) return false;
  console.warn(`[Chat] Context overflow in session - compacting and retrying (attempt ${retryCount + 1}/${MAX_CONTEXT_OVERFLOW_RETRIES})`);

  // Check context before compaction
  const statsBefore = computeContextStats(store.messages);

  void store.compactSessionHistory(sessionId).then(() => {
    // Verify compaction was effective
    const currentStore = useChat.getState();
    const statsAfter = computeContextStats(currentStore.messages);
    const tokensReclaimed = statsBefore.totalTokens - statsAfter.totalTokens;

    if (tokensReclaimed < 1000) {
      // Compaction didn't reclaim enough — don't retry
      const failMsg: ChatMessage = {
        id: "sys-" + crypto.randomUUID(),
        role: "system",
        content: `Context overflow: compaction only reclaimed ${tokensReclaimed} tokens. Consider starting a new session.`,
        timestamp: Date.now(),
      };
      useChat.setState((s) => ({
        messages: [...s.messages, failMsg],
        isStreaming: false, streamingStartedAt: null, _sendInProgress: false, streamingContent: "", thinkingContent: "", pendingToolCalls: [], pendingActivities: [],
      }));
      return;
    }

    useChat.setState((s) => {
      const sid = s.activeSessionId;
      const result: Partial<ChatState> = { isStreaming: false, streamingStartedAt: null, _sendInProgress: false, streamingContent: "", thinkingContent: "", pendingToolCalls: [], pendingActivities: [] };
      if (sid) {
        const msgIds = new Set(s.messages.map((m) => m.id));
        result.sessionMessages = { ...s.sessionMessages, [sid]: (s.sessionMessages[sid] ?? []).filter((m) => msgIds.has(m.id)) };
      }
      return result;
    });
    const retryMsg = [...useChat.getState().messages].reverse().find((m) => m.role === "user");
    if (retryMsg) {
      const retrySid = sessionId;
      // Capture streaming content at time of check for race-free comparison
      const snapshotStreamingContent = useChat.getState().streamingContent;
      // Only auto-retry if user hasn't already manually retried (prevents double-send)
      setTimeout(() => {
        const state = useChat.getState();
        if (state.activeSessionId !== retrySid) return; // Session switched
        if (state._sendInProgress) return; // User already retried manually
        if (state.isStreaming) return; // Already streaming
        if (state.streamingContent !== snapshotStreamingContent) return; // Content changed
        void useChat.getState().sendMessage(retryMsg.content);
      }, 500);
    } else {
      const sysMsg: ChatMessage = {
        id: "sys-" + crypto.randomUUID(),
        role: "system",
        content: "Context compaction removed all messages. Please resend your request.",
        timestamp: Date.now(),
      };
      useChat.setState((s) => ({
        messages: [...s.messages, sysMsg],
        _sendInProgress: false,
      }));
    }
  }).catch((compactErr) => {
    console.warn("[Chat] Compaction failed:", compactErr);
    useChat.setState({ isStreaming: false, streamingStartedAt: null, streamingContent: "", thinkingContent: "", pendingToolCalls: [], pendingActivities: [], _sendInProgress: false });
  });
  return true;
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

    // Check if workspace root is accessible before attempting .dalam operations
    try {
      if (!(await exists(workspacePath))) return;
    } catch {
      // Path outside Tauri scope (forbidden) — silently skip this workspace
      return;
    }

    // Ensure .dalam directory exists before checking files inside it
    try {
      if (!(await exists(dotDalam))) {
        await mkdir(dotDalam, { recursive: true });
      }
    } catch {
      // .dalam dir may already exist, or path is outside Tauri scope — skip
      return;
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
          const mergedSettings = { ...currentSettings, ...projConfig.settings };
          useSettings.setState({ settings: mergedSettings });
          try { localStorage.setItem("dalam.settings.v1", JSON.stringify(mergedSettings)); } catch (e) { console.warn("[Storage] Failed to save merged settings:", e); }
        }
        if (projConfig.providers) {
          const { providers } = useModelProviders.getState();
          const nextProviders = providers.map(p => {
            const projProv = (projConfig.providers as ProjectProviderConfig[] | undefined)?.find((pp) => pp.id === p.id);
            return projProv ? { ...p, ...projProv } : p;
          });
          useModelProviders.setState({ providers: nextProviders });
          try { localStorage.setItem("dalam.providers.v1", JSON.stringify(nextProviders)); } catch (e) { console.warn("[Storage] Failed to save merged providers:", e); }
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
            void useSkillsMcp.getState().connectMcpServer(server.name).catch((err) => {
              if (import.meta.env.DEV) console.error(`Failed to auto-connect to MCP server ${server.name}:`, err);
            });
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
            void useSkillsMcp.getState().connectMcpServer(server.name).catch((err) => {
              if (import.meta.env.DEV) console.error(`Failed to auto-connect to MCP server ${server.name}:`, err);
            });
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
        // Guard: if a new chat was just initiated, don't overwrite the fresh state
        if (useChat.getState()._suppressSessionRestore) {
          // Still load chatSessions for this workspace — merge with existing sessions
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
        // Merge sessions: replace this workspace's sessions, keep others intact
        const currentSessions = useChat.getState().chatSessions.filter(
          (s) => s.workspacePath !== workspacePath
        );
        const newSessions = data.chatSessions || [];
        // Deduplicate by session ID to prevent duplicates from concurrent loads
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
          // Reconstruct a proper AgentSession from the stored ChatSessionSummary
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
        // Remove sessions for this workspace, keep others intact
        const otherSessions = useChat.getState().chatSessions.filter(
          (s) => s.workspacePath !== workspacePath
        );
        useChat.setState({
          chatSessions: otherSessions,
          session: null,
          messages: [],
        });
      } catch (e) {
        console.warn("Failed to create default workspace sessions.json:", e);
      }
    }
    // Load editor state (open tabs, active file)
    const editorStatePath = joinPath(dotDalam, "editor.json");
    if (await exists(editorStatePath)) {
      try {
        const content = await api.fs.readFile(editorStatePath);
        const editorData = JSON.parse(content);
        if (editorData.openTabs && Array.isArray(editorData.openTabs)) {
          // Validate that files still exist and reload content for dirty tabs
          const validTabs: typeof editorData.openTabs = [];
          for (const tab of editorData.openTabs) {
            if (tab.path && tab.name) {
              try {
                const { exists: fileExists } = await import("@tauri-apps/plugin-fs");
                if (await fileExists(tab.path)) {
                  // Always reload content from disk to ensure freshness
                  const content = await api.fs.readFile(tab.path);
                  validTabs.push({
                    ...tab,
                    content,
                    dirty: false,
                    language: detectLanguage(tab.path),
                  });
                }
              } catch {
                // Skip files that can't be read
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
        console.warn("Failed to load editor state:", e);
      }
    }
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err);
    if (msg.includes("forbidden") || msg.includes("scope")) {
      console.debug("[Workspace] Skipped inaccessible workspace:", workspacePath);
    } else {
      console.warn("Failed to load workspace:", workspacePath, err);
    }
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
    try {
      if (!(await exists(dotDalam))) {
        await mkdir(dotDalam, { recursive: true });
      }
    } catch {
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
    console.warn("Failed to save workspace data:", e);
  }
}

export const useAgents = create<AgentStoreState>((set, get) => ({
  agents: ALL_AGENTS,
  activeAgentName: "build" as PrimaryAgentName,
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
    const prev = get().enabledSkills;
    const next = new Set(prev);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    set({ enabledSkills: next });
    saveEnabledSkills(next);
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
  /** Timestamp (ms) when the current streaming response started. Used by WorkingTimer. */
  streamingStartedAt: number | null;
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
  /** Message queue — follow-up messages waiting to be sent */
  messageQueue: Array<{ id: string; content: string; attachments?: FileAttachment[]; timestamp: number }>;
  compactionSummaries: Record<string, string>;
  _compactingSessions: Set<string>;
  /** AbortControllers for cancellation propagation across streaming, tool exec, dream, compaction */
  _abortControllers: Map<string, AbortController>;
  _safetyTimer: ReturnType<typeof setTimeout> | null;
  _sendInProgress: boolean;
  /** Timers for auto-removing denied tools and completed sub-agents from UI */
  _autoRemoveTimers: Set<ReturnType<typeof setTimeout>>;
  doomLoopWarningCount: number;
  /** Active sub-agents spawned via the task tool */
  subAgents: SubAgentState[];
  /** Track if we need to run verification after plan execution completes */
  _pendingVerification: { workspacePath: string; planContent: string } | null;
  compactSessionHistory: (sessionId: string) => Promise<void>;
  setSelectedModel: (id: string) => Promise<void>;
  startSession: (workspacePath: string, mode: import("@dalam/shared-types").AgentSessionMode) => Promise<void>;
  sendMessage: (content: string) => Promise<void>;
  saveVersion: (sessionId: string, label: string) => void;
  restoreVersion: (sessionId: string, versionId: string) => void;
  deleteVersion: (sessionId: string, versionId: string) => void;
  cancelVersionRestore: () => void;
  confirmVersionRestore: () => void;
  abort: (sessionId: string) => Promise<void>;
  /** Cancel all ongoing operations for a session (streaming, tools, dream, compaction) */
  cancelSessionOperations: (sessionId: string) => void;
  appendStream: (event: StreamEvent) => void;
  setTodos: (todos: TodoItem[]) => void;
  updateTodo: (id: string, patch: Partial<TodoItem>) => void;
  resolveToolApproval: (toolCallId: string, decision: "approved" | "denied", result?: string) => Promise<void>;
  openFile: (path: string) => void;
  newChat: () => void;
  goBackChat: () => boolean;
  goForwardChat: () => boolean;
  _clearAutoRemoveTimers: () => void;
  reset: () => void;
  /** Set to true by newChat() to prevent async session restore from overwriting fresh state */
  _suppressSessionRestore: boolean;
  setActiveSession: (id: string | null) => void;
  renameSession: (id: string, title: string) => void;
  setSessionStatus: (id: string, status: ChatSessionSummary["status"]) => void;
  removeSession: (id: string) => void;
  approvePlan: () => void;
  rejectPlan: () => void;
  agentMode: import("@dalam/shared-types").AgentSessionMode;
  setAgentMode: (mode: import("@dalam/shared-types").AgentSessionMode) => void;
  addPendingAttachment: (file: FileAttachment) => void;
  removePendingAttachment: (id: string) => void;
  clearPendingAttachments: () => void;
  /** Message queue methods */
  addToQueue: (content: string, attachments?: FileAttachment[]) => void;
  removeFromQueue: (id: string) => void;
  reorderQueue: (fromIdx: number, toIdx: number) => void;
  editQueueItem: (id: string, content: string) => void;
  steerQueueItem: (id: string) => void;
  clearQueue: () => void;
  injectSystemMessage: (content: string) => void;
  verifyAfterPlanExecution: () => Promise<void>;
  load: () => Promise<void>;
  /** Agent runtime state machine (tracks phase transitions) */
  runtimeState: AgentRuntimeState;
};

export const useChat = create<ChatState>((set, get) => ({
  session: null,
  messages: [],
  pendingToolCalls: [],
  pendingActivities: [],
  streamingContent: "",
  thinkingContent: "",
  isStreaming: false,
  streamingStartedAt: null,
  activeAgentName: "build" as PrimaryAgentName,
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
  messageQueue: [],
  compactionSummaries: loadPersistedCompactionSummaries(),
  _compactingSessions: new Set<string>(),
  _abortControllers: new Map<string, AbortController>(),
  _safetyTimer: null,
  _sendInProgress: false,
  doomLoopWarningCount: 0,
  _suppressSessionRestore: false,
  agentMode: "build" as import("@dalam/shared-types").AgentSessionMode,
  subAgents: [],
  _pendingVerification: null,
  runtimeState: createInitialRuntimeState(),
  _autoRemoveTimers: new Set<ReturnType<typeof setTimeout>>(),
  _clearAutoRemoveTimers() {
    get()._autoRemoveTimers.forEach((timer) => clearTimeout(timer));
    get()._autoRemoveTimers.clear();
  },

  async load() {
    try {
      const { idbGet, isIndexedDBAvailable } = await import("@/lib/storage");
      if (isIndexedDBAvailable()) {
        const s = await idbGet("sessions", "all") as { data: ChatSessionSummary[] } | null;
        const m = await idbGet("messages", "all") as { data: Record<string, ChatMessage[]> } | null;
        const v = await idbGet("versions", "all") as { data: Record<string, import("@dalam/shared-types").ChatVersion[]> } | null;
        const c = await idbGet("compaction", "all") as { data: Record<string, string> } | null;
        const patch: Partial<ChatState> = {};
        if (s?.data && s.data.length > 0) patch.chatSessions = s.data;
        if (m?.data && Object.keys(m.data).length > 0) patch.sessionMessages = m.data;
        if (v?.data && Object.keys(v.data).length > 0) patch.sessionVersions = v.data;
        if (c?.data && Object.keys(c.data).length > 0) patch.compactionSummaries = c.data;
        if (Object.keys(patch).length > 0) set(patch);
      }
    } catch (e) {
      // Fallback: localStorage data is already loaded at store creation time
      console.warn("IndexedDB unavailable, using localStorage defaults:", e);
    }
  },

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
      lastVisitedAt: now,
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
        _pendingVerification: null,
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
      subAgents: [],
      _suppressSessionRestore: false,
    });
    savePersistedSessionSummaries(get().chatSessions);
    savePersistedMessages(get().sessionMessages);
    savePersistedAgents(get().sessionAgentName);
    void startRecording(sessionId, workspacePath).catch(() => {});
  },

  async abort(sessionId) {
    const api = createDalamAPI();
    // Cancel all ongoing operations for this session (dream, compaction, tools)
    get().cancelSessionOperations(sessionId);
    // Clear safety timer on abort
    const currentTimer = get()._safetyTimer;
    if (currentTimer) clearTimeout(currentTimer);
    // Clear all auto-remove timers to prevent leaked timers firing on stale state
    get()._clearAutoRemoveTimers();
    try {
      await api.agent.abort(sessionId);
    } finally {
      // Cleanup stream AFTER abort completes to avoid race with final stream events
      api.agent.cleanupStream(sessionId);
      // Guard against race with newChat — if session was already cleared,
      // don't overwrite the fresh state with stale abort data
      const currentSession = get().session;
      const isStillOurSession = currentSession && currentSession.id === sessionId;
      if (isStillOurSession) {
        set({
          isStreaming: false,
          streamingStartedAt: null,
          _sendInProgress: false,
          streamingContent: "",
          thinkingContent: "",
          pendingToolCalls: [],
          pendingActivities: [],
          _safetyTimer: null,
          subAgents: [],
          messageQueue: [],
          chatSessions: get().chatSessions.map((s) =>
            s.id === sessionId ? { ...s, status: "aborted" as const, lastActivityAt: Date.now(), lastVisitedAt: Date.now() } : s
          ),
          session: { ...currentSession, status: "aborted" },
        });
        savePersistedSessionSummaries(get().chatSessions);
      } else {
        // Session was cleared by newChat — still reset _sendInProgress so user can send
        set({ _sendInProgress: false });
      }
    }
  },

  /**
   * Cancel all ongoing operations for a session.
   * Aborts streaming, tool execution, dream cycle, and compaction.
   */
  cancelSessionOperations(sessionId: string) {
    const controllers = get()._abortControllers;
    const controller = controllers.get(sessionId);
    if (controller) {
      controller.abort();
      controllers.delete(sessionId);
      set({ _abortControllers: new Map(controllers) });
    }
  },

  async sendMessage(content) {
    // If viewing history, exit history mode first (restore to latest messages)
    const historyIdx = get().chatHistoryIdx;
    if (historyIdx >= 0) {
      const { chatHistory } = get();
      const latestMessages = chatHistory[chatHistory.length - 1] ?? [];
      set({ chatHistoryIdx: -1, messages: latestMessages });
    }

    // Atomic check-and-set to prevent race condition from rapid double-clicks
    let sendBlocked = false;
    set((s) => {
      if (s.isStreaming || s._sendInProgress) {
        sendBlocked = true;
        return s; // No state change
      }
      return { _sendInProgress: true };
    });
    if (sendBlocked) return;

    // Safety timeout: if _sendInProgress gets stuck true (e.g., unhandled exception), reset after 30s
    const sendInProgressSafety = setTimeout(() => {
      const s = get();
      if (s._sendInProgress && !s.isStreaming) {
        console.warn("[useChat] _sendInProgress safety timeout — resetting stuck state");
        set({ _sendInProgress: false });
      }
    }, 30_000);

    let { session } = get();
    if (!session) {
      const targetWs = useWorkspace.getState().activeWorkspaceId
        ? useWorkspace.getState().workspaces.find(
            (w) => w.id === useWorkspace.getState().activeWorkspaceId
          )?.path
        : undefined;
      try {
        const sessionMode = get().agentMode || "build" as import("@dalam/shared-types").AgentSessionMode;
        await get().startSession(targetWs ?? "", sessionMode);
      } catch (err) {
        if (import.meta.env.DEV) console.error("Failed to start session:", err);
        set({ _sendInProgress: false, _suppressSessionRestore: false });
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
      id: "msg-" + crypto.randomUUID(),
      role: "user",
      content,
      timestamp: Date.now(),
      ...(pendingAttachments.length > 0 ? { attachments: pendingAttachments } : {}),
    };
    set((s) => ({
      messages: [...s.messages, userMsg],
      isStreaming: true,
      streamingStartedAt: Date.now(),
      streamingContent: "",
      thinkingContent: "",
      pendingToolCalls: [],
      pendingActivities: [],
      pendingAttachments: [],
      restoredVersionId: null,
      preRestoreMessages: null,
      chatSessions: s.chatSessions.map((cs) =>
        cs.id === session!.id
          ? {
              ...cs,
              status: "running",
              lastActivityAt: Date.now(),
              messageCount: messages.length + 1,
              preview: content.length > 60 ? content.slice(0, 57) + "…" : content,
              title:
                cs.title && cs.title !== "New task"
                  ? cs.title
                  : content.length > 50
                    ? content.slice(0, 47) + "…"
                    : content,
          }
          : cs
      ),
      sessionMessages: { ...s.sessionMessages, [session!.id]: [...(s.sessionMessages[session!.id] ?? []), userMsg] },
    }));
    // Record user message in trajectory
    recordUserMessage(session.id, content);
        // Save version AFTER user message is added so the snapshot includes it
    get().saveVersion(session.id, content.length > 60 ? content.slice(0, 57) + "…" : content);

    // Safety timeout: fires 120s after the LAST stream event (reset on each event in appendStream).
    // This catches truly hung streams without killing active multi-turn agent loops.
    const safetyTimer = _createSafetyTimer(get, set, "normal");
    set({ _safetyTimer: safetyTimer });
    // Capture sessionId for stale-closure prevention in async error handlers
    const sendSessionId = session.id;

    try {
      const agentName = useAgents.getState().activeAgentName;
      await api.agent.sendPrompt(session.id, content, get().messages, agentName, pendingAttachments);
    } catch (err: unknown) {
      // Re-read timer from state (not local ref) — appendStream may have replaced it
      const timer = get()._safetyTimer;
      if (timer) clearTimeout(timer);
      set({ _safetyTimer: null });
      const msg = err instanceof Error ? err.message : "Unknown error";
      const sessionId = get().activeSessionId;
      // Context overflow auto-compaction: handle errors thrown before streaming starts
      if (sendSessionId && _isContextOverflowError(msg)) {
        if (_handleContextOverflowRetry(sendSessionId)) {
          // Clear flags so user can interact while compaction runs async
          clearTimeout(sendInProgressSafety);
          set({ isStreaming: false, _sendInProgress: false, streamingContent: "", thinkingContent: "" });
          return;
        }
      }
      // Standard error handling (non-overflow errors)
      const { isStreaming } = get();
      // If appendStream already handled the error (streaming ended), don't add duplicate error message
      if (!isStreaming) { set({ _sendInProgress: false }); return; }
      const errorMsg: ChatMessage = {
        id: "err-" + crypto.randomUUID(),
        role: "assistant",
        content: `**Error**: ${msg}\n\nCheck your provider settings and try again.`,
        timestamp: Date.now(),
      };
      if (!sessionId) { set({ _sendInProgress: false }); return; }
      const newSessionMessages = { ...get().sessionMessages, [sessionId]: [...(get().sessionMessages[sessionId] ?? []), errorMsg] };
      set((s) => {
        const timer = s._safetyTimer;
        if (timer) clearTimeout(timer);
        return {
          isStreaming: false,
          streamingStartedAt: null,
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
      savePersistedMessages(newSessionMessages);
      savePersistedSessionSummaries(get().chatSessions);
    }
    // Clear safety timer and reset _sendInProgress
    clearTimeout(sendInProgressSafety);
    set({ _sendInProgress: false });
  },

  appendStream(event) {
    const _log = (...args: unknown[]) => {
      if (typeof window !== "undefined" && (window as unknown as Record<string, unknown>).__DALAM_DEBUG) {
        console.log("[DALAM:store]", ...args);
      }
    };
    _log(`appendStream: ${event.type}`, event.type === "message-delta" ? `len=${event.content?.length ?? 0}` : event.type === "message-end" ? `msgId=${event.messageId}` : "");
    // Reset safety timer on every stream event — the agent loop is alive
    // as long as events keep flowing. This prevents the timer from killing
    // active multi-turn agent loops (tool approval waits, sequential LLM calls).
    // If there are pending tool approvals, use the extended 10-minute timeout.
    {
      const currentTimer = get()._safetyTimer;
      if (currentTimer) clearTimeout(currentTimer);
      const pending = get().pendingToolCalls;
      const hasUnresolved = pending.some(tc => tc.status === "awaiting-approval" || tc.status === "pending");
      const newTimer = _createSafetyTimer(get, set, hasUnresolved ? "tool-approval" : "normal");
      set({ _safetyTimer: newTimer });
    }

    // Dispatch event through runtime contract for phase tracking
    {
      let runtimeEvent: import("@/lib/agentRuntimeContract").AgentEvent | null = null;
      switch (event.type) {
        case "message-start": {
          runtimeEvent = { type: "STREAM_START", messageId: event.messageId };
          break;
        }
        case "tool-call": {
          runtimeEvent = { type: "TOOL_CALL", toolCallId: event.toolCall.id, toolName: event.toolCall.name };
          break;
        }
        case "diff-proposed": {
          // No separate event type — handled by the tool call flow
          break;
        }
        case "message-end": {
          const pending = get().pendingToolCalls;
          const hasMoreTools = pending.some(
            (tc) => tc.status === "awaiting-approval" || tc.status === "running" || tc.status === "pending"
          );
          runtimeEvent = { type: "STREAM_MESSAGE_END", messageId: event.messageId, hasMoreTools };
          break;
        }
        case "error": {
          const sessionId = get().activeSessionId ?? "";
          runtimeEvent = { type: "ERROR", sessionId, error: event.error };
          break;
        }
        case "tool-result": {
          const toolResult = event as import("@dalam/shared-types").StreamEvent & { type: "tool-result"; toolCallId: string; result: string };
          const isTimeout = toolResult.result?.includes("timed out");
          if (isTimeout) {
            // Timeout takes priority over result — marks the tool as errored
            runtimeEvent = { type: "TOOL_TIMEOUT", toolCallId: toolResult.toolCallId };
          } else {
            const isSuccess = !toolResult.result?.startsWith("Error:");
            runtimeEvent = { type: "TOOL_RESULT_RECEIVED", toolCallId: toolResult.toolCallId, success: isSuccess };
          }
          break;
        }
      }
      if (runtimeEvent) {
        const oldState = get().runtimeState;
        const newRuntimeState = agentReducer(oldState, runtimeEvent, { debug: false });

        // ── Phase Enforcement (must happen BEFORE set()) ──
        // If the reducer returned the same reference (invalid transition), drop the event.
        if (newRuntimeState === oldState) {
          _log(`[AgentRuntime] phase enforcement: dropping ${event.type} — invalid transition from ${oldState.phase}`);
          return; // Skip further processing for invalid events
        }

        if (newRuntimeState.phase !== oldState.phase) {
          _log(`[AgentRuntime] phase: ${oldState.phase} → ${newRuntimeState.phase}`);
        }
        set({ runtimeState: newRuntimeState });
      }
    }
    switch (event.type) {
      case "message-start": {
        const pending = get().pendingToolCalls;
        const hasUnresolved = pending.some(tc => tc.status === "awaiting-approval" || tc.status === "pending");
        set(() => ({
          ...(hasUnresolved ? {} : { streamingContent: "", thinkingContent: "", pendingActivities: [], _pendingChanges: [] }),
          // Don't clear taskPlan or todos here — they persist across turns within a session
          // They're only cleared when starting a completely new chat
          ...(hasUnresolved ? {} : { pendingToolCalls: [] }),
          isStreaming: true,
          streamingStartedAt: Date.now(),
        }));
        // NOTE: Safety timer is already reset by the preamble above this switch.
        // Only create a new one if no timer exists (e.g., first event after manual clear).
        if (!get()._safetyTimer) {
          const newTimer = _createSafetyTimer(get, set, "turn");
          set({ _safetyTimer: newTimer });
        }
        break;
      }
      case "message-delta":
        // Flush each delta directly to streamingContent — no batching timer.
        // The component's StreamingMessageWrapper has its own 16ms throttle +
        // boundary detection that prevents excessive React re-renders, and
        // handles XML tag stripping during its throttled performUpdate.
        // This eliminates the old 50ms store-level latency.
        set((s) => {
          const newContent = s.streamingContent + event.content;
          // Trim very long streams to prevent memory issues (keep last 200K chars)
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
          // Deterministic binding: prefer diffId-to-toolCall lookup first.
          // FUTURE: The stream protocol should include toolCallId in diff-proposed events.
          // Until then, heuristic fallbacks (Strategies 2-4) are used as a safety net
          // with dev warnings to surface when they fire.
          const proposalToolCallId = (proposal as { toolCallId?: string }).toolCallId;

          // Strategy 1: Direct toolCallId match (most deterministic)
          let idx = -1;
          if (proposalToolCallId) {
            idx = s.pendingToolCalls.findIndex(
              tc => tc.id === proposalToolCallId && !tc.diffId
            );
          }

          // Strategy 2: Match by filePath + edit tool name (precise)
          if (idx === -1) {
            idx = s.pendingToolCalls.findIndex(
              tc => (tc.status === "awaiting-approval" || tc.status === "pending" || tc.status === "completed") &&
                    tc.args.path === proposal.filePath &&
                    (tc.name === "write_file" || tc.name === "edit_file") &&
                    !tc.diffId
            );
            if (idx !== -1 && typeof import.meta !== "undefined" && import.meta.env?.DEV) {
              console.warn(`[DiffBinding] Using heuristic (filePath+toolName) for diff ${proposal.diffId} — stream protocol should provide toolCallId`);
            }
          }

          // Strategy 3: Match by content hash for write_file tools
          if (idx === -1) {
            idx = s.pendingToolCalls.findIndex(
              tc => (tc.status === "awaiting-approval" || tc.status === "pending" || tc.status === "completed") &&
                    tc.name === "write_file" &&
                    typeof tc.args.content === "string" &&
                    tc.args.content === proposal.newContent &&
                    !tc.diffId
            );
            if (idx !== -1 && typeof import.meta !== "undefined" && import.meta.env?.DEV) {
              console.warn(`[DiffBinding] Using heuristic (contentHash) for diff ${proposal.diffId} — stream protocol should provide toolCallId`);
            }
          }

          // Strategy 4 (final fallback): pick the most recent pending edit tool
          if (idx === -1) {
            for (let i = s.pendingToolCalls.length - 1; i >= 0; i--) {
              const tc = s.pendingToolCalls[i];
              if ((tc.status === "awaiting-approval" || tc.status === "pending" || tc.status === "completed") &&
                  !tc.diffId &&
                  (tc.name === "write_file" || tc.name === "edit_file" || tc.name === "write" || tc.name === "edit") &&
                  tc.args.path === proposal.filePath) {
                idx = i;
                break;
              }
            }
            if (idx !== -1 && typeof import.meta !== "undefined" && import.meta.env?.DEV) {
              console.warn(`[DiffBinding] Using heuristic (mostRecentEdit) for diff ${proposal.diffId} — stream protocol should provide toolCallId`);
            }
          }

          // If not found in pendingToolCalls, search messages (message-end may have already cleared pendingToolCalls)
          let targetMsgIdx = -1;
          let targetTcIdx = -1;
          if (idx === -1) {
            for (let m = s.messages.length - 1; m >= 0; m--) {
              const msg = s.messages[m];
              if (!msg.toolCalls) continue;
              const tcIdx = msg.toolCalls.findIndex(
                tc => !tc.diffId &&
                      (tc.name === "write_file" || tc.name === "edit_file" || tc.name === "write" || tc.name === "edit") &&
                      tc.args.path === proposal.filePath
              );
              if (tcIdx !== -1) {
                targetMsgIdx = m;
                targetTcIdx = tcIdx;
                break;
              }
            }
          }

          if (idx === -1 && targetMsgIdx === -1) return s;

          // If found in a message, update the message's toolCalls
          if (targetMsgIdx !== -1) {
            const updatedMsgs = [...s.messages];
            const msg = updatedMsgs[targetMsgIdx];
            const patchedToolCalls = msg.toolCalls!.map((tc, i) =>
              i === targetTcIdx ? { ...tc, diffId: proposal.diffId, diff: proposal } : tc
            );
            updatedMsgs[targetMsgIdx] = { ...msg, toolCalls: patchedToolCalls };
            const sid = s.activeSessionId;
            const updatedSM = sid
              ? { ...s.sessionMessages, [sid]: (s.sessionMessages[sid] ?? []).map((m) =>
                  m.id === msg.id ? { ...m, toolCalls: patchedToolCalls } : m
                ) }
              : s.sessionMessages;
            return { messages: updatedMsgs, sessionMessages: updatedSM };
          }

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
        // Check if any pending tool calls have diffIds attached — these must not be orphaned.
        const existingTimer = get()._safetyTimer;
        if (existingTimer) {
          clearTimeout(existingTimer);
          const hasActiveToolCalls = pendingToolCalls.some(
            (tc) => tc.status === "awaiting-approval" || tc.status === "pending"
          );
          if (hasActiveToolCalls) {
            const extendedTimer = _createSafetyTimer(get, set, "tool-approval");
            set({ _safetyTimer: extendedTimer });
          } else {
            set({ _safetyTimer: null });
          }
        }

        // Invariant: message-end must not orphan tool calls with attached diffs
        // If any pending tool calls have diffIds, they must all be resolved before
        // clearing pendingToolCalls. If unresolved, we keep them so the UI can
        // continue showing the diffs — break out early to prevent downstream clear.
        const unresolvedDiffs = pendingToolCalls.filter(
          (tc) => tc.diffId && tc.status !== "completed" && tc.status !== "failed"
        );
        if (unresolvedDiffs.length > 0) {
          if (typeof import.meta !== "undefined" && import.meta.env?.DEV) {
            console.warn(
              `[AgentRuntime] INVARIANT: message-end with ${unresolvedDiffs.length} unresolved diff attachments. toolCallIds: ${unresolvedDiffs.map(t => t.id).join(", ")}. Keeping pendingToolCalls intact.`
            );
          }
          // Enforce invariant: do NOT clear pendingToolCalls when unresolved diffs exist.
          // Partial message-end: save current turn content but preserve tool state.
          // Use streamingContent directly (not finalContent which is declared later via let).
          const intermediateMsg: ChatMessage = {
            id: event.messageId,
            role: "assistant",
            content: streamingContent || "(executing tools...)",
            timestamp: Date.now(),
            ...(thinkingContent ? { thinking: thinkingContent } : {}),
            ...(_pendingChanges.length > 0 ? { fileChanges: [..._pendingChanges] } : {}),
            ...(pendingToolCalls.length > 0 ? { toolCalls: pendingToolCalls } : {}),
            ...(pendingActivities.length > 0 ? { activities: [...pendingActivities] } : {}),
          };
          const sessionId = get().activeSessionId;
          const newSessionMessages = sessionId
            ? { ...get().sessionMessages, [sessionId]: [...(get().sessionMessages[sessionId] ?? []), intermediateMsg] }
            : get().sessionMessages;
          set({
            messages: [...get().messages, intermediateMsg],
            sessionMessages: newSessionMessages,
            // Keep pendingToolCalls intact — don't clear!
            streamingContent: "",
            thinkingContent: "",
            _pendingChanges: [],
          });
          if (sessionId) savePersistedMessages(newSessionMessages);
          break;
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
          const now = Date.now();
          const completedSessions = liveSession
            ? get().chatSessions.map((cs) =>
                cs.id === liveSession.id
                  ? { ...cs, status: "completed" as const, lastActivityAt: now, lastVisitedAt: now }
                  : cs
              )
            : get().chatSessions;
          set({
            isStreaming: false,
            _sendInProgress: false,
            pendingToolCalls: [],
            pendingActivities: [],
            streamingContent: "",
            thinkingContent: "",
            _pendingChanges: [],
            chatSessions: completedSessions,
          });
          savePersistedSessionSummaries(completedSessions);
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
            // NOTE: Don't clear _sendInProgress here — the agentic loop is still
            // running (tools were just executed, results will be sent back to API).
            // Clearing it here would allow the user to send another message while
            // the agent is still processing, creating a race condition.
          });
          if (sessionId) savePersistedMessages(newSessionMessages);
          break;
        }

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
          messages: [...get().messages, assistantMsg],
          sessionMessages: newSessionMessages,
          streamingContent: "",
          thinkingContent: "",
          isStreaming: false,
          streamingStartedAt: null,
          _sendInProgress: false,
          _pendingChanges: [],
          pendingToolCalls: [],
          pendingActivities: [],
          chatSessions: liveSession
            ? get().chatSessions.map((s) =>
                s.id === liveSession.id
                  ? { ...s, status: "completed", lastActivityAt: Date.now(), lastVisitedAt: Date.now() }
                  : s
              )
            : get().chatSessions,
        });
        // Process message queue: auto-send next queued message
        // Guard: only send if not already streaming or in-progress
        const { messageQueue } = get();
        if (messageQueue.length > 0) {
          const next = messageQueue[0];
          set({ messageQueue: messageQueue.slice(1) });
          setTimeout(() => {
            // Double-check: only send if still not streaming
            const state = get();
            if (!state.isStreaming && !state._sendInProgress) {
              void get().sendMessage(next.content);
            } else {
              // Re-enqueue at front so it's tried again after streaming finishes
              useChat.setState(s => ({ messageQueue: [next, ...s.messageQueue] }));
            }
          }, 300);
        }
        // Record assistant message in trajectory
        if (sessionId) {
          recordAssistantMessage(sessionId, finalContent, undefined, allToolCalls.length > 0 ? allToolCalls.map(tc => ({ name: tc.name, arguments: tc.args, result: tc.result })) : undefined);
        }
        savePersistedMessages(newSessionMessages);
        savePersistedSessionSummaries(get().chatSessions);
        // Auto-verification: if build agent produced changes (pending changes or fileChanges in messages),
        // set _pendingVerification so verifyAfterPlanExecution will run the verification pipeline.
        if (sessionId && !get()._pendingVerification) {
          const pendingChanges = get()._pendingChanges;
          const hasFileChanges = get().messages.some(m => m.fileChanges && m.fileChanges.length > 0);
          if ((pendingChanges && pendingChanges.length > 0) || hasFileChanges) {
            const liveSess = get().session;
            if (liveSess?.workspacePath) {
              set({ _pendingVerification: { workspacePath: liveSess.workspacePath, planContent: "" } });
            }
          }
        }
        if (sessionId) {
          void get().compactSessionHistory(sessionId);
          // Post-turn verification: if a plan was just executed, run verification
          void get().verifyAfterPlanExecution();

          // Post-turn memory consolidation: async memory sync after each conversation turn
          // Inspired by Hermes memory lifecycle — extracts key facts from the conversation
          // and persists them to the memory store for future reference.
          void (async () => {
            try {
              const { extractMemoriesWithLLM } = await import("@/lib/memoryStore");
              const ws = useWorkspace.getState().workspaces.find(w => w.id === useWorkspace.getState().activeWorkspaceId);
              if (ws && finalContent) {
                const api = createDalamAPI();
                const model = useSettings.getState().settings.selectedModel;
                if (model) {
                  // Re-read messages from state (not stale closure) for memory extraction
                  const latestMessages = useChat.getState().messages;
                  // Extract key facts from the conversation and save as memory
                  await extractMemoriesWithLLM(
                    latestMessages.filter(m => m.role === "user").pop()?.content ?? "",
                    finalContent,
                    (prompt) => api.agent.summarizeMessages(model, [{ role: "user", content: prompt }]),
                    { sessionId, workspacePath: ws.path, maxEntries: 3 }
                  );
                }
              }
            } catch (err) {
              // Memory extraction is best-effort — don't break the main flow
              console.debug("[Chat] Post-turn memory extraction skipped:", err);
            }
          })();
        }
        break;
      }
      case "tool-call": {
        const tool = event.toolCall;
        const existing = get().pendingToolCalls.some((tc) => tc.id === tool.id);
        if (existing) break;
        // Canonicalize bash commands for permission matching
        const isBashTool = tool.name === "shell" || tool.name === "bash" || tool.name === "execute" || tool.name === "run_command";
        const commandStr = tool.args && typeof tool.args.command === "string" ? tool.args.command : "";
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
        // Auto-denied tools: mark as failed and resolve immediately so the
        // API layer's waitForToolApproval doesn't hang forever.
        if (denied) {
          // Log audit trail
          logPermission({
            timestamp: Date.now(),
            sessionId: get().activeSessionId ?? "",
            toolName: tool.name,
            command: commandStr,
            decision: "deny",
            source: "rule",
          });
          const deniedTool = { ...tool, status: "failed" as const, result: "Denied by permission policy" };
          set((s) => ({ pendingToolCalls: [...s.pendingToolCalls, deniedTool] }));
          get().resolveToolApproval(tool.id, "denied", "Denied by permission policy");
          // Auto-remove denied tools from UI after a short delay
          const _autoRemoveTimer = setTimeout(() => {
            set((s) => ({ pendingToolCalls: s.pendingToolCalls.filter((tc) => tc.id !== tool.id) }));
            get()._autoRemoveTimers.delete(_autoRemoveTimer);
          }, 2000);
          get()._autoRemoveTimers.add(_autoRemoveTimer);
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
            // Log audit trail
            logPermission({
              timestamp: Date.now(),
              sessionId: get().activeSessionId ?? "",
              toolName: tool.name,
              command: commandStr,
              decision: decision === "always" ? "always" : decision === "allow" ? "allow" : "deny",
              source: "user",
            });
            // Persist "always allow" so future tools of the same kind are auto-approved
            if (decision === "always") {
              usePermission.getState().allowAlways({
              id: "perm-" + crypto.randomUUID(),
              createdAt: Date.now(),
              kind: permissionKey,
              title: tool.name,
              description,
              ...(commandStr ? { command: commandStr } : {}),
              ...(activeSession?.workspacePath ? { workspacePath: activeSession.workspacePath } : {}),
              });
            }
          }).catch((err) => {
            if (import.meta.env.DEV) console.error("Permission dialog error:", err);
            // If the dialog was dismissed/closed, deny the tool to unblock waitForToolApproval
            get().resolveToolApproval(tool.id, "denied");
          });
        } else {
          // Log audit trail for auto-allow
          logPermission({
            timestamp: Date.now(),
            sessionId: get().activeSessionId ?? "",
            toolName: tool.name,
            command: commandStr,
            decision: "allow",
            source: "auto",
          });
          get().resolveToolApproval(tool.id, "approved");
        }
        break;
      }
      case "tool-result":
        set((s) => {
          const updated = s.pendingToolCalls.map((tc) =>
            tc.id === event.toolCallId
              ? {
                  ...tc,
                  status: typeof event.result === "string" && event.result.startsWith("Error:") ? "failed" as const : "completed" as const,
                  result: event.result,
                }
              : tc
          );
          // If the tool call was already cleared by message-end (race condition),
          // the result is orphaned. Search ALL messages (not just last) for the
          // assistant message with matching toolCalls, so it's not lost.
          const found = s.pendingToolCalls.some((tc) => tc.id === event.toolCallId);
          if (!found && s.pendingToolCalls.length === 0 && s.messages.length > 0) {
            // Search backwards through all messages to find the matching tool call
            for (let msgIdx = s.messages.length - 1; msgIdx >= 0; msgIdx--) {
              const msg = s.messages[msgIdx];
              if (msg.role !== "assistant" || !msg.toolCalls?.length) continue;
              const hasMatchingTc = msg.toolCalls.some((tc) => tc.id === event.toolCallId);
              if (!hasMatchingTc) continue;
              // Guard: skip if this result was already applied (prevents double-patching in multi-turn loops)
              const alreadyApplied = msg.toolCalls.some((tc) => tc.id === event.toolCallId && tc.result !== undefined);
              if (alreadyApplied) break;
              const patchedToolCalls = msg.toolCalls.map((tc) =>
                tc.id === event.toolCallId
                  ? { ...tc, status: (typeof event.result === "string" && event.result.startsWith("Error:") ? "failed" : "completed") as "completed" | "failed", result: event.result }
                  : tc
              );
              const patchedMsg = { ...msg, toolCalls: patchedToolCalls };
              const patchedMessages = [...s.messages.slice(0, msgIdx), patchedMsg, ...s.messages.slice(msgIdx + 1)];
              // Also patch sessionMessages by ID, not by index (arrays may diverge)
              const sid = s.activeSessionId;
              const patchedSessionMessages = sid ? {
                ...s.sessionMessages,
                [sid]: (s.sessionMessages[sid] ?? []).map(m =>
                  m.id === patchedMsg.id ? patchedMsg : m
                ),
              } : s.sessionMessages;
              return {
                pendingToolCalls: updated,
                messages: patchedMessages,
                sessionMessages: patchedSessionMessages,
              };
            }
          }
          return { pendingToolCalls: updated };
        });
        // Doom loop detection + tool failure tracking (on tool RESULT, not call)
        {
          const tc = get().pendingToolCalls.find((t) => t.id === event.toolCallId);
          if (tc) {
            const sessionId = get().activeSessionId;
            if (sessionId) {
              const isError = typeof event.result === "string" && event.result.startsWith("Error:");
              if (isError) {
                // Record failure for doom loop tracking
                _recordToolFailure(sessionId, tc.name, tc.args);
                // Check doom loop threshold
                const doomResult = _checkDoomLoop(sessionId, tc.name, tc.args);
                if (doomResult) {
                  console.warn("[Chat]", doomResult.message);
                  set((s) => ({ doomLoopWarningCount: s.doomLoopWarningCount + 1 }));
                  if (doomResult.severity === "halt") {
                    void get().abort(sessionId);
                  }
                }
              } else {
                // Reset doom loop failure counter for this specific signature on success
                _clearToolFailure(sessionId, tc.name, tc.args);
              }
            }
          }
        }
        break;
      case "sub-agent-start": {
        const newAgent: SubAgentState = {
          id: event.subAgentId,
          prompt: event.prompt,
          description: event.description,
          subagentType: event.subagentType,
          status: "running",
          startedAt: Date.now(),
          toolCalls: [],
          content: "",
        };
        set((s) => ({
          subAgents: [...s.subAgents, newAgent],
        }));
        break;
      }
      case "sub-agent-end": {
        set((s) => ({
          subAgents: s.subAgents.map((sa) =>
            sa.id === event.subAgentId
              ? { ...sa, status: event.status, completedAt: Date.now(), error: event.error }
              : sa
          ),
        }));
        // Auto-remove completed sub-agents from UI after 30 seconds
        const _subRemoveTimer = setTimeout(() => {
          set((s) => ({
            subAgents: s.subAgents.filter((sa) => sa.id !== event.subAgentId),
          }));
          get()._autoRemoveTimers.delete(_subRemoveTimer);
        }, 30000);
        get()._autoRemoveTimers.add(_subRemoveTimer);
        break;
      }
      case "sub-agent-update": {
        set((s) => ({
          subAgents: s.subAgents.map((sa) =>
            sa.id === event.subAgentId
              ? {
                  ...sa,
                  ...(event.toolCalls ? { toolCalls: event.toolCalls } : {}),
                  ...(event.content !== undefined ? { content: event.content } : {}),
                }
              : sa
          ),
        }));
        break;
      }
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
          thinkingContent: (s.thinkingContent + (s.thinkingContent ? "\n" : "") + event.content).slice(-100000),
        }));
        break;
      }
      case "activity-explore": {
        set((s) => ({
          pendingActivities: [
            ...s.pendingActivities,
            {
              id: "pa-" + crypto.randomUUID(),
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
              id: "pa-" + crypto.randomUUID(),
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
              id: "pa-" + crypto.randomUUID(),
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
            // Match task IDs like "task-1", "1.2", "T1", etc. followed by colon and title
            const match = line.match(/^([\w.-]+):\s*(.+)$/);
            return match ? { id: match[1], title: match[2].trim(), status: "pending" as const } : null;
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
          // Hermes-style TurnFinalizer: when iteration budget exhausts without
          // a final response, make one toolless API call to get a summary
          // instead of failing silently.
          void (async () => {
            try {
              const sid = get().activeSessionId;
              const model = useSettings.getState().settings.selectedModel;
              if (!sid || !model) return;
              // Dedup guard: skip if a TurnFinalizer summary already exists in messages
              const hasFinalizerSummary = get().messages.some(
                (m) => m.role === "system" && m.content.startsWith("**Budget exhausted**")
              );
              if (hasFinalizerSummary) return;
              const recentMsgs = get().messages
                .slice(-20)
                .filter((m) => m.role === "user" || m.role === "assistant");
              if (recentMsgs.length === 0) return;
              const summaryPrompt = `The agent's iteration budget has been exhausted. Based on the conversation so far, provide a brief summary of what was accomplished and what remains. Do not use any tools — just summarize.`;
              const api = createDalamAPI();
              const summaryText = await api.agent.summarizeMessages(model, [
                ...recentMsgs.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
                { role: "user", content: summaryPrompt },
              ]);
              if (summaryText) {
                const summaryMsg: ChatMessage = {
                  id: "sys-" + crypto.randomUUID(),
                  role: "system",
                  content: `**Budget exhausted** — Here's a summary of progress:\n\n${summaryText}`,
                  timestamp: Date.now(),
                };
                const s = get();
                const sm = s.sessionMessages, msgs = s.messages;
                const sid2 = s.activeSessionId;
                const newSM = sid2 ? { ...sm, [sid2]: [...(sm[sid2] ?? []), summaryMsg] } : sm;
                set({ messages: [...msgs, summaryMsg], sessionMessages: newSM });
                if (sid2) savePersistedMessages(newSM);
              }
            } catch (err) {
              console.debug("[Chat] TurnFinalizer summary failed:", err);
            }
          })();
        }
        // Only append non-meta bash activities to the visible activity feed
        const META_COMMANDS = new Set(["task plan", "completed", "task budget exhausted"]);
        if (!META_COMMANDS.has(event.command)) {
          set((s) => ({
            pendingActivities: [
              ...s.pendingActivities,
              { id: "pa-" + crypto.randomUUID(), type: "bash" as const, command: event.command, result: event.result },
            ].slice(-500) as typeof s.pendingActivities,
          }));
        }
        break;
      }
      case "activity-plan": {
        set((s) => ({
          pendingActivities: [
            ...s.pendingActivities,
            { id: "pa-" + crypto.randomUUID(), type: "plan" as const, plan: event.plan },
          ].slice(-500) as typeof s.pendingActivities,
        }));
        break;
      }
      case "thinking":
        set((s) => ({ thinkingContent: (s.thinkingContent + event.content).slice(-100000) }));
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
              id: "perm-" + crypto.randomUUID(),
              createdAt: Date.now(),
              kind: permKind,
              title: "Permission required",
              description: event.description ?? `Dalam wants to run: ${event.kind}`,
              ...(event.command ? { command: event.command } : {}),
            });
          }
        }).catch((err) => {
          if (import.meta.env.DEV) console.error("Permission dialog error:", err);
          // If the dialog was dismissed/closed, deny the tool to unblock the agent loop
          if (event.toolCallId) {
            get().resolveToolApproval(event.toolCallId, "denied");
          }
        });
        break;
      }
      case "ask-question": {
        const questionSessionId = get().activeSessionId;
        // Set session status to questioning when AI asks a question
        if (questionSessionId) {
          get().setSessionStatus(questionSessionId, "questioning");
        }
        // Show the question dialog — the promise is intentionally not awaited here
        // because the stream handler must return immediately. The useQuestion store
        // resolves the promise when the user answers or dismisses, and the session
        // status is restored to "running" in useQuestion.resolve().
        useQuestion.getState().ask({
          header: event.header ?? "Question",
          question: event.question,
          options: event.options ?? [],
        }).catch((err) => {
          if (import.meta.env.DEV) console.error("ask-question error:", err);
          // Restore status on error so the UI doesn't get stuck
          if (questionSessionId) {
            try { useChat.getState().setSessionStatus(questionSessionId, "running"); } catch { /* ignore */ }
          }
        });
        break;
      }
      case "error": {
        const sessionId = get().activeSessionId;
        if (sessionId && _isContextOverflowError(event.error)) {
          if (_handleContextOverflowRetry(sessionId)) {
            break; // retry initiated
          }
        }

        let lastUserMsgId: string | undefined;
        for (let i = get().messages.length - 1; i >= 0; i--) {
          if (get().messages[i].role === "user") { lastUserMsgId = get().messages[i].id; break; }
        }
        const errorMsg: ChatMessage = {
          id: "err-" + crypto.randomUUID(),
          role: "assistant",
          content: (() => {
            // Parse provider error JSON into human-readable text
            const raw = event.error;
            let friendly = raw;
            try {
              const json = JSON.parse(raw.replace(/^.*?(HTTP \d+:\s*)/, ""));
              if (json?.error?.message) friendly = String(json.error.message);
              else if (json?.detail) friendly = String(json.detail);
              else if (json?.message) friendly = String(json.message);
              else if (typeof json?.error === "string") friendly = json.error;
            } catch { /* not JSON — use raw */ }
            return `**Error**: ${friendly}\n\nCheck your provider settings and try again.`;
          })(),
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
            _sendInProgress: false,
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
    get()._clearAutoRemoveTimers();
    _pendingResolutions.clear();
    _toolCallResolvers.clear();
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
      planApproval: null,
      _pendingVerification: null,
      messageQueue: [],
      runtimeState: createInitialRuntimeState(),
      activeSessionId: null,
      restoredVersionId: null,
      preRestoreMessages: null,
      _safetyTimer: null,
      _sendInProgress: false,
      subAgents: [],
    });
  },

  setActiveSession(id) {
    const timer = get()._safetyTimer;
    if (timer) clearTimeout(timer);
    get()._clearAutoRemoveTimers();
    // NOTE: Don't clear _pendingResolutions or _toolCallResolvers here.
    // They survive across session switches so pending tool approvals can still
    // resolve after the user switches back to the original session.
    // _pendingResolutions.clear();
    // _toolCallResolvers.clear();
    const { session, abort, sessionMessages, sessionAgentName, isStreaming } = get();
    // Clean up stream listener for the old session before switching
    if (session) {
      const api = createDalamAPI();
      api.agent.cleanupStream(session.id);
    }
    // Save terminal state before switching sessions
    const activeSessionId = get().activeSessionId;
    if (activeSessionId) {
      useTerminal.getState().saveForSession(activeSessionId);
    }
    // Only abort if the current session is actually streaming
    if (session && isStreaming) void abort(session.id).catch(() => {});
    if (!id) {
      if (useUI.getState().bottomPanelTab === "terminal") {
        useUI.getState().setBottomPanelOpen(false);
      }
      set({
        activeSessionId: null,
        session: null,
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
        planApproval: null,
        _sendInProgress: false,
        messageQueue: [],
        _suppressSessionRestore: false,
        _safetyTimer: null,
        todos: [],
        _pendingChanges: [],
        subAgents: [],
        chatHistory: [],
        chatHistoryIdx: -1,
        doomLoopWarningCount: 0,
      });
      return;
    }
    const messages = sessionMessages[id] ?? [];
      const agent = sessionAgentName[id] ?? "build";
    useAgents.getState().setActiveAgent(agent);
    // Reconstruct the AgentSession object from stored data
    const chatSession = get().chatSessions.find((cs) => cs.id === id);
    if (!chatSession || !chatSession.workspacePath) {
      if (useUI.getState().bottomPanelTab === "terminal") {
        useUI.getState().setBottomPanelOpen(false);
      }
    } else {
      useTerminal.getState().ensureTabForCwd(chatSession.workspacePath);
    }
    // Restore terminal state for the new session
    if (id) {
      useTerminal.getState().restoreForSession(id);
      // Clear diff view — it's per-session
      useDiffView.getState().close();
      // Clear browser tabs — they're per-session
      useUI.getState().clearBrowserTabs();
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
      messageQueue: [],
      todos: [],
      _pendingChanges: [],
      subAgents: [],
      _suppressSessionRestore: false,
      chatHistory: [],
      chatHistoryIdx: -1,
      // Mark session as visited — clears status dots in sidebar
      ...(id ? { chatSessions: get().chatSessions.map((cs) => cs.id === id ? { ...cs, lastVisitedAt: Date.now() } : cs) } : {}),
    });
    if (id) savePersistedSessionSummaries(get().chatSessions);
  },

  renameSession(id, title) {
    set((s) => ({
      chatSessions: s.chatSessions.map((cs) =>
        cs.id === id ? { ...cs, title } : cs
      ),
    }));
    savePersistedSessionSummaries(get().chatSessions);
  },

  setSessionStatus(id, status) {
    set((s) => ({
      chatSessions: s.chatSessions.map((cs) =>
        cs.id === id ? { ...cs, status, lastActivityAt: Date.now() } : cs
      ),
    }));
    savePersistedSessionSummaries(get().chatSessions);
  },

  async removeSession(id) {
    const timer = get()._safetyTimer;
    if (timer) clearTimeout(timer);
    // Clear all auto-remove timers to prevent leaked timers firing on stale state
    get()._clearAutoRemoveTimers();
    _pendingResolutions.clear();
    _toolCallResolvers.clear();
    // Wait for abort to complete before cleanup to avoid race conditions
    try { await get().abort(id); } catch { /* abort may throw, that's ok */ }
    void stopRecording(id).catch(() => {});
    // cleanupStream is handled inside abort()'s finally block
    // Clean all per-session caches to prevent memory leaks
    _clearDoomLoopState(id);
    _clearContextOverflowRetries(id);
    delete _lastCompactionCounts[id];
    delete _lastCompactionAttempt[id];
    delete _compactionTier[id];
    delete _antiThrashTimestamps[id];
    _terminalStateCache.delete(id);
    // Abort any in-progress compaction
    const nextCompacting = new Set(get()._compactingSessions);
    nextCompacting.delete(id);
    // Compute new state outside set() to avoid side effects in updater
    const s = get();
    const { [id]: _removed1, ...restVersions } = s.sessionVersions;
    const { [id]: _removed2, ...restMessages } = s.sessionMessages;
    const { [id]: _removed3, ...restAgents } = s.sessionAgentName;
    const { [id]: _removed4, ...restCompaction } = s.compactionSummaries;
    const newSessions = s.chatSessions.filter((cs) => cs.id !== id);
    const isActive = s.activeSessionId === id;
    // When removing the active session, auto-switch to the most recent remaining
    // session so the user doesn't end up on a blank screen.
    const nextActiveSessionId = isActive
      ? (newSessions.length > 0 ? [...newSessions].sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0))[0].id : null)
      : s.activeSessionId;
    // Persist to disk (outside set updater to avoid side effects during render)
    savePersistedVersions(restVersions);
    _doSavePersistedMessages(restMessages);
    void saveWorkspaceData();
    savePersistedAgents(restAgents);
    savePersistedSessionSummaries(newSessions);
    savePersistedCompactionSummaries(restCompaction);
    // Update state
    set({
      chatSessions: newSessions,
      activeSessionId: nextActiveSessionId,
      sessionVersions: restVersions,
      sessionMessages: restMessages,
      sessionAgentName: restAgents,
      compactionSummaries: restCompaction,
      _compactingSessions: nextCompacting,
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
    });
  },

  archiveSession(id: string) {
    const s = get();
    const session = s.chatSessions.find(cs => cs.id === id);
    if (!session) return;

    // Mark session as archived
    const updatedSessions = s.chatSessions.map(cs =>
      cs.id === id ? { ...cs, archived: true, archivedAt: Date.now() } : cs
    );

    // Move messages to archive storage
    const messages = s.sessionMessages[id];
    const ws = useWorkspace.getState().workspaces.find(w => w.id === useWorkspace.getState().activeWorkspaceId);
    if (messages && ws) {
      const archiveDir = joinPath(ws.path, ".dalam/archive");
      void import("@tauri-apps/plugin-fs").then(async ({ exists, mkdir, writeFile }) => {
        try {
          if (!(await exists(archiveDir))) await mkdir(archiveDir, { recursive: true });
          await writeFile(joinPath(archiveDir, `${id}.json`), new TextEncoder().encode(JSON.stringify(messages)));
        } catch (err) {
          console.warn("[Session] Failed to archive messages:", err);
        }
      });
    }

    // Remove from active storage
    const { [id]: _removed, ...restMessages } = s.sessionMessages;
    const { [id]: _removedV, ...restVersions } = s.sessionVersions;

    set({
      chatSessions: updatedSessions,
      sessionMessages: restMessages,
      sessionVersions: restVersions,
    });
    savePersistedSessionSummaries(updatedSessions);
    _doSavePersistedMessages(restMessages);
    savePersistedVersions(restVersions);
  },

  restoreSession(id: string) {
    const s = get();
    const session = s.chatSessions.find(cs => cs.id === id);
    if (!session?.archived) return;

    const ws = useWorkspace.getState().workspaces.find(w => w.id === useWorkspace.getState().activeWorkspaceId);
    if (!ws) return;

    // Load archived messages
    void import("@tauri-apps/plugin-fs").then(async ({ exists, readFile, remove }) => {
      const archivePath = joinPath(ws.path, ".dalam/archive", `${id}.json`);
      try {
        if (await exists(archivePath)) {
          const content = await readFile(archivePath);
          const messages = JSON.parse(new TextDecoder().decode(content));

          // Unarchive session
          const updatedSessions = get().chatSessions.map(cs =>
            cs.id === id ? { ...cs, archived: false, archivedAt: undefined } : cs
          );

          set({
            chatSessions: updatedSessions,
            sessionMessages: { ...get().sessionMessages, [id]: messages },
          });
          savePersistedSessionSummaries(updatedSessions);
          _doSavePersistedMessages({ ...get().sessionMessages, [id]: messages });
          await remove(archivePath);
        }
      } catch (err) {
        console.warn("[Session] Failed to restore archived session:", err);
      }
    });
  },

  approvePlan() {
    const { agentMode, planApproval, session } = get();
    const planContent = planApproval?.planContent ?? null;
    set({ planApproval: null });
    // Set _pendingVerification so verification runs after plan execution
    if (planContent && session?.workspacePath) {
      set({ _pendingVerification: { workspacePath: session.workspacePath, planContent } });
    }
    if (agentMode === "plan" && planContent) {
      const buildMode = "build" as import("@dalam/shared-types").AgentSessionMode;
      set({ agentMode: buildMode });
      useAgents.getState().setActiveAgent(buildMode);
      // Auto-send a message in build mode to execute the approved plan
      setTimeout(() => {
        const state = get();
        if (!state.isStreaming && !state._sendInProgress) {
          const executeMsg = `The user approved the plan. Execute it now.\n\nPlan:\n${planContent}`;
          void state.sendMessage(executeMsg);
        }
      }, 500);
    }
  },
  setAgentMode(mode) {
    set({ agentMode: mode });
    // Sync with agents store so the active agent matches the requested mode
    // This ensures sendMessage uses the correct agent name for permission evaluation
    useAgents.getState().setActiveAgent(mode);
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

  addToQueue(content, attachments) {
    const id = "q-" + crypto.randomUUID();
    set((s) => ({
      messageQueue: [...s.messageQueue, { id, content, attachments, timestamp: Date.now() }],
    }));
  },

  removeFromQueue(id) {
    set((s) => ({
      messageQueue: s.messageQueue.filter((q) => q.id !== id),
    }));
  },

  reorderQueue(fromIdx, toIdx) {
    set((s) => {
      const queue = [...s.messageQueue];
      if (fromIdx < 0 || fromIdx >= queue.length) return {};
      if (toIdx < 0 || toIdx >= queue.length) return {};
      const [moved] = queue.splice(fromIdx, 1);
      queue.splice(toIdx, 0, moved);
      return { messageQueue: queue };
    });
  },

  editQueueItem(id, content) {
    set((s) => ({
      messageQueue: s.messageQueue.map((q) => q.id === id ? { ...q, content } : q),
    }));
  },

  steerQueueItem(id) {
    // Move the item to the front and send it immediately
    const { messageQueue } = get();
    const item = messageQueue.find((q) => q.id === id);
    if (!item) return;
    // Atomically check streaming state and either move to front or remove+send
    // This prevents the race where streaming starts between check and removal
    set((s) => {
      // Re-check isStreaming inside set to get fresh state
      if (s.isStreaming) {
        // Streaming started — move to front instead of sending
        const filtered = s.messageQueue.filter((q) => q.id !== id);
        return { messageQueue: [item, ...filtered] };
      }
      // Not streaming — remove from queue and send
      const updatedQueue = s.messageQueue.filter((q) => q.id !== id);
      return { messageQueue: updatedQueue };
    });
    // Send outside of set to avoid race — only if still not streaming
    setTimeout(() => {
      const state = get();
      if (!state.isStreaming) {
        void state.sendMessage(item.content);
      }
      // If streaming started, item is already at front of queue and will be sent later
    }, 0);
  },

  clearQueue() {
    set({ messageQueue: [] });
  },

  injectSystemMessage(content) {
    const sessionId = get().activeSessionId;
    if (!sessionId) return;
    const sysMsg: ChatMessage = {
      id: "sys-" + crypto.randomUUID(),
      role: "system",
      content,
      timestamp: Date.now(),
    };
    set((s) => {
      const sessionMsgs = {
        ...s.sessionMessages,
        [sessionId]: [...(s.sessionMessages[sessionId] ?? []), sysMsg]
      };
      return {
        messages: [...s.messages, sysMsg],
        sessionMessages: sessionMsgs,
        chatSessions: s.chatSessions.map(cs =>
          cs.id === sessionId ? { ...cs, messageCount: (cs.messageCount ?? 0) + 1 } : cs
        ),
      };
    });
    savePersistedMessages(get().sessionMessages);
  },

  /**
   * Run verification after plan execution completes.
   * Checks auto-detected commands and file changes, then injects results.
   * If required checks fail, switches back to plan mode for replanning.
   */
  async verifyAfterPlanExecution() {
    const state = get();
    if (!state._pendingVerification) return;
    const { workspacePath } = state._pendingVerification;
    set({ _pendingVerification: null });
    try {
      const { buildDefaultCriteria, runVerificationPipeline } = await import("@/lib/verificationEngine");
      const criteria = await buildDefaultCriteria(workspacePath);
      if (criteria.verificationCommands.length === 0) return;
      const changeList = state._pendingChanges.length > 0
        ? state._pendingChanges
        : state.messages.flatMap(m => m.fileChanges ?? []);
      const result = await runVerificationPipeline(criteria, changeList);
      const content = [
        `## Verification Results ${result.status === "passed" ? "✅" : "❌"}`,
        `**Duration:** ${result.durationMs}ms`,
        `**Status:** ${result.status}`,
        result.summary,
      ].join("\n");
      const verifMsg: ChatMessage = {
        id: "verif-" + crypto.randomUUID(),
        role: "system",
        content,
        timestamp: Date.now(),
      };
      const sessionId = get().activeSessionId;
      if (sessionId) {
        const updatedSessionsMsg = { ...get().sessionMessages, [sessionId]: [...(get().sessionMessages[sessionId] ?? []), verifMsg] };
        set({
          messages: [...get().messages, verifMsg],
          sessionMessages: updatedSessionsMsg,
        });
        savePersistedMessages(updatedSessionsMsg);
      }
      // If verification failed, switch back to plan mode for self-correction
      if (result.status !== "passed") {
        const requiredFailed = result.commandResults.some(r => !r.passed);
        if (requiredFailed) {
          get().setAgentMode("plan" as import("@dalam/shared-types").AgentSessionMode);
          set({ planApproval: { planContent: `The previous plan needs corrections.\n\n${result.summary}\n\nPlease revise the plan and propose fixes.`, status: "pending" } });
        }
      }
    } catch (err) {
      console.warn("[Verification] Failed to run verification:", err);
    }
  },

  saveVersion(sessionId, label) {
    const { messages, sessionVersions } = get();
    if (!messages.length) return;
    const versions = sessionVersions[sessionId] ?? [];
    const parentId = versions.length > 0 ? versions[versions.length - 1].id : undefined;
    const version: import("@dalam/shared-types").ChatVersion = {
      id: "ver-" + crypto.randomUUID(),
      sessionId,
      label,
      messages: [...messages].map(m => ({
        ...m,
        ...(m.toolCalls ? { toolCalls: m.toolCalls.map(tc => ({ ...tc, diff: undefined, diffId: undefined })) } : {}),
      })),
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
    const { messages, sessionVersions, sessionMessages, isStreaming, chatSessions } = get();
    if (isStreaming) return; // Don't restore while streaming
    const versions = sessionVersions[sessionId];
    if (!versions) return;
    const version = versions.find((v) => v.id === versionId);
    if (!version) return;
    // Strip stale diff artifacts but preserve tool results for context (Phase 6.3)
    const restoredMessages = [...version.messages].map((m) => ({
      ...m,
      toolCalls: m.toolCalls ? m.toolCalls.map((tc) => ({
        ...tc,
        result: tc.result,  // Preserve result for context
        diff: undefined,    // Diff is stale, remove
        diffId: undefined,
        status: "completed" as const,
      })) : m.toolCalls,
    }));
    const newSessionMessages = { ...sessionMessages, [sessionId]: restoredMessages };
    const lastUserMsg = [...restoredMessages].reverse().find((m) => m.role === "user");
    const preview = lastUserMsg
      ? lastUserMsg.content.length > 60 ? lastUserMsg.content.slice(0, 57) + "…" : lastUserMsg.content
      : undefined;
    set({
      preRestoreMessages: [...messages],
      messages: restoredMessages,
      sessionMessages: newSessionMessages,
      restoredVersionId: versionId,
      streamingContent: "",
      thinkingContent: "",
      pendingToolCalls: [],
      pendingActivities: [],
      planApproval: null,
      chatSessions: chatSessions.map((cs) =>
        cs.id === sessionId
          ? { ...cs, messageCount: restoredMessages.length, lastActivityAt: Date.now(), ...(preview ? { preview } : {}) }
          : cs
      ),
    });
    savePersistedMessages(newSessionMessages);
    savePersistedSessionSummaries(get().chatSessions);
    useWorkspace.getState().setActiveFile(null);
  },

  confirmVersionRestore() {
    const { messages, activeSessionId, sessionMessages, chatSessions } = get();
    // Persist the current (restored) messages as the session's messages
    if (activeSessionId) {
      const newSessionMessages = { ...sessionMessages, [activeSessionId]: [...messages] };
      const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
      const preview = lastUserMsg
        ? lastUserMsg.content.length > 60 ? lastUserMsg.content.slice(0, 57) + "…" : lastUserMsg.content
        : undefined;
      set({
        restoredVersionId: null,
        preRestoreMessages: null,
        sessionMessages: newSessionMessages,
        pendingToolCalls: [],
        pendingActivities: [],
        _pendingChanges: [],
        chatSessions: chatSessions.map((cs) =>
          cs.id === activeSessionId
            ? { ...cs, messageCount: messages.length, lastActivityAt: Date.now(), ...(preview ? { preview } : {}) }
            : cs
        ),
      });
      savePersistedMessages(newSessionMessages);
      savePersistedSessionSummaries(get().chatSessions);
    } else {
      set({ restoredVersionId: null, preRestoreMessages: null, pendingToolCalls: [], pendingActivities: [], _pendingChanges: [] });
    }
  },

  cancelVersionRestore() {
    const { preRestoreMessages, activeSessionId, sessionMessages, chatSessions } = get();
    if (!preRestoreMessages || !activeSessionId) return;
    const restoredMessages = [...preRestoreMessages];
    const newSessionMessages = { ...sessionMessages, [activeSessionId]: restoredMessages };
    const lastUserMsg = [...restoredMessages].reverse().find((m) => m.role === "user");
    const preview = lastUserMsg
      ? lastUserMsg.content.length > 60 ? lastUserMsg.content.slice(0, 57) + "…" : lastUserMsg.content
      : undefined;
    set({
      messages: restoredMessages,
      sessionMessages: newSessionMessages,
      restoredVersionId: null,
      preRestoreMessages: null,
      pendingToolCalls: [],
      pendingActivities: [],
      _pendingChanges: [],
      chatSessions: chatSessions.map((cs) =>
        cs.id === activeSessionId
          ? { ...cs, messageCount: restoredMessages.length, lastActivityAt: Date.now(), ...(preview ? { preview } : {}) }
          : cs
      ),
    });
    savePersistedMessages(newSessionMessages);
    savePersistedSessionSummaries(get().chatSessions);
  },

  deleteVersion(sessionId, versionId) {
    set((s) => {
      const versions = (s.sessionVersions[sessionId] ?? []).filter((v) => v.id !== versionId);
      return {
        sessionVersions: { ...s.sessionVersions, [sessionId]: versions },
        chatSessions: s.chatSessions.map((ss) =>
          ss.id === sessionId ? { ...ss, versionCount: versions.length } : ss
        ),
        ...(s.restoredVersionId === versionId ? { restoredVersionId: null, preRestoreMessages: null } : {}),
      };
    });
    savePersistedVersions(get().sessionVersions);
  },

  async compactSessionHistory(sessionId) {
    const { sessionMessages, selectedModelId, compactionSummaries, _compactingSessions, _abortControllers } = get();
    if (_compactingSessions.has(sessionId)) return;
    // Create AbortController for cancellable compaction
    const compactController = new AbortController();
    _abortControllers.set(sessionId + "-compact", compactController);
    set({ _abortControllers: new Map(_abortControllers) });
    const messages = sessionMessages[sessionId];
    if (!messages || messages.length <= 6) return;

    // Anti-thrashing: skip if last compaction was ineffective (Hermes pattern)
    const lastCount = _lastCompactionCounts[sessionId];
    const lastSkip = _antiThrashTimestamps[sessionId];
    if (lastCount && lastCount < 0) {
      // Last compaction was ineffective — skip if within cooldown window
      if (lastSkip && Date.now() - lastSkip < ANTI_THRASH_SKIP_MS) {
        return;
      }
      // Cooldown expired — allow one retry
    }

    // Compaction throttle: don't attempt more than once per 30 seconds
    const lastAttempt = _lastCompactionAttempt[sessionId] ?? 0;
    if (Date.now() - lastAttempt < COMPACTION_THROTTLE_MS) return;
    // Clean up compaction AbortController
    const compactCtrl = get()._abortControllers.get(sessionId + "-compact");
    if (compactCtrl) {
      const ctrls = new Map(get()._abortControllers);
      ctrls.delete(sessionId + "-compact");
      set({ _abortControllers: ctrls });
    }
    _lastCompactionAttempt[sessionId] = Date.now();

    // Minimum message count gate
    if (messages.length < COMPACTION_MIN_MESSAGES) return;

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
      // Apply context budget reduction from overflow retries to prevent infinite loops
      const budgetFactor = _contextBudgetFactor[sessionId] ?? 1.0;
      const reducedMaxContext = Math.round(maxContext * budgetFactor);


      // Use context manager to determine what to compact
      const stats = computeContextStats(messages, reducedMaxContext);
      const currentTier = _compactionTier[sessionId] ?? 0;

      // Tier 1: Lightweight tool output pruning at 50% (no LLM call)
      const tier1Threshold = budgetFactor < 1.0
        ? CTX.TIER1_PRUNE_RATIO * 0.75
        : CTX.TIER1_PRUNE_RATIO;
      if (stats.pressureRatio >= tier1Threshold && currentTier < 1) {
        const { pruned, tokensReclaimed } = tier1PruneToolOutputs(messages);
        if (tokensReclaimed > 0) {
          _compactionTier[sessionId] = 1;
          set((s) => {
            const nextMessages = { ...s.sessionMessages, [sessionId]: pruned };
            const isActiveSession = s.activeSessionId === sessionId;
            return {
              sessionMessages: nextMessages,
              ...(isActiveSession ? { messages: pruned } : {}),
            };
          });
          savePersistedMessages(get().sessionMessages);
          console.log(`[Compaction] Tier 1: pruned ~${tokensReclaimed} tokens from old tool outputs at ${(stats.pressureRatio * 100).toFixed(0)}% context usage.`);
        }
      }

      // Recompute stats after Tier 1 pruning so Tier 2 decisions use fresh data
      const freshStats = computeContextStats(
        get().sessionMessages[sessionId] ?? messages,
        reducedMaxContext
      );

      // Tier 2: Full LLM summarization at 85% (using TIER2_COMPACT_RATIO)
      const tier2Threshold = budgetFactor < 1.0
        ? CTX.TIER2_COMPACT_RATIO * 0.8
        : CTX.TIER2_COMPACT_RATIO;
      if (freshStats.pressureRatio >= tier2Threshold) {
        // Use LIVE store messages (not stale snapshot) to avoid Tier 2 overwriting Tier 1 pruning.
        const liveMessages = get().sessionMessages[sessionId] ?? messages;
        const { toCompact } = selectMessagesForCompaction(liveMessages, 6);
        if (toCompact.length > 0) {
          // Build index set for efficient lookup against live messages
          const toCompactIndices = new Set(toCompact.map(m => liveMessages.indexOf(m)));
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
            // Replace compacted messages with summary + kept messages (from live messages)
            const toKeep = liveMessages.filter((_, i) => !toCompactIndices.has(i));
            const summaryMsg: ChatMessage = {
              id: "compact-" + crypto.randomUUID(),
              role: "system",
              content: `[Conversation summary]\n${summary}`,
              timestamp: Date.now(),
            };
            const compacted = [summaryMsg, ...toKeep];
            _compactionTier[sessionId] = 2;
            set((s) => {
              const nextSummaries = { ...s.compactionSummaries, [sessionId]: summary };
              const nextMessages = { ...s.sessionMessages, [sessionId]: compacted };
              const isActiveSession = s.activeSessionId === sessionId;
              return {
                compactionSummaries: nextSummaries,
                sessionMessages: nextMessages,
                ...(isActiveSession ? { messages: compacted } : {}),
              };
            });
            savePersistedCompactionSummaries(get().compactionSummaries);
            savePersistedMessages(get().sessionMessages);

            // Anti-thrashing: track savings (Hermes ineffective compression detection)
            const savingsPercent = ((liveMessages.length - compacted.length) / liveMessages.length) * 100;
            if (savingsPercent < COMPACTION_MIN_SAVINGS_PERCENT) {
              // Ineffective — mark with negative count and record skip timestamp
              _lastCompactionCounts[sessionId] = -liveMessages.length;
              _antiThrashTimestamps[sessionId] = Date.now();
              console.warn(`[Compaction] Anti-thrashing: savings ${savingsPercent.toFixed(1)}% < ${COMPACTION_MIN_SAVINGS_PERCENT}% threshold. Skipping for ${ANTI_THRASH_SKIP_MS / 1000}s.`);
            } else {
              // Effective — record positive count
              _lastCompactionCounts[sessionId] = compacted.length;
              delete _antiThrashTimestamps[sessionId]; // Clear skip timestamp on success
            }
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
    // Guard: if tool already reached a terminal state, ignore duplicate resolution
    const existingTool = get().pendingToolCalls.find((tc) => tc.id === toolCallId);
    if (existingTool && (existingTool.status === "completed" || existingTool.status === "failed")) return;

    // First, resolve via direct callback if registered (avoids polling races)
    const resolver = _toolCallResolvers.get(toolCallId);
    if (resolver) _toolCallResolvers.delete(toolCallId);
    const finalDecision = resolver ? await resolver(decision) : undefined;
    // If the resolver already handled the side effects, we may still need
    // to update the store for UI consistency. The resolver returns the
    // effective decision (e.g., "denied" if already resolved).
    const effectiveDecision = finalDecision ?? decision;

    const api = createDalamAPI();
    const sessionId = get().activeSessionId;

    // Find tool: first in pendingToolCalls, then fall back to scanning messages
    let tool = get().pendingToolCalls.find((tc) => tc.id === toolCallId);
    if (!tool) {
      for (const msg of get().messages) {
        if (msg.toolCalls) {
          tool = msg.toolCalls.find((tc) => tc.id === toolCallId);
          if (tool) break;
        }
      }
    }

    // Save decision for waitForToolApproval to pick up if no resolver was registered yet
    // (fixes the race where auto-approved tools resolve before waitForToolApproval registers)
    if (!resolver) {
      _pendingResolutions.set(toolCallId, effectiveDecision);
    }

    // Handle diff approval/rejection
    if (tool?.diffId) {
      if (effectiveDecision === "approved") {
        try {
          if (sessionId) await api.agent.approveDiff(sessionId, tool.diffId);
        } catch (err) {
          if (import.meta.env.DEV) console.error("Failed to approve diff:", err);
          const failMsg = `Diff approval failed: ${err}`;
          set((s) => ({
            pendingToolCalls: s.pendingToolCalls.map((tc) =>
              tc.id === toolCallId ? { ...tc, status: "failed" as const, result: failMsg } : tc
            ),
            messages: s.messages.map((msg) =>
              msg.toolCalls?.some((tc) => tc.id === toolCallId)
                ? { ...msg, toolCalls: msg.toolCalls.map((tc) => tc.id === toolCallId ? { ...tc, status: "failed" as const, result: failMsg } : tc) }
                : msg
            ),
            sessionMessages: sessionId
              ? { ...s.sessionMessages, [sessionId]: (s.sessionMessages[sessionId] ?? []).map((msg) =>
                  msg.toolCalls?.some((tc) => tc.id === toolCallId)
                    ? { ...msg, toolCalls: msg.toolCalls.map((tc) => tc.id === toolCallId ? { ...tc, status: "failed" as const, result: failMsg } : tc) }
                    : msg
                ) }
              : s.sessionMessages,
          }));
          return;
        }
      } else {
        try {
          if (sessionId) await api.agent.rejectDiff(sessionId, tool.diffId);
        } catch (err) {
          if (import.meta.env.DEV) console.error("Failed to reject diff:", err);
        }
      }
    }

    // Update tool status in pendingToolCalls, messages, and sessionMessages
    const applyStatus = (tc: ToolCall) => ({
      ...tc,
      status: (effectiveDecision === "approved" ? "completed" : "failed") as ToolCall["status"],
      result: result ?? (effectiveDecision === "denied" ? "Denied by user" : undefined),
    });

    set((s) => {
      const sid = s.activeSessionId;
      return {
        pendingToolCalls: s.pendingToolCalls.map((tc) => tc.id === toolCallId ? applyStatus(tc) : tc),
        messages: s.messages.map((msg) =>
          msg.toolCalls?.some((tc) => tc.id === toolCallId)
            ? { ...msg, toolCalls: msg.toolCalls.map((tc) => tc.id === toolCallId ? applyStatus(tc) : tc) }
            : msg
        ),
        sessionMessages: sid
          ? { ...s.sessionMessages, [sid]: (s.sessionMessages[sid] ?? []).map((msg) =>
              msg.toolCalls?.some((tc) => tc.id === toolCallId)
                ? { ...msg, toolCalls: msg.toolCalls.map((tc) => tc.id === toolCallId ? applyStatus(tc) : tc) }
                : msg
            ) }
          : s.sessionMessages,
      };
    });
  },

  newChat() {
    const { session } = get();
    // Abort first to stop any in-progress streaming before clearing state
    if (session) void get().abort(session.id).catch(() => {});
    // Re-read state after abort — abort's finally block may have modified chatSessions
    const latestSession = get().session;
    const latestMessages = get().messages;
    // Clean up all timers and state
    get()._clearAutoRemoveTimers();
    _pendingResolutions.clear();
    _toolCallResolvers.clear();
    const currentTimer = get()._safetyTimer;
    if (currentTimer) clearTimeout(currentTimer);
    // Stop trajectory recording for old session
    if (latestSession) void stopRecording(latestSession.id).catch(() => {});
    // Clear doom loop + context overflow + compaction state
    if (latestSession) {
      _clearDoomLoopState(latestSession.id);
      set({ doomLoopWarningCount: 0 });
      _clearContextOverflowRetries(latestSession.id);
      delete _compactionTier[latestSession.id];
      delete _lastCompactionCounts[latestSession.id];
      delete _lastCompactionAttempt[latestSession.id];
      delete _antiThrashTimestamps[latestSession.id];
      // Abort any in-progress compaction to prevent it writing back after session is removed
      const nextCompacting = new Set(get()._compactingSessions);
      nextCompacting.delete(latestSession.id);
      set({ _compactingSessions: nextCompacting });
    }
    if (latestSession && latestMessages.length > 0) {
      get().saveVersion(latestSession.id, "Session checkpoint");
    }
    const { chatHistory, chatHistoryIdx, chatSessions } = get();
    const trimmedHistory = chatHistoryIdx >= 0
      ? chatHistory.slice(0, chatHistoryIdx + 1)
      : chatHistory;
    const newHistory = latestMessages.length > 0
      ? [...trimmedHistory, latestMessages].slice(-20)
      : trimmedHistory;
    const finalizedSessions = latestSession && latestMessages.length > 0
      ? chatSessions.map((cs) =>
          cs.id === latestSession!.id
            ? {
                ...cs,
                status: cs.status === "running" ? ("completed" as const) : cs.status,
                lastActivityAt: Date.now(),
                lastVisitedAt: Date.now(),
              }
            : cs
        )
      : chatSessions;
    if (useUI.getState().bottomPanelTab === "terminal") {
      useUI.getState().setBottomPanelOpen(false);
    }
    set({
      chatHistory: newHistory,
      chatHistoryIdx: -1,
      messages: [],
      pendingToolCalls: [],
      pendingActivities: [],
      streamingStartedAt: null,
      streamingContent: "",
      thinkingContent: "",
      isStreaming: false,
      _pendingChanges: [],
      _sendInProgress: false,
      pendingAttachments: [],
      session: null,
      activeSessionId: null,
      chatSessions: finalizedSessions,
      planApproval: null,
      restoredVersionId: null,
      preRestoreMessages: null,
      taskPlan: null,
      taskPlanSummary: null,
      subAgents: [],
      _safetyTimer: null,
      _suppressSessionRestore: true,
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
      const restoredMessages = newHistory[targetIdx] ?? [];
      set({
        chatHistory: newHistory,
        chatHistoryIdx: targetIdx,
        messages: restoredMessages,
        pendingToolCalls: [],
        streamingContent: "",
        thinkingContent: "",
        isStreaming: false,
        _pendingChanges: [],
      });
      // Don't touch sessionMessages during navigation — debounced saveWorkspaceData
      // would persist historical snapshots and corrupt the user's actual conversation.
      return true;
    }
    if (chatHistoryIdx <= 0) return false;
    const newIdx = chatHistoryIdx - 1;
    const restoredMessages = chatHistory[newIdx] ?? [];
    set({
      chatHistoryIdx: newIdx,
      messages: restoredMessages,
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
    const restoredMessages = chatHistory[newIdx] ?? [];
    set({
      chatHistoryIdx: newIdx,
      messages: restoredMessages,
      pendingToolCalls: [],
      streamingContent: "",
      thinkingContent: "",
      isStreaming: false,
      _pendingChanges: [],
    });
    // Don't touch sessionMessages during navigation — same reason as goBackChat.
    return true;
  },
}));

// Subscribe to model selection events from settings
import("./events").then(({ eventBus }) => {
  eventBus.on("chat:model-selected", ({ modelId }) => {
    useChat.getState().setSelectedModel(modelId);
  });
  // Handle workspace switching - abort streaming when workspace changes
  eventBus.on("workspace:switched", ({ workspaceId: _workspaceId }) => {
    const { session, isStreaming } = useChat.getState();
    if (session && isStreaming) {
      void useChat.getState().abort(session.id).catch(() => {});
    }
  });
});

type TerminalState = {
  tabs: TerminalTab[];
  activeTabId: string | null;
  output: Record<string, string>;
  pendingCommands: Record<string, string>;
  addTab: (cwd: string, shell?: string, command?: string) => void;
  closeTab: (id: string) => void;
  setActiveTab: (id: string) => void;
  appendOutput: (id: string, data: string) => void;
  consumePendingCommand: (id: string) => string | undefined;
  ensureTabForCwd: (cwd: string) => void;
  updateTabShell: (id: string, shell: string) => void;
  /** Save terminal state for current session */
  saveForSession: (sessionId: string) => void;
  /** Restore terminal state for a session */
  restoreForSession: (sessionId: string) => void;
  /** Write a command to a terminal tab's pending queue (picked up by consumePendingCommand) */
  writeToTerminal: (tabId: string, command: string) => void;
};

// Persist terminal state keyed by session ID (proper Map, not single cache)
const _terminalStateCache = new Map<string, { tabs: TerminalTab[]; activeTabId: string | null }>();

export const useTerminal = create<TerminalState>((set, get) => ({
  tabs: [] as TerminalTab[],
  activeTabId: null,
  output: {},
  pendingCommands: {},
  addTab(cwd, shell = "bash", command?) {
    const id = "t-" + crypto.randomUUID();
    set((s) => ({
      tabs: [...s.tabs, { id, title: shell, cwd, shell } as TerminalTab],
      activeTabId: id,
      pendingCommands: command ? { ...s.pendingCommands, [id]: command } : s.pendingCommands,
    }));
  },
  consumePendingCommand(id) {
    const { pendingCommands } = get();
    const cmd = pendingCommands[id];
    if (cmd !== undefined) {
      const { [id]: _, ...rest } = pendingCommands;
      set({ pendingCommands: rest });
    }
    return cmd;
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
      addTab(cwd);
    }
  },
  updateTabShell(id, shell) {
    set((s) => ({
      tabs: s.tabs.map((t) => t.id === id ? { ...t, shell: shell as TerminalTab["shell"] } : t),
    }));
  },
  writeToTerminal(tabId, command) {
    set((s) => ({
      pendingCommands: { ...s.pendingCommands, [tabId]: command },
    }));
  },
  saveForSession(sessionId) {
    const { tabs, activeTabId } = get();
    _terminalStateCache.set(sessionId, { tabs: tabs as TerminalTab[], activeTabId });
  },
  restoreForSession(sessionId) {
    const cached = _terminalStateCache.get(sessionId);
    if (cached) {
      set({ tabs: cached.tabs as TerminalTab[], activeTabId: cached.activeTabId });
    } else {
      // First time for this session — initialize with workspace cwd
      const { activeWorkspaceId, workspaces } = useWorkspace.getState();
      const ws = workspaces.find(w => w.id === activeWorkspaceId);
      const cwd = ws?.path ?? ".";
      set({
        tabs: [{ id: "t-1", title: basename(cwd) || "bash", cwd, shell: "bash" }] as TerminalTab[],
        activeTabId: "t-1",
      });
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
  try {
    localStorage.setItem(MCP_STORAGE_KEY, JSON.stringify(userServers));
  } catch (e) {
    if (e instanceof DOMException && e.name === "QuotaExceededError") {
      console.warn("[Storage] Quota exceeded saving MCP servers:", e);
    } else {
      console.warn("[Storage] Failed to save MCP servers:", e);
    }
  }
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let childRef: any = null;

    const stdoutHandler = (data: string) => {
      outputBuffer += data;
      const trimmed = outputBuffer.trim();
      if (trimmed.startsWith("{")) {
        try {
          const parsed = JSON.parse(trimmed);
          if (parsed.result?.tools || parsed.tools) {
            resolved = true;
            if (timeoutId !== undefined) clearTimeout(timeoutId);
            cleanup();
            // Kill the child process after successful response
            if (childRef) childRef.kill().catch(() => {});
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
      childRef = child;
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
    set((s) => ({
      skills: s.skills.map((sk) =>
        sk.name === name ? { ...sk, enabled: !sk.enabled } : sk
      ),
    }));
    const nextSkills = get().skills;
    const bundledStates: Record<string, boolean> = {};
    const userSkillsOnly: Skill[] = [];
    nextSkills.forEach((sk) => {
      if (sk.source === "bundled") {
        bundledStates[sk.name] = sk.enabled;
      } else {
        userSkillsOnly.push(sk);
      }
    });
    try {
      localStorage.setItem(BUNDLED_SKILLS_STORAGE_KEY, JSON.stringify(bundledStates));
    } catch (e) {
      console.warn("[Storage] Failed to save bundled skills states:", e);
    }
    try {
      localStorage.setItem(USER_SKILLS_STORAGE_KEY, JSON.stringify(userSkillsOnly));
    } catch (e) {
      console.warn("[Storage] Failed to save user skills:", e);
    }
  },
  toggleMcp(name) {
    set((s) => ({
      mcpServers: s.mcpServers.map((m) =>
        m.name === name ? { ...m, enabled: !m.enabled } : m
      ),
    }));
    saveMcpServers(get().mcpServers);
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
      return { skills: [...s.skills, { ...skill, enabled: true, source: "user" as const }] };
    });
    const userSkillsOnly = get().skills.filter(sk => sk.source === "user");
    try {
      localStorage.setItem(USER_SKILLS_STORAGE_KEY, JSON.stringify(userSkillsOnly));
    } catch (e) {
      console.warn("[Storage] Failed to save user skills:", e);
    }
  },
  removeSkill(name) {
    set((s) => ({
      skills: s.skills.filter((sk) => sk.name !== name),
    }));
    const userSkillsOnly = get().skills.filter(sk => sk.source === "user");
    try {
      localStorage.setItem(USER_SKILLS_STORAGE_KEY, JSON.stringify(userSkillsOnly));
    } catch (e) {
      console.warn("[Storage] Failed to save user skills:", e);
    }
  },
  addMcpServer(server) {
    set((s) => {
      if (s.mcpServers.some((m) => m.name === server.name)) return s;
      const newServer: McpServer = { scope: "user", ...server, enabled: true, status: "disconnected" };
      return { mcpServers: [...s.mcpServers, newServer] };
    });
    saveMcpServers(get().mcpServers);
    get().connectMcpServer(server.name);
  },
  removeMcpServer(name) {
    set((s) => ({
      mcpServers: s.mcpServers.filter((m) => m.name !== name),
    }));
    saveMcpServers(get().mcpServers);
  },
  async connectMcpServer(name) {
    set((s) => ({
      mcpServers: s.mcpServers.map((m) =>
        m.name === name ? { ...m, status: "connecting", error: undefined } : m
      ),
    }));

    const server = get().mcpServers.find((m) => m.name === name);
    if (!server) return;

    // Check cache first
    const { getCachedTools, cacheTools } = await import("../lib/mcpCache");
    const cached = getCachedTools(name);
    if (cached) {
      set((s) => ({
        mcpServers: s.mcpServers.map((m) =>
          m.name === name ? { ...m, status: "connected", tools: cached.tools, error: undefined } : m
        ),
      }));
      return;
    }

    try {
      let tools: { name: string; description: string }[] = [];
      if (server.transport === "http") {
        const url = server.url;
        if (!url) throw new Error("HTTP Endpoint URL is required");
        // SSRF protection: validate URL before fetching
        const { validateMcpUrl } = await import("../lib/security");
        validateMcpUrl(url);
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

      // Cache the tools for future use
      cacheTools(name, tools, server.url);
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      if (import.meta.env.DEV) console.error(`MCP server "${name}" connection failed:`, errorMsg);
      set((s) => ({
        mcpServers: s.mcpServers.map((m) =>
          m.name === name ? { ...m, status: "error", error: errorMsg } : m
        ),
      }));
    }
  },
  async disconnectMcpServer(name) {
    mcpHttpSessions.delete(name);
    const { invalidateCache } = await import("../lib/mcpCache");
    invalidateCache(name);
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
  | "instructions"
  | "skills"
  | "mcp"
  | "memory-graph"
  | "commands"
  | "indexing"
  | "onboard"
  | "connectors";

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
  try {
    localStorage.setItem(PROVIDERS_STORAGE_KEY, JSON.stringify(providers));
  } catch (e) {
    if (e instanceof DOMException && e.name === "QuotaExceededError") {
      console.warn("[Storage] Quota exceeded saving providers:", e);
    } else {
      console.warn("[Storage] Failed to save providers:", e);
    }
  }
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
    set((s) => ({
      providers: [...s.providers, { ...provider, id }],
    }));
    saveProviders(get().providers);
  },
  removeProvider(id) {
    set((s) => ({
      providers: s.providers.filter((p) => p.id !== id),
    }));
    saveProviders(get().providers);
    localStorage.removeItem(`dalam.provider.${id}`);
  },
  toggleProvider(id) {
    set((s) => ({
      providers: s.providers.map((p) => p.id === id ? { ...p, enabled: !p.enabled } : p),
    }));
    saveProviders(get().providers);
  },
  updateProvider(id, updates) {
    set((s) => ({
      providers: s.providers.map((p) => p.id === id ? { ...p, ...updates } : p),
    }));
    saveProviders(get().providers);
  },
  addModel(providerId, model) {
    set((s) => ({
      providers: s.providers.map((p) =>
        p.id === providerId ? { ...p, models: [...p.models, { ...model, connected: false }] } : p
      ),
    }));
    saveProviders(get().providers);
  },
  removeModel(providerId, modelId) {
    set((s) => ({
      providers: s.providers.map((p) =>
        p.id === providerId ? { ...p, models: p.models.filter((m) => m.modelId !== modelId) } : p
      ),
    }));
    saveProviders(get().providers);
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
  _refreshTimer?: ReturnType<typeof setTimeout>;
};

type UIState = {
  rightPanelOpen: boolean;
  sidebarOpen: boolean;
  bottomPanelOpen: boolean;
  viewMode: "chat" | "editor";
  browserTabs: BrowserTab[];
  activeBrowserTabId: string | null;
  rightPanelTab: "git" | "diff" | "review" | "browser" | "progress";
  bottomPanelTab: "terminal" | "output" | "problems";
  setRightPanelOpen: (open: boolean) => void;
  toggleRightPanel: () => void;
  setSidebarOpen: (open: boolean) => void;
  toggleSidebar: () => void;
  setBottomPanelOpen: (open: boolean) => void;
  toggleBottomPanel: () => void;
  setViewMode: (mode: "chat" | "editor") => void;
  toggleViewMode: () => void;
  setRightPanelTab: (tab: "git" | "diff" | "review" | "browser" | "progress") => void;
  setBottomPanelTab: (tab: "terminal" | "output" | "problems") => void;
  addBrowserTab: (tab?: Partial<BrowserTab>) => string;
  removeBrowserTab: (id: string) => void;
  setActiveBrowserTab: (id: string) => void;
  navigateBrowser: (id: string, url: string) => void;
  goBackBrowser: (id: string) => void;
  goForwardBrowser: (id: string) => void;
  refreshBrowser: (id: string) => void;
  updateBrowserTab: (id: string, patch: Partial<BrowserTab>) => void;
  clearBrowserTabs: () => void;
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

/** Check if a hostname resolves to a private/internal address. */
function isPrivateHost(hostname: string): boolean {
  // IPv6 loopback/link-local
  if (hostname === "::1" || hostname === "[::1]") return true;
  // IPv4 private ranges
  if (/^127\./.test(hostname)) return true;
  if (/^10\./.test(hostname)) return true;
  if (/^192\.168\./.test(hostname)) return true;
  if (/^169\.254\./.test(hostname)) return true;
  if (/^0\./.test(hostname)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(hostname)) return true;
  // Cloud metadata endpoints
  if (/^metadata\.google\.internal$/i.test(hostname)) return true;
  if (/^instance-data\.local$/i.test(hostname)) return true;
  if (/^169\.254\.169\.254$/.test(hostname)) return true;
  // Catch bare integer IP representations (0x7f000001, 2130706433, 0177.0.0.1)
  // These don't match dotted patterns but still resolve to IPs in the OS network stack.
  if (hostname.includes(".")) {
    try {
      const testUrl = new URL(`http://${hostname}`);
      const normalized = testUrl.hostname;
      if (normalized !== hostname) return isPrivateHost(normalized);
    } catch { /* not parseable as host */ }
  } else if (/^0x[0-9a-f]+$/i.test(hostname)) {
    // Hex IP representations like 0x7f000001 → 127.0.0.1
    return true;
  } else if (/^\d+$/.test(hostname)) {
    // Decimal IP representations like 2130706433 → 127.0.0.1 (and 1 → 0.0.0.1, etc.)
    // These are interpreted as IP addresses by the OS socket layer and in some browsers.
    return true;
  }
  return hostname === "localhost";
}

function normalizeBrowserUrl(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  // Block dangerous URL schemes
  if (/^(file|data|javascript|vbscript):/i.test(raw)) return null;

  // Try parsing as a URL with protocol
  if (/^https?:\/\//i.test(raw)) {
    try {
      const url = new URL(raw);
      if (isPrivateHost(url.hostname)) return null;
      return url.href;
    } catch {
      return null;
    }
  }

  // Try as a bare hostname/IP (no protocol)
  try {
    const testUrl = new URL(`https://${raw}`);
    if (isPrivateHost(testUrl.hostname)) return null;
  } catch { /* not a valid hostname — treat as search query */ }

  if (/\s/.test(raw)) return "https://www.google.com/search?q=" + encodeURIComponent(raw);
  return "https://" + raw.replace(/^https?:\/\//i, "");
}

export const useUI = create<UIState>((set, get) => ({
  rightPanelOpen: false,
  sidebarOpen: true,
  bottomPanelOpen: false,
  viewMode: "chat",
  browserTabs: [],
  activeBrowserTabId: null,
  rightPanelTab: "git",
  bottomPanelTab: "terminal",
  setRightPanelOpen: (open) => set({ rightPanelOpen: open }),
  toggleRightPanel: () => set((s) => ({ rightPanelOpen: !s.rightPanelOpen })),
  setSidebarOpen: (open) => set({ sidebarOpen: open }),
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  setBottomPanelOpen: (open) => set({ bottomPanelOpen: open }),
  toggleBottomPanel: () => set((s) => ({ bottomPanelOpen: !s.bottomPanelOpen })),
  setViewMode: (mode) => {
    const prevMode = get().viewMode;
    const patch: Partial<UIState> = { viewMode: mode };
    // Always close the right panel when switching to chat/agent mode
    // Agent mode doesn't need the right sidebar by default
    if (mode === "chat" && get().rightPanelOpen) {
      patch.rightPanelOpen = false;
    }
    set(patch);
    // Use event bus for cross-store communication instead of direct getState() calls
    // This breaks the circular dependency between useUI and useWorkspace
    if (prevMode !== mode) {
      import("./events").then(({ eventBus }) => {
        eventBus.emit("ui:view-mode-changed", { mode });
      });
    }
  },
  toggleViewMode: () => {
    const nextMode = get().viewMode === "chat" ? "editor" : "chat";
    get().setViewMode(nextMode);
  },
  setRightPanelTab: (tab) => set({ rightPanelTab: tab }),
  setBottomPanelTab: (tab) => set({ bottomPanelTab: tab }),
  addBrowserTab: (tab) => {
    const id = "bt-" + crypto.randomUUID();
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
      const tab = s.browserTabs.find((t) => t.id === id);
      if (tab?._refreshTimer) clearTimeout(tab._refreshTimer);
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
        const isSameUrl = t.history[t.historyIdx] === truncated;
        return {
          ...t,
          url: truncated,
          title: deriveTitleFromUrl(truncated),
          history: isSameUrl
            ? t.history
            : [...t.history.slice(0, t.historyIdx + 1), truncated],
          historyIdx: isSameUrl ? t.historyIdx : t.historyIdx + 1,
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
    set((s) => ({
      browserTabs: s.browserTabs.map((t) => {
        if (t.id !== id) return t;
        if (t._refreshTimer) clearTimeout(t._refreshTimer);
        const base = t.url.replace(/[?&]_r=\d+/, "");
        const sep = base.includes("?") ? "&" : "?";
        const refreshedUrl = base + sep + "_r=" + Date.now();
        const timer = setTimeout(() => {
          useUI.setState((s2) => ({
            browserTabs: s2.browserTabs.map((tab) => tab.id === id ? { ...tab, loading: false, _refreshTimer: undefined } : tab),
          }));
        }, 5000);
        return { ...t, url: refreshedUrl, loading: true, _refreshTimer: timer };
      }),
    }));
  },
  updateBrowserTab: (id, patch) => {
    set((s) => ({
      browserTabs: s.browserTabs.map((t) => {
        if (t.id !== id) return t;
        if (patch.loading === false && t._refreshTimer) { clearTimeout(t._refreshTimer); return { ...t, ...patch, _refreshTimer: undefined }; }
        return { ...t, ...patch };
      }),
    }));
  },
  clearBrowserTabs: () => {
    // Clear refresh timers before wiping
    const { browserTabs } = get();
    for (const tab of browserTabs) {
      if (tab._refreshTimer) clearTimeout(tab._refreshTimer);
    }
    set({ browserTabs: [], activeBrowserTabId: null });
  },
}));

// Subscribe to workspace file opened events to switch to editor mode
import("./events").then(({ eventBus }) => {
  eventBus.on("workspace:file-opened", () => {
    useUI.getState().setViewMode("editor");
  });
});

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

/**
 * Module-level resolver map that survives pendingToolCalls being cleared.
 * waitForToolApproval registers a callback keyed by toolCallId;
 * resolveToolApproval invokes it directly when found. This decouples
 * tool resolution from the pendingToolCalls array, fixing the race
 * where message-end clears the array before the user responds.
 */
export const _toolCallResolvers = new Map<string, (decision: "approved" | "denied") => void>();
export const _pendingResolutions = new Map<string, "approved" | "denied">();

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
    if (!(await exists(dotDalam))) await mkdir(dotDalam, { recursive: true });
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
      id: "perm-" + crypto.randomUUID(),
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
  const shouldAlways = decision === "always";
  const result = await run();
  if (shouldAlways) {
    usePermission.getState().allowAlways({
      id: "perm-" + crypto.randomUUID(),
      createdAt: Date.now(),
      ...params,
    });
  }
  return result;
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

export const useQuestion = create<QuestionState>((set, _get) => {
  let pendingResolve: ((a: { selectedLabel: string; customText?: string } | null) => void) | null = null;
  const ask: QuestionState["ask"] = (req) => {
    // Dismiss any previous pending question to avoid stale promises
    if (pendingResolve) { pendingResolve(null); pendingResolve = null; }
    const full: QuestionRequest = {
      ...req,
      id: "q-" + crypto.randomUUID(),
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
      // Capture and clear the pending resolver before invoking to prevent double-resolve
      const r = pendingResolve;
      pendingResolve = null;
      if (r) {
        r(answer);
      }
      // Clear the request from UI state
      set({ request: null });
      // Restore session status — guard against missing session
      try {
        const activeSessionId = useChat.getState().activeSessionId;
        if (activeSessionId) {
          useChat.getState().setSessionStatus(activeSessionId, "running");
        }
      } catch { /* store may be resetting */ }
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
