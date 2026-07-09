/**
 * Dalam chat activity blocks.
 *
 * Every agent activity — thinking, reading, exploring, running tools, invoking
 * skills, editing files, proposing plans — renders as a single inline row
 * with a chevron. Clicking the chevron expands the detail content directly
 * underneath. There are intentionally no card / border wrappers around the
 * rows themselves: the chat reads as direct text, with the detail only
 * appearing when the user asks for it.
 *
 * Block types:
 *   - ThinkingBlock  — the model's reasoning (collapsed by default)
 *   - ExploreBlock   — file tree / grep / codebase navigation findings
 *   - ReadBlock      — file contents the agent looked at
 *   - SkillBlock     — a $skill-name invocation
 *   - PlanBlock      — a plan the agent produced
 *   - BashActivityBlock — terminal-like shell output
 *   - ToolCallsList  — list of tool calls (read_file, edit_file, shell, etc.)
 *   - ChangesCard    — file changes (open diff, +/- stats)
 *   - TodoBlock      — todo list checklist
 */
import React, { useState } from "react";
import {
  CheckCircle2,
  FileText,
  Loader2,
  X,
  Check,
  ChevronDown,
  Code2,
  Terminal,
  Search,
  FilePlus,
  Shield,
  Folder,
  File,
  FileCode,
  FileJson,
  FileImage,
  FileType,
  GitBranch,
  Monitor,
  Eye,
  HelpCircle,
  Layout,
  ListChecks,
  Paintbrush,
} from "lucide-react";
import type {
  FileChange,
  SkillInfo,
  TodoItem,
  ToolCall,
  SubAgentState,
} from "@dalam/shared-types";
import {
  useChat,
  useDiffView,
  useWorkspace,
  BUNDLED_SKILLS,
} from "@/store/useAppStore";
import { skillRegistry } from "@/lib/skills";
import { basename, dirname } from "@/lib/pathUtils";

// ============================================================================
// Shared row primitive
// ============================================================================

/**
 * One activity row in the chat. The row is rendered as a single line of muted
 * text — the same visual weight as a normal chat line, just lower opacity so
 * it doesn't compete with the assistant's actual reply. A small chevron at the
 * start shows the expand state. When expanded, the detail content is rendered
 * directly underneath, indented with a thin left rule to mark it as a sub-block.
 */
