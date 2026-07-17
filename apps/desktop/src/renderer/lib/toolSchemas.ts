/**
 * ============================================================
 * DALAM TOOL SCHEMAS — Zod Validation for Tool Arguments
 * ============================================================
 *
 * Runtime validation of tool arguments before execution.
 * Prevents shell injection, path traversal, and malformed args.
 * ============================================================
 */

import { z } from "zod";

// ─── Tool Argument Schemas ───────────────────────────────────

export const ReadFileArgsSchema = z.object({
  path: z.string().min(1, "path is required"),
  offset: z
    .string()
    .regex(/^\d+$/, "offset must be a positive integer")
    .optional(),
  limit: z
    .string()
    .regex(/^\d+$/, "limit must be a positive integer")
    .optional(),
});

export const WriteFileArgsSchema = z.object({
  path: z.string().min(1, "path is required"),
  content: z.string(),
  create_dirs: z
    .union([z.boolean(), z.enum(["true", "false"])])
    .optional()
    .default(false)
    .transform((v) => v === true || v === "true"),
});

export const EditFileArgsSchema = z.object({
  path: z.string().min(1, "path is required"),
  search: z.string().min(1, "search string is required"),
  replace: z.string(),
  occurrence: z
    .string()
    .regex(/^\d+$/, "occurrence must be a non-negative integer")
    .optional(),
});

export const ListDirArgsSchema = z.object({
  // Optional — defaults to workspace root at execution time
  path: z
    .string()
    .optional()
    .transform((v) => (!v || v.trim() === "" ? "." : v)),
});

export const GrepFileArgsSchema = z.object({
  path: z.string().min(1, "path is required"),
  pattern: z.string().min(1, "pattern is required"),
  regex: z.string().optional(),
  max_results: z
    .string()
    .regex(/^\d+$/, "max_results must be a numeric string")
    .optional(),
});

export const SearchFilesArgsSchema = z.object({
  pattern: z.string().min(1, "pattern is required"),
  path: z.string().optional(),
  glob: z.string().optional(),
  regex: z.string().optional(),
  max_results: z
    .string()
    .regex(/^\d+$/, "max_results must be a numeric string")
    .optional(),
});

export const RunCommandArgsSchema = z.object({
  command: z.string().min(1, "command is required"),
});

export const GitStatusArgsSchema = z.object({});

export const GitCommitArgsSchema = z.object({
  message: z.string().min(1, "commit message is required"),
});

export const GitLogArgsSchema = z.object({});

export const GitBranchArgsSchema = z.object({});

export const GitCheckoutArgsSchema = z.object({
  branch: z.string().min(1, "branch name is required"),
});

export const GitCreateBranchArgsSchema = z.object({
  branch: z.string().min(1, "branch name is required"),
  base_branch: z.string().optional(),
});

export const GitDiffFileArgsSchema = z.object({
  path: z.string().min(1, "path is required"),
});

export const ClipboardReadArgsSchema = z.object({});

export const ClipboardWriteArgsSchema = z.object({
  text: z.string(),
});

export const NotifyArgsSchema = z.object({
  title: z.string().min(1, "title is required"),
  body: z.string().optional().default(""),
});

export const SystemInfoArgsSchema = z.object({});

export const OpenUrlArgsSchema = z.object({
  url: z
    .string()
    .url("must be a valid URL")
    .refine((url) => {
      try {
        return ["http:", "https:", "mailto:"].includes(new URL(url).protocol);
      } catch (e) {
        if (import.meta.env.DEV) console.warn("[ToolSchemas] Failed to parse URL for protocol check:", url, e);
        return false;
      }
    }, "Only http, https, and mailto URLs are allowed"),
});

export const LaunchAppArgsSchema = z.object({
  name: z.string().min(1, "app name is required"),
  args: z.string().optional(),
  cwd: z.string().optional(),
});

export const RevealInFinderArgsSchema = z.object({
  path: z.string().min(1, "path is required"),
});

