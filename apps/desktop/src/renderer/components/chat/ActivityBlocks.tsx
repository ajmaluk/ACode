/**
 * ACode chat activity blocks.
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
import { useState } from "react";
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
} from "lucide-react";
import type {
  FileChange,
  SkillInfo,
  TodoItem,
  ToolCall,
} from "@acode/shared-types";
import { useChat, useDiffView, useWorkspace, BUNDLED_SKILLS } from "@/store/useAppStore";
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
}: {
  icon?: React.ReactNode;
  iconClass?: string;
  label: React.ReactNode;
  meta?: React.ReactNode;
  defaultOpen?: boolean;
  children?: React.ReactNode;
  trailing?: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const hasDetail = !!children;
  return (
    <div className="my-0.5">
      <button
        type="button"
        onClick={() => hasDetail && setOpen((o) => !o)}
        className={`group flex items-center gap-1.5 text-left text-[13px] leading-relaxed w-full opacity-60 hover:opacity-100 transition-opacity ${
          hasDetail ? "cursor-pointer" : "cursor-default"
        } text-acode-text-secondary`}
        title={hasDetail ? (open ? "Click to collapse" : "Click to expand") : undefined}
      >
        {hasDetail ? (
          <ChevronDown
            className={`w-3 h-3 text-acode-text-muted/70 transition-transform flex-shrink-0 ${open ? "" : "-rotate-90"}`}
          />
        ) : (
          <span className="w-3 h-3 flex-shrink-0" />
        )}
        {icon && (
          <span className={`flex-shrink-0 inline-flex items-center opacity-80 ${iconClass ?? ""}`}>{icon}</span>
        )}
        <span className="truncate">{label}</span>
        {meta && <span className="text-acode-text-muted/80 text-[11px] truncate">{meta}</span>}
        {trailing && <span className="ml-auto flex-shrink-0 flex items-center gap-1 opacity-80">{trailing}</span>}
      </button>
      {hasDetail && open && (
        <div className="ml-3.5 mt-1 pl-3 border-l border-acode-border-primary/60 text-[12px] text-acode-text-secondary/80 leading-relaxed">
          {children}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// ThinkingBlock — model's step-by-step reasoning
// ============================================================================

export function ThinkingBlock({ content, streaming }: { content: string; streaming?: boolean }) {
  return (
    <ActivityRow
      label={
        <span className="italic">
          {streaming ? "Thinking…" : "Reasoned step-by-step"}
        </span>
      }
      meta={streaming ? undefined : `${content.length} chars`}
      defaultOpen={false}
    >
      <pre className="whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed text-acode-text-secondary/90">
        {content}
        {streaming && <span className="inline-block w-1.5 h-3 bg-acode-accent-primary ml-0.5 animate-pulse-soft align-middle" />}
      </pre>
    </ActivityRow>
  );
}

// ============================================================================
// ExploreBlock — file tree / grep findings
// ============================================================================

export type ExploreResult = {
  query: string;
  kind?: "files" | "grep" | "symbols" | "definition";
  matches: { path: string; line?: number; preview?: string }[];
};

export function ExploreBlock({ result }: { result: ExploreResult }) {
  return (
    <ActivityRow
      label={<>Explored {result.kind ? <span className="text-acode-text-secondary/70">{result.kind}</span> : "codebase"}</>}
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
            className="flex items-center gap-2 hover:opacity-100 opacity-90 font-mono text-[11px] cursor-pointer hover:bg-acode-bg-hover rounded px-1 py-0.5 transition-colors"
            onClick={() => {
              useWorkspace.getState().openFile(m.path);
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
              <span className="truncate max-w-[260px] opacity-70">{m.preview}</span>
            )}
          </li>
        ))}
      </ul>
    </ActivityRow>
  );
}

// ============================================================================
// ReadBlock — file content the agent looked at
// ============================================================================

export function ReadBlock({ path, content, lineRange }: { path: string; content: string; lineRange?: [number, number] }) {
  const fileName = basename(path);
  const lines = content.split("\n");
  const start = lineRange?.[0] ?? 1;
  const range = lineRange ? `${lineRange[0]}–${lineRange[1]}` : `${lines.length} lines`;
  return (
    <ActivityRow
      label={<>Read <span className="font-mono">{fileName}</span></>}
      meta={path}
      trailing={<span className="text-[10px] tabular-nums">{range}</span>}
    >
      <pre className="text-[11px] font-mono leading-relaxed bg-acode-bg-secondary/30 rounded-md p-2 max-h-80 overflow-y-auto scrollbar-thin">
        {lines.map((line, i) => {
          const lineNum = start + i;
          return (
            <div key={i} className="flex hover:bg-acode-bg-hover/30">
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
}

// ============================================================================
// SkillBlock — $skill invocation
// ============================================================================

export function SkillBlock({ name, args, content, status }: { name: string; args?: string; content?: string; status?: "running" | "completed" | "failed" }) {
  const skill = BUNDLED_SKILLS.find((s: SkillInfo) => s.name === name);
  const statusIcon = status === "running" ? <span className="w-1.5 h-1.5 rounded-full bg-acode-accent-primary animate-pulse" />
    : status === "failed" ? <span className="w-1.5 h-1.5 rounded-full bg-acode-git-deleted" />
    : null;
  return (
    <ActivityRow
      label={<>Invoked <span className="font-mono">${name}</span>{args ? <span className="opacity-70 ml-1.5 font-mono">{args}</span> : null}</>}
      trailing={<>{statusIcon}{skill ? <span className="text-[10px] italic opacity-70 truncate max-w-[200px]">{skill.description}</span> : null}</>}
    >
      {content && (
        <pre className="font-mono text-[11px] bg-acode-bg-secondary/30 rounded-md p-2 max-h-60 overflow-y-auto scrollbar-thin whitespace-pre-wrap break-words">
          {content}
        </pre>
      )}
    </ActivityRow>
  );
}

// ============================================================================
// PlanBlock — plan from plan mode
// ============================================================================

export function PlanBlock({ plan }: { plan: string }) {
  return (
    <ActivityRow
      label="Implementation plan"
      meta="ready to review"
      defaultOpen
    >
      <pre className="whitespace-pre-wrap break-words leading-relaxed text-acode-text-primary">
        {plan}
      </pre>
    </ActivityRow>
  );
}

// ============================================================================
// BashActivityBlock — terminal-like display
// ============================================================================

export function BashActivityBlock({ command, result }: { command: string; result: string }) {
  return (
    <ActivityRow
      label={<>Ran <span className="font-mono">$ {command}</span></>}
      defaultOpen={false}
    >
      {result ? (
        <pre className="font-mono text-[11px] bg-acode-bg-secondary/30 rounded-md p-2 max-h-60 overflow-y-auto scrollbar-thin whitespace-pre-wrap break-words">
          {result}
        </pre>
      ) : (
        <span className="italic opacity-70">no output</span>
      )}
    </ActivityRow>
  );
}

// ============================================================================
// ToolCallsList — list of tool calls
// ============================================================================

const TOOL_META: Record<string, { icon: React.ElementType; label: string; color: string }> = {
  read_file: { icon: FileText, label: "Read", color: "text-acode-text-muted" },
  read: { icon: FileText, label: "Read", color: "text-acode-text-muted" },
  edit_file: { icon: Code2, label: "Edited", color: "text-acode-text-muted" },
  edit: { icon: Code2, label: "Edited", color: "text-acode-text-muted" },
  write_file: { icon: FilePlus, label: "Wrote", color: "text-acode-text-muted" },
  write: { icon: FilePlus, label: "Wrote", color: "text-acode-text-muted" },
  create_file: { icon: FilePlus, label: "Created", color: "text-acode-text-muted" },
  bash: { icon: Terminal, label: "Ran", color: "text-acode-text-muted" },
  shell: { icon: Terminal, label: "Ran", color: "text-acode-text-muted" },
  execute: { icon: Terminal, label: "Ran", color: "text-acode-text-muted" },
  run_command: { icon: Terminal, label: "Ran", color: "text-acode-text-muted" },
  file_search: { icon: Search, label: "Searched", color: "text-acode-text-muted" },
  search_files: { icon: Search, label: "Searched", color: "text-acode-text-muted" },
  grep: { icon: Search, label: "Searched", color: "text-acode-text-muted" },
  grep_file: { icon: Search, label: "Searched", color: "text-acode-text-muted" },
  list_dir: { icon: FileText, label: "Listed", color: "text-acode-text-muted" },
  webfetch: { icon: Code2, label: "Fetched", color: "text-acode-text-muted" },
  websearch: { icon: Search, label: "Searched", color: "text-acode-text-muted" },
  git_status: { icon: Code2, label: "Git Status", color: "text-acode-text-muted" },
  git_commit: { icon: Code2, label: "Git Commit", color: "text-acode-text-muted" },
  git_log: { icon: Code2, label: "Git Log", color: "text-acode-text-muted" },
  clipboard_read: { icon: FileText, label: "Clipboard", color: "text-acode-text-muted" },
  clipboard_write: { icon: FileText, label: "Clipboard", color: "text-acode-text-muted" },
  notify: { icon: Shield, label: "Notify", color: "text-acode-text-muted" },
  system_info: { icon: Code2, label: "System Info", color: "text-acode-text-muted" },
  open_url: { icon: Code2, label: "Open URL", color: "text-acode-text-muted" },
  launch_app: { icon: Terminal, label: "Launched", color: "text-acode-text-muted" },
  reveal_in_finder: { icon: FileText, label: "Revealed", color: "text-acode-text-muted" },
  memory_save: { icon: Shield, label: "Memory Save", color: "text-acode-text-muted" },
  memory_search: { icon: Search, label: "Memory Search", color: "text-acode-text-muted" },
  memory_delete: { icon: X, label: "Memory Delete", color: "text-acode-text-muted" },
  memory_stats: { icon: Code2, label: "Memory Stats", color: "text-acode-text-muted" },
  memory_maintain: { icon: Shield, label: "Memory Maintain", color: "text-acode-text-muted" },
  memory_extract: { icon: Code2, label: "Memory Extract", color: "text-acode-text-muted" },
  memory_export: { icon: Code2, label: "Memory Export", color: "text-acode-text-muted" },
  memory_import: { icon: Code2, label: "Memory Import", color: "text-acode-text-muted" },
  get_env: { icon: Code2, label: "Get Env", color: "text-acode-text-muted" },
  get_screen_info: { icon: Code2, label: "Screen Info", color: "text-acode-text-muted" },
  list_processes: { icon: Terminal, label: "Processes", color: "text-acode-text-muted" },
  kill_process: { icon: X, label: "Kill Process", color: "text-acode-text-muted" },
  get_disk_space: { icon: Code2, label: "Disk Space", color: "text-acode-text-muted" },
};

function getToolMeta(name: string) {
  return TOOL_META[name] ?? { icon: Code2, label: name, color: "text-acode-text-muted" };
}

export function ToolCallsList({ toolCalls }: { toolCalls: ToolCall[] }) {
  if (!toolCalls.length) return null;
  return (
    <div className="my-1">
      {toolCalls.map((tc) => (
        <ToolCallRow key={tc.id} toolCall={tc} />
      ))}
    </div>
  );
}

function ToolCallRow({ toolCall }: { toolCall: ToolCall }) {
  const [open, setOpen] = useState(false);
  const { resolveToolApproval } = useChat();
  const openDiff = useDiffView((s) => s.openFile);
  const needsApproval = toolCall.status === "awaiting-approval";

  const meta = getToolMeta(toolCall.name);

  const target = (() => {
    if (typeof toolCall.args.path === "string") return toolCall.args.path;
    if (typeof toolCall.args.command === "string") return `$ ${toolCall.args.command}`;
    if (typeof toolCall.args.query === "string") return toolCall.args.query;
    if (typeof toolCall.args.pattern === "string") return toolCall.args.pattern;
    if (typeof toolCall.args.skill === "string") return toolCall.args.skill;
    if (typeof toolCall.args.url === "string") return toolCall.args.url;
    if (typeof toolCall.args.dir === "string") return toolCall.args.dir;
    return "";
  })();

  const isEdit = toolCall.name === "edit_file" || toolCall.name === "edit" || toolCall.name === "write_file" || toolCall.name === "write";

  // Status as a small inline word rather than a colored badge — keeps the row
  // visually quiet.
  const statusText = (() => {
    switch (toolCall.status) {
      case "completed":         return "done";
      case "failed":            return "failed";
      case "awaiting-approval": return "awaiting approval";
      case "running":
      case "pending":
      default:                  return "running";
    }
  })();

  return (
    <ActivityRow
      label={<>{meta.label}{target ? <span className="opacity-70 ml-1.5 font-mono">{target}</span> : null}</>}
      meta={
        <span className="flex items-center gap-1.5 text-[10px] opacity-70">
          {toolCall.status === "running" || toolCall.status === "pending" ? (
            <Loader2 className="w-2.5 h-2.5 animate-spin" />
          ) : toolCall.status === "awaiting-approval" ? (
            <Shield className="w-2.5 h-2.5 text-amber-400" />
          ) : null}
          <span>{statusText}</span>
          {isEdit && toolCall.status === "completed" && typeof toolCall.args.path === "string" && (
            <>
              <span>·</span>
              <button
                className="text-acode-accent-primary hover:underline"
                onClick={(e) => {
                  e.stopPropagation();
                  const isWrite = toolCall.name === "write_file" || toolCall.name === "write";
                  openDiff({
                    path: toolCall.args.path as string,
                    action: isWrite ? "created" : "modified",
                    additions: toolCall.diff?.hunks.reduce((n, h) => n + h.newLines, 0) ?? 0,
                    deletions: toolCall.diff?.hunks.reduce((n, h) => n + h.oldLines, 0) ?? 0,
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
          <div className="text-[10px] uppercase tracking-wider opacity-60 mb-0.5">Arguments</div>
          <pre className="font-mono whitespace-pre-wrap break-words bg-acode-bg-secondary/30 rounded-md p-2">
            {JSON.stringify(toolCall.args, null, 2)}
          </pre>
        </div>
        {toolCall.result && (
          <div>
            <div className="text-[10px] uppercase tracking-wider opacity-60 mb-0.5">Result</div>
            <pre className="font-mono whitespace-pre-wrap break-words max-h-40 overflow-y-auto scrollbar-thin bg-acode-bg-secondary/30 rounded-md p-2">
              {toolCall.result}
            </pre>
          </div>
        )}
        {needsApproval && (
          <div className="flex items-center gap-1.5 pt-1">
            <button
              onClick={() => resolveToolApproval(toolCall.id, "approved", "Approved by user")}
              className="flex items-center gap-1 px-2 py-1 bg-acode-git-added/20 hover:bg-acode-git-added/30 text-acode-git-added text-xs rounded transition-colors"
            >
              <Check className="w-3 h-3" />Approve
            </button>
            <button
              onClick={() => resolveToolApproval(toolCall.id, "denied", "Denied by user")}
              className="flex items-center gap-1 px-2 py-1 bg-acode-git-deleted/20 hover:bg-acode-git-deleted/30 text-acode-git-deleted text-xs rounded transition-colors"
            >
              <X className="w-3 h-3" />Deny
            </button>
          </div>
        )}
      </div>
    </ActivityRow>
  );
}

// ============================================================================
// ChangesCard — file changes (open diff, +/- stats)
// ============================================================================

export function ChangesCard({ changes }: { changes: FileChange[] }) {
  const openDiff = useDiffView((s) => s.openFile);
  const totalAdded = changes.reduce((s, c) => s + c.additions, 0);
  const totalRemoved = changes.reduce((s, c) => s + c.deletions, 0);

  return (
    <ActivityRow
      label={<>{changes.length} {changes.length === 1 ? "file" : "files"} changed</>}
      meta={
        <span className="font-mono text-[11px]">
          <span className="text-acode-git-added">+{totalAdded.toLocaleString()}</span>{" "}
          <span className="text-acode-git-deleted">−{totalRemoved.toLocaleString()}</span>
        </span>
      }
    >
      <ul className="space-y-0.5 max-h-80 overflow-y-auto scrollbar-thin">
        {changes.map((c) => (
          <li key={c.path}>
            <FileChangeRow change={c} onOpenDiff={() => { openDiff(c); }} />
          </li>
        ))}
      </ul>
    </ActivityRow>
  );
}

function FileChangeRow({ change, onOpenDiff }: { change: FileChange; onOpenDiff: () => void }) {
  const fileName = basename(change.path);
  const dirPath = dirname(change.path);
  return (
    <div className="flex items-center gap-2 group hover:opacity-100 opacity-90 text-[12px]">
      <span className="font-medium flex-shrink-0">{fileName}</span>
      <span className="opacity-70 truncate font-mono flex-1 min-w-0 text-[11px]">{dirPath}</span>
      <span className="text-[11px] font-mono flex-shrink-0">
        <span className="text-acode-git-added">+{change.additions}</span>{" "}
        <span className="text-acode-git-deleted">−{change.deletions}</span>
      </span>
      <button
        onClick={onOpenDiff}
        className="text-[10px] text-acode-accent-primary hover:underline flex-shrink-0"
      >
        Open diff
      </button>
    </div>
  );
}

// ============================================================================
// TodoBlock — todo list checklist
// ============================================================================

export function TodoBlock({ todos }: { todos: TodoItem[] }) {
  if (!todos.length) return null;
  const completed = todos.filter((t) => t.status === "completed").length;
  const total = todos.length;
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;

  return (
    <ActivityRow
      label="Progress"
      meta={
        <span className="flex items-center gap-2">
          <span className="tabular-nums">{completed}/{total}</span>
          <span className="h-1 w-16 bg-acode-bg-secondary/60 rounded-full overflow-hidden flex-shrink-0">
            <span className="block h-full bg-acode-accent-primary" style={{ width: `${pct}%` }} />
          </span>
        </span>
      }
      defaultOpen
    >
      <ul className="space-y-0.5">
        {todos.map((t) => {
          const done = t.status === "completed";
          const inFlight = t.status === "in_progress";
          return (
            <li
              key={t.id}
              className="flex items-start gap-1.5 text-[12px]"
            >
              {done ? (
                <CheckCircle2 className="w-3 h-3 text-acode-git-added flex-shrink-0 mt-0.5" />
              ) : inFlight ? (
                <Loader2 className="w-3 h-3 text-acode-accent-primary animate-spin flex-shrink-0 mt-0.5" />
              ) : (
                <span className="w-3 h-3 rounded-full border border-acode-text-muted/40 flex-shrink-0 mt-0.5" />
              )}
              <span className={done ? "line-through opacity-70" : ""}>{t.content}</span>
            </li>
          );
        })}
      </ul>
    </ActivityRow>
  );
}
