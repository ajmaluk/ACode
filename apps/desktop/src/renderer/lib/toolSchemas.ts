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
  offset: z.string().regex(/^\d+$/, "offset must be a positive integer").optional(),
  limit: z.string().regex(/^\d+$/, "limit must be a positive integer").optional(),
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
  occurrence: z.string().regex(/^\d+$/, "occurrence must be a non-negative integer").optional(),
});

export const ListDirArgsSchema = z.object({
  path: z.string().min(1, "path is required"),
});

export const GrepFileArgsSchema = z.object({
  path: z.string().min(1, "path is required"),
  pattern: z.string().min(1, "pattern is required"),
  regex: z.string().optional(),
  max_results: z.string().regex(/^\d+$/, "max_results must be a numeric string").optional(),
});

export const SearchFilesArgsSchema = z.object({
  pattern: z.string().min(1, "pattern is required"),
  path: z.string().optional(),
  glob: z.string().optional(),
  regex: z.string().optional(),
  max_results: z.string().regex(/^\d+$/, "max_results must be a numeric string").optional(),
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
  url: z.string().url("must be a valid URL").refine(
    (url) => {
      try { return ["http:", "https:", "mailto:"].includes(new URL(url).protocol); }
      catch { return false; }
    },
    "Only http, https, and mailto URLs are allowed"
  ),
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
  tier: z.enum(["critical", "high", "medium", "low"]).optional().default("medium"),
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
});

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
  tasks: z.string().min(1, "tasks is required — newline-separated list of task titles"),
});