export const MemorySaveArgsSchema = z.object({
  category: z
    .enum(["user", "feedback", "project", "reference", "task", "decision"])
    .optional()
    .default("project"),
  tier: z
    .enum(["critical", "high", "medium", "low"])
    .optional()
    .default("medium"),
  summary: z.string().optional(),
  tags: z.string().optional(),
  content: z.string(),
});

export const MemorySearchArgsSchema = z.object({
  query: z.string().min(1, "query is required"),
  category: z.string().optional(),
  limit: z.string().optional(),
});

export const MemoryDeleteArgsSchema = z.object({
  id: z.string().min(1, "id is required"),
});

export const MemoryStatsArgsSchema = z.object({});
export const MemoryMaintainArgsSchema = z.object({});
export const MemoryExtractArgsSchema = z.object({});
export const MemoryExportArgsSchema = z.object({});
export const MemoryImportArgsSchema = z.object({});

export const TaskArgsSchema = z.object({
  prompt: z.string().min(1, "prompt is required"),
  subagent_type: z.string().optional().default("general"),
  description: z.string().optional(),
  background: z
    .union([z.boolean(), z.enum(["true", "false"])])
    .optional()
    .transform((v) => v === true || v === "true"),
  task_id: z.string().optional(),
});

/** Single todo item for todowrite tool (OpenCode-compatible) */
export const TodoItemSchema = z.object({
  id: z.string().min(1),
  content: z.string().min(1),
  status: z
    .enum(["pending", "in_progress", "completed", "failed", "cancelled"])
    .default("pending"),
});

export const TodoWriteArgsSchema = z.object({
  // Accept either a JSON string of todos or a pre-parsed array via content
  todos: z.string().optional(),
  content: z.string().optional(),
}).refine(
  (v) => Boolean(v.todos?.trim() || v.content?.trim()),
  { message: "todowrite requires todos JSON (or content body with JSON array)" },
);

export const OpenPanelArgsSchema = z.object({
  panel: z.enum(["git", "diff", "review", "browser", "progress", "terminal"]),
});

export const ScreenshotArgsSchema = z.object({});

export const BrowserNavigateArgsSchema = z.object({
  url: z.string().min(1, "url is required"),
});

export const RunPreviewArgsSchema = z.object({
  command: z.string().min(1, "command is required"),
  port: z.string().optional(),
});

export const BrowserExecuteArgsSchema = z.object({
  script: z.string().min(1, "script is required"),
});

export const CreateTaskPlanArgsSchema = z.object({
  tasks: z
    .string()
    .min(1, "tasks is required — newline-separated list of task titles"),
});

export const WebFetchArgsSchema = z.object({
  url: z.string().url("must be a valid URL").refine(
    (url) => /^https?:\/\//i.test(url),
    "URL must use http or https protocol"
  ),
  format: z.enum(["markdown", "text", "html"]).optional().default("markdown"),
});

export const WebSearchArgsSchema = z.object({
  query: z.string().min(1, "query is required"),
  num_results: z.string().optional(),
  livecrawl: z.string().optional(),
  type: z.string().optional(),
});

export const CreateFileArgsSchema = z.object({
  path: z.string().min(1, "path is required"),
  content: z.string(),
});

export const QuestionArgsSchema = z.object({
  question: z.string().min(1, "question is required"),
  options: z.string().optional(),
  type: z.enum(["text", "number", "confirm"]).optional(),
  allowFreeText: z.enum(["true", "false"]).optional(),
  placeholder: z.string().optional(),
  defaultValue: z.string().optional(),
  required: z.enum(["true", "false"]).optional(),
});

export const GetEnvArgsSchema = z.object({
  key: z.string().min(1, "key is required"),
});

export const GetScreenInfoArgsSchema = z.object({});

export const ListProcessesArgsSchema = z.object({});

export const KillProcessArgsSchema = z.object({
  pid: z.string().min(1, "pid is required"),
});

export const GetDiskSpaceArgsSchema = z.object({
  path: z.string().min(1, "path is required"),
});

