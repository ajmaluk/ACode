/**
 * Shared types for Dalam's IPC surface.
 * The renderer NEVER has direct access to Node APIs —
 * every call goes through the typed bridge defined in `dalamAPI`.
 */

export type Theme = "dark" | "light" | "system";

export interface AppSettings {
  theme: Theme;
  language: string;
  uiZoom: number;
  inheritSystemTerminal: boolean;
  terminalFont: string;
  terminalFontSize: number;
  httpProxy: string;
  codeThemeLight: string;
  codeThemeDark: string;
  showLineNumbers: boolean;
  wordWrap: boolean;
  codeFontSize: number;
  selectedModel: string;
  selectedProvider: string;
  maxTokens?: number;
  indexingEnabled?: boolean;
  autoIndex?: boolean;
  maxFileSize?: number;
  excludedPatterns?: string;
  doomLoopThreshold?: number;
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: "dark",
  language: "en",
  uiZoom: 1.0,
  inheritSystemTerminal: true,
  terminalFont: "JetBrains Mono",
  terminalFontSize: 13,
  httpProxy: "",
  codeThemeLight: "github-light",
  codeThemeDark: "dalam-dark",
  showLineNumbers: true,
  wordWrap: false,
  codeFontSize: 13,
  selectedModel: "",
  selectedProvider: "",
  maxTokens: 4096,
  doomLoopThreshold: 5,
};

export type FileNode = {
  name: string;
  path: string;
  type: "file" | "directory";
  children?: FileNode[];
  gitStatus?: "modified" | "added" | "deleted" | "untracked" | "ignored" | null;
};

export type GitStatus = {
  branch: string;
  modified: string[];
  added: string[];
  deleted: string[];
  untracked: string[];
  ahead: number;
  behind: number;
};

export type GitBranchInfo = {
  name: string;
  current: boolean;
};

export type TerminalTab = {
  id: string;
  title: string;
  cwd: string;
  isAgent?: boolean;
};

export type FileAttachment = {
  id: string;
  name: string;
  path?: string;
  mimeType: string;
  content: string;
  size: number;
};

export type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  timestamp: number;
  parentID?: string;
  toolCall?: ToolCall;
  toolCalls?: ToolCall[];
  thinking?: string;
  isStreaming?: boolean;
  fileChanges?: FileChange[];
  todos?: TodoItem[];
  activities?: PendingActivity[];
  attachments?: FileAttachment[];
  taskPlan?: { id: string; title: string; status: "pending" | "running" | "done" | "failed" }[];
  taskPlanSummary?: string;
  /** Internal flag: tool result messages that should be hidden from the chat UI */
  isToolResult?: boolean;
};

export type PendingActivity =
  | { type: "think"; id: string; content: string }
  | { type: "explore"; id: string; query: string; kind?: "files" | "grep" | "symbols" | "definition"; matches: { path: string; line?: number; preview?: string }[] }
  | { type: "read"; id: string; path: string; content: string; lineRange?: [number, number] }
  | { type: "skill"; id: string; name: string; content: string; args?: string }
  | { type: "bash"; id: string; command: string; result: string }
  | { type: "plan"; id: string; plan: string };

export type ToolCall = {
  id: string;
  name: string;
  args: Record<string, unknown>;
  status: "pending" | "running" | "completed" | "failed" | "awaiting-approval";
  result?: string;
  diffId?: string;
  diff?: DiffProposal;
};

export type DiffProposal = {
  diffId: string;
  filePath: string;
  oldContent: string;
  newContent: string;
  hunks: DiffHunk[];
  createdAt: number;
};

export type DiffHunk = {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
};

export type DiffLine = {
  type: "context" | "add" | "remove";
  content: string;
  oldLineNumber?: number;
  newLineNumber?: number;
};

export type AgentSessionMode = "build" | "plan" | "yolo";

export type AgentSession = {
  id: string;
  workspacePath: string;
  model: string;
  mode: AgentSessionMode;
  startedAt: number;
  messages: ChatMessage[];
  status: "idle" | "running" | "aborted" | "error";
};

/** @deprecated Use SkillInfo instead — Skill has inconsistent source values */
export type Skill = {
  name: string;
  description: string;
  prompt: string;
  enabled: boolean;
  scope: "global" | "workspace";
  source: "user" | "user-global" | "user-workspace" | "project" | "bundled";
};

export type McpServer = {
  name: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  enabled: boolean;
  status: "disconnected" | "connecting" | "connected" | "error";
  error?: string;
  tools?: { name: string; description: string; inputSchema?: Record<string, unknown> }[];
  scope?: "user" | "project";
};

export type Workspace = {
  id: string;
  path: string;
  name: string;
  tasks: Task[];
};

