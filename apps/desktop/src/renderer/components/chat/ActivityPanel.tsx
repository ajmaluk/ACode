/* eslint-disable react-refresh/only-export-components */

import React, { useState } from "react";
import {
  X, FileCode, FilePlus,
  ChevronDown, Loader2,
  FileText, GitBranch, Terminal, Search, FolderOpen,
  Check, Zap, Code2, ClipboardList,
  Database, HelpCircle, Globe, Layout,
} from "lucide-react";
import { useChat } from "@/store/useAppStore";
import { ThinkingBlock, TaskPlanBlock, SubAgentList } from "./ActivityBlocks";
// ============================================================================
// WorkingTimer — elapsed time display
// ============================================================================
export const WorkingTimer = React.memo(function WorkingTimer({ startTime }: { startTime: number }) {
  const [elapsed, setElapsed] = useState(() => Math.floor((Date.now() - startTime) / 1000));
  React.useEffect(() => {
    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startTime) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, [startTime]);
  const minutes = Math.floor(elapsed / 60);
  const seconds = elapsed % 60;
  const timeStr = minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
  return (
    <span className="text-[12px] text-dalam-text-muted/60 tabular-nums">
      Working for {timeStr}
    </span>
  );
});

// ============================================================================
// InlineActivityRow — shows a single tool/activity in progress (Cursor-style)
// ============================================================================
export function InlineActivityRow({
  icon,
  label,
  target,
  status,
  duration,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  target?: string;
  status?: "running" | "completed" | "failed";
  duration?: string;
  children?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const hasDetail = !!children;
  return (
    <div className="my-0.5">
      <button
        type="button"
        onClick={() => hasDetail && setOpen((o) => !o)}
        className={`group flex items-center gap-1.5 text-left text-[12px] leading-relaxed w-full opacity-70 hover:opacity-100 transition-opacity ${
          hasDetail ? "cursor-pointer" : "cursor-default"
        } text-dalam-text-secondary`}
      >
        {status === "running" ? (
          <Loader2 className="w-3 h-3 text-dalam-accent-primary animate-spin flex-shrink-0" />
        ) : status === "completed" ? (
          <Check className="w-3 h-3 text-dalam-git-added flex-shrink-0" />
        ) : status === "failed" ? (
          <X className="w-3 h-3 text-dalam-git-deleted flex-shrink-0" />
        ) : (
          icon
        )}
        <span className="opacity-80">{label}</span>
        {target && (
          <span className="font-mono text-[11px] text-dalam-text-muted/60 truncate max-w-[400px]">
            {target}
          </span>
        )}
        {duration && (
          <span className="text-[10px] text-dalam-text-muted/50 tabular-nums ml-auto">{duration}</span>
        )}
        {hasDetail && (
          <ChevronDown
            className={`w-2.5 h-2.5 text-dalam-text-muted/50 transition-transform flex-shrink-0 ml-1 ${open ? "" : "-rotate-90"}`}
          />
        )}
      </button>
      {hasDetail && open && (
        <div className="ml-5 mt-0.5 pl-2 border-l border-dalam-border-primary/40 text-[11px] text-dalam-text-secondary/70 leading-relaxed max-h-60 overflow-y-auto scrollbar-thin">
          {children}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Helpers for tool metadata
// ============================================================================

export function getFileIcon(ext: string): React.ElementType {
  const iconMap: Record<string, React.ElementType> = {
    ts: FileCode, tsx: FileCode, js: FileCode, jsx: FileCode,
    json: FileCode, html: FileCode, css: FileCode,
    md: FileText, py: FileCode, rs: FileCode, go: FileCode,
  };
  return iconMap[ext] || FileText;
}

export function getToolMeta(name: string): { icon: React.ElementType; label: string } {
  const meta: Record<string, { icon: React.ElementType; label: string }> = {
    read_file: { icon: FileText, label: "Read" },
    read: { icon: FileText, label: "Read" },
    edit_file: { icon: FileCode, label: "Edited" },
    edit: { icon: FileCode, label: "Edited" },
    write_file: { icon: FilePlus, label: "Wrote" },
    write: { icon: FilePlus, label: "Wrote" },
    bash: { icon: Terminal, label: "Ran" },
    shell: { icon: Terminal, label: "Ran" },
    run_command: { icon: Terminal, label: "Ran" },
    list_dir: { icon: FolderOpen, label: "Listed" },
    grep_file: { icon: Search, label: "Searched" },
    search_files: { icon: Search, label: "Searched" },
    git_status: { icon: GitBranch, label: "Git Status" },
    git_commit: { icon: GitBranch, label: "Git Commit" },
    git_log: { icon: GitBranch, label: "Git Log" },
    git_branch: { icon: GitBranch, label: "Git Branch" },
    git_checkout: { icon: GitBranch, label: "Git Checkout" },
    git_diff_file: { icon: GitBranch, label: "Git Diff" },
    memory_save: { icon: Database, label: "Memory Saved" },
    memory_search: { icon: Search, label: "Memory Searched" },
    memory_delete: { icon: Database, label: "Memory Deleted" },
    memory_stats: { icon: Database, label: "Memory Stats" },
    question: { icon: HelpCircle, label: "Question" },
    task: { icon: ClipboardList, label: "Task" },
    browser_navigate: { icon: Globe, label: "Browser" },
    open_panel: { icon: Layout, label: "Panel" },
  };
  return meta[name] || { icon: Code2, label: name };
}

// ============================================================================
// StreamingActivityPanel — shows all activities inline during streaming
// ============================================================================
export const StreamingActivityPanel = React.memo(function StreamingActivityPanel({
  activities,
  toolCalls,
  thinkingContent,
  sessionStartTime,
}: {
  activities: import("@dalam/shared-types").PendingActivity[];
  toolCalls: import("@dalam/shared-types").ToolCall[];
  thinkingContent: string;
  sessionStartTime: number;
}) {
  const taskPlan = useChat((s) => s.taskPlan);
  const taskPlanSummary = useChat((s) => s.taskPlanSummary);
  const subAgents = useChat((s) => s.subAgents);
  const streamingStartedAt = useChat((s) => s.streamingStartedAt);

  return (
    <div className="animate-fade-in">
      {taskPlan && taskPlan.length > 0 && (
        <TaskPlanBlock tasks={taskPlan} summary={taskPlanSummary} />
      )}
      {subAgents.length > 0 && (
        <SubAgentList agents={subAgents} />
      )}
      <div className="mb-2">
        <WorkingTimer startTime={streamingStartedAt ?? sessionStartTime} />
      </div>
      {thinkingContent && (
        <ThinkingBlock content={thinkingContent} streaming />
      )}
      {toolCalls.length > 0 && (
        <div className="space-y-0.5">
          {toolCalls.map((tc) => {
            const meta = getToolMeta(tc.name);
            const isRunning = tc.status === "running" || tc.status === "pending";
            const isCompleted = tc.status === "completed";
            const isFailed = tc.status === "failed";
            const status = isRunning ? "running" : isCompleted ? "completed" : isFailed ? "failed" : undefined;

            const target = (() => {
              const args = tc.args;
              if (!args) return "";
              if (typeof args.path === "string") return args.path;
              if (typeof args.command === "string") return `$ ${args.command}`;
              if (typeof args.query === "string") return args.query;
              if (typeof args.pattern === "string") return args.pattern;
              return "";
            })();

            return (
              <InlineActivityRow
                key={tc.id}
                icon={React.createElement(meta.icon, { className: "w-3 h-3 flex-shrink-0" })}
                label={meta.label}
                target={target}
                status={status}
              >
                {tc.result && (
                  <pre className="font-mono text-[10px] bg-dalam-bg-secondary/30 rounded p-2 max-h-32 overflow-y-auto whitespace-pre-wrap break-words">
                    {tc.result.slice(0, 2000)}
                  </pre>
                )}
              </InlineActivityRow>
            );
          })}
        </div>
      )}
      {activities.length > 0 && (
        <div className="space-y-0.5">
          {activities.map((activity, idx) => {
            const isLast = idx === activities.length - 1;
            const status: "completed" | "running" = isLast && activity.type !== "skill" ? "running" : "completed";
            if (activity.type === "explore") {
              return (
                <InlineActivityRow
                  key={`explore-${idx}`}
                  icon={<Search className="w-3 h-3 flex-shrink-0" />}
                  label="Searched"
                  target={activity.query}
                  status={status}
                />
              );
            }
            if (activity.type === "read") {
              const fileName = activity.path.split("/").pop() || activity.path;
              const ext = fileName.split(".").pop()?.toLowerCase() || "";
              return (
                <InlineActivityRow
                  key={`read-${idx}`}
                  icon={React.createElement(getFileIcon(ext), { className: "w-3 h-3 flex-shrink-0" })}
                  label="Read"
                  target={fileName}
                  status={status}
                />
              );
            }
            if (activity.type === "bash") {
              return (
                <InlineActivityRow
                  key={`bash-${idx}`}
                  icon={<Terminal className="w-3 h-3 flex-shrink-0" />}
                  label="Ran"
                  target={`$ ${activity.command}`}
                  status={status}
                >
                  <pre className="font-mono text-[10px] bg-dalam-bg-secondary/30 rounded p-2 max-h-32 overflow-y-auto whitespace-pre-wrap break-words">
                    {activity.result.slice(0, 2000)}
                    {activity.result.length > 2000 && <span className="text-dalam-text-muted"> (truncated)</span>}
                  </pre>
                </InlineActivityRow>
              );
            }
            if (activity.type === "skill") {
              return (
                <InlineActivityRow
                  key={`skill-${idx}`}
                  icon={<Zap className="w-3 h-3 flex-shrink-0" />}
                  label="Invoked"
                  target={`$${activity.name}`}
                  status="completed"
                />
              );
            }
            if (activity.type === "plan") {
              return (
                <InlineActivityRow
                  key={`plan-${idx}`}
                  icon={<ClipboardList className="w-3 h-3 flex-shrink-0" />}
                  label="Plan"
                  target={activity.plan.slice(0, 60)}
                  status="completed"
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