export const SetThemeArgsSchema = z.object({
  theme: z.enum(["light", "dark", "system"]),
});

export const ToggleThemeArgsSchema = z.object({});

export const SetViewModeArgsSchema = z.object({
  mode: z.enum(["editor", "chat"]),
});

export const ToggleViewModeArgsSchema = z.object({});

export const ToggleRightPanelArgsSchema = z.object({});

export const ToggleBottomPanelArgsSchema = z.object({});

export const SetRightPanelTabArgsSchema = z.object({
  tab: z.enum(["git", "diff", "review", "browser", "progress"]),
});

export const SetBottomPanelTabArgsSchema = z.object({
  tab: z.enum(["terminal", "output", "problems"]),
});

export const NewTerminalArgsSchema = z.object({
  cwd: z.string().optional(),
  shell: z.string().optional(),
});

export const TerminalWriteArgsSchema = z.object({
  command: z.string().min(1, "command is required"),
  terminal_id: z.string().optional(),
});

// ─── Schema Registry ─────────────────────────────────────────

type ToolSchemaEntry = {
  schema: z.ZodType<unknown>;
  requiredFields: string[];
};

const TOOL_SCHEMAS: Record<string, ToolSchemaEntry> = {
  read_file: { schema: ReadFileArgsSchema, requiredFields: ["path"] },
  write_file: { schema: WriteFileArgsSchema, requiredFields: ["path"] },
  edit_file: { schema: EditFileArgsSchema, requiredFields: ["path"] },
  list_dir: { schema: ListDirArgsSchema, requiredFields: [] },
  grep_file: {
    schema: GrepFileArgsSchema,
    requiredFields: ["path", "pattern"],
  },
  grep: { schema: GrepFileArgsSchema, requiredFields: ["path", "pattern"] },
  search_files: { schema: SearchFilesArgsSchema, requiredFields: ["pattern"] },
  search: { schema: SearchFilesArgsSchema, requiredFields: ["pattern"] },
  run_command: { schema: RunCommandArgsSchema, requiredFields: ["command"] },
  bash: { schema: RunCommandArgsSchema, requiredFields: ["command"] },
  shell: { schema: RunCommandArgsSchema, requiredFields: ["command"] },
  execute: { schema: RunCommandArgsSchema, requiredFields: ["command"] },
  git_status: { schema: GitStatusArgsSchema, requiredFields: [] },
  git_commit: { schema: GitCommitArgsSchema, requiredFields: ["message"] },
  git_log: { schema: GitLogArgsSchema, requiredFields: [] },
  git_branch: { schema: GitBranchArgsSchema, requiredFields: [] },
  git_checkout: { schema: GitCheckoutArgsSchema, requiredFields: ["branch"] },
  git_create_branch: { schema: GitCreateBranchArgsSchema, requiredFields: ["branch"] },
  git_diff_file: { schema: GitDiffFileArgsSchema, requiredFields: ["path"] },
  clipboard_read: { schema: ClipboardReadArgsSchema, requiredFields: [] },
  clipboard_write: {
    schema: ClipboardWriteArgsSchema,
    requiredFields: ["text"],
  },
  notify: { schema: NotifyArgsSchema, requiredFields: ["title"] },
  system_info: { schema: SystemInfoArgsSchema, requiredFields: [] },
  open_url: { schema: OpenUrlArgsSchema, requiredFields: ["url"] },
  launch_app: { schema: LaunchAppArgsSchema, requiredFields: ["name"] },
  reveal_in_finder: {
    schema: RevealInFinderArgsSchema,
    requiredFields: ["path"],
  },
  memory_save: { schema: MemorySaveArgsSchema, requiredFields: ["content"] },
  memory_search: { schema: MemorySearchArgsSchema, requiredFields: ["query"] },
  memory_delete: { schema: MemoryDeleteArgsSchema, requiredFields: ["id"] },
  memory_stats: { schema: MemoryStatsArgsSchema, requiredFields: [] },
  memory_maintain: { schema: MemoryMaintainArgsSchema, requiredFields: [] },
  memory_extract: { schema: MemoryExtractArgsSchema, requiredFields: [] },
  memory_export: { schema: MemoryExportArgsSchema, requiredFields: [] },
  memory_import: { schema: MemoryImportArgsSchema, requiredFields: [] },
  task: { schema: TaskArgsSchema, requiredFields: ["prompt"] },
  todowrite: { schema: TodoWriteArgsSchema, requiredFields: [] },
  open_panel: { schema: OpenPanelArgsSchema, requiredFields: ["panel"] },
  screenshot: { schema: ScreenshotArgsSchema, requiredFields: [] },
  browser_navigate: {
    schema: BrowserNavigateArgsSchema,
    requiredFields: ["url"],
  },
  run_preview: { schema: RunPreviewArgsSchema, requiredFields: ["command"] },
  browser_execute: {
    schema: BrowserExecuteArgsSchema,
    requiredFields: ["script"],
  },
  create_task_plan: {
    schema: CreateTaskPlanArgsSchema,
    requiredFields: ["tasks"],
  },
  question: { schema: QuestionArgsSchema, requiredFields: ["question"] },
  webfetch: { schema: WebFetchArgsSchema, requiredFields: ["url"] },
  websearch: { schema: WebSearchArgsSchema, requiredFields: ["query"] },
  create_file: { schema: CreateFileArgsSchema, requiredFields: ["path"] },
  get_env: { schema: GetEnvArgsSchema, requiredFields: ["key"] },
  get_screen_info: { schema: GetScreenInfoArgsSchema, requiredFields: [] },
  list_processes: { schema: ListProcessesArgsSchema, requiredFields: [] },
  kill_process: { schema: KillProcessArgsSchema, requiredFields: ["pid"] },
  get_disk_space: { schema: GetDiskSpaceArgsSchema, requiredFields: ["path"] },
  set_theme: { schema: SetThemeArgsSchema, requiredFields: ["theme"] },
  toggle_theme: { schema: ToggleThemeArgsSchema, requiredFields: [] },
  set_view_mode: { schema: SetViewModeArgsSchema, requiredFields: ["mode"] },
  toggle_view_mode: { schema: ToggleViewModeArgsSchema, requiredFields: [] },
  toggle_right_panel: {
    schema: ToggleRightPanelArgsSchema,
    requiredFields: [],
  },
  toggle_bottom_panel: {
    schema: ToggleBottomPanelArgsSchema,
    requiredFields: [],
  },
  set_right_panel_tab: {
    schema: SetRightPanelTabArgsSchema,
    requiredFields: ["tab"],
  },
  set_bottom_panel_tab: {
    schema: SetBottomPanelTabArgsSchema,
    requiredFields: ["tab"],
  },
  new_terminal: { schema: NewTerminalArgsSchema, requiredFields: [] },
  terminal_write: {
    schema: TerminalWriteArgsSchema,
    requiredFields: ["command"],
  },
};