export type Task = {
  id: string;
  title: string;
  status: "pending" | "running" | "completed" | "failed";
  createdAt: number;
  updatedAt: number;
};

/**
 * Lightweight summary of a chat session for the sidebar / session list.
 * The full conversation lives in `ChatMessage[]`; this is the metadata
 * we need to render the session row and show its live status.
 */
export type ChatSessionSummary = {
  id: string;
  workspacePath: string;
  workspaceName: string;
  title: string;
  agentName: string;
  mode: AgentSessionMode;
  model?: string;
  startedAt: number;
  lastActivityAt: number;
  messageCount: number;
  /** "running" reflects an in-flight AI response; "aborted" is user-paused. */
  status: "idle" | "running" | "completed" | "aborted" | "error";
  /** A short preview of the last user message, for the sidebar tooltip. */
  preview?: string;
  versionCount: number;
};

export type ChatVersion = {
  id: string;
  sessionId: string;
  label: string;
  messages: ChatMessage[];
  timestamp: number;
  parentVersionId?: string;
};

/** State of a sub-agent spawned via the task tool */
export type SubAgentState = {
  id: string;
  prompt: string;
  description: string;
  subagentType: string;
  status: "running" | "completed" | "failed";
  startedAt: number;
  completedAt?: number;
  /** Tool calls executed inside this sub-agent */
  toolCalls: ToolCall[];
  /** Text content streamed from the sub-agent */
  content: string;
  /** Error message if failed */
  error?: string;
};

export type StreamEvent =
  | { type: "message-start"; messageId: string }
  | { type: "message-delta"; messageId: string; content: string }
  | { type: "message-end"; messageId: string }
  | { type: "tool-call"; toolCall: ToolCall }
  | { type: "tool-result"; toolCallId: string; result: string }
  | { type: "diff-proposed"; proposal: DiffProposal }
  | { type: "file-changed"; change: FileChange }
  | { type: "todo-update"; todos: TodoItem[] }
  | { type: "thinking"; messageId: string; content: string }
  | { type: "status"; status: AgentSession["status"] }
  | { type: "ask-permission"; toolCallId: string; kind: string; command?: string; description?: string }
  | { type: "ask-question"; header: string; question: string; options: { label: string; description: string }[] }
  | { type: "sub-agent-start"; subAgentId: string; prompt: string; description: string; subagentType: string }
  | { type: "sub-agent-update"; subAgentId: string; toolCalls?: ToolCall[]; content?: string }
  | { type: "sub-agent-end"; subAgentId: string; status: "completed" | "failed"; error?: string }
  | { type: "activity-think"; content: string }
  | { type: "activity-explore"; query: string; kind?: "files" | "grep" | "symbols" | "definition"; matches: { path: string; line?: number; preview?: string }[] }
  | { type: "activity-read"; path: string; content: string; lineRange?: [number, number] }
  | { type: "activity-skill"; name: string; content: string; args?: string }
  | { type: "activity-bash"; command: string; result: string }
  | { type: "activity-plan"; plan: string }
  | { type: "error"; error: string };

// ============================================================================
// Agent System (matches MiMo-Code's primary/subagent architecture)
// ============================================================================

export type AgentMode = "subagent" | "primary" | "all";

export type AgentCategory = "build" | "plan" | "general" | "explore" | "title" | "summary" | "compaction" | "dream" | "distill";

export type PermissionAction = "allow" | "deny" | "ask";

export type PermissionReply = "once" | "always" | "reject";

/**
 * A single permission rule. Mirrors MiMo-Code's `Permission.Rule` shape.
 *
 * - `permission`: the operation being requested (e.g. "bash", "edit", "read",
 *   "webfetch", "doom_loop", "external_directory", "question", "plan_enter",
 *   "plan_exit", "skill")
 * - `pattern`: the resource the rule applies to. Use `*` as a wildcard.
 *   For bash, patterns are command prefixes resolved by the arity table.
 * - `action`: allow / deny / ask
 */
export type PermissionRule = {
  permission: string;
  pattern: string;
  action: PermissionAction;
};

export type PermissionRuleset = PermissionRule[];

/**
 * An agent definition. Mirrors MiMo-Code's `Agent.Info` shape.
 */
export type AgentInfo = {
  name: string;
  description?: string;
  category: AgentCategory;
  mode: AgentMode;
  hidden?: boolean;
  native?: boolean;
  color?: string;
  temperature?: number;
  topP?: number;
  model?: { providerID: string; modelID: string };
  permission: PermissionRuleset;
  prompt?: string;
  steps?: number;
  toolAllowlist?: string[];
  tools?: { name: string; description: string }[];
};