export const QuestionArgsSchema = z.object({
  question: z.string().min(1, "question is required"),
  options: z.string().optional(),
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
  list_dir: { schema: ListDirArgsSchema, requiredFields: ["path"] },
  grep_file: { schema: GrepFileArgsSchema, requiredFields: ["path", "pattern"] },
  search_files: { schema: SearchFilesArgsSchema, requiredFields: ["pattern"] },
  run_command: { schema: RunCommandArgsSchema, requiredFields: ["command"] },
  git_status: { schema: GitStatusArgsSchema, requiredFields: [] },
  git_commit: { schema: GitCommitArgsSchema, requiredFields: ["message"] },
  git_log: { schema: GitLogArgsSchema, requiredFields: [] },
  git_branch: { schema: GitBranchArgsSchema, requiredFields: [] },
  git_checkout: { schema: GitCheckoutArgsSchema, requiredFields: ["branch"] },
  git_diff_file: { schema: GitDiffFileArgsSchema, requiredFields: ["path"] },
  clipboard_read: { schema: ClipboardReadArgsSchema, requiredFields: [] },
  clipboard_write: { schema: ClipboardWriteArgsSchema, requiredFields: ["text"] },
  notify: { schema: NotifyArgsSchema, requiredFields: ["title"] },
  system_info: { schema: SystemInfoArgsSchema, requiredFields: [] },
  open_url: { schema: OpenUrlArgsSchema, requiredFields: ["url"] },
  launch_app: { schema: LaunchAppArgsSchema, requiredFields: ["name"] },
  reveal_in_finder: { schema: RevealInFinderArgsSchema, requiredFields: ["path"] },
  memory_save: { schema: MemorySaveArgsSchema, requiredFields: ["content"] },
  memory_search: { schema: MemorySearchArgsSchema, requiredFields: ["query"] },
  memory_delete: { schema: MemoryDeleteArgsSchema, requiredFields: ["id"] },
  memory_stats: { schema: MemoryStatsArgsSchema, requiredFields: [] },
  memory_maintain: { schema: MemoryMaintainArgsSchema, requiredFields: [] },
  memory_extract: { schema: MemoryExtractArgsSchema, requiredFields: [] },
  memory_export: { schema: MemoryExportArgsSchema, requiredFields: [] },
  memory_import: { schema: MemoryImportArgsSchema, requiredFields: [] },
  task: { schema: TaskArgsSchema, requiredFields: ["prompt"] },
  open_panel: { schema: OpenPanelArgsSchema, requiredFields: ["panel"] },
  screenshot: { schema: ScreenshotArgsSchema, requiredFields: [] },
  browser_navigate: { schema: BrowserNavigateArgsSchema, requiredFields: ["url"] },
  run_preview: { schema: RunPreviewArgsSchema, requiredFields: ["command"] },
  browser_execute: { schema: BrowserExecuteArgsSchema, requiredFields: ["script"] },
  create_task_plan: { schema: CreateTaskPlanArgsSchema, requiredFields: ["tasks"] },
  question: { schema: QuestionArgsSchema, requiredFields: ["question"] },
  get_env: { schema: GetEnvArgsSchema, requiredFields: ["key"] },
  get_screen_info: { schema: GetScreenInfoArgsSchema, requiredFields: [] },
  list_processes: { schema: ListProcessesArgsSchema, requiredFields: [] },
  kill_process: { schema: KillProcessArgsSchema, requiredFields: ["pid"] },
  get_disk_space: { schema: GetDiskSpaceArgsSchema, requiredFields: ["path"] },
  set_theme: { schema: SetThemeArgsSchema, requiredFields: ["theme"] },
  toggle_theme: { schema: ToggleThemeArgsSchema, requiredFields: [] },
  set_view_mode: { schema: SetViewModeArgsSchema, requiredFields: ["mode"] },
  toggle_view_mode: { schema: ToggleViewModeArgsSchema, requiredFields: [] },
  toggle_right_panel: { schema: ToggleRightPanelArgsSchema, requiredFields: [] },
  toggle_bottom_panel: { schema: ToggleBottomPanelArgsSchema, requiredFields: [] },
  set_right_panel_tab: { schema: SetRightPanelTabArgsSchema, requiredFields: ["tab"] },
  set_bottom_panel_tab: { schema: SetBottomPanelTabArgsSchema, requiredFields: ["tab"] },
  new_terminal: { schema: NewTerminalArgsSchema, requiredFields: [] },
  terminal_write: { schema: TerminalWriteArgsSchema, requiredFields: ["command"] },
};

// ─── Security Validation ─────────────────────────────────────

/** Paths that should never be read or written to */
const DANGEROUS_PATH_PATTERNS = [
  /\.\./, // path traversal
  /^\/etc\//,
  /^\/usr\//,
  /^\/var\//,
  /^\/bin\//,
  /^\/sbin\//,
  /^\/root\//,
  /^~\//,
  // Windows critical paths
  /^[a-zA-Z]:\\Windows\\/,
  /^[a-zA-Z]:\\Program Files/,
  /^[a-zA-Z]:\\System32/,
  /^[a-zA-Z]:\\Boot/,
  /^[a-zA-Z]:\\ProgramData/,
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
  // Unix - downloading and executing
  "curl | sh",
  "curl | bash",
  "wget | sh",
  "wget | bash",
  "curl -s | sh",
  "curl -s | bash",
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

/**
 * Normalize a shell command for safety checking.
 * Collapses multiple spaces, trims, lowercases, and removes common obfuscation.
 */
function normalizeCommand(cmd: string): string {
  return cmd
    .toLowerCase()
    .replace(/\s+/g, " ")  // Collapse whitespace
    .replace(/["']/g, "")  // Remove quotes (common bypass)
    .replace(/\\/g, "")    // Remove backslashes (Windows paths)
    .trim();
}

/**
 * Validate tool arguments against the registered schema.
 * Returns { valid: true, args } on success, { valid: false, error } on failure.
 */
export function validateToolArgs(
  toolName: string,
  args: Record<string, unknown>,
): { valid: true; args: Record<string, unknown> } | { valid: false; error: string } {
  const entry = TOOL_SCHEMAS[toolName];

  if (!entry) {
    // Unknown tool — validate MCP tools against a generic schema
    if (toolName.startsWith("mcp_")) {
      if (typeof args !== "object" || args === null || Array.isArray(args)) {
        return { valid: false, error: `MCP tool ${toolName}: args must be a plain object` };
      }
      // Validate all arg values are JSON-serializable primitives or simple objects
      for (const [key, val] of Object.entries(args)) {
        if (typeof key !== "string") {
          return { valid: false, error: `MCP tool ${toolName}: arg keys must be strings` };
        }
        if (val !== null && typeof val === "function") {
          return { valid: false, error: `MCP tool ${toolName}: arg '${key}' cannot be a function` };
        }
      }
      // Security scan for string arg values — block dangerous paths and commands
      for (const val of Object.values(args)) {
        if (typeof val === "string") {
          for (const pattern of DANGEROUS_PATH_PATTERNS) {
            if (pattern.test(val)) {
              return { valid: false, error: `MCP tool ${toolName}: path not allowed` };
            }
          }
          const normalizedCmd = normalizeCommand(val);
          for (const dangerous of DANGEROUS_COMMANDS) {
            const normalizedDangerous = normalizeCommand(dangerous);
            if (normalizedCmd === normalizedDangerous || normalizedCmd.startsWith(normalizedDangerous + " ")) {
              return { valid: false, error: `MCP tool ${toolName}: dangerous command blocked` };
            }
          }
        }
      }
      return { valid: true, args };
    }
    return { valid: false, error: `Unknown tool: ${toolName}` };
  }

  // Check required fields first (cheap)
  for (const field of entry.requiredFields) {
    if (args[field] === undefined || args[field] === null || args[field] === "") {
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

  // Security checks for file operations
  if (["read_file", "write_file", "edit_file", "list_dir", "grep_file", "get_disk_space", "reveal_in_finder"].includes(toolName)) {
    const path = String(args.path ?? "");
    for (const pattern of DANGEROUS_PATH_PATTERNS) {
      if (pattern.test(path)) {
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
      for (const pattern of DANGEROUS_PATH_PATTERNS) {
        if (pattern.test(cwd)) {
          return {
            valid: false,
            error: `Path not allowed: ${cwd}`,
          };
        }
      }
    }
  }

  // Security checks for commands (normalized to prevent bypass via whitespace)
  if (toolName === "run_command") {
    const cmd = normalizeCommand(String(args.command || ""));
    for (const dangerous of DANGEROUS_COMMANDS) {
      const normalizedDangerous = normalizeCommand(dangerous);
      // Patterns ending with / (like "rm -rf /") need care:
      // Block "rm -rf /" and "echo && rm -rf /" but allow "rm -rf /tmp/build"
      // Use negative lookahead to ensure the pattern is NOT followed by path chars
      let matched: boolean;
      if (normalizedDangerous.endsWith("/")) {
        const escaped = normalizedDangerous.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const regex = new RegExp(`${escaped}(?![\\w/])`);
        matched = regex.test(cmd);
      } else {
        matched = cmd === normalizedDangerous || cmd.startsWith(normalizedDangerous + " ") || cmd.includes(normalizedDangerous);
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