// ─── Security Validation ─────────────────────────────────────

/** Paths that should never be read or written to */
const DANGEROUS_PATH_PATTERNS = [
  /\.\./, // path traversal
  /^\/etc(?:\/|$)/i,
  /^\/usr(?:\/|$)/i,
  /^\/var(?:\/|$)/i,
  /^\/bin(?:\/|$)/i,
  /^\/sbin(?:\/|$)/i,
  /^\/root(?:\/|$)/i,
  /^~\//,
  // Windows critical paths (both backslash and forward-slash variants)
  /^[a-zA-Z]:(?:\\|\/)Windows(?:\\|\/)/i,
  /^[a-zA-Z]:(?:\\|\/)Program Files/i,
  /^[a-zA-Z]:(?:\\|\/)System32/i,
  /^[a-zA-Z]:(?:\\|\/)Boot/i,
  /^[a-zA-Z]:(?:\\|\/)ProgramData/i,
];

/**
 * Commands that are too dangerous to execute.
 * Includes both Unix and Windows-specific dangerous patterns.
 * Patterns are checked against normalized commands (lowercase, whitespace-collapsed).
 */
const DANGEROUS_COMMANDS = [
  // Unix - destructive file operations
  "rm -rf /",
  "rm -rf /*",
  "rm -fr /",
  "rm -fr /*",
  "rm -rf ~",
  "rm -rf ~/",
  // Unix - disk/format operations
  "mkfs",
  "dd if=",
  "> /dev/sda",
  "> /dev/nvme",
  // Unix - fork bombs
  ":(){ :|:& };:",
  ":(){ :|:&};:",
  // Unix - permission escalation
  "chmod 777 /",
  "chmod -R 777 /",
  "chown -R",
  // Unix - moving system files
  "mv /* ",
  "mv /etc/",
  "mv /usr/",
  // Windows - destructive operations
  "Format-Volume",
  "Remove-Item -Recurse -Force C:\\",
  "Remove-Item -Recurse -Force C:/",
  "del /s /q C:\\",
  "del /s /q C:/",
  "rmdir /s /q C:\\",
  "rmdir /s /q C:/",
  "bcdedit",
  "reg delete HKLM",
  // Windows - PowerShell dangerous
  "Stop-Computer",
  "Restart-Computer",
  "Set-ExecutionPolicy Unrestricted",
];