function ActivityRow({
  icon,
  iconClass,
  label,
  meta,
  defaultOpen = false,
  children,
  trailing,
  className,
}: {
  icon?: React.ReactNode;
  iconClass?: string;
  label: React.ReactNode;
  meta?: React.ReactNode;
  defaultOpen?: boolean;
  children?: React.ReactNode;
  trailing?: React.ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const hasDetail = !!children;
  return (
    <div className={`my-0.5 ${className ?? ""}`}>
      <button
        type="button"
        onClick={() => hasDetail && setOpen((o) => !o)}
        aria-expanded={hasDetail ? open : undefined}
        className={`group flex items-center gap-1.5 text-left text-[13px] leading-relaxed w-full opacity-60 hover:opacity-100 transition-opacity ${
          hasDetail ? "cursor-pointer" : "cursor-default"
        } text-dalam-text-secondary`}
        title={
          hasDetail
            ? open
              ? "Click to collapse"
              : "Click to expand"
            : undefined
        }
      >
        {hasDetail ? (
          <ChevronDown
            className={`w-3 h-3 text-dalam-text-muted/70 transition-transform flex-shrink-0 ${open ? "" : "-rotate-90"}`}
          />
        ) : (
          <span className="w-3 h-3 flex-shrink-0" />
        )}
        {icon && (
          <span
            className={`flex-shrink-0 inline-flex items-center opacity-80 ${iconClass ?? ""}`}
          >
            {icon}
          </span>
        )}
        <span className="truncate">{label}</span>
        {meta && (
          <span className="text-dalam-text-muted/80 text-[11px] truncate">
            {meta}
          </span>
        )}
        {trailing && (
          <span className="ml-auto flex-shrink-0 flex items-center gap-1 opacity-80">
            {trailing}
          </span>
        )}
      </button>
      {hasDetail && open && (
        <div className="ml-3.5 mt-1 pl-3 border-l border-dalam-border-primary/60 text-[12px] text-dalam-text-secondary/80 leading-relaxed">
          {children}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// ThinkingBlock — model's step-by-step reasoning
// ============================================================================

export const ThinkingBlock = React.memo(function ThinkingBlock({
  content,
  streaming,
}: {
  content: string;
  streaming?: boolean;
}) {
  return (
    <ActivityRow
      label={
        <span className="italic flex items-center gap-2">
          {streaming ? (
            <>
              <span className="animate-thinking-wave">
                <span className="w-1 h-1 rounded-full bg-dalam-accent-primary" />
                <span className="w-1 h-1 rounded-full bg-dalam-accent-primary" />
                <span className="w-1 h-1 rounded-full bg-dalam-accent-primary" />
              </span>
              Thinking…
            </>
          ) : (
            "Reasoned step-by-step"
          )}
        </span>
      }
      meta={streaming ? undefined : `${content.length} chars`}
      defaultOpen={streaming}
    >
      <pre className="whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed text-dalam-text-secondary/90">
        {content}
        {streaming && (
          <span className="inline-block w-1.5 h-3 bg-dalam-accent-primary ml-0.5 animate-pulse-soft align-middle" />
        )}
      </pre>
    </ActivityRow>
  );
});

// ============================================================================
// ExploreBlock — file tree / grep findings
// ============================================================================

export type ExploreResult = {
  query: string;
  kind?: "files" | "grep" | "symbols" | "definition";
  matches: { path: string; line?: number; preview?: string }[];
};

export const ExploreBlock = React.memo(function ExploreBlock({
  result,
}: {
  result: ExploreResult;
}) {
  return (
    <ActivityRow
      label={
        <>
          Explored{" "}
          {result.kind ? (
            <span className="text-dalam-text-secondary/70">{result.kind}</span>
          ) : (
            "codebase"
          )}
        </>
      }
      meta={result.query}
      defaultOpen
      trailing={
        <span className="text-[10px] tabular-nums">
          {result.matches.length} match{result.matches.length !== 1 ? "es" : ""}
        </span>
      }
    >
      <ul className="space-y-0.5 max-h-64 overflow-y-auto scrollbar-thin">
        {result.matches.map((m, idx) => (
          <li
            key={idx}
            className="flex items-center gap-2 hover:opacity-100 opacity-90 font-mono text-[11px] cursor-pointer hover:bg-dalam-bg-hover rounded px-1 py-0.5 transition-colors"
            onClick={() => {
              void useWorkspace.getState().openFile(m.path);
            }}
          >
            {result.kind === "grep" || result.kind === "symbols" ? (
              <Search className="w-3 h-3 flex-shrink-0" />
            ) : (
              <FileText className="w-3 h-3 flex-shrink-0" />
            )}
            <span className="truncate flex-1 min-w-0">{m.path}</span>
            {m.line !== undefined && (
              <span className="opacity-70 tabular-nums">:{m.line}</span>
            )}
            {m.preview && (
              <span className="truncate max-w-[260px] opacity-70">
                {m.preview}
              </span>
            )}
          </li>
        ))}
      </ul>
    </ActivityRow>
  );
});

// ============================================================================
// ReadBlock — file content the agent looked at
// ============================================================================

export const ReadBlock = React.memo(function ReadBlock({
  path,
  content,
  lineRange,
}: {
  path: string;
  content: string;
  lineRange?: [number, number];
}) {
  const fileName = basename(path);
  const lines = content.split("\n");
  const start = lineRange?.[0] ?? 1;
  const range = lineRange
    ? `${lineRange[0]}–${lineRange[1]}`
    : `${lines.length} lines`;
  return (
    <ActivityRow
      label={
        <>
          Read <span className="font-mono">{fileName}</span>
        </>
      }
      meta={path}
      trailing={<span className="text-[10px] tabular-nums">{range}</span>}
    >
      <pre className="text-[11px] font-mono leading-relaxed bg-dalam-bg-secondary/30 rounded-md p-2 max-h-80 overflow-y-auto scrollbar-thin">
        {lines.map((line, i) => {
          const lineNum = start + i;
          return (
            <div key={i} className="flex hover:bg-dalam-bg-hover/30">
              <span className="w-12 flex-shrink-0 text-right pr-2 opacity-50 select-none tabular-nums">
                {lineNum}
              </span>
              <code className="flex-1 px-2 whitespace-pre">
                {line || "\u00A0"}
              </code>
            </div>
          );
        })}
      </pre>
    </ActivityRow>
  );
});

// ============================================================================
// ContextGatheringGroup — collapsible group for explore/read activities
// ============================================================================

export const ContextGatheringGroup = React.memo(function ContextGatheringGroup({
  activities,
}: {
  activities: import("@dalam/shared-types").PendingActivity[];
}) {
  const [open, setOpen] = useState(false);
  if (activities.length === 0) return null;

  const exploreCount = activities.filter((a) => a.type === "explore").length;
  const readCount = activities.filter((a) => a.type === "read").length;
  const parts: string[] = [];
  if (exploreCount > 0)
    parts.push(`${exploreCount} search${exploreCount !== 1 ? "s" : ""}`);
  if (readCount > 0)
    parts.push(`${readCount} file read${readCount !== 1 ? "s" : ""}`);

  return (
    <div className="my-0.5">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="group flex items-center gap-1.5 text-left text-[13px] leading-relaxed w-full opacity-60 hover:opacity-100 transition-opacity cursor-pointer text-dalam-text-secondary"
        title={open ? "Click to collapse context" : "Click to expand context"}
      >
        <ChevronDown
          className={`w-3 h-3 text-dalam-text-muted/70 transition-transform flex-shrink-0 ${open ? "" : "-rotate-90"}`}
        />
        <Search className="w-3 h-3 flex-shrink-0 opacity-80" />
        <span className="truncate">Gathered context ({parts.join(", ")})</span>
        <span className="ml-auto text-[10px] tabular-nums opacity-70">
          {activities.length} items
        </span>
      </button>
      {open && (
        <div className="ml-3.5 mt-1 pl-3 border-l border-dalam-border-primary/60 text-[12px] text-dalam-text-secondary/80 leading-relaxed space-y-1">
          {activities.map((activity) => {
            if (activity.type === "explore") {
              return <ExploreBlock key={activity.id} result={activity} />;
            }
            if (activity.type === "read") {
              return (
                <ReadBlock
                  key={activity.id}
                  path={activity.path}
                  content={activity.content}
                  lineRange={activity.lineRange}
                />
              );
            }
            return null;
          })}
        </div>
      )}
    </div>
  );
});

// ============================================================================
// SkillBlock — $skill invocation
// ============================================================================

export const SkillBlock = React.memo(function SkillBlock({
  name,
  args,
  content,
  status,
}: {
  name: string;
  args?: string;
  content?: string;
  status?: "running" | "completed" | "failed";
}) {
  const bundledSkill = BUNDLED_SKILLS.find((s: SkillInfo) => s.name === name);
  const projectSkill = skillRegistry.get(name);
  const skill =
    bundledSkill ??
    (projectSkill
      ? {
          name: projectSkill.name,
          description: projectSkill.description ?? "",
          content: projectSkill.content,
          location: projectSkill.location,
          source: projectSkill.source,
        }
      : null);
  const statusIcon =
    status === "running" ? (
      <span className="w-1.5 h-1.5 rounded-full bg-dalam-accent-primary animate-pulse" />
    ) : status === "failed" ? (
      <span className="w-1.5 h-1.5 rounded-full bg-dalam-git-deleted" />
    ) : null;
  return (
    <ActivityRow
      label={
        <>
          Invoked <span className="font-mono">${name}</span>
          {args ? (
            <span className="opacity-70 ml-1.5 font-mono">{args}</span>
          ) : null}
        </>
      }
      trailing={
        <>
          {statusIcon}
          {skill ? (
            <span className="text-[10px] italic opacity-70 truncate max-w-[200px]">
              {skill.description}
            </span>
          ) : null}
        </>
      }
    >
      {content && (
        <pre className="font-mono text-[11px] bg-dalam-bg-secondary/30 rounded-md p-2 max-h-60 overflow-y-auto scrollbar-thin whitespace-pre-wrap break-words">
          {content}
        </pre>
      )}
    </ActivityRow>
  );
});

// ============================================================================
// PlanBlock — plan from plan mode
// ============================================================================

export const PlanBlock = React.memo(function PlanBlock({
  plan,
}: {
  plan: string;
}) {
  return (
    <ActivityRow label="Implementation plan" meta="ready to review" defaultOpen>
      <pre className="whitespace-pre-wrap break-words leading-relaxed text-dalam-text-primary">
        {plan}
      </pre>
    </ActivityRow>
  );
});

// ============================================================================
// BashActivityBlock — terminal-like display
// ============================================================================

export const BashActivityBlock = React.memo(function BashActivityBlock({
  command,
  result,
}: {
  command: string;
  result: string;
}) {
  return (
    <ActivityRow
      label={
        <>
          Ran <span className="font-mono">$ {command}</span>
        </>
      }
      defaultOpen={false}
    >
      {result ? (
        <pre className="font-mono text-[11px] bg-dalam-bg-secondary/30 rounded-md p-2 max-h-60 overflow-y-auto scrollbar-thin whitespace-pre-wrap break-words">
          {result}
        </pre>
      ) : (
        <span className="italic opacity-70">no output</span>
      )}
    </ActivityRow>
  );
});

// ============================================================================
// ToolCallsList — list of tool calls
// ============================================================================

const TOOL_META: Record<
  string,
  { icon: React.ElementType; label: string; color: string }
> = {
  read_file: { icon: FileText, label: "Read", color: "text-dalam-text-muted" },
  read: { icon: FileText, label: "Read", color: "text-dalam-text-muted" },
  edit_file: { icon: Code2, label: "Edited", color: "text-dalam-text-muted" },
  edit: { icon: Code2, label: "Edited", color: "text-dalam-text-muted" },
  write_file: {
    icon: FilePlus,
    label: "Wrote",
    color: "text-dalam-text-muted",
  },
  write: { icon: FilePlus, label: "Wrote", color: "text-dalam-text-muted" },
  create_file: {
    icon: FilePlus,
    label: "Created",
    color: "text-dalam-text-muted",
  },
  bash: { icon: Terminal, label: "Ran", color: "text-dalam-text-muted" },
  shell: { icon: Terminal, label: "Ran", color: "text-dalam-text-muted" },
  execute: { icon: Terminal, label: "Ran", color: "text-dalam-text-muted" },
  run_command: { icon: Terminal, label: "Ran", color: "text-dalam-text-muted" },
  file_search: {
    icon: Search,
    label: "Searched",
    color: "text-dalam-text-muted",
  },
  search_files: {
    icon: Search,
    label: "Searched",
    color: "text-dalam-text-muted",
  },
  grep: { icon: Search, label: "Searched", color: "text-dalam-text-muted" },
  grep_file: {
    icon: Search,
    label: "Searched",
    color: "text-dalam-text-muted",
  },
  list_dir: { icon: FileText, label: "Listed", color: "text-dalam-text-muted" },
  webfetch: { icon: Code2, label: "Fetched", color: "text-dalam-text-muted" },
  websearch: {
    icon: Search,
    label: "Searched",
    color: "text-dalam-text-muted",
  },
  git_status: {
    icon: Code2,
    label: "Git Status",
    color: "text-dalam-text-muted",
  },
  git_commit: {
    icon: Code2,
    label: "Git Commit",
    color: "text-dalam-text-muted",
  },
  git_log: { icon: Code2, label: "Git Log", color: "text-dalam-text-muted" },
  clipboard_read: {
    icon: FileText,
    label: "Clipboard",
    color: "text-dalam-text-muted",
  },
  clipboard_write: {
    icon: FileText,
    label: "Clipboard",
    color: "text-dalam-text-muted",
  },
  notify: { icon: Shield, label: "Notify", color: "text-dalam-text-muted" },
  system_info: {
    icon: Code2,
    label: "System Info",
    color: "text-dalam-text-muted",
  },
  open_url: { icon: Code2, label: "Open URL", color: "text-dalam-text-muted" },
  launch_app: {
    icon: Terminal,
    label: "Launched",
    color: "text-dalam-text-muted",
  },
  reveal_in_finder: {
    icon: FileText,
    label: "Revealed",
    color: "text-dalam-text-muted",
  },
  memory_save: {
    icon: Shield,
    label: "Memory Save",
    color: "text-dalam-text-muted",
  },
  memory_search: {
    icon: Search,
    label: "Memory Search",
    color: "text-dalam-text-muted",
  },
  memory_delete: {
    icon: X,
    label: "Memory Delete",
    color: "text-dalam-text-muted",
  },
  memory_stats: {
    icon: Code2,
    label: "Memory Stats",
    color: "text-dalam-text-muted",
  },
  memory_maintain: {
    icon: Shield,
    label: "Memory Maintain",
    color: "text-dalam-text-muted",
  },
  memory_extract: {
    icon: Code2,
    label: "Memory Extract",
    color: "text-dalam-text-muted",
  },
  memory_export: {
    icon: Code2,
    label: "Memory Export",
    color: "text-dalam-text-muted",
  },
  memory_import: {
    icon: Code2,
    label: "Memory Import",
    color: "text-dalam-text-muted",
  },
  get_env: { icon: Code2, label: "Get Env", color: "text-dalam-text-muted" },
  get_screen_info: {
    icon: Monitor,
    label: "Screen Info",
    color: "text-dalam-text-muted",
  },
  list_processes: {
    icon: Terminal,
    label: "Processes",
    color: "text-dalam-text-muted",
  },
  kill_process: {
    icon: X,
    label: "Kill Process",
    color: "text-dalam-text-muted",
  },
  get_disk_space: {
    icon: Code2,
    label: "Disk Space",
    color: "text-dalam-text-muted",
  },
  open_panel: {
    icon: Layout,
    label: "Opened Panel",
    color: "text-dalam-text-muted",
  },
  screenshot: {
    icon: Monitor,
    label: "Screenshot",
    color: "text-dalam-text-muted",
  },
  browser_navigate: {
    icon: Search,
    label: "Navigated",
    color: "text-dalam-text-muted",
  },
  run_preview: { icon: Eye, label: "Preview", color: "text-dalam-text-muted" },
  browser_execute: {
    icon: Code2,
    label: "Browser JS",
    color: "text-dalam-text-muted",
  },
  create_task_plan: {
    icon: ListChecks,
    label: "Task Plan",
    color: "text-dalam-text-muted",
  },
  question: {
    icon: HelpCircle,
    label: "Question",
    color: "text-dalam-text-muted",
  },
  task: {
    icon: ListChecks,
    label: "Sub-Agent",
    color: "text-dalam-text-muted",
  },
  git_branch: {
    icon: GitBranch,
    label: "Git Branch",
    color: "text-dalam-text-muted",
  },
  git_checkout: {
    icon: GitBranch,
    label: "Git Checkout",
    color: "text-dalam-text-muted",
  },
  git_diff_file: {
    icon: FileText,
    label: "Git Diff",
    color: "text-dalam-text-muted",
  },
  set_theme: {
    icon: Paintbrush,
    label: "Set Theme",
    color: "text-dalam-text-muted",
  },
  toggle_theme: {
    icon: Paintbrush,
    label: "Toggle Theme",
    color: "text-dalam-text-muted",
  },
  set_view_mode: {
    icon: Layout,
    label: "Set Mode",
    color: "text-dalam-text-muted",
  },
  toggle_view_mode: {
    icon: Layout,
    label: "Toggle Mode",
    color: "text-dalam-text-muted",
  },
  toggle_right_panel: {
    icon: Layout,
    label: "Toggle Panel",
    color: "text-dalam-text-muted",
  },
  toggle_bottom_panel: {
    icon: Layout,
    label: "Toggle Panel",
    color: "text-dalam-text-muted",
  },
  set_right_panel_tab: {
    icon: Layout,
    label: "Set Panel Tab",
    color: "text-dalam-text-muted",
  },
  set_bottom_panel_tab: {
    icon: Layout,
    label: "Set Panel Tab",
    color: "text-dalam-text-muted",
  },
  new_terminal: {
    icon: Terminal,
    label: "New Terminal",
    color: "text-dalam-text-muted",
  },
  terminal_write: {
    icon: Terminal,
    label: "Terminal Cmd",
    color: "text-dalam-text-muted",
  },
};

// Cache for tool metadata lookups to avoid recreating objects per render
const _toolMetaCache: Record<
  string,
  { icon: React.ElementType; label: string; color: string }
> = {};
function getToolMeta(name: string) {
  if (_toolMetaCache[name]) return _toolMetaCache[name];
  const meta = TOOL_META[name] ?? {
    icon: Code2,
    label: name,
    color: "text-dalam-text-muted",
  };
  _toolMetaCache[name] = meta;
  return meta;
}

export const ToolCallsList = React.memo(function ToolCallsList({
  toolCalls,
}: {
  toolCalls: ToolCall[];
}) {
  if (!toolCalls.length) return null;
  return (
    <div className="my-1">
      {toolCalls.map((tc) => (
        <ToolCallRow key={tc.id} toolCall={tc} />
      ))}
    </div>
  );
});

// ============================================================================
// Smart tool result display — renders results as nice UI instead of raw JSON
// ============================================================================

function ArgsDisplay({
  toolName,
  args,
}: {
  toolName: string;
  args: Record<string, unknown>;
}) {
  const [expanded, setExpanded] = useState(false);
  const entries = Object.entries(args).filter(([k]) => {
    const lower = k.toLowerCase();
    return (
      !lower.includes("api_key") &&
      !lower.includes("token") &&
      !lower.includes("password") &&
      !lower.includes("secret") &&
      !lower.includes("authorization") &&
      !lower.includes("privatekey") &&
      !lower.includes("accesskey")
    );
  });

  if (entries.length === 0) {
    return (
      <span className="text-dalam-text-muted text-[10px] italic">
        No arguments
      </span>
    );
  }

  // Compact inline display for common tools
  const compact: string | null = (() => {
    if (
      toolName === "read_file" ||
      toolName === "write_file" ||
      toolName === "edit_file" ||
      toolName === "list_dir"
    ) {
      const p = args.path as string;
      if (p) return p;
    }
    if (toolName === "run_command") return `$ ${String(args.command ?? "")}`;
    if (toolName === "grep_file")
      return `${String(args.pattern ?? "")} in ${String(args.path ?? ".")}`;
    if (toolName === "search_files")
      return `"${String(args.pattern ?? "")}" in ${String(args.path ?? ".")}`;
    if (toolName === "fetch_url") return String(args.url ?? "");
    if (toolName === "create_file") return String(args.path ?? "");
    return null;
  })();

  return (
    <div>
      {compact ? (
        <div className="font-mono text-dalam-text-primary bg-dalam-bg-secondary/30 rounded-md px-2 py-1 flex items-center gap-1.5">
          <span className="text-dalam-text-muted">
            {args.mode ? `[${String(args.mode)}]` : ""}
          </span>
          <span className="truncate">{compact}</span>
        </div>
      ) : (
        <button
          onClick={() => setExpanded(!expanded)}
          className="font-mono text-dalam-text-primary bg-dalam-bg-secondary/30 rounded-md px-2 py-1 w-full text-left hover:bg-dalam-bg-hover/30 transition-colors"
        >
          {expanded ? "Hide" : "Show"} {entries.length} params
        </button>
      )}
      {expanded && (
        <pre className="font-mono text-[10px] whitespace-pre-wrap break-words bg-dalam-bg-secondary/30 rounded-md p-2 mt-1 max-h-32 overflow-y-auto scrollbar-thin">
          {entries
            .map(
              ([k, v]) =>
                `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`,
            )
            .join("\n")}
        </pre>
      )}
    </div>
  );
}

function getFileIconForName(name: string) {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (["js", "jsx", "ts", "tsx", "mjs", "cjs"].includes(ext)) return FileCode;
  if (["json", "jsonc"].includes(ext)) return FileJson;
  if (["png", "jpg", "jpeg", "gif", "svg", "ico", "webp"].includes(ext))
    return FileImage;
  if (["md", "txt", "rst", "log"].includes(ext)) return FileText;
  if (["css", "scss", "less", "html", "htm"].includes(ext)) return FileType;
  return File;
}

const ToolResultDisplay = React.memo(function ToolResultDisplay({
  toolName,
  result,
  args,
}: {
  toolName: string;
  result: string;
  args: Record<string, unknown>;
}) {
  const openFile = useWorkspace((s) => s.openFile);

  // list_dir: parse JSON array of { name, path, type }
  if (toolName === "list_dir" && result.startsWith("[")) {
    let items: { name: string; path: string; type: string }[] | null = null;
    try {
      items = JSON.parse(result);
    } catch (e) {
      if (import.meta.env.DEV) console.warn("[ActivityBlocks] Failed to parse list_dir JSON:", e);
    }
    if (items) {
      const dirs = items
        .filter((i) => i.type === "directory")
        .sort((a, b) => a.name.localeCompare(b.name));
      const files = items
        .filter((i) => i.type !== "directory")
        .sort((a, b) => a.name.localeCompare(b.name));
      return (
        <div className="space-y-0.5">
          {dirs.map((item) => (
            <button
              key={item.path}
              className="flex items-center gap-1.5 px-2 py-0.5 rounded text-left hover:bg-dalam-bg-hover/50 transition-colors w-full group"
              onClick={(e) => {
                e.stopPropagation();
                void openFile(item.path);
              }}
            >
              <Folder className="w-3 h-3 text-dalam-accent-primary flex-shrink-0" />
              <span className="text-dalam-text-primary text-[11px] group-hover:text-dalam-accent-primary transition-colors">
                {item.name}/
              </span>
            </button>
          ))}
          {files.map((item) => {
            const Icon = getFileIconForName(item.name);
            return (
              <button
                key={item.path}
                className="flex items-center gap-1.5 px-2 py-0.5 rounded text-left hover:bg-dalam-bg-hover/50 transition-colors w-full group"
                onClick={(e) => {
                  e.stopPropagation();
                  void openFile(item.path);
                }}
              >
                <Icon className="w-3 h-3 text-dalam-text-muted flex-shrink-0" />
                <span className="text-dalam-text-primary text-[11px] group-hover:text-dalam-accent-primary transition-colors">
                  {item.name}
                </span>
              </button>
            );
          })}
          <div className="text-[10px] text-dalam-text-muted pt-0.5">
            {dirs.length} {dirs.length === 1 ? "folder" : "folders"},{" "}
            {files.length} {files.length === 1 ? "file" : "files"}
          </div>
        </div>
      );
    }
  }

  // grep_file / search_files: parse "lineNum: text" or "file:lineNum: text"
  if (
    (toolName === "grep_file" || toolName === "search_files") &&
    !result.startsWith("Error")
  ) {
    const lines = result.split("\n").filter(Boolean);
    if (lines.length > 0 && /^\d+:|^[\w/.-]+:\d+:/.test(lines[0])) {
      const isSearch = toolName === "search_files";
      return (
        <div className="space-y-0.5 max-h-48 overflow-y-auto scrollbar-thin">
          {lines.slice(0, 50).map((line, idx) => {
            if (isSearch) {
              const match = line.match(/^(.+?):(\d+):(.*)$/);
              if (match) {
                const [, filePath, lineNum, text] = match;
                const shortPath = filePath?.split("/").pop() ?? filePath;
                return (
                  <div
                    key={idx}
                    className="flex items-start gap-1 px-2 py-0.5 rounded hover:bg-dalam-bg-hover/30 text-[11px] font-mono"
                  >
                    <button
                      className="text-dalam-accent-primary hover:underline flex-shrink-0 truncate max-w-[120px]"
                      onClick={(e) => {
                        e.stopPropagation();
                        void openFile(filePath);
                      }}
                      title={filePath}
                    >
                      {shortPath}
                    </button>
                    <span className="text-dalam-text-muted flex-shrink-0">
                      :{lineNum}
                    </span>
                    <span className="text-dalam-text-primary truncate">
                      {text}
                    </span>
                  </div>
                );
              }
            }
            const match = line.match(/^(\d+):(.*)$/);
            if (match) {
              const [, lineNum, text] = match;
              const filePath = args.path as string;
              return (
                <button
                  key={idx}
                  className="flex items-start gap-1 px-2 py-0.5 rounded hover:bg-dalam-bg-hover/30 text-[11px] font-mono w-full text-left"
                  onClick={(e) => {
                    e.stopPropagation();
                    void openFile(filePath);
                  }}
                >
                  <span className="text-dalam-text-muted flex-shrink-0 w-8 text-right">
                    {lineNum}:
                  </span>
                  <span className="text-dalam-text-primary truncate">
                    {text}
                  </span>
                </button>
              );
            }
            return (
              <div
                key={idx}
                className="px-2 py-0.5 text-[11px] font-mono text-dalam-text-primary truncate"
              >
                {line}
              </div>
            );
          })}
          {lines.length > 50 && (
            <div className="text-[10px] text-dalam-text-muted px-2 pt-0.5">
              Showing first 50 of {lines.length} matches
            </div>
          )}
        </div>
      );
    }
  }

  // read_file: show truncated code preview
  if (
    toolName === "read_file" &&
    !result.startsWith("Error") &&
    !result.startsWith("[")
  ) {
    const lines = result.split("\n");
    const preview = lines.slice(0, 15).join("\n");
    const totalLines = lines.length;
    return (
      <div>
        <pre className="font-mono text-[11px] text-dalam-text-primary bg-dalam-bg-secondary/30 rounded-md p-2 max-h-32 overflow-y-auto scrollbar-thin whitespace-pre-wrap break-words">
          {preview}
          {totalLines > 15 && (
            <span className="text-dalam-text-muted">
              {"\n"}... ({totalLines - 15} more lines)
            </span>
          )}
        </pre>
        {typeof args.path === "string" && args.path && (
          <button
            className="text-[10px] text-dalam-accent-primary hover:underline mt-1"
            onClick={(e) => {
              e.stopPropagation();
              void openFile(args.path as string);
            }}
          >
            Open file
          </button>
        )}
      </div>
    );
  }

  // Default: raw display with truncation
  const isLong = result.length > 500;
  const display = isLong ? result.slice(0, 500) + "..." : result;

  // Question tool: show answer with accent styling
  if (toolName === "question") {
    const answerText = result.replace(/^User answered:\s*/, "");
    return (
      <div className="flex items-center gap-2 px-2 py-1 rounded-md bg-dalam-bg-secondary/30">
        <span className="text-[10px] text-dalam-text-muted">Answer:</span>
        <span className="text-[11px] text-dalam-accent-primary font-medium">
          {answerText}
        </span>
      </div>
    );
  }

  return (
    <pre className="font-mono text-[11px] text-dalam-text-primary whitespace-pre-wrap break-words bg-dalam-bg-secondary/30 rounded-md p-2 max-h-40 overflow-y-auto scrollbar-thin">
      {display}
    </pre>
  );
});

const ToolCallRow = React.memo(function ToolCallRow({
  toolCall,
}: {
  toolCall: ToolCall;
}) {
  const resolveToolApproval = useChat((s) => s.resolveToolApproval);
  const openDiff = useDiffView((s) => s.openFile);
  const needsApproval = toolCall.status === "awaiting-approval";
  const [resolving, setResolving] = useState(false);

  const meta = getToolMeta(toolCall.name);
  const args = toolCall.args ?? {};

  const target = (() => {
    if (typeof args.path === "string") return args.path;
    if (typeof args.command === "string") return `$ ${args.command}`;
    if (typeof args.query === "string") return args.query;
    if (typeof args.pattern === "string") return args.pattern;
    if (typeof args.skill === "string") return args.skill;
    if (typeof args.url === "string") return args.url;
    if (typeof args.dir === "string") return args.dir;
    if (typeof args.question === "string") return args.question;
    return "";
  })();

  const isEdit =
    toolCall.name === "edit_file" ||
    toolCall.name === "edit" ||
    toolCall.name === "write_file" ||
    toolCall.name === "write";

  // Status as a small inline word rather than a colored badge — keeps the row
  // visually quiet.
  const isFailed = toolCall.status === "failed";
  const statusText = (() => {
    switch (toolCall.status) {
      case "completed":
        return "done";
      case "failed":
        return "failed";
      case "awaiting-approval":
        return "awaiting approval";
      case "running":
      case "pending":
      default:
        return "running";
    }
  })();

  return (
    <ActivityRow
      className={isFailed ? "border-l-2 border-red-500/50" : undefined}
      label={
        <>
          {meta.label}
          {target ? (
            <span className="opacity-70 ml-1.5 font-mono">{target}</span>
          ) : null}
        </>
      }
      meta={
        <span className="flex items-center gap-1.5 text-[10px] opacity-70">
          {toolCall.status === "running" || toolCall.status === "pending" ? (
            <Loader2 className="w-2.5 h-2.5 animate-spin" />
          ) : toolCall.status === "awaiting-approval" ? (
            <Shield className="w-2.5 h-2.5 text-yellow-500" />
          ) : isFailed ? (
            <span className="text-red-400 font-medium">failed</span>
          ) : null}
          {!isFailed && <span>{statusText}</span>}
          {isEdit &&
            toolCall.status === "completed" &&
            typeof args.path === "string" && (
              <>
                <span>·</span>
                <button
                  className="text-[10px] text-dalam-accent-primary hover:underline"
                  onClick={(e) => {
                    e.stopPropagation();
                    const isWrite =
                      toolCall.name === "write_file" ||
                      toolCall.name === "write";
                    // Use "created" only if old content was empty (new file)
                    const isNewFile =
                      isWrite &&
                      (!toolCall.diff?.oldContent ||
                        toolCall.diff.oldContent === "");
                    openDiff({
                      path: args.path as string,
                      action: isNewFile ? "created" : "modified",
                      additions:
                        toolCall.diff?.hunks?.reduce(
                          (n: number, h: { newLines: number }) =>
                            n + h.newLines,
                          0,
                        ) ?? 0,
                      deletions:
                        toolCall.diff?.hunks?.reduce(
                          (n: number, h: { oldLines: number }) =>
                            n + h.oldLines,
                          0,
                        ) ?? 0,
                    });
                  }}
                >
                  Open diff
                </button>
              </>
            )}
        </span>
      }
    >
      <div className="space-y-2 text-[11px]">
        <div>
          <div className="text-[10px] uppercase tracking-wider opacity-60 mb-0.5">
            Arguments
          </div>
          <ArgsDisplay toolName={toolCall.name} args={args} />
        </div>
        {toolCall.result && (
          <div>
            <div className="text-[10px] uppercase tracking-wider opacity-60 mb-0.5">
              Result
            </div>
            <ToolResultDisplay
              toolName={toolCall.name}
              result={toolCall.result}
              args={args}
            />
          </div>
        )}
        {needsApproval && (
          <div className="flex items-center gap-1.5 pt-1">
            <button
              disabled={resolving}
              onClick={async () => {
                setResolving(true);
                try {
                  await resolveToolApproval(
                    toolCall.id,
                    "approved",
                    "Approved by user",
                  );
                } finally {
                  setResolving(false);
                }
              }}
              className="flex items-center gap-1 px-2 py-1 bg-dalam-git-added/20 hover:bg-dalam-git-added/30 text-dalam-git-added text-xs rounded transition-colors disabled:opacity-50"
            >
              <Check className="w-3 h-3" />
              {resolving ? "Approving..." : "Approve"}
            </button>
            <button
              disabled={resolving}
              onClick={async () => {
                setResolving(true);
                try {
                  await resolveToolApproval(
                    toolCall.id,
                    "denied",
                    "Denied by user",
                  );
                } finally {
                  setResolving(false);
                }
              }}
              className="flex items-center gap-1 px-2 py-1 bg-dalam-git-deleted/20 hover:bg-dalam-git-deleted/30 text-dalam-git-deleted text-xs rounded transition-colors disabled:opacity-50"
            >
              <X className="w-3 h-3" />
              {resolving ? "Denying..." : "Deny"}
            </button>
          </div>
        )}
      </div>
    </ActivityRow>
  );
});

// ============================================================================
// ChangesCard — file changes with expandable inline diffs
// ============================================================================

export const ChangesCard = React.memo(function ChangesCard({
  changes,
}: {
  changes: FileChange[];
}) {
  const openDiff = useDiffView((s) => s.openFile);
  const totalAdded = changes.reduce((s, c) => s + c.additions, 0);
  const totalRemoved = changes.reduce((s, c) => s + c.deletions, 0);

  return (
    <ActivityRow
      label={
        <>
          {changes.length} {changes.length === 1 ? "file" : "files"} changed
        </>
      }
      meta={
        <span className="font-mono text-[11px]">
          <span className="text-dalam-git-added">
            +{totalAdded.toLocaleString()}
          </span>{" "}
          <span className="text-dalam-git-deleted">
            −{totalRemoved.toLocaleString()}
          </span>
        </span>
      }
    >
      <div className="space-y-1 max-h-96 overflow-y-auto scrollbar-thin">
        {changes.map((c) => (
          <FileChangeRow
            key={c.path}
            change={c}
            onOpenDiff={() => openDiff(c)}
          />
        ))}
      </div>
    </ActivityRow>
  );
});

function FileChangeRow({
  change,
  onOpenDiff,
}: {
  change: FileChange;
  onOpenDiff: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const fileName = basename(change.path);
  const dirPath = dirname(change.path);
  const actionIcon =
    change.action === "created" ? "+" : change.action === "deleted" ? "−" : "✎";
  const actionColor =
    change.action === "created"
      ? "text-dalam-git-added"
      : change.action === "deleted"
        ? "text-dalam-git-deleted"
        : "text-dalam-text-muted";

  return (
    <div className="rounded-lg border border-dalam-border-primary/40 overflow-hidden">
      {/* File header — clickable to expand */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-dalam-bg-hover/50 transition-colors text-left"
      >
        <span className={`text-[11px] flex-shrink-0 ${actionColor}`}>
          {actionIcon}
        </span>
        <FileCode className="w-3.5 h-3.5 text-dalam-accent-primary flex-shrink-0" />
        <span className="text-[12px] font-medium flex-shrink-0">
          {fileName}
        </span>
        <span className="opacity-60 truncate font-mono flex-1 min-w-0 text-[11px]">
          {dirPath}
        </span>
        <span className="text-[11px] font-mono flex-shrink-0">
          {change.additions > 0 && (
            <span className="text-dalam-git-added">+{change.additions}</span>
          )}
          {change.additions > 0 && change.deletions > 0 && " "}
          {change.deletions > 0 && (
            <span className="text-dalam-git-deleted">−{change.deletions}</span>
          )}
        </span>
        <ChevronDown
          className={`w-3 h-3 text-dalam-text-muted transition-transform ${expanded ? "rotate-180" : ""}`}
        />
      </button>

      {/* Expandable diff preview */}
      {expanded && (
        <div className="border-t border-dalam-border-primary/30 bg-dalam-bg-primary/50">
          {change.preview ? (
            <pre className="text-[11px] font-mono leading-relaxed p-3 overflow-x-auto max-h-60 overflow-y-auto scrollbar-thin">
              {change.preview.split("\n").map((line, i) => {
                const isAdd = line.startsWith("+");
                const isRemove = line.startsWith("-");
                return (
                  <div
                    key={i}
                    className={`flex ${isAdd ? "bg-dalam-git-added/10" : isRemove ? "bg-dalam-git-deleted/10" : ""}`}
                  >
                    <span className="w-8 text-right pr-2 text-dalam-text-muted/40 select-none flex-shrink-0">
                      {i + 1}
                    </span>
                    <span
                      className={`flex-1 whitespace-pre ${isAdd ? "text-dalam-git-added" : isRemove ? "text-dalam-git-deleted" : "text-dalam-text-secondary"}`}
                    >
                      {line || "\u00A0"}
                    </span>
                  </div>
                );
              })}
            </pre>
          ) : (
            <div className="p-3 text-[11px] text-dalam-text-muted">
              <span
                className={
                  change.action === "created"
                    ? "text-dalam-git-added"
                    : change.action === "deleted"
                      ? "text-dalam-git-deleted"
                      : ""
                }
              >
                {change.action === "created"
                  ? "New file created"
                  : change.action === "deleted"
                    ? "File deleted"
                    : "File modified"}
              </span>{" "}
              — {change.additions} additions, {change.deletions} deletions
              <button
                onClick={onOpenDiff}
                className="ml-2 text-dalam-accent-primary hover:underline"
              >
                View full diff
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// TodoBlock — todo list checklist
// ============================================================================

export const TodoBlock = React.memo(function TodoBlock({
  todos,
}: {
  todos: TodoItem[];
}) {
  if (!todos.length) return null;
  const completed = todos.filter((t) => t.status === "completed").length;
  const total = todos.length;
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;

  return (
    <ActivityRow
      label="Progress"
      meta={
        <span className="flex items-center gap-2">
          <span className="tabular-nums">
            {completed}/{total}
          </span>
          <span className="h-1 w-16 bg-dalam-bg-secondary/60 rounded-full overflow-hidden flex-shrink-0">
            <span
              className="block h-full bg-dalam-accent-primary"
              style={{ width: `${pct}%` }}
            />
          </span>
        </span>
      }
      defaultOpen
    >
      <ul className="space-y-0.5">
        {todos.map((t) => {
          const done = t.status === "completed";
          const inFlight = t.status === "in_progress";
          const failed = t.status === "failed";
          return (
            <li key={t.id} className="flex items-start gap-1.5 text-[12px]">
              {done ? (
                <CheckCircle2 className="w-3 h-3 text-dalam-git-added flex-shrink-0 mt-0.5" />
              ) : failed ? (
                <X className="w-3 h-3 text-dalam-git-deleted flex-shrink-0 mt-0.5" />
              ) : inFlight ? (
                <Loader2 className="w-3 h-3 text-dalam-accent-primary animate-spin flex-shrink-0 mt-0.5" />
              ) : (
                <span className="w-3 h-3 rounded-full border border-dalam-text-muted/40 flex-shrink-0 mt-0.5" />
              )}
              <span
                className={
                  done
                    ? "line-through opacity-70"
                    : failed
                      ? "line-through opacity-50"
                      : ""
                }
              >
                {t.content}
              </span>
            </li>
          );
        })}
      </ul>
    </ActivityRow>
  );
});

// ============================================================================
// TaskPlanBlock — live-updating task plan checklist
// ============================================================================

export type TaskPlanItem = {
  id: string;
  title: string;
  status: "pending" | "running" | "completed" | "failed";
};

export const TaskPlanBlock = React.memo(function TaskPlanBlock({
  tasks,
  summary,
}: {
  tasks: TaskPlanItem[];
  summary?: string | null;
}) {
  const completed = tasks.filter((t) => t.status === "completed").length;
  const total = tasks.length;
  const current = tasks.find((t) => t.status === "running");

  return (
    <ActivityRow
      label={
        <span className="flex items-center gap-2">
          <span className="font-medium">Todo</span>
          {current && (
            <span className="text-dalam-accent-primary/80 text-[11px] italic truncate max-w-[300px]">
              {current.title}
            </span>
          )}
        </span>
      }
      meta={
        <span className="flex items-center gap-1.5 text-[10px] tabular-nums">
          <span>
            {completed}/{total}
          </span>
          {summary && completed === total && (
            <span className="text-dalam-git-added text-[10px]">{summary}</span>
          )}
        </span>
      }
      defaultOpen
    >
      <ul className="space-y-1">
        {tasks.map((task) => {
          const isDone = task.status === "completed";
          const isRunning = task.status === "running";
          const isFailed = task.status === "failed";
          return (
            <li key={task.id} className="flex items-start gap-2 text-[12px]">
              {isDone ? (
                <CheckCircle2 className="w-3.5 h-3.5 text-dalam-git-added flex-shrink-0 mt-0.5" />
              ) : isRunning ? (
                <span className="w-3.5 h-3.5 flex items-center justify-center flex-shrink-0 mt-0.5">
                  <span className="text-dalam-accent-primary text-sm">→</span>
                </span>
              ) : isFailed ? (
                <X className="w-3.5 h-3.5 text-dalam-git-deleted flex-shrink-0 mt-0.5" />
              ) : (
                <span className="w-3.5 h-3.5 rounded-full border border-dalam-text-muted/40 flex-shrink-0 mt-0.5" />
              )}
              <span
                className={`${isDone ? "line-through opacity-70" : ""} ${isFailed ? "text-dalam-git-deleted" : ""}`}
              >
                {task.title}
              </span>
            </li>
          );
        })}
      </ul>
    </ActivityRow>
  );
});

// ============================================================================
// SubAgentBlock — collapsible accordion for spawned sub-agents
// ============================================================================

export const SubAgentBlock = React.memo(function SubAgentBlock({
  agent,
}: {
  agent: SubAgentState;
}) {
  const [open, setOpen] = useState(false);
  const isRunning = agent.status === "running";
  const isCompleted = agent.status === "completed";

  const statusIcon = isRunning ? (
    <Loader2 className="w-3.5 h-3.5 text-dalam-accent-primary animate-spin flex-shrink-0" />
  ) : isCompleted ? (
    <CheckCircle2 className="w-3.5 h-3.5 text-dalam-git-added flex-shrink-0" />
  ) : (
    <X className="w-3.5 h-3.5 text-dalam-git-deleted flex-shrink-0" />
  );

  const typeLabel = agent.subagentType === "explore" ? "Explore" : "General";
  const elapsed = agent.completedAt
    ? ((agent.completedAt - agent.startedAt) / 1000).toFixed(1) + "s"
    : isRunning
      ? "running..."
      : "";

  return (
    <div className="my-1 border border-dalam-border-primary/30 rounded-md overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 w-full text-left px-2.5 py-1.5 text-[12px] hover:bg-dalam-bg-secondary/40 transition-colors"
      >
        {statusIcon}
        <ChevronDown
          className={`w-3 h-3 text-dalam-text-muted/70 transition-transform flex-shrink-0 ${open ? "" : "-rotate-90"}`}
        />
        <span className="font-mono text-dalam-accent-primary font-medium">
          task
        </span>
        <span className="text-dalam-text-secondary truncate flex-1">
          {agent.description}
        </span>
        <span className="text-[10px] text-dalam-text-muted/60 flex-shrink-0">
          {typeLabel}
          {elapsed ? ` · ${elapsed}` : ""}
        </span>
      </button>
      {open && (
        <div className="px-2.5 pb-2 border-t border-dalam-border-primary/20">
          <div className="mt-1.5 mb-1">
            <span className="text-[10px] text-dalam-text-muted/50 uppercase tracking-wider">
              Prompt
            </span>
            <p className="text-[11px] text-dalam-text-secondary/80 mt-0.5 whitespace-pre-wrap break-words">
              {agent.prompt}
            </p>
          </div>
          {agent.toolCalls.length > 0 && (
            <div className="mt-1.5">
              <span className="text-[10px] text-dalam-text-muted/50 uppercase tracking-wider">
                Tools used ({agent.toolCalls.length})
              </span>
              <div className="mt-0.5 space-y-0.5">
                {agent.toolCalls.map((tc) => (
                  <div
                    key={tc.id}
                    className="flex items-center gap-1.5 text-[11px]"
                  >
                    {tc.status === "completed" ? (
                      <CheckCircle2 className="w-3 h-3 text-dalam-git-added flex-shrink-0" />
                    ) : tc.status === "failed" ? (
                      <X className="w-3 h-3 text-dalam-git-deleted flex-shrink-0" />
                    ) : (
                      <Loader2 className="w-3 h-3 text-dalam-accent-primary animate-spin flex-shrink-0" />
                    )}
                    <span className="font-mono text-dalam-text-secondary/80">
                      {tc.name}
                    </span>
                    {tc.args && typeof tc.args === "object" && (
                      <span className="text-dalam-text-muted/50 truncate max-w-[200px]">
                        {Object.values(tc.args).slice(0, 2).join(", ")}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
          {agent.content && (
            <div className="mt-1.5">
              <span className="text-[10px] text-dalam-text-muted/50 uppercase tracking-wider">
                Output
              </span>
              <pre className="font-mono text-[10px] bg-dalam-bg-secondary/30 rounded p-1.5 max-h-40 overflow-y-auto scrollbar-thin whitespace-pre-wrap break-words mt-0.5">
                {agent.content}
              </pre>
            </div>
          )}
          {agent.error && (
            <div className="mt-1.5">
              <span className="text-[10px] text-dalam-git-deleted uppercase tracking-wider">
                Error
              </span>
              <p className="text-[11px] text-dalam-git-deleted/80 mt-0.5 whitespace-pre-wrap break-words">
                {agent.error}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
});

// ============================================================================
// SubAgentList — renders all active/recent sub-agents as a group
// ============================================================================

export const SubAgentList = React.memo(function SubAgentList({
  agents,
}: {
  agents: SubAgentState[];
}) {
  if (agents.length === 0) return null;
  return (
    <div className="my-1">
      {agents.map((agent) => (
        <SubAgentBlock key={agent.id} agent={agent} />
      ))}
    </div>
  );
});

// ============================================================================
// QuestionAccordion — shows questions asked by the agent and user's answers
// ============================================================================

export const QuestionAccordion = React.memo(function QuestionAccordion({
  questions,
}: {
  questions: {
    id: string;
    question: string;
    options: string[];
    answer: string;
    timestamp: number;
  }[];
}) {
  if (!questions || questions.length === 0) return null;
  return (
    <div className="my-1 space-y-1">
      {questions.map((q) => (
        <QuestionItem key={q.id} question={q} />
      ))}
    </div>
  );
});

const QuestionItem = React.memo(function QuestionItem({
  question,
}: {
  question: {
    id: string;
    question: string;
    options: string[];
    answer: string;
    timestamp: number;
  };
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="rounded-lg border border-dalam-border-primary/40 overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 hover:bg-dalam-bg-hover/50 transition-colors text-left"
      >
        <span className="text-dalam-accent-primary text-sm">?</span>
        <span className="text-[12px] text-dalam-text-primary flex-1 truncate">
          {question.question}
        </span>
        <span className="text-[10px] text-dalam-accent-primary bg-dalam-accent-subtle px-1.5 py-0.5 rounded">
          {question.answer}
        </span>
        <ChevronDown
          className={`w-3 h-3 text-dalam-text-muted transition-transform ${expanded ? "rotate-180" : ""}`}
        />
      </button>
      {expanded && (
        <div className="border-t border-dalam-border-primary/30 bg-dalam-bg-primary/50 px-3 py-2 space-y-2">
          {question.options.length > 0 && (
            <div>
              <div className="text-[10px] text-dalam-text-muted mb-1 font-medium">Options:</div>
              <div className="flex flex-wrap gap-1.5">
                {question.options.map((opt) => {
                  const isSelected = opt === question.answer;
                  return (
                    <button
                      key={opt}
                      type="button"
                      onClick={(e) => { e.stopPropagation(); void navigator.clipboard.writeText(opt); }}
                      className={`flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-md border transition-colors cursor-pointer ${
                        isSelected
                          ? "bg-dalam-accent-primary/15 border-dalam-accent-primary/40 text-dalam-accent-primary font-medium"
                          : "bg-dalam-bg-secondary border-dalam-border-primary/30 text-dalam-text-muted hover:border-dalam-border-primary/60"
                      }`}
                      title={isSelected ? "Selected answer — click to copy" : "Click to copy"}
                    >
                      {isSelected && <Check className="w-3 h-3 flex-shrink-0" />}
                      {opt}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          <div className="text-[11px]">
            <span className="font-medium text-dalam-text-primary">Answer:</span>{" "}
            <span className="text-dalam-accent-primary">{question.answer}</span>
          </div>
        </div>
      )}
    </div>
  );
});
