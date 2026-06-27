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
import { useState, useMemo } from "react";
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
  FolderOpen,
  File,
  FileCode,
  FileJson,
  FileImage,
  FileType,
} from "lucide-react";
import type {
  FileChange,
  SkillInfo,
  TodoItem,
  ToolCall,
} from "@dalam/shared-types";
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
        } text-dalam-text-secondary`}
        title={hasDetail ? (open ? "Click to collapse" : "Click to expand") : undefined}
      >
        {hasDetail ? (
          <ChevronDown
            className={`w-3 h-3 text-dalam-text-muted/70 transition-transform flex-shrink-0 ${open ? "" : "-rotate-90"}`}
          />
        ) : (
          <span className="w-3 h-3 flex-shrink-0" />
        )}
        {icon && (
          <span className={`flex-shrink-0 inline-flex items-center opacity-80 ${iconClass ?? ""}`}>{icon}</span>
        )}
        <span className="truncate">{label}</span>
        {meta && <span className="text-dalam-text-muted/80 text-[11px] truncate">{meta}</span>}
        {trailing && <span className="ml-auto flex-shrink-0 flex items-center gap-1 opacity-80">{trailing}</span>}
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

export function ThinkingBlock({ content, streaming }: { content: string; streaming?: boolean }) {
  return (
    <ActivityRow
      label={
        <span className="italic flex items-center gap-2">
          {streaming ? (
            <>
              <span className="flex items-center gap-0.5">
                <span className="w-1 h-1 rounded-full bg-dalam-accent-primary animate-thinking-wave" style={{ animationDelay: "0s" }} />
                <span className="w-1 h-1 rounded-full bg-dalam-accent-primary animate-thinking-wave" style={{ animationDelay: "0.15s" }} />
                <span className="w-1 h-1 rounded-full bg-dalam-accent-primary animate-thinking-wave" style={{ animationDelay: "0.3s" }} />
              </span>
              Thinking…
            </>
          ) : "Reasoned step-by-step"}
        </span>
      }
      meta={streaming ? undefined : `${content.length} chars`}
      defaultOpen={false}
    >
      <pre className="whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed text-dalam-text-secondary/90">
        {content}
        {streaming && <span className="inline-block w-1.5 h-3 bg-dalam-accent-primary ml-0.5 animate-pulse-soft align-middle" />}
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
      label={<>Explored {result.kind ? <span className="text-dalam-text-secondary/70">{result.kind}</span> : "codebase"}</>}
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
}

// ============================================================================
// ContextGatheringGroup — collapsible group for explore/read activities
// ============================================================================

export function ContextGatheringGroup({ activities }: { activities: import("@dalam/shared-types").PendingActivity[] }) {
  const [open, setOpen] = useState(false);
  if (activities.length === 0) return null;

  const exploreCount = activities.filter(a => a.type === "explore").length;
  const readCount = activities.filter(a => a.type === "read").length;
  const parts: string[] = [];
  if (exploreCount > 0) parts.push(`${exploreCount} search${exploreCount !== 1 ? "s" : ""}`);
  if (readCount > 0) parts.push(`${readCount} file read${readCount !== 1 ? "s" : ""}`);

  return (
    <div className="my-0.5">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="group flex items-center gap-1.5 text-left text-[13px] leading-relaxed w-full opacity-60 hover:opacity-100 transition-opacity cursor-pointer text-dalam-text-secondary"
        title={open ? "Click to collapse context" : "Click to expand context"}
      >
        <ChevronDown className={`w-3 h-3 text-dalam-text-muted/70 transition-transform flex-shrink-0 ${open ? "" : "-rotate-90"}`} />
        <Search className="w-3 h-3 flex-shrink-0 opacity-80" />
        <span className="truncate">Gathered context ({parts.join(", ")})</span>
        <span className="ml-auto text-[10px] tabular-nums opacity-70">{activities.length} items</span>
      </button>
      {open && (
        <div className="ml-3.5 mt-1 pl-3 border-l border-dalam-border-primary/60 text-[12px] text-dalam-text-secondary/80 leading-relaxed space-y-1">
          {activities.map((activity) => {
            if (activity.type === "explore") {
              return <ExploreBlock key={activity.id} result={activity} />;
            }
            if (activity.type === "read") {
              return <ReadBlock key={activity.id} path={activity.path} content={activity.content} lineRange={activity.lineRange} />;
            }
            return null;
          })}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// SkillBlock — $skill invocation
// ============================================================================

export function SkillBlock({ name, args, content, status }: { name: string; args?: string; content?: string; status?: "running" | "completed" | "failed" }) {
  const skill = BUNDLED_SKILLS.find((s: SkillInfo) => s.name === name);
  const statusIcon = status === "running" ? <span className="w-1.5 h-1.5 rounded-full bg-dalam-accent-primary animate-pulse" />
    : status === "failed" ? <span className="w-1.5 h-1.5 rounded-full bg-dalam-git-deleted" />
    : null;
  return (
    <ActivityRow
      label={<>Invoked <span className="font-mono">${name}</span>{args ? <span className="opacity-70 ml-1.5 font-mono">{args}</span> : null}</>}
      trailing={<>{statusIcon}{skill ? <span className="text-[10px] italic opacity-70 truncate max-w-[200px]">{skill.description}</span> : null}</>}
    >
      {content && (
        <pre className="font-mono text-[11px] bg-dalam-bg-secondary/30 rounded-md p-2 max-h-60 overflow-y-auto scrollbar-thin whitespace-pre-wrap break-words">
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
      <pre className="whitespace-pre-wrap break-words leading-relaxed text-dalam-text-primary">
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
        <pre className="font-mono text-[11px] bg-dalam-bg-secondary/30 rounded-md p-2 max-h-60 overflow-y-auto scrollbar-thin whitespace-pre-wrap break-words">
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
  read_file: { icon: FileText, label: "Read", color: "text-dalam-text-muted" },
  read: { icon: FileText, label: "Read", color: "text-dalam-text-muted" },
  edit_file: { icon: Code2, label: "Edited", color: "text-dalam-text-muted" },
  edit: { icon: Code2, label: "Edited", color: "text-dalam-text-muted" },
  write_file: { icon: FilePlus, label: "Wrote", color: "text-dalam-text-muted" },
  write: { icon: FilePlus, label: "Wrote", color: "text-dalam-text-muted" },
  create_file: { icon: FilePlus, label: "Created", color: "text-dalam-text-muted" },
  bash: { icon: Terminal, label: "Ran", color: "text-dalam-text-muted" },
  shell: { icon: Terminal, label: "Ran", color: "text-dalam-text-muted" },
  execute: { icon: Terminal, label: "Ran", color: "text-dalam-text-muted" },
  run_command: { icon: Terminal, label: "Ran", color: "text-dalam-text-muted" },
  file_search: { icon: Search, label: "Searched", color: "text-dalam-text-muted" },
  search_files: { icon: Search, label: "Searched", color: "text-dalam-text-muted" },
  grep: { icon: Search, label: "Searched", color: "text-dalam-text-muted" },
  grep_file: { icon: Search, label: "Searched", color: "text-dalam-text-muted" },
  list_dir: { icon: FileText, label: "Listed", color: "text-dalam-text-muted" },
  webfetch: { icon: Code2, label: "Fetched", color: "text-dalam-text-muted" },
  websearch: { icon: Search, label: "Searched", color: "text-dalam-text-muted" },
  git_status: { icon: Code2, label: "Git Status", color: "text-dalam-text-muted" },
  git_commit: { icon: Code2, label: "Git Commit", color: "text-dalam-text-muted" },
  git_log: { icon: Code2, label: "Git Log", color: "text-dalam-text-muted" },
  clipboard_read: { icon: FileText, label: "Clipboard", color: "text-dalam-text-muted" },
  clipboard_write: { icon: FileText, label: "Clipboard", color: "text-dalam-text-muted" },
  notify: { icon: Shield, label: "Notify", color: "text-dalam-text-muted" },
  system_info: { icon: Code2, label: "System Info", color: "text-dalam-text-muted" },
  open_url: { icon: Code2, label: "Open URL", color: "text-dalam-text-muted" },
  launch_app: { icon: Terminal, label: "Launched", color: "text-dalam-text-muted" },
  reveal_in_finder: { icon: FileText, label: "Revealed", color: "text-dalam-text-muted" },
  memory_save: { icon: Shield, label: "Memory Save", color: "text-dalam-text-muted" },
  memory_search: { icon: Search, label: "Memory Search", color: "text-dalam-text-muted" },
  memory_delete: { icon: X, label: "Memory Delete", color: "text-dalam-text-muted" },
  memory_stats: { icon: Code2, label: "Memory Stats", color: "text-dalam-text-muted" },
  memory_maintain: { icon: Shield, label: "Memory Maintain", color: "text-dalam-text-muted" },
  memory_extract: { icon: Code2, label: "Memory Extract", color: "text-dalam-text-muted" },
  memory_export: { icon: Code2, label: "Memory Export", color: "text-dalam-text-muted" },
  memory_import: { icon: Code2, label: "Memory Import", color: "text-dalam-text-muted" },
  get_env: { icon: Code2, label: "Get Env", color: "text-dalam-text-muted" },
  get_screen_info: { icon: Code2, label: "Screen Info", color: "text-dalam-text-muted" },
  list_processes: { icon: Terminal, label: "Processes", color: "text-dalam-text-muted" },
  kill_process: { icon: X, label: "Kill Process", color: "text-dalam-text-muted" },
  get_disk_space: { icon: Code2, label: "Disk Space", color: "text-dalam-text-muted" },
};

function getToolMeta(name: string) {
  return TOOL_META[name] ?? { icon: Code2, label: name, color: "text-dalam-text-muted" };
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

// ============================================================================
// Smart tool result display — renders results as nice UI instead of raw JSON
// ============================================================================

function ArgsDisplay({ toolName, args }: { toolName: string; args: Record<string, any> }) {
  const [expanded, setExpanded] = useState(false);
  const entries = Object.entries(args).filter(([k]) => k !== "api_key" && k !== "token");

  if (entries.length === 0) {
    return <span className="text-dalam-text-muted text-[10px] italic">No arguments</span>;
  }

  // Compact inline display for common tools
  const compact = (() => {
    if (toolName === "read_file" || toolName === "write_file" || toolName === "edit_file" || toolName === "list_dir") {
      const p = args.path as string;
      if (p) return p;
    }
    if (toolName === "run_command") return `$ ${args.command}`;
    if (toolName === "grep_file") return `${args.pattern} in ${args.path ?? "."}`;
    if (toolName === "search_files") return `"${args.pattern}" in ${args.path ?? "."}`;
    if (toolName === "fetch_url") return args.url;
    if (toolName === "create_file") return args.path;
    return null;
  })();

  return (
    <div>
      {compact ? (
        <div className="font-mono text-dalam-text-primary bg-dalam-bg-secondary/30 rounded-md px-2 py-1 flex items-center gap-1.5">
          <span className="text-dalam-text-muted">{args.mode ? `[${args.mode}]` : ""}</span>
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
          {entries.map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`).join("\n")}
        </pre>
      )}
    </div>
  );
}