/** Pattern-based dangerous commands (regex instead of string matching) */
const DANGEROUS_PATTERNS: Array<{ pattern: RegExp; description: string }> = [
  // Unix - downloading and executing (piped to shell): curl ... | sh, wget ... | bash, etc.
  { pattern: /\b(curl|wget)\b[^|]*\|[^|]*\bsh\b/, description: "pipe_curl_sh" },
  { pattern: /\b(curl|wget)\b[^|]*\|[^|]*\bbash\b/, description: "pipe_curl_bash" },
  { pattern: /\bwget\b[^|]*\|[^|]*\bsh\b/, description: "pipe_wget_sh" },
  { pattern: /\bwget\b[^|]*\|[^|]*\bbash\b/, description: "pipe_wget_bash" },
];

/**
 * Normalize a shell command for safety checking.
 * Collapses multiple spaces, trims, lowercases, and removes common obfuscation.
 */
function normalizeCommand(cmd: string): string {
  return cmd
    .toLowerCase()
    .replace(/\s+/g, " ") // Collapse whitespace
    .replace(/["']/g, "") // Remove quotes (common bypass)
    // M-19: Don't remove ALL backslashes — only remove backslash before specific chars (quotes, spaces for safety)
    .replace(/\\(?=["'\\nrt])/g, "") // Only remove backslash before quotes, backslash, n, r, t
    .replace(/\s+/g, " ") // Re-collapse after possible backslash-space removal
    .trim();
}

/**
 * Recursively validate all string values in a nested object/array structure.
 * Returns an array of error messages (empty if valid).
 */
function validateNestedValues(
  val: unknown,
  path: string[],
  toolName: string,
): string[] {
  const errors: string[] = [];

  if (typeof val === "string") {
    // String validation
    for (const pattern of DANGEROUS_PATH_PATTERNS) {
      if (pattern.test(val)) {
        errors.push(`MCP tool ${toolName}: arg '${path.join(".")}' path not allowed`);
        break;
      }
    }
    const normalizedCmd = normalizeCommand(val);
    // H-4: NFC normalization — normalize Unicode for path checking
    const normalizedPath = val.normalize("NFC");
    for (const pattern of DANGEROUS_PATH_PATTERNS) {
      if (pattern.test(normalizedPath)) {
        errors.push(`MCP tool ${toolName}: arg '${path.join(".")}' path not allowed`);
        break;
      }
    }
    for (const dangerous of DANGEROUS_COMMANDS) {
      const normalizedDangerous = normalizeCommand(dangerous);
      if (
        normalizedCmd === normalizedDangerous ||
        normalizedCmd.startsWith(normalizedDangerous + " ")
      ) {
        errors.push(`MCP tool ${toolName}: arg '${path.join(".")}' dangerous command blocked`);
        break;
      }
    }
  } else if (Array.isArray(val)) {
    for (let i = 0; i < val.length; i++) {
      errors.push(...validateNestedValues(val[i], [...path, String(i)], toolName));
    }
  } else if (val !== null && typeof val === "object") {
    for (const [key, childVal] of Object.entries(val as Record<string, unknown>)) {
      errors.push(...validateNestedValues(childVal, [...path, key], toolName));
    }
  }

  return errors;
}

/**
 * Validate tool arguments against the registered schema.
 * Returns { valid: true, args } on success, { valid: false, error } on failure.
 */
export function validateToolArgs(
  toolName: string,
  args: Record<string, unknown>,
):
  | { valid: true; args: Record<string, unknown> }
  | { valid: false; error: string } {
  const entry = TOOL_SCHEMAS[toolName];

  if (!entry) {
    // Unknown tool — validate MCP tools against a generic schema
    if (toolName.startsWith("mcp_")) {
      if (typeof args !== "object" || args === null || Array.isArray(args)) {
        return {
          valid: false,
          error: `MCP tool ${toolName}: args must be a plain object`,
        };
      }
      // Validate all arg values are JSON-serializable primitives or simple objects
      for (const [key, val] of Object.entries(args)) {
        if (typeof key !== "string") {
          return {
            valid: false,
            error: `MCP tool ${toolName}: arg keys must be strings`,
          };
        }
        if (val !== null && typeof val === "function") {
          return {
            valid: false,
            error: `MCP tool ${toolName}: arg '${key}' cannot be a function`,
          };
        }
      }
      // M-18: Recursive validation for MCP tool args (check nested objects/arrays)
      const nestedErrors = validateNestedValues(args, [], toolName);
      if (nestedErrors.length > 0) {
        return { valid: false, error: nestedErrors[0] };
      }
      return { valid: true, args };
    }
    return { valid: false, error: `Unknown tool: ${toolName}` };
  }

  // Check required fields first (cheap)
  for (const field of entry.requiredFields) {
    if (
      args[field] === undefined ||
      args[field] === null ||
      args[field] === ""
    ) {
      return {
        valid: false,
        error: `${toolName} requires a '${field}' argument`,
      };
    }
  }

  // Validate against Zod schema
  const result = entry.schema.safeParse(args);
  if (!result.success) {
    const firstError = result.error.issues[0];
    return {
      valid: false,
      error: `${toolName}: ${firstError.path.join(".")}: ${firstError.message}`,
    };
  }

  // Security checks for file operations (including create_file and aliases)
  const pathCheckedTools = [
    "read_file", "write_file", "edit_file", "list_dir",
    "grep_file", "grep", "search_files", "search",
    "create_file", "get_disk_space", "reveal_in_finder",
  ];
  if (pathCheckedTools.includes(toolName)) {
    const path = String(args.path ?? "");
    // H-4: NFC normalization for path checking
    const normalizedPath = path.normalize("NFC");
    for (const pattern of DANGEROUS_PATH_PATTERNS) {
      if (pattern.test(normalizedPath)) {
        return {
          valid: false,
          error: `Path not allowed: ${path}`,
        };
      }
    }
  }

  // Security check for launch_app cwd
  if (toolName === "launch_app") {
    const cwd = String(args.cwd ?? "");
    if (cwd) {
      const normalizedCwd = cwd.normalize("NFC");
      for (const pattern of DANGEROUS_PATH_PATTERNS) {
        if (pattern.test(normalizedCwd)) {
          return {
            valid: false,
            error: `Path not allowed: ${cwd}`,
          };
        }
      }
    }
  }

  // Security checks for commands (normalized to prevent bypass via whitespace)
  const commandCheckedTools = ["run_command", "bash", "shell", "execute", "run_preview", "terminal_write"];
  if (commandCheckedTools.includes(toolName)) {
    const cmd = normalizeCommand(String(args.command || ""));
    for (const dangerous of DANGEROUS_COMMANDS) {
      const normalizedDangerous = normalizeCommand(dangerous);
      // Patterns ending with / (like "rm -rf /") need care:
      // Block "rm -rf /" and "echo && rm -rf /" but allow "rm -rf /tmp/build"
      // Use negative lookahead to ensure the pattern is NOT followed by path chars
      let matched: boolean;
      // Check pattern-based dangerous commands first (e.g., pipe-to-shell)
      const patternMatch = DANGEROUS_PATTERNS.find((p) => p.pattern.test(cmd));
      if (patternMatch) {
        matched = true;
      } else if (normalizedDangerous.endsWith("/")) {
        const escaped = normalizedDangerous.replace(
          /[.*+?^${}()|[\]\\]/g,
          "\\$&",
        );
        const regex = new RegExp(`${escaped}(?![\\w/])`);
        matched = regex.test(cmd);
      } else {
        // Use word-boundary matching to prevent false positives from substrings.
        // Single-word commands (e.g. "bcdedit", "mkfs") should only match whole words.
        const escaped = normalizedDangerous.replace(
          /[.*+?^${}()|[\]\\]/g,
          "\\$&",
        );
        if (normalizedDangerous.includes(" ")) {
          // Multi-word commands: match at word boundary start
          matched = new RegExp(`(?:^|\\W)${escaped}(?=\\W|$)`).test(cmd);
        } else {
          // Single-word commands: require full word boundary on both sides
          matched = new RegExp(`\\b${escaped}\\b`).test(cmd);
        }
      }
      if (matched) {
        return {
          valid: false,
          error: `Dangerous command blocked: contains '${dangerous}'`,
        };
      }
    }
  }

  return { valid: true, args: result.data as Record<string, unknown> };
}

// ─── Unified Tool Registry (single source of truth) ────────────
// Central registry mapping XML tag names to canonical tool names,
// used by TAG_TO_TOOL, ALL_TOOL_NAMES, and permission categories.
// Every tool should be registered here exactly once.

export type ToolCategory = "edit" | "bash" | "read" | "other";

export type ToolRegistryEntry = {
  tag: string; // XML tag name (e.g., "bash", "shell")
  tool: string; // canonical internal name (e.g., "bash")
  category: ToolCategory;
};

export const TOOL_REGISTRY: ToolRegistryEntry[] = [
  // File operations
  { tag: "read_file", tool: "read_file", category: "read" },
  { tag: "write_file", tool: "write_file", category: "edit" },
  { tag: "edit_file", tool: "edit_file", category: "edit" },
  { tag: "list_dir", tool: "list_dir", category: "read" },
  { tag: "grep_file", tool: "grep_file", category: "read" },
  { tag: "grep", tool: "grep", category: "read" },
  { tag: "search_files", tool: "search_files", category: "read" },
  { tag: "search", tool: "search", category: "read" },
  { tag: "create_file", tool: "create_file", category: "edit" },

  // Shell execution
  { tag: "bash", tool: "bash", category: "bash" },
  { tag: "shell", tool: "bash", category: "bash" },
  { tag: "execute", tool: "bash", category: "bash" },
  { tag: "run_command", tool: "bash", category: "bash" },

  // Git operations
  { tag: "git_status", tool: "git_status", category: "read" },
  { tag: "git_commit", tool: "git_commit", category: "edit" },
  { tag: "git_log", tool: "git_log", category: "read" },
  { tag: "git_branch", tool: "git_branch", category: "read" },
  { tag: "git_checkout", tool: "git_checkout", category: "read" },
  { tag: "git_create_branch", tool: "git_create_branch", category: "edit" },
  { tag: "git_diff_file", tool: "git_diff_file", category: "read" },

  // Clipboard & system
  { tag: "clipboard_read", tool: "clipboard_read", category: "read" },
  { tag: "clipboard_write", tool: "clipboard_write", category: "other" },
  { tag: "notify", tool: "notify", category: "read" },
  { tag: "system_info", tool: "system_info", category: "read" },
  { tag: "open_url", tool: "open_url", category: "bash" },
  { tag: "launch_app", tool: "launch_app", category: "bash" },
  { tag: "reveal_in_finder", tool: "reveal_in_finder", category: "bash" },
  { tag: "get_env", tool: "get_env", category: "read" },
  { tag: "get_screen_info", tool: "get_screen_info", category: "read" },
  { tag: "list_processes", tool: "list_processes", category: "read" },
  { tag: "kill_process", tool: "kill_process", category: "bash" },
  { tag: "get_disk_space", tool: "get_disk_space", category: "read" },

  // Memory
  { tag: "memory_save", tool: "memory_save", category: "edit" },
  { tag: "memory_search", tool: "memory_search", category: "read" },
  { tag: "memory_delete", tool: "memory_delete", category: "edit" },
  { tag: "memory_stats", tool: "memory_stats", category: "read" },
  { tag: "memory_maintain", tool: "memory_maintain", category: "edit" },
  { tag: "memory_extract", tool: "memory_extract", category: "read" },
  { tag: "memory_export", tool: "memory_export", category: "edit" },
  { tag: "memory_import", tool: "memory_import", category: "edit" },

  // Agent & UI
  { tag: "task", tool: "task", category: "read" },
  { tag: "todowrite", tool: "todowrite", category: "other" },
  { tag: "create_task_plan", tool: "create_task_plan", category: "other" },
  { tag: "open_panel", tool: "open_panel", category: "read" },
  { tag: "screenshot", tool: "screenshot", category: "read" },
  { tag: "question", tool: "question", category: "other" },

  // Browser & preview
  { tag: "browser_navigate", tool: "browser_navigate", category: "bash" },
  { tag: "browser_execute", tool: "browser_execute", category: "bash" },
  { tag: "run_preview", tool: "run_preview", category: "bash" },

  // Web
  { tag: "webfetch", tool: "webfetch", category: "read" },
  { tag: "websearch", tool: "websearch", category: "read" },

  // UI control
  { tag: "set_theme", tool: "set_theme", category: "read" },
  { tag: "toggle_theme", tool: "toggle_theme", category: "read" },
  { tag: "set_view_mode", tool: "set_view_mode", category: "read" },
  { tag: "toggle_view_mode", tool: "toggle_view_mode", category: "read" },
  { tag: "toggle_right_panel", tool: "toggle_right_panel", category: "read" },
  { tag: "toggle_bottom_panel", tool: "toggle_bottom_panel", category: "read" },
  { tag: "set_right_panel_tab", tool: "set_right_panel_tab", category: "read" },
  {
    tag: "set_bottom_panel_tab",
    tool: "set_bottom_panel_tab",
    category: "read",
  },

  // Terminal
  { tag: "new_terminal", tool: "new_terminal", category: "bash" },
  { tag: "terminal_write", tool: "terminal_write", category: "bash" },

  // Catch-all for invalid tool calls (OpenCode parity: feeds error back to model)
  { tag: "invalid", tool: "invalid", category: "other" },
];

// Derived registries from the single source of truth
export const TAG_TO_TOOL: Record<string, string> = {};
export const ALL_TOOL_NAMES: string[] = [];
export const CANONICAL_TOOL_NAMES: string[] = [];

for (const entry of TOOL_REGISTRY) {
  TAG_TO_TOOL[entry.tag] = entry.tool;
  ALL_TOOL_NAMES.push(entry.tag);
  if (!CANONICAL_TOOL_NAMES.includes(entry.tool)) {
    CANONICAL_TOOL_NAMES.push(entry.tool);
  }
}

export const TOOL_CATEGORIES = {
  edit: new Set(
    TOOL_REGISTRY.filter((e) => e.category === "edit").map((e) => e.tool),
  ),
  bash: new Set(
    TOOL_REGISTRY.filter((e) => e.category === "bash").map((e) => e.tool),
  ),
  read: new Set(
    TOOL_REGISTRY.filter((e) => e.category === "read").map((e) => e.tool),
  ),
};
