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
  create_dirs: z.boolean().optional().default(false),
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
  max_results: z.string().optional(),
});

export const SearchFilesArgsSchema = z.object({
  pattern: z.string().min(1, "pattern is required"),
  path: z.string().optional(),
  glob: z.string().optional(),
  regex: z.string().optional(),
  max_results: z.string().optional(),
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
  url: z.string().url("must be a valid URL"),
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
};

// ─── Security Validation ─────────────────────────────────────

/** Paths that should never be written to */
const DANGEROUS_PATH_PATTERNS = [
  /\.\./, // path traversal
  /^\/etc\//,
  /^\/usr\//,
  /^\/var\//,
  /^\/bin\//,
  /^\/sbin\//,
  /^\/root\//,
  /^~\//,
];

/** Commands that are too dangerous to execute */
const DANGEROUS_COMMANDS = [
  "rm -rf /",
  "mkfs",
  "dd if=",
  ":(){ :|:& };:",
  "chmod 777 /",
  "> /dev/sda",
  "mv /* ",
];

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
  if (["write_file", "edit_file"].includes(toolName)) {
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

  // Security checks for commands
  if (toolName === "run_command") {
    const cmd = String(args.command || "").toLowerCase();
    for (const dangerous of DANGEROUS_COMMANDS) {
      if (cmd.includes(dangerous.toLowerCase())) {
        return {
          valid: false,
          error: `Dangerous command blocked: contains '${dangerous}'`,
        };
      }
    }
  }

  return { valid: true, args: result.data as Record<string, unknown> };
}