function getFileIconForName(name: string) {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (["js", "jsx", "ts", "tsx", "mjs", "cjs"].includes(ext)) return FileCode;
  if (["json", "jsonc"].includes(ext)) return FileJson;
  if (["png", "jpg", "jpeg", "gif", "svg", "ico", "webp"].includes(ext)) return FileImage;
  if (["md", "txt", "rst", "log"].includes(ext)) return FileText;
  if (["css", "scss", "less", "html", "htm"].includes(ext)) return FileType;
  return File;
}

function ToolResultDisplay({ toolName, result, args }: { toolName: string; result: string; args: Record<string, any> }) {
  const openFile = useWorkspace((s) => s.openFile);
  const openDiff = useDiffView((s) => s.openFile);

  // list_dir: parse JSON array of { name, path, type }
  if (toolName === "list_dir" && result.startsWith("[")) {
    let items: { name: string; path: string; type: string }[] | null = null;
    try { items = JSON.parse(result); } catch { /* fall through */ }
    if (items) {
      const dirs = items.filter((i) => i.type === "directory").sort((a, b) => a.name.localeCompare(b.name));
      const files = items.filter((i) => i.type !== "directory").sort((a, b) => a.name.localeCompare(b.name));
      return (
        <div className="space-y-0.5">
          {dirs.map((item) => (
              <button
                key={item.path}
                className="flex items-center gap-1.5 px-2 py-0.5 rounded text-left hover:bg-dalam-bg-hover/50 transition-colors w-full group"
                onClick={(e) => { e.stopPropagation(); openFile(item.path); }}
              >
                <Folder className="w-3 h-3 text-dalam-accent-primary flex-shrink-0" />
                <span className="text-dalam-text-primary text-[11px] group-hover:text-dalam-accent-primary transition-colors">{item.name}/</span>
              </button>
          ))}
          {files.map((item) => {
            const Icon = getFileIconForName(item.name);
            return (
              <button
                key={item.path}
                className="flex items-center gap-1.5 px-2 py-0.5 rounded text-left hover:bg-dalam-bg-hover/50 transition-colors w-full group"
                onClick={(e) => { e.stopPropagation(); openFile(item.path); }}
              >
                <Icon className="w-3 h-3 text-dalam-text-muted flex-shrink-0" />
                <span className="text-dalam-text-primary text-[11px] group-hover:text-dalam-accent-primary transition-colors">{item.name}</span>
              </button>
            );
          })}
          <div className="text-[10px] text-dalam-text-muted pt-0.5">{dirs.length} {dirs.length === 1 ? "folder" : "folders"}, {files.length} {files.length === 1 ? "file" : "files"}</div>
        </div>
      );
    }
  }

  // grep_file / search_files: parse "lineNum: text" or "file:lineNum: text"
  if ((toolName === "grep_file" || toolName === "search_files") && !result.startsWith("Error")) {
    const lines = result.split("\n").filter(Boolean);
    if (lines.length > 0 && /^\d+:|^[\w/.-]+:\d+:/.test(lines[0])) {
      const isSearch = toolName === "search_files";
      return (
        <div className="space-y-0.5 max-h-48 overflow-y-auto scrollbar-thin">
          {lines.map((line, idx) => {
            if (isSearch) {
              // Format: filePath:lineNum: text
              const match = line.match(/^(.+?):(\d+):(.*)$/);
              if (match) {
                const [, filePath, lineNum, text] = match;
                const shortPath = filePath?.split("/").pop() ?? filePath;
                return (
                  <div key={idx} className="flex items-start gap-1 px-2 py-0.5 rounded hover:bg-dalam-bg-hover/30 text-[11px] font-mono">
                    <button
                      className="text-dalam-accent-primary hover:underline flex-shrink-0 truncate max-w-[120px]"
                      onClick={(e) => { e.stopPropagation(); openFile(filePath); }}
                      title={filePath}
                    >
                      {shortPath}
                    </button>
                    <span className="text-dalam-text-muted flex-shrink-0">:{lineNum}</span>
                    <span className="text-dalam-text-primary truncate">{text}</span>
                  </div>
                );
              }
            }
            // Format: lineNum: text
            const match = line.match(/^(\d+):(.*)$/);
            if (match) {
              const [, lineNum, text] = match;
              const filePath = args.path as string;
              return (
                <button
                  key={idx}
                  className="flex items-start gap-1 px-2 py-0.5 rounded hover:bg-dalam-bg-hover/30 text-[11px] font-mono w-full text-left"
                  onClick={(e) => { e.stopPropagation(); openFile(filePath); }}
                >
                  <span className="text-dalam-text-muted flex-shrink-0 w-8 text-right">{lineNum}:</span>
                  <span className="text-dalam-text-primary truncate">{text}</span>
                </button>
              );
            }
            return (
              <div key={idx} className="px-2 py-0.5 text-[11px] font-mono text-dalam-text-primary truncate">{line}</div>
            );
          })}
          {lines.length >= 50 && (
            <div className="text-[10px] text-dalam-text-muted px-2 pt-0.5">Showing 50 of {lines.length} matches</div>
          )}
        </div>
      );
    }
  }

  // read_file: show truncated code preview
  if (toolName === "read_file" && !result.startsWith("Error") && !result.startsWith("[")) {
    const lines = result.split("\n");
    const preview = lines.slice(0, 15).join("\n");
    const totalLines = lines.length;
    return (
      <div>
        <pre className="font-mono text-[11px] text-dalam-text-primary bg-dalam-bg-secondary/30 rounded-md p-2 max-h-32 overflow-y-auto scrollbar-thin whitespace-pre-wrap break-words">
          {preview}
          {totalLines > 15 && <span className="text-dalam-text-muted">{"\n"}... ({totalLines - 15} more lines)</span>}
        </pre>
        {args.path && (
          <button
            className="text-[10px] text-dalam-accent-primary hover:underline mt-1"
            onClick={(e) => { e.stopPropagation(); openFile(args.path as string); }}
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
  return (
    <pre className="font-mono text-[11px] text-dalam-text-primary whitespace-pre-wrap break-words bg-dalam-bg-secondary/30 rounded-md p-2 max-h-40 overflow-y-auto scrollbar-thin">
      {display}
    </pre>
  );
}

function ToolCallRow({ toolCall }: { toolCall: ToolCall }) {
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
                  className="text-[10px] text-dalam-accent-primary hover:underline"
                  onClick={(e) => {
                    e.stopPropagation();
                    const isWrite = toolCall.name === "write_file" || toolCall.name === "write";
                    // Use "created" only if old content was empty (new file)
                    const isNewFile = isWrite && (!toolCall.diff?.oldContent || toolCall.diff.oldContent === "");
                    openDiff({
                      path: toolCall.args.path as string,
                      action: isNewFile ? "created" : "modified",
                      additions: toolCall.diff?.hunks?.reduce((n: number, h: { newLines: number }) => n + h.newLines, 0) ?? 0,
                      deletions: toolCall.diff?.hunks?.reduce((n: number, h: { oldLines: number }) => n + h.oldLines, 0) ?? 0,
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
          <ArgsDisplay toolName={toolCall.name} args={toolCall.args} />
        </div>
        {toolCall.result && (
          <div>
            <div className="text-[10px] uppercase tracking-wider opacity-60 mb-0.5">Result</div>
            <ToolResultDisplay toolName={toolCall.name} result={toolCall.result} args={toolCall.args} />
          </div>
        )}
        {needsApproval && (
          <div className="flex items-center gap-1.5 pt-1">
            <button
              onClick={() => resolveToolApproval(toolCall.id, "approved", "Approved by user")}
              className="flex items-center gap-1 px-2 py-1 bg-dalam-git-added/20 hover:bg-dalam-git-added/30 text-dalam-git-added text-xs rounded transition-colors"
            >
              <Check className="w-3 h-3" />Approve
            </button>
            <button
              onClick={() => resolveToolApproval(toolCall.id, "denied", "Denied by user")}
              className="flex items-center gap-1 px-2 py-1 bg-dalam-git-deleted/20 hover:bg-dalam-git-deleted/30 text-dalam-git-deleted text-xs rounded transition-colors"
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
          <span className="text-dalam-git-added">+{totalAdded.toLocaleString()}</span>{" "}
          <span className="text-dalam-git-deleted">−{totalRemoved.toLocaleString()}</span>
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
        <span className="text-dalam-git-added">+{change.additions}</span>{" "}
        <span className="text-dalam-git-deleted">−{change.deletions}</span>
      </span>
      <button
        onClick={onOpenDiff}
        className="text-[10px] text-dalam-accent-primary hover:underline flex-shrink-0"
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
          <span className="h-1 w-16 bg-dalam-bg-secondary/60 rounded-full overflow-hidden flex-shrink-0">
            <span className="block h-full bg-dalam-accent-primary" style={{ width: `${pct}%` }} />
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
                <CheckCircle2 className="w-3 h-3 text-dalam-git-added flex-shrink-0 mt-0.5" />
              ) : inFlight ? (
                <Loader2 className="w-3 h-3 text-dalam-accent-primary animate-spin flex-shrink-0 mt-0.5" />
              ) : (
                <span className="w-3 h-3 rounded-full border border-dalam-text-muted/40 flex-shrink-0 mt-0.5" />
              )}
              <span className={done ? "line-through opacity-70" : ""}>{t.content}</span>
            </li>
          );
        })}
      </ul>
    </ActivityRow>
  );
}

// ============================================================================
// TaskPlanBlock — live-updating task plan checklist
// ============================================================================

export type TaskPlanItem = {
  id: string;
  title: string;
  status: "pending" | "running" | "done" | "failed";
};

export function TaskPlanBlock({ tasks, summary }: { tasks: TaskPlanItem[]; summary?: string | null }) {
  const completed = tasks.filter((t) => t.status === "done").length;
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
          <span>{completed}/{total}</span>
          {summary && completed === total && (
            <span className="text-dalam-git-added text-[10px]">{summary}</span>
          )}
        </span>
      }
      defaultOpen
    >
      <ul className="space-y-1">
        {tasks.map((task) => {
          const isDone = task.status === "done";
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
              <span className={`${isDone ? "line-through opacity-70" : ""} ${isFailed ? "text-dalam-git-deleted" : ""}`}>
                {task.title}
              </span>
            </li>
          );
        })}
      </ul>
    </ActivityRow>
  );
}