/**
 * The set of primary (user-selectable) agents. This is what shows up in the
 * mode switcher.
 */
export type PrimaryAgentName = "build" | "plan" | "yolo";

/**
 * A discovered skill (matches MiMo-Code's `Skill.Info`).
 *
 * Skills are markdown files with a YAML frontmatter:
 * ---
 * name: my-skill
 * description: A short tagline
 * ---
 *
 * The body is the prompt that gets injected when the skill is invoked.
 */
export type SkillInfo = {
  name: string;
  description: string;
  content: string;
  location: string;   // absolute path to SKILL.md
  hidden?: boolean;
  source: "bundled" | "user-global" | "user-workspace" | "user" | "project";
};

export type SkillInvocation = {
  name: string;
  args?: string;
};

export type FileChangeAction = "created" | "modified" | "deleted" | "renamed";

export type FileChange = {
  path: string;
  action: FileChangeAction;
  additions: number;
  deletions: number;
  oldPath?: string; // for renames
  preview?: string; // optional diff preview snippet
};

export type TodoItem = {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed" | "failed";
};

/** The surface exposed by `contextBridge` to the renderer. */
export interface DalamAPI {
  fs: {
    readFile(path: string): Promise<string>;
    writeFile(path: string, content: string): Promise<void>;
    listDir(path: string): Promise<FileNode[]>;
    createFile(parentPath: string, name: string): Promise<FileNode>;
    createDirectory(parentPath: string, name: string): Promise<FileNode>;
    deletePath(path: string): Promise<void>;
    renamePath(path: string, newName: string): Promise<void>;
    watchPath(path: string): Promise<void>;
  };
  terminal: {
    create(cwd: string, title?: string): Promise<string>;
    writeInput(id: string, input: string): Promise<void>;
    resize(id: string, cols: number, rows: number): Promise<void>;
    kill(id: string): Promise<void>;
    onData(id: string, cb: (data: string) => void): () => void;
  };
  agent: {
    startSession(options: {
      workspacePath: string;
      model: string;
      mode: AgentSessionMode;
    }): Promise<{ sessionId: string }>;
    sendPrompt(sessionId: string, prompt: string, conversationHistory?: ChatMessage[], agentName?: string, attachments?: FileAttachment[]): Promise<void>;
    summarizeMessages(model: string, messages: Array<{ role: string; content: string }>): Promise<string>;
    abort(sessionId: string): Promise<void>;
    approveDiff(sessionId: string, diffId: string): Promise<void>;
    rejectDiff(sessionId: string, diffId: string): Promise<void>;
    onStreamEvent(sessionId: string, cb: (event: StreamEvent) => void): () => void;
    cleanupStream(sessionId: string): void;
  };
  git: {
    status(repoPath: string): Promise<GitStatus>;
    commit(repoPath: string, message: string): Promise<{ sha: string }>;
    log(repoPath: string, limit?: number): Promise<{ sha: string; message: string; date: string; author: string }[]>;
    branches(repoPath: string): Promise<GitBranchInfo[]>;
    checkout(repoPath: string, branch: string): Promise<void>;
    createBranch(repoPath: string, name: string): Promise<void>;
    diffFile(repoPath: string, filePath: string): Promise<string>;
  };
  settings: {
    get<T = unknown>(key: keyof AppSettings): Promise<T>;
    set<T = unknown>(key: keyof AppSettings, value: T): Promise<void>;
    getAll(): Promise<AppSettings>;
  };
  system: {
    openDirectoryPicker(): Promise<string | null>;
    openLink(url: string): Promise<void>;
    revealInFinder(path: string): Promise<void>;
    getAppVersion(): Promise<string>;
    clipboardReadText(): Promise<string>;
    clipboardWriteText(text: string): Promise<void>;
    clipboardHasImage(): Promise<boolean>;
    notify(payload: { title: string; body: string; icon?: string }): Promise<void>;
    getSystemInfo(): Promise<{ os: string; arch: string; hostname: string; homeDir: string; shell: string; locale?: string }>;
    getWorkingDir(): Promise<string>;
    openWithSystemHandler(pathOrUrl: string): Promise<void>;
    launchApp(appName: string, args?: string[], cwd?: string): Promise<string>;
    getEnv(key: string): Promise<string>;
    getScreenInfo(): Promise<{ width: number; height: number; scaleFactor: number }>;
    listProcesses(): Promise<{ pid: number; name: string; cpuUsage: number; memoryKb: number }[]>;
    killProcess(pid: number): Promise<void>;
    getDiskSpace(path: string): Promise<{ totalBytes: number; availableBytes: number; usedBytes: number }>;
  };
}

declare global {
  interface Window {
    dalamAPI: DalamAPI;
  }
}
