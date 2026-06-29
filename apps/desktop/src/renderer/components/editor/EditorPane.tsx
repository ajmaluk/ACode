import React, { useEffect, useRef, useState, useMemo, useCallback, useLayoutEffect } from "react";
import ReactDOM from "react-dom";
import { useWorkspace, useSettings, useChat, useGit, useModelProviders, useSettingsView, useUI, stripXmlToolCallTags, type ModelProvider } from "@/store/useAppStore";
import type { FileNode } from "@dalam/shared-types";
import { CodeView } from "@/components/editor/Editor";
import { Breadcrumb } from "@/components/editor/Breadcrumb";
import { TopNav } from "@/components/editor/TopNav";
import {
  X, FileCode, FilePlus, Circle, MoreHorizontal, Columns, ArrowUp,
  ChevronDown, ChevronRight, Loader2, Sparkles,
  FileText, GitBranch, Terminal, Search,
  FolderOpen, Check, ClipboardList, Settings, Zap, Hash, Cpu, RotateCcw, History, Info, Copy, Code2, Pause, Plus,
} from "lucide-react";
import { useToast } from "@/components/ui/toastStore";
import { Tooltip } from "@/components/ui/Tooltip";
import { createDalamAPI } from "@/lib/dalamAPI";
import { ThinkingBlock, ToolCallsList, ChangesCard, TodoBlock, SkillBlock, PlanBlock, BashActivityBlock, TaskPlanBlock, ContextGatheringGroup, SubAgentList } from "@/components/chat/ActivityBlocks";

import { CostDisplay } from "@/components/chat/CostDisplay";
import { PromptAutocomplete } from "@/components/editor/PromptAutocomplete";
import { basename } from "@/lib/pathUtils";
import { modKey } from "@/lib/platform";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import hljs from "highlight.js";

// ============================================================================
// WorkingTimer — shows elapsed time since streaming started
// ============================================================================
function WorkingTimer({ startTime }: { startTime: number }) {
  const [elapsed, setElapsed] = useState(() => Math.floor((Date.now() - startTime) / 1000));
  useEffect(() => {
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
}

// ============================================================================
// InlineActivityRow — shows a single tool/activity in progress (Cursor-style)
// ============================================================================
function InlineActivityRow({
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
// StreamingActivityPanel — shows all activities inline during streaming
// ============================================================================
function StreamingActivityPanel({
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
      {/* Task plan (if LLM declared one) */}
      {taskPlan && taskPlan.length > 0 && (
        <TaskPlanBlock tasks={taskPlan} summary={taskPlanSummary} />
      )}

      {/* Active sub-agents (collapsible accordions) */}
      {subAgents.length > 0 && (
        <SubAgentList agents={subAgents} />
      )}

      {/* Working timer */}
      <div className="mb-2">
        <WorkingTimer startTime={streamingStartedAt ?? sessionStartTime} />
      </div>

      {/* Thinking block (if any) */}
      {thinkingContent && (
        <ThinkingBlock content={thinkingContent} streaming />
      )}

      {/* Tool calls */}
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

      {/* Pending activities (explore, read, bash, skill, plan) */}
      {activities.length > 0 && (
        <div className="space-y-0.5">
          {activities.map((activity, idx) => {
            if (activity.type === "explore") {
              return (
                <InlineActivityRow
                  key={`explore-${idx}`}
                  icon={<Search className="w-3 h-3 flex-shrink-0" />}
                  label="Searched"
                  target={activity.query}
                  status="completed"
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
                  status="completed"
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
                  status="completed"
                >
                  <pre className="font-mono text-[10px] bg-dalam-bg-secondary/30 rounded p-2 max-h-32 overflow-y-auto whitespace-pre-wrap break-words">
                    {activity.result.slice(0, 2000)}
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
            return null;
          })}
        </div>
      )}
    </div>
  );
}

// Helper to get file icon based on extension
function getFileIcon(ext: string): React.ElementType {
  const iconMap: Record<string, React.ElementType> = {
    ts: FileCode,
    tsx: FileCode,
    js: FileCode,
    jsx: FileCode,
    json: FileCode,
    html: FileCode,
    css: FileCode,
    md: FileText,
    py: FileCode,
    rs: FileCode,
    go: FileCode,
  };
  return iconMap[ext] || FileText;
}

// Tool metadata for display
function getToolMeta(name: string): { icon: React.ElementType; label: string } {
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
  };
  return meta[name] || { icon: Code2, label: name };
}

const MemoizedOpenFileButton = React.memo(function MemoizedOpenFileButton({ fileTree, openFile }: { fileTree: FileNode[]; openFile: (path: string) => Promise<void> }) {
  const toast = useToast();
  const mod = modKey();
  const firstFile = useMemo(() => findFirstFile(fileTree), [fileTree]);
  const handleClick = useCallback(async () => { if (firstFile) { await openFile(firstFile); toast.info("Opened file", basename(firstFile)); } }, [firstFile, openFile, toast]);
  return (
    <button
      className={`px-3 h-full transition-colors ${firstFile ? "text-dalam-text-muted hover:text-dalam-text-primary hover:bg-dalam-bg-hover" : "text-dalam-text-muted/40 cursor-not-allowed"}`}
      onClick={handleClick}
      disabled={!firstFile}
      title={firstFile ? `Open file (${mod}P)` : "No files in workspace"}
    >
      <FilePlus className="w-3.5 h-3.5" />
    </button>
  );
});



export function EditorPane() {
  const { openTabs, activeFilePath, setActiveFile, closeTab, updateTabContent, markSaved, fileTree, openFile } = useWorkspace();
  const toast = useToast();
  const activeTab = openTabs.find((t) => t.path === activeFilePath) ?? null;

  useEffect(() => {
    const onKey = async (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        const { activeFilePath, openTabs } = useWorkspace.getState();
        const tab = openTabs.find((t) => t.path === activeFilePath);
        if (!tab) return;
        try {
          const api = createDalamAPI();
          await api.fs.writeFile(tab.path, tab.content);
          markSaved(tab.path);
          toast.success("File saved", tab.name);
        } catch (err) {
          toast.error("Save failed", (err as Error)?.message ?? "Unknown error");
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [markSaved, toast]);

  if (openTabs.length > 0) {
    return (
      <div className="h-full flex flex-col bg-dalam-bg-primary">
        <div className="h-9 flex items-center bg-dalam-bg-secondary border-b border-dalam-border-primary overflow-x-auto flex-shrink-0 scrollbar-thin">
          {openTabs.map((t) => {
            const active = t.path === activeFilePath;
            return (
              <div key={t.path}
                className={`group flex items-center gap-1.5 px-3 h-full border-r border-dalam-border-primary cursor-pointer transition-colors ${active ? "bg-dalam-bg-primary text-dalam-text-primary" : "bg-dalam-bg-secondary text-dalam-text-secondary hover:bg-dalam-bg-hover"}`}
                onClick={() => setActiveFile(t.path)}
                onAuxClick={(e) => { if (e.button === 1) closeTab(t.path); }}
                title={`${t.path}${t.dirty ? " (unsaved)" : ""}`}>
                <FileCode className="w-3.5 h-3.5 flex-shrink-0" />
                <span className="text-xs whitespace-nowrap">{t.name}</span>
                <button
                  className={`ml-1 rounded p-0.5 ${active ? "opacity-70 hover:opacity-100" : "opacity-0 group-hover:opacity-100"} hover:bg-dalam-bg-active transition-opacity`}
                  onClick={(e) => { e.stopPropagation(); closeTab(t.path); }}
                  title={t.dirty ? "Close (unsaved)" : "Close"}
                  aria-label={`Close ${t.name}`}
                >
                  {t.dirty
                    ? <Circle className="w-2.5 h-2.5 fill-current text-dalam-accent-primary" />
                    : <X className="w-3 h-3" />}
                </button>
              </div>
            );
          })}
          <MemoizedOpenFileButton fileTree={fileTree} openFile={openFile} />
          <div className="flex-1" />
          <div className="flex items-center gap-0.5 pr-1">
            <button className="px-2 h-full text-dalam-text-muted hover:text-dalam-text-primary hover:bg-dalam-bg-hover transition-colors" title="Split editor" onClick={() => toast.info("Split", "Coming soon")}>
              <Columns className="w-3.5 h-3.5" />
            </button>
            <button className="px-2 h-full text-dalam-text-muted hover:text-dalam-text-primary hover:bg-dalam-bg-hover transition-colors" title="More actions" onClick={() => toast.info("More", "Coming soon")}>
              <MoreHorizontal className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
        {activeTab && <Breadcrumb />}
        <div className="flex-1 min-h-0 relative">
          {activeTab && <CodeView path={activeTab.path} content={activeTab.content} onChange={(v) => updateTabContent(activeTab.path, v)} />}
        </div>
        {activeTab && <EditorStatusBar />}
      </div>
    );
  }

  return <ChatView />;
}

function EditorStatusBar() {
  const { settings } = useSettings();
  const { openTabs, activeFilePath, markSaved } = useWorkspace();
  const toast = useToast();
  const activeTab = openTabs.find((t) => t.path === activeFilePath);
  const mod = modKey();
  if (!activeTab) return null;
  const language = activeTab.path.split(".").pop()?.toLowerCase() ?? "text";
  const cursor = activeTab.cursor;
  return (
    <div className="h-6 flex items-center justify-between bg-dalam-bg-tertiary border-t border-dalam-border-primary px-3 text-[11px] text-dalam-text-muted flex-shrink-0 select-none">
      <div className="flex items-center gap-3 min-w-0 overflow-hidden">
        <span className="flex items-center gap-1.5 flex-shrink-0">
          <FileCode className="w-3 h-3" />
          {activeTab.name}
        </span>
        <span className="px-1.5 py-0.5 rounded bg-dalam-bg-active text-dalam-text-secondary uppercase tracking-wider text-[10px] flex-shrink-0">{language}</span>
        {cursor && (
          <span className="flex items-center gap-1 flex-shrink-0">
            <span>Ln {cursor.line}, Col {cursor.column}</span>
          </span>
        )}
        <span className="flex items-center gap-1 flex-shrink-0">
          <span>Spaces: 2</span>
        </span>
        <span className="flex items-center gap-1 flex-shrink-0">
          <span>UTF-8</span>
        </span>
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">
        {activeTab.dirty ? (
          <button
            onClick={async () => {
              try {
                const api = createDalamAPI();
                await api.fs.writeFile(activeTab.path, activeTab.content);
                markSaved(activeTab.path);
              } catch (err) {
                toast.error("Save failed", (err as Error)?.message ?? "Unknown error");
              }
            }}
            className="flex items-center gap-1 text-dalam-text-secondary hover:text-dalam-text-primary transition-colors"
            title={`Save (${mod}S)`}
          >
            <Circle className="w-2 h-2 fill-current text-dalam-accent-primary" />
            <span>Unsaved</span>
          </button>
        ) : (
          <span className="flex items-center gap-1 text-dalam-text-muted">
            <Check className="w-3 h-3" />
            Saved
          </span>
        )}
        <span className="flex items-center gap-1 flex-shrink-0 text-dalam-text-muted">
          <span>Font {settings.codeFontSize}px</span>
        </span>
      </div>
    </div>
  );
}

function VersionRestoreBar({ restoredVersionId, activeSessionId, sessionVersions, onConfirm, onCancel }: {
  restoredVersionId: string;
  activeSessionId: string;
  sessionVersions: Record<string, import("@dalam/shared-types").ChatVersion[]>;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const versions = sessionVersions[activeSessionId] ?? [];
  const ver = versions.find((v) => v.id === restoredVersionId);
  if (!ver) return null;
  return (
    <div className="px-3 pt-1.5 pb-0 flex-shrink-0 bg-dalam-bg-primary">
      <div className="flex items-center gap-2 px-3 py-1.5 bg-dalam-accent-subtle/40 border border-dalam-accent-primary/20 rounded-lg text-xs">
        <History className="w-3.5 h-3.5 text-dalam-accent-primary flex-shrink-0" />
        <div className="flex-1 min-w-0">
          <span className="text-dalam-text-primary font-medium truncate">{ver.label}</span>
          <span className="text-dalam-text-muted ml-1.5">· {ver.messages.length} message{ver.messages.length !== 1 ? "s" : ""}</span>
        </div>
        <button
          className="flex items-center gap-1 px-2 py-1 bg-dalam-accent-primary/10 hover:bg-dalam-accent-primary/20 text-dalam-accent-primary rounded-md transition-colors"
          title="Reset to this version"
          onClick={onConfirm}
        >
          <RotateCcw className="w-3 h-3" />
          <span>Reset</span>
        </button>
        <button
          className="text-dalam-text-muted hover:text-dalam-text-primary transition-colors"
          title="Cancel and return to current"
          onClick={onCancel}
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}

function ChatView() {
  const { workspaces, activeWorkspaceId, setActiveWorkspace, openWorkspace, fileTree } = useWorkspace();
  const { settings } = useSettings();
  const { sendMessage, isStreaming, messages, selectedModelId, setSelectedModel, chatSessions, planApproval, approvePlan, rejectPlan, restoredVersionId, sessionVersions, activeSessionId, cancelVersionRestore, confirmVersionRestore, pendingAttachments, removePendingAttachment } = useChat();
  const { providers, getAllModels } = useModelProviders();
  const { status: gitStatus } = useGit();
  const toast = useToast();
  const mod = modKey();
  const scrollRef = useRef<HTMLDivElement>(null);
  const mainTextareaRef = useRef<HTMLTextAreaElement>(null);
  const followupTextareaRef = useRef<HTMLTextAreaElement>(null);
  const [value, setValue] = useState("");
  const isUserScrolledUp = useRef(false);
  // Imperative key-handlers from the autocomplete components. The parent
  // calls them first from each textarea's onKeyDown; they return true to
  // signal "I've handled this, don't also submit / mutate".
  const mainAutocompleteKey = useRef<((e: React.KeyboardEvent<HTMLTextAreaElement>) => boolean) | null>(null);
  const followupAutocompleteKey = useRef<((e: React.KeyboardEvent<HTMLTextAreaElement>) => boolean) | null>(null);
  const [showWorkspaceDropdown, setShowWorkspaceDropdown] = useState(false);
  const [showBranchDropdown, setShowBranchDropdown] = useState(false);
  const [showModelDropdown, setShowModelDropdown] = useState(false);
  const [hoveredProvider, setHoveredProvider] = useState<string | null>(null);
  const providerHoverTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [showFollowupModelDropdown, setShowFollowupModelDropdown] = useState(false);
  const [hoveredFollowupProvider, setHoveredFollowupProvider] = useState<string | null>(null);
  const followupProviderHoverTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const followupProviderRowRefs = useRef<Record<string, HTMLDivElement | null>>({});

  const [timestamp] = useState(() => Date.now());

  // Auto-resize the textareas dynamically based on scrollHeight
  useEffect(() => {
    const mainTextarea = mainTextareaRef.current;
    if (mainTextarea) {
      mainTextarea.style.height = "auto";
      mainTextarea.style.height = `${Math.min(mainTextarea.scrollHeight, 320)}px`;
    }
  }, [value]);

  // Cleanup both provider hover timeouts on unmount
  useEffect(() => {
    return () => {
      if (providerHoverTimeout.current) clearTimeout(providerHoverTimeout.current);
      if (followupProviderHoverTimeout.current) clearTimeout(followupProviderHoverTimeout.current);
    };
  }, []);

  // Refs for click-outside detection
  const workspaceRef = useRef<HTMLDivElement>(null);
  const branchRef = useRef<HTMLDivElement>(null);
  const modelRef = useRef<HTMLDivElement>(null);
  const followupModelRef = useRef<HTMLDivElement>(null);
  const providerRowRefs = useRef<Record<string, HTMLDivElement | null>>({});

  const workspace = workspaces.find((w) => w.id === activeWorkspaceId);
  const allModels = getAllModels();
  const currentModel = allModels.find((m) => m.model.modelId === selectedModelId);

  // Track whether user has scrolled up
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
      isUserScrolledUp.current = !atBottom;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  // Auto-scroll only if user hasn't scrolled up — debounced via RAF to prevent jitter
  const scrollRafRef = useRef<number>(0);
  useEffect(() => {
    if (!isUserScrolledUp.current && scrollRef.current) {
      cancelAnimationFrame(scrollRafRef.current);
      scrollRafRef.current = requestAnimationFrame(() => {
        if (scrollRef.current) {
          scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
      });
    }
    return () => cancelAnimationFrame(scrollRafRef.current);
  }, [messages]);

  const hasMessages = messages.length > 0;

  // Auto-focus the chat input on mount and when switching between empty/non-empty
  const prevMsgCountRef = useRef(messages.length);
  useEffect(() => {
    const prevCount = prevMsgCountRef.current;
    const justEmptied = prevCount > 0 && messages.length === 0;
    prevMsgCountRef.current = messages.length;
    const t = setTimeout(() => {
      if (justEmptied || messages.length === 0) mainTextareaRef.current?.focus();
      else if (messages.length > 0) followupTextareaRef.current?.focus();
    }, 200);
    return () => clearTimeout(t);
  }, [messages.length]);

  // Click-outside to close dropdowns
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      // Skip if click is inside a portal-rendered model sub-dropdown
      if ((target as HTMLElement)?.closest?.("[data-model-subdropdown]")) return;
      if (workspaceRef.current && !workspaceRef.current.contains(target)) setShowWorkspaceDropdown(false);
      if (branchRef.current && !branchRef.current.contains(target)) setShowBranchDropdown(false);
      if (modelRef.current && !modelRef.current.contains(target)) setShowModelDropdown(false);
      if (followupModelRef.current && !followupModelRef.current.contains(target)) setShowFollowupModelDropdown(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const handleSubmit = () => {
    if (isStreaming) {
      const chat = useChat.getState();
      if (chat.session?.id) {
        chat.abort(chat.session.id);
        toast.info("Generation aborted");
      }
      return;
    }
    if (!value.trim()) return;
    if (!workspace) { toast.warning("Open a folder first"); return; }
    if (!selectedModelId && !settings.selectedModel) { toast.warning("Select a model in Settings first"); return; }
    const trimmed = value.trim();
    const chat = useChat.getState();

    // Local slash-command dispatch.
    if (trimmed === "/clear") {
      chat.newChat();
      setValue("");
      return;
    }

    if (trimmed === "/help") {
      const helpText = `Available Slash Commands:
  /help       - Show this help notification
  /clear      - Start a fresh task/chat session
  /compact    - Compresses history using compaction summaries
  /dream      - Run background memory consolidation cycle
  /crystallize - Assess chat history for skill crystallization
  /login      - Opens Settings -> Models to configure API keys
  /model [id] - Switch the active model (e.g. /model gpt-4o)
  /reasoning  - Toggles reasoning modes or shows details
  /share      - Formats and copies conversation to clipboard
  /init       - Scans workspace & creates/bootstraps DALAM.md

Keyboard Shortcuts:
  ${mod}K          - Open command palette
  ${mod}B          - Toggle sidebar panel
  ${mod}\\          - Toggle right panel
  ${mod}N          - Start new task/chat
  ${mod},          - Open settings panel
  ${mod}[ / ${mod}]     - Navigate task history backward/forward
  ?           - Show shortcuts cheatsheet (when not typing)`;
      chat.injectSystemMessage(helpText);
      setValue("");
      return;
    }

            if (trimmed === "/compact") {
      const sessionId = chat.activeSessionId;
      if (sessionId) {
        toast.info("Compacting history...");
        chat.compactSessionHistory(sessionId).then(() => {
          chat.injectSystemMessage("Conversation history compacted successfully. Selected messages have been compressed to free up context window space.");
        }).catch((err: unknown) => {
          chat.injectSystemMessage(`Compaction failed: ${(err as Error).message || String(err)}`);
        });
      } else {
        toast.warning("No active chat session to compact.");
      }
      setValue("");
      return;
    }

    if (trimmed === "/dream") {
      const workspacePath = useWorkspace.getState().workspaces.find(w => w.id === useWorkspace.getState().activeWorkspaceId)?.path;
      if (workspacePath) {
        toast.info("Running memory consolidation cycle...");
        import("@/lib/dreamAgent").then(({ runDreamCycle }) => {
          runDreamCycle(workspacePath).then((report) => {
            chat.injectSystemMessage(`### 🌙 Dream Cycle Report\nConsolidation cycle completed:\n- **Purged**: ${report.purgedCount} memories\n- **Validated**: ${report.validatedCount} file references\n- **Merged & Deduplicated**: ${report.deduplicatedCount} memories\n- **Adjusted relative dates**: ${report.dateAdjustedCount} memories`);
          }).catch((err: unknown) => {
            chat.injectSystemMessage(`Dream cycle failed: ${(err as Error).message || String(err)}`);
          });
        });
      } else {
        toast.warning("No active workspace to run dream cycle.");
      }
      setValue("");
      return;
    }

    if (trimmed === "/crystallize") {
      const sessionId = chat.activeSessionId;
      const workspacePath = useWorkspace.getState().workspaces.find(w => w.id === useWorkspace.getState().activeWorkspaceId)?.path;
      if (sessionId && workspacePath) {
        toast.info("Assessing chat history for skill crystallization...");
        import("@/lib/skillCrystallizer").then(({ proposeSkillFromSession }) => {
          proposeSkillFromSession(sessionId, workspacePath, true);
        }).catch((err) => {
          chat.injectSystemMessage(`Crystallization failed to load: ${err.message || err}`);
        });
      } else {
        toast.warning("No active chat session or workspace open.");
      }
      setValue("");
      return;
    }

    if (trimmed === "/login") {
      useSettingsView.getState().open("models");
      chat.injectSystemMessage("Settings modal opened on the Models configuration tab.");
      setValue("");
      return;
    }

    if (trimmed.startsWith("/model")) {
      const targetModelId = trimmed.slice(7).trim();
      const allModels = getAllModels();
      
      if (!targetModelId) {
        const modelList = allModels.map(m => `- ${m.model.modelId} (${m.model.name})`).join("\n");
        chat.injectSystemMessage(`Usage: /model <modelId>\n\nAvailable Models:\n${modelList}`);
      } else {
        const found = allModels.find(m => 
          m.model.modelId.toLowerCase() === targetModelId.toLowerCase() || 
          m.model.name.toLowerCase().includes(targetModelId.toLowerCase())
        );
        if (found) {
          chat.setSelectedModel(found.model.modelId);
          chat.injectSystemMessage(`Active model switched to: ${found.model.name} (${found.model.modelId})`);
        } else {
          chat.injectSystemMessage(`Model "${targetModelId}" not found. Type "/model" to see available options.`);
        }
      }
      setValue("");
      return;
    }

    if (trimmed.startsWith("/agent")) {
      chat.injectSystemMessage("Mode selection is no longer available. The assistant always has full access to read, write, and execute.");
      setValue("");
      return;
    }

    if (trimmed === "/reasoning") {
      const model = chat.selectedModelId;
      const isReasoningModel = model.includes("o1") || model.includes("o3") || model.includes("deepseek-r1");
      const statusText = isReasoningModel 
        ? `Model "${model}" supports native thinking output. Reasoning is active.`
        : `Model "${model}" does not natively output deep thinking tokens. Use o1/o3-mini/deepseek-r1 models for extended reasoning.`;
      chat.injectSystemMessage(statusText);
      setValue("");
      return;
    }

    if (trimmed === "/share") {
      const messages = chat.messages;
      if (messages.length === 0) {
        toast.warning("Nothing to share yet.");
        setValue("");
        return;
      }
      const formatted = messages.filter(m => !m.isToolResult && !m.content?.startsWith("[Tool result for ")).map(m => `### ${m.role.toUpperCase()}:\n\n${m.content}\n`).join("\n---\n\n");
      const title = `Dalam Session Share log - ${new Date().toLocaleString()}\n\n`;
      const shareContent = title + formatted;
      
      void (async () => {
        try {
          const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
          await writeText(shareContent);
          toast.success("Share link created", "Conversation copied to clipboard!");
          chat.injectSystemMessage("Conversation history copied to clipboard successfully!");
        } catch {
          try {
            await navigator.clipboard.writeText(shareContent);
            toast.success("Share link created", "Conversation copied to clipboard!");
            chat.injectSystemMessage("Conversation history copied to clipboard successfully!");
          } catch (err) {
            toast.error("Failed to copy", String(err));
          }
        }
      })();
      
      setValue("");
      return;
    }

    if (trimmed === "/init") {
      void (async () => {
        try {
          toast.info("Scanning workspace...");
          const api = createDalamAPI();
          const files = fileTree; 
          const filesText = files.length > 0 
            ? files.map(f => `  - \`${f.name}\` (${f.type})`).join("\n")
            : "  No files detected yet.";
          
          // Detect project type from file extensions
          const extCounts: Record<string, number> = {};
          for (const f of files) {
            const ext = f.name.split(".").pop()?.toLowerCase();
            if (ext) extCounts[ext] = (extCounts[ext] ?? 0) + 1;
          }
          const hasTS = (extCounts["ts"] ?? 0) + (extCounts["tsx"] ?? 0);
          const hasRust = extCounts["rs"] ?? 0;
          const hasPython = extCounts["py"] ?? 0;
          const hasReact = (extCounts["tsx"] ?? 0) + (extCounts["jsx"] ?? 0);
          const hasConfig = files.some(f => f.name === "package.json" || f.name === "Cargo.toml" || f.name === "pyproject.toml");
          
          const dalamMdContent = `# ${workspace.name} — Dalam Workspace Instructions

> Generated by \`/init\` on ${new Date().toLocaleDateString()}.\n> Edit this file to teach Dalam about your project conventions.\n> Dalam loads instructions from a 4-layer hierarchy (lowest → highest priority):\n>\n>   1. **Global** — \`~/.dalam/DALAM.md\` (your personal rules, all projects)\n>   2. **Org** — \`.dalam/org/DALAM.md\` (team rules, shared via repo)\n>   3. **Project** — \`DALAM.md\` (this file — project-specific rules)\n>   4. **Local** — \`.dalam/local/DALAM.md\` (your overrides for this project, gitignored)

---

## Project Overview

${workspace.path}

**Detected stack:** ${[hasTS > 0 ? "TypeScript" : "", hasReact > 0 ? "React" : "", hasRust > 0 ? "Rust/Tauri" : "", hasPython > 0 ? "Python" : "", hasConfig ? "configured" : ""].filter(Boolean).join(", ") || "Unknown"}

## Directory Layout

${filesText}

---

## Global Rules

These rules apply to ALL files in the project:

- Always run typecheck and tests before declaring a task complete
- Use absolute paths for file operations
- Follow the existing code style and naming conventions
- Prefer editing existing files over creating new ones
- Ask before executing destructive commands (rm, git reset, etc.)

---

## Path-Scoped Rules

Use \`@path: <glob>\` blocks to apply rules only to matching files.
The glob supports \`*\` (single segment) and \`**\` (recursive) patterns.

### Examples:

\`\`\`
@path: src/components/**/*.tsx
- Use functional components with hooks
- Name files PascalCase (e.g. Button.tsx, ModalDialog.tsx)
- Import types with the 'type' keyword: import type { ... }
- Prefer named exports over default exports

@path: src/lib/**/*.ts
- Pure functions only — no side effects
- Export all public functions with JSDoc comments
- Use Zod schemas for runtime validation at API boundaries

@path: **/*.test.ts
- Use vitest for all tests
- Follow Arrange-Act-Assert pattern
- Mock external dependencies with vi.mock()
- Name test files with .test.ts suffix

@path: **/*.rs
- Use rustfmt defaults
- Prefer Result<T, E> over panics
- Add #[cfg(test)] modules for unit tests

@path: **/package.json
- Never pin dependency versions manually — use the package manager
- Always run the lockfile after dependency changes
\`\`\`

---

## Build & Test Commands

Add your project's common commands here so Dalam knows how to build:

| Command | Purpose |
|---------|----------|
| (add yours) | (e.g. \`pnpm build\`, \`cargo check\`) |

---

## Notes

- Dalam reads this file at the start of every conversation
- Changes take effect on the next prompt submission
- For personal overrides, create \`.dalam/local/DALAM.md\` (gitignored)
- For team-shared rules, create \`.dalam/org/DALAM.md\` and commit it
`;
          const dotDalam = `${workspace.path}/.dalam`;
          const plansDir = `${dotDalam}/plans`;
          const dalamMdPath = `${workspace.path}/DALAM.md`;
          
          const { exists, mkdir } = await import("@tauri-apps/plugin-fs");
          
          if (!(await exists(dotDalam))) {
            await mkdir(dotDalam);
          }
          if (!(await exists(plansDir))) {
            await mkdir(plansDir);
          }
          
          await api.fs.writeFile(dalamMdPath, dalamMdContent);
          await useWorkspace.getState().refreshFileTree();
          
          chat.injectSystemMessage(`Workspace bootstrap completed:
  1. Created DALAM.md overview at: ${dalamMdPath}
  2. Setup .dalam/plans directory for Plan mode.
  3. Active workspace memory loaded.`);
          toast.success("Workspace bootstrapped", "DALAM.md generated.");
        } catch (err) {
          toast.error("Failed to initialize workspace", String(err));
          chat.injectSystemMessage(`Workspace bootstrap failed: ${String(err)}`);
        }
      })();
      
      setValue("");
      return;
    }

    void sendMessage(trimmed);
    setValue("");
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Let the autocomplete intercept ↑/↓/Tab/Enter/Escape when the menu is open.
    if (mainAutocompleteKey.current?.(e)) return;
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSubmit(); }
  };

  const handleFollowupKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (followupAutocompleteKey.current?.(e)) return;
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSubmit(); }
  };

  const totalAdded = gitStatus?.added.length ?? 0;
  const totalDeleted = gitStatus?.deleted.length ?? 0;
  const totalModified = gitStatus?.modified.length ?? 0;

  return (
    <div className="h-full flex flex-col bg-dalam-bg-primary">
      <TopNav />

      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto scrollbar-thin">
        {!hasMessages && !isStreaming ? (
          <div className="relative h-full flex flex-col items-center justify-center px-8 -mt-10">
            {/* Large background D watermark — low opacity, behind everything */}
            <div aria-hidden="true" className="pointer-events-none absolute inset-0 flex items-center justify-center select-none">
              <span
                style={{
                  fontFamily: "'Newsreader', 'Iowan Old Style', 'Georgia', serif",
                  fontSize: "min(95vh, 1300px)",
                  fontWeight: 300,
                  lineHeight: 0.85,
                  letterSpacing: "-0.06em",
                  transform: "translateY(4.5%) rotate(90deg)",
                  userSelect: "none",
                  background: "linear-gradient(to left, color-mix(in srgb, var(--dalam-text-primary) 0.5%, transparent), color-mix(in srgb, var(--dalam-text-primary) 9.5%, transparent))",
                  WebkitBackgroundClip: "text",
                  WebkitTextFillColor: "transparent",
                }}
              >
                D
              </span>
            </div>

            {/* Foreground content — sits above the A watermark */}
            <div className="relative w-full max-w-2xl">
              <h1
                className="text-4xl text-dalam-text-primary text-center mb-10 tracking-tight"
                style={{ fontFamily: "'Newsreader', 'Iowan Old Style', 'Georgia', serif", fontWeight: 500 }}
              >
                {workspace
                  ? <>Start a new task in <span className="text-dalam-accent-primary">{workspace.name}</span></>
                  : "Open a folder to begin"}
              </h1>
              {/* Removed overflow-hidden so dropdowns can render above the card */}
              <div className="bg-dalam-bg-secondary border border-dalam-border-primary rounded-xl shadow-2xl">
                <div className="px-4 pt-2.5 flex items-center gap-3">
                  <div className="relative" ref={workspaceRef}>
                    <button
                      className={`flex items-center gap-1.5 text-sm transition-colors ${workspace ? "text-dalam-text-secondary hover:text-dalam-text-primary" : "text-dalam-text-muted hover:text-dalam-text-secondary"}`}
                      onClick={() => { setShowWorkspaceDropdown((v) => !v); setShowBranchDropdown(false); setShowModelDropdown(false); }}
                      title={workspace ? `Active workspace: ${workspace.name}` : "Select a folder to start working"}
                    >
                      <FolderOpen className={`w-4 h-4 ${workspace ? "text-dalam-text-muted" : "text-amber-400/80"}`} />
                      <span>{workspace?.name || "Select a folder"}</span>
                      <ChevronDown className="w-3.5 h-3.5 text-dalam-text-muted" />
                    </button>
                    {showWorkspaceDropdown && (
                      <div className="absolute top-full left-0 mt-1 w-64 bg-dalam-bg-secondary border border-dalam-border-primary rounded-xl shadow-2xl z-50 overflow-hidden">
                        <div className="p-2 border-b border-dalam-border-primary">
                          <input className="input-base w-full text-xs" placeholder="Search workspaces" autoFocus />
                        </div>
                        <div className="max-h-60 overflow-y-auto">
                          {workspaces.length === 0 && (
                            <div className="px-3 py-3 text-xs text-dalam-text-muted">No workspaces yet. Open a folder to get started.</div>
                          )}
                          {workspaces.map((ws) => (
                            <button key={ws.id}
                              className={`w-full text-left px-3 py-2 flex items-center gap-2 text-sm hover:bg-dalam-bg-hover transition-colors ${ws.id === activeWorkspaceId ? "bg-dalam-bg-hover" : ""}`}
                              onClick={() => { setActiveWorkspace(ws.id); setShowWorkspaceDropdown(false); }}>
                              <FolderOpen className="w-4 h-4 text-dalam-text-muted flex-shrink-0" />
                              <span className="flex-1 truncate text-dalam-text-primary">{ws.name}</span>
                              {ws.id === activeWorkspaceId && <Check className="w-4 h-4 text-dalam-accent-primary" />}
                            </button>
                          ))}
                          <div className="border-t border-dalam-border-primary">
                            <button className="w-full text-left px-3 py-2 flex items-center gap-2 text-sm text-dalam-text-secondary hover:bg-dalam-bg-hover transition-colors"
                              onClick={() => { void openWorkspace(); setShowWorkspaceDropdown(false); }}>
                              <FolderOpen className="w-4 h-4 text-dalam-text-muted flex-shrink-0" />
                              <span>Open folder…</span>
                            </button>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                  {gitStatus && (
                    <div className="relative" ref={branchRef}>
                      <button className="flex items-center gap-1.5 text-xs text-dalam-text-muted hover:text-dalam-text-secondary transition-colors"
                        onClick={() => { setShowBranchDropdown((v) => !v); setShowWorkspaceDropdown(false); setShowModelDropdown(false); }}>
                        <GitBranch className="w-3.5 h-3.5" />
                        <span>{gitStatus.branch}</span>
                        <ChevronDown className="w-3 h-3" />
                      </button>
                      {showBranchDropdown && (
                        <div className="absolute top-full left-0 mt-1 w-40 bg-dalam-bg-secondary border border-dalam-border-primary rounded-lg shadow-2xl z-50 overflow-hidden">
                          <button className="w-full text-left px-3 py-2 flex items-center gap-2 text-sm text-dalam-text-primary hover:bg-dalam-bg-hover">
                            <Check className="w-3.5 h-3.5 text-dalam-accent-primary" />{gitStatus.branch}
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
                <div className="px-4 py-2.5 relative">
                  {pendingAttachments.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mb-2">
                      {pendingAttachments.map((att) => (
                        <div key={att.id} className="flex items-center gap-1.5 px-2 py-1 bg-dalam-bg-active border border-dalam-border-primary rounded-md text-xs text-dalam-text-primary">
                          {att.mimeType.startsWith("image/") ? (
                            <img src={`data:${att.mimeType};base64,${att.content}`} alt={att.name} className="w-5 h-5 rounded object-cover" />
                          ) : (
                            <FileText className="w-3.5 h-3.5 text-dalam-text-muted" />
                          )}
                          <span className="max-w-[120px] truncate">{att.name}</span>
                          <button
                            className="text-dalam-text-muted hover:text-dalam-text-primary transition-colors ml-0.5"
                            onClick={() => removePendingAttachment(att.id)}
                            title={`Remove ${att.name}`}
                          >
                            <X className="w-3 h-3" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                  <textarea
                    ref={mainTextareaRef}
                    className="w-full bg-transparent border-0 outline-none text-sm text-dalam-text-primary placeholder-dalam-text-muted resize-none leading-relaxed overflow-y-auto min-h-[28px] max-h-80"
                    placeholder="Ask Dalam anything, @ to add files, / for commands, $ for skills, # for related conversations"
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                    onKeyDown={handleKeyDown}
                    rows={1}
                  />
                  <PromptAutocomplete
                    value={value}
                    onChange={setValue}
                    textareaRef={mainTextareaRef}
                    fileTree={fileTree}
                    chatSessions={chatSessions}
                    keyHandlerRef={mainAutocompleteKey}
                  />
                </div>
                <div className="flex items-center justify-between px-4 pb-2.5">
                  <div className="flex items-center gap-2">
                    <AttachFileButton />
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="relative" ref={modelRef}>
                      <Tooltip content={currentModel?.model.name || (selectedModelId || "Select model")} side="top">
                        <button className="flex items-center gap-1.5 px-2.5 py-1 text-xs text-dalam-text-secondary hover:bg-dalam-bg-hover rounded-md transition-colors"
                          onClick={() => { setShowModelDropdown((v) => !v); setShowWorkspaceDropdown(false); setShowBranchDropdown(false); }}>
                          <span className={`w-2 h-2 rounded-full ${currentModel ? "bg-dalam-git-added" : "bg-dalam-text-muted"}`} />
                          {currentModel?.model.name || (selectedModelId || "Select model")}
                          <ChevronDown className="w-3 h-3" />
                        </button>
                      </Tooltip>
                      {showModelDropdown && (
                        <div className="absolute bottom-full right-0 mb-1 bg-dalam-bg-secondary border border-dalam-border-primary rounded-xl shadow-2xl z-50 min-w-[220px]" data-dropdown-body>
                          <div className="max-h-80 overflow-y-auto">
                            {providers.filter((p) => p.enabled).map((p) => {
                              const enabledModels = p.models.filter((m) => m.enabled !== false);
                              if (enabledModels.length === 0) return null;
                              const hasActiveModel = enabledModels.some((m) => m.modelId === selectedModelId);
                              return (
                                <div key={p.id}
                                  ref={(el) => { providerRowRefs.current[p.id] = el; }}
                                  onMouseEnter={() => { if (providerHoverTimeout.current) clearTimeout(providerHoverTimeout.current); setHoveredProvider(p.id); }}
                                  onMouseLeave={() => { providerHoverTimeout.current = setTimeout(() => setHoveredProvider(null), 200); }}>
                                  <div className={`flex items-center justify-between px-3 py-2 cursor-pointer transition-colors ${hasActiveModel ? "text-dalam-accent-primary" : "text-dalam-text-primary hover:bg-dalam-bg-hover"}`}>
                                    <span className="text-sm">{p.name}</span>
                                    <div className="flex items-center gap-1">
                                      {hasActiveModel && <Check className="w-3.5 h-3.5 text-dalam-accent-primary" />}
                                      <ChevronRight className="w-3 h-3 text-dalam-text-muted" />
                                    </div>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                          <div className="border-t border-dalam-border-primary">
                            <button className="w-full text-left px-3 py-2 flex items-center gap-2 text-sm text-dalam-text-secondary hover:bg-dalam-bg-hover transition-colors"
                              onClick={() => { useSettingsView.getState().open("models"); setShowModelDropdown(false); }}>
                              <Settings className="w-4 h-4 text-dalam-text-muted" />
                              <span>Manage models</span>
                            </button>
                          </div>
                        </div>
                      )}
                      {/* Sub-dropdown rendered OUTSIDE the scrollable container via portal-like approach */}
                      {showModelDropdown && hoveredProvider && (
                        <ModelSubDropdown
                          hoveredProvider={hoveredProvider}
                          providerRowRefs={providerRowRefs}
                          modelRef={modelRef}
                          providers={providers}
                          selectedModelId={selectedModelId}
                          onSelect={(modelId) => { setSelectedModel(modelId); setShowModelDropdown(false); }}
                          onClose={() => setHoveredProvider(null)}
                          hoverTimeoutRef={providerHoverTimeout}
                        />
                      )}
                    </div>
                    <Tooltip content={isStreaming ? "Stop generating" : !workspace ? "Open a folder first" : !selectedModelId ? "Select a model first" : "Send"} side="top">
                      <button
                        className="w-8 h-8 flex items-center justify-center rounded-full bg-dalam-text-primary text-dalam-bg-primary hover:opacity-90 transition-opacity disabled:opacity-30 disabled:cursor-not-allowed"
                        disabled={!isStreaming && (!value.trim() || !workspace || (!selectedModelId && !settings.selectedModel))}
                        onClick={handleSubmit}
                      >
                        {isStreaming ? <Pause className="w-4 h-4" /> : <ArrowUp className="w-4 h-4" strokeWidth={2.5} />}
                      </button>
                    </Tooltip>
                  </div>
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className="max-w-3xl mx-auto py-6 px-6 space-y-1">
            {gitStatus && (totalAdded + totalDeleted + totalModified) > 0 && (
              <div className="flex items-center gap-2 mb-4 text-[11px] text-dalam-text-muted">
                <FileText className="w-3 h-3" />
                <span>Changes</span>
                {totalAdded > 0 && <span className="text-dalam-git-added">+{totalAdded}</span>}
                {totalDeleted > 0 && <span className="text-dalam-git-deleted">-{totalDeleted}</span>}
                <span className="ml-auto flex items-center gap-1">
                  <Cpu className="w-2.5 h-2.5" />
                  {currentModel?.model.name || "Select model"}
                </span>
              </div>
            )}
            {hasMessages && (
              <div className="max-w-3xl mx-auto mt-4 mb-6 px-6 text-[10px] text-dalam-text-muted flex items-center gap-2">
                <span className="flex items-center gap-1">
                  <Hash className="w-3 h-3" />
                  {messages.length} {messages.length === 1 ? "message" : "messages"}
                </span>
                <span className="text-dalam-text-muted/40">·</span>
                <CostDisplay />
                <span className="flex items-center gap-1" title="Approximate token count (1 token ≈ 4 chars)">
                  <Sparkles className="w-3 h-3" />
                  {Math.ceil(messages.reduce((sum, m) => sum + m.content.length, 0) / 4).toLocaleString()} tokens
                </span>
                <span className="text-dalam-text-muted/40">·</span>
                <span className="flex items-center gap-1">
                  {formatTime(messages[0].timestamp)}
                </span>
                <span className="ml-auto flex items-center gap-1">
                  <Cpu className="w-3 h-3" />
                  {currentModel?.model.name || settings.selectedModel || "No model"}
                </span>
              </div>
            )}
            {messages.filter(m => !m.isToolResult && !m.content?.startsWith("[Tool result for ")).map((m, idx, arr) => <ChatMessage key={m.id} message={m} onResetToMessage={(content) => setValue(content)} isLast={idx === arr.length - 1} />)}
            {planApproval && planApproval.status === "pending" && (
              <div className="mx-4 my-3 p-4 bg-dalam-accent-subtle border border-dalam-accent-primary/30 rounded-xl animate-fade-in">
                <div className="flex items-center gap-2 mb-2">
                  <ClipboardList className="w-4 h-4 text-dalam-accent-primary" />
                  <span className="text-sm font-medium text-dalam-text-primary">Plan ready for review</span>
                </div>
                <p className="text-xs text-dalam-text-muted mb-3">The AI has produced a plan. Approve to switch to Build mode and execute it.</p>
                <div className="flex gap-2">
                  <button
                    onClick={approvePlan}
                    className="px-4 py-1.5 bg-dalam-accent-primary hover:bg-dalam-accent-hover text-white text-sm rounded-lg transition-colors"
                  >
                    Approve & Build
                  </button>
                  <button
                    onClick={rejectPlan}
                    className="px-4 py-1.5 bg-dalam-bg-active hover:bg-dalam-bg-tertiary text-dalam-text-primary text-sm rounded-lg border border-dalam-border-primary transition-colors"
                  >
                    Reject
                  </button>
                </div>
              </div>
            )}
            <StreamingMessageWrapper scrollRef={scrollRef} isUserScrolledUp={isUserScrolledUp} timestamp={timestamp} />
          </div>
        )}
      </div>

      {/* Version restore bar — shown when viewing a historical version */}
      {hasMessages && restoredVersionId && activeSessionId && (
        <VersionRestoreBar
          restoredVersionId={restoredVersionId}
          activeSessionId={activeSessionId}
          sessionVersions={sessionVersions}
          onConfirm={confirmVersionRestore}
          onCancel={cancelVersionRestore}
        />
      )}

      {/* Only show follow-up input when there are actual messages */}
      {hasMessages && (
        <div className="p-3 flex-shrink-0 bg-dalam-bg-primary">
          <div className="max-w-2xl w-full mx-auto bg-dalam-bg-secondary border border-dalam-border-primary rounded-xl shadow-lg">
            <div className="px-4 py-3 relative">
              {pendingAttachments.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {pendingAttachments.map((att) => (
                    <div key={att.id} className="flex items-center gap-1.5 px-2 py-1 bg-dalam-bg-active border border-dalam-border-primary rounded-md text-xs text-dalam-text-primary">
                      {att.mimeType.startsWith("image/") ? (
                        <img src={`data:${att.mimeType};base64,${att.content}`} alt={att.name} className="w-5 h-5 rounded object-cover" />
                      ) : (
                        <FileText className="w-3.5 h-3.5 text-dalam-text-muted" />
                      )}
                      <span className="max-w-[120px] truncate">{att.name}</span>
                      <button
                        className="text-dalam-text-muted hover:text-dalam-text-primary transition-colors ml-0.5"
                        onClick={() => removePendingAttachment(att.id)}
                        title={`Remove ${att.name}`}
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <textarea ref={followupTextareaRef}
                className="w-full bg-transparent border-0 outline-none text-sm text-dalam-text-primary placeholder-dalam-text-muted resize-none overflow-y-auto leading-relaxed min-h-[40px] max-h-80"
                placeholder="Ask for follow-up changes" value={value} onChange={(e) => setValue(e.target.value)}
                onKeyDown={handleFollowupKeyDown} rows={1} />
              <PromptAutocomplete
                value={value}
                onChange={setValue}
                textareaRef={followupTextareaRef}
                fileTree={fileTree}
                chatSessions={chatSessions}
                keyHandlerRef={followupAutocompleteKey}
              />
            </div>
            <div className="flex items-center justify-between px-4 pb-3">
              <div className="flex items-center gap-2">
                <AttachFileButton />
              </div>
              <div className="flex items-center gap-2">
                <div className="relative" ref={followupModelRef}>
                  <button className="flex items-center gap-1.5 px-2.5 py-1 text-xs text-dalam-text-secondary hover:bg-dalam-bg-hover rounded-md transition-colors"
                    onClick={() => { setShowFollowupModelDropdown((v) => !v); }}>
                        <span className={`w-2 h-2 rounded-full ${currentModel ? "bg-dalam-git-added" : "bg-dalam-text-muted"}`} />
                        {currentModel?.model.name || (selectedModelId || "Select model")}
                        <ChevronDown className="w-3 h-3" />
                  </button>
                  {showFollowupModelDropdown && (
                    <div className="absolute bottom-full right-0 mb-1 bg-dalam-bg-secondary border border-dalam-border-primary rounded-xl shadow-2xl z-50 min-w-[220px]" data-dropdown-body>
                      <div className="max-h-80 overflow-y-auto">
                        {providers.filter((p) => p.enabled).map((p) => {
                          const enabledModels = p.models.filter((m) => m.enabled !== false);
                          if (enabledModels.length === 0) return null;
                          const hasActiveModel = enabledModels.some((m) => m.modelId === selectedModelId);
                          return (
                            <div key={p.id}
                              ref={(el) => { followupProviderRowRefs.current[p.id] = el; }}
                              onMouseEnter={() => { if (followupProviderHoverTimeout.current) clearTimeout(followupProviderHoverTimeout.current); setHoveredFollowupProvider(p.id); }}
                              onMouseLeave={() => { followupProviderHoverTimeout.current = setTimeout(() => setHoveredFollowupProvider(null), 200); }}>
                              <div className={`flex items-center justify-between px-3 py-2 cursor-pointer transition-colors ${hasActiveModel ? "text-dalam-accent-primary" : "text-dalam-text-primary hover:bg-dalam-bg-hover"}`}>
                                <span className="text-sm">{p.name}</span>
                                <div className="flex items-center gap-1">
                                  {hasActiveModel && <Check className="w-3.5 h-3.5 text-dalam-accent-primary" />}
                                  <ChevronRight className="w-3 h-3 text-dalam-text-muted" />
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                      <div className="border-t border-dalam-border-primary">
                        <button className="w-full text-left px-3 py-2 flex items-center gap-2 text-sm text-dalam-text-secondary hover:bg-dalam-bg-hover transition-colors"
                          onClick={() => { useSettingsView.getState().open("models"); setShowFollowupModelDropdown(false); }}>
                          <Settings className="w-4 h-4 text-dalam-text-muted" />
                          <span>Manage models</span>
                        </button>
                      </div>
                    </div>
                  )}
                  {showFollowupModelDropdown && hoveredFollowupProvider && (
                    <ModelSubDropdown
                      hoveredProvider={hoveredFollowupProvider}
                      providerRowRefs={followupProviderRowRefs}
                      modelRef={followupModelRef}
                      providers={providers}
                      selectedModelId={selectedModelId}
                      onSelect={(modelId) => { setSelectedModel(modelId); setShowFollowupModelDropdown(false); }}
                      onClose={() => setHoveredFollowupProvider(null)}
                      hoverTimeoutRef={followupProviderHoverTimeout}
                    />
                  )}
                </div>
                <button
                  className="w-8 h-8 flex items-center justify-center rounded-full bg-dalam-text-primary text-dalam-bg-primary hover:opacity-90 transition-opacity disabled:opacity-30 disabled:cursor-not-allowed"
                  disabled={!isStreaming && (!value.trim() || !workspace || (!selectedModelId && !settings.selectedModel))}
                  onClick={handleSubmit}
                  title={isStreaming ? "Stop generating" : !workspace ? "Open a folder first" : !selectedModelId ? "Select a model first" : "Send"}
                >
                  {isStreaming ? <Pause className="w-4 h-4" /> : <ArrowUp className="w-4 h-4" strokeWidth={2.5} />}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      {/* InterruptBar removed — use main input instead */}
    </div>
  );
}

/**
 * Sub-accordion wrapper for the agent's in-flight tool calls. While the agent
 * is streaming, the right side of the chat shows the running shell/read/edit
 * calls as a single collapsible group so the user can hide the noise and
 * focus on the streamed text.
 */
function ModelSubDropdown({ hoveredProvider, providerRowRefs, modelRef, providers, selectedModelId, onSelect, onClose, hoverTimeoutRef }: {
  hoveredProvider: string;
  providerRowRefs: React.MutableRefObject<Record<string, HTMLElement | null>>;
  modelRef: React.RefObject<HTMLDivElement | null>;
  providers: ModelProvider[];
  selectedModelId: string;
  onSelect: (modelId: string) => void;
  onClose: () => void;
  hoverTimeoutRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null>;
}) {
  const [style, setStyle] = useState<React.CSSProperties>({});
  const p = providers.find((pr) => pr.id === hoveredProvider);
  const enabledModels = p?.models.filter((m) => m.enabled !== false) ?? [];

  useLayoutEffect(() => {
    const rowEl = providerRowRefs.current[hoveredProvider];
    const dropdownEl = modelRef.current?.querySelector('[data-dropdown-body]');
    if (!rowEl || !dropdownEl) return;
    const rowRect = rowEl.getBoundingClientRect();
    const dropRect = dropdownEl.getBoundingClientRect();
    const subH = enabledModels.length * 40 + 8;
    const vpH = window.innerHeight;
    let top = rowRect.top;
    if (top + subH > vpH) top = Math.max(0, vpH - subH - 8);
    setStyle({ left: dropRect.right + 2, top });

    const scrollEl = dropdownEl;
    const onScroll = () => {
      const rr = rowEl.getBoundingClientRect();
      let t = rr.top;
      if (t + subH > vpH) t = Math.max(0, vpH - subH - 8);
      setStyle({ left: dropRect.right + 2, top: t });
    };
    scrollEl.addEventListener('scroll', onScroll, { passive: true });
    return () => scrollEl.removeEventListener('scroll', onScroll);
  }, [hoveredProvider, enabledModels.length]);

  if (!p || enabledModels.length === 0) return null;

  return ReactDOM.createPortal(
    <div className="fixed w-56 bg-dalam-bg-secondary border border-dalam-border-primary rounded-xl shadow-2xl z-[100]"
      style={style}
      data-model-subdropdown
      onMouseEnter={() => { if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current); }}
      onMouseLeave={() => { hoverTimeoutRef.current = setTimeout(onClose, 200); }}>
      <div className="max-h-64 overflow-y-auto">
        {enabledModels.map((m) => (
          <button key={m.modelId}
            className={`w-full text-left px-3 py-2 flex items-center gap-2 text-sm transition-colors ${selectedModelId === m.modelId ? "bg-dalam-bg-hover text-dalam-accent-primary" : "text-dalam-text-primary hover:bg-dalam-bg-hover"}`}
            onClick={() => { onSelect(m.modelId); }}>
            <span className="flex-1 truncate">{m.name}</span>
            {selectedModelId === m.modelId && <Check className="w-3.5 h-3.5 text-dalam-accent-primary" />}
          </button>
        ))}
      </div>
    </div>,
    document.body
  );
}

const EMPTY_ACTIVITIES: never[] = [];

const ChatMessage = React.memo(function ChatMessage({ message, pending, onResetToMessage, isLast }: { message: import("@dalam/shared-types").ChatMessage; pending?: boolean; onResetToMessage?: (content: string) => void; isLast?: boolean }) {
  const toast = useToast();
  const segments = useMemo(() => splitCodeFences(message.content), [message.content]);
  // For settled messages, activities come from message.activities (no store subscription needed).
  // For the streaming message, subscribe to pendingActivities.
  const pendingActivities = useChat((s) => pending ? s.pendingActivities : EMPTY_ACTIVITIES);
  const activities = message.activities ?? (pending ? pendingActivities : []);

  // System message: styled notification box
  if (message.role === "system") {
    return (
      <div className="py-2.5 px-3.5 my-3 bg-dalam-bg-secondary border border-dalam-border-primary rounded-xl text-xs text-dalam-text-secondary flex items-start gap-3 animate-fade-in shadow-sm max-w-2xl mx-auto">
        <Info className="w-4 h-4 text-dalam-accent-primary mt-0.5 flex-shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="font-semibold text-dalam-text-primary mb-1">System Notification</div>
          <div className="whitespace-pre-wrap leading-relaxed font-mono text-[11px] text-dalam-text-secondary">{message.content}</div>
        </div>
      </div>
    );
  }

  // User message: right-aligned with subtle background
  if (message.role === "user") {
    // Skip empty user messages (e.g. tool result placeholders that leaked through)
    if (!message.content && !message.attachments?.length) return null;
    return (
      <div className="group/usermsg py-2 animate-fade-in">
        <div className="flex justify-end">
          <div className="max-w-[80%]">
            {message.attachments && message.attachments.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mb-2 justify-end">
                {message.attachments.map((att) => (
                  <div key={att.id} className="flex items-center gap-1.5 px-2 py-1 bg-dalam-bg-active border border-dalam-border-primary rounded-md text-xs text-dalam-text-primary">
                    {att.mimeType.startsWith("image/") ? (
                      <img src={`data:${att.mimeType};base64,${att.content}`} alt={att.name} className="w-10 h-10 rounded object-cover" />
                    ) : (
                      <>
                        <FileText className="w-3.5 h-3.5 text-dalam-text-muted" />
                        <span className="max-w-[120px] truncate">{att.name}</span>
                      </>
                    )}
                  </div>
                ))}
              </div>
            )}
            <div className="bg-dalam-bg-secondary border border-dalam-border-primary rounded-xl rounded-tr-sm px-4 py-2.5 relative">
              <p className="text-[13px] text-dalam-text-primary leading-relaxed whitespace-pre-wrap break-words text-left">
                {message.content}
              </p>
              {/* Hover toolbar: copy + reset to checkpoint */}
              <div className="absolute -bottom-7 right-0 flex items-center gap-0.5 opacity-0 group-hover/usermsg:opacity-100 transition-opacity z-10">
                <button
                  className="p-1 rounded hover:bg-dalam-bg-hover text-dalam-text-muted hover:text-dalam-text-primary transition-colors"
                  title="Copy message"
                  onClick={() => { void navigator.clipboard.writeText(message.content); toast.success("Copied"); }}
                >
                  <Copy className="w-3 h-3" />
                </button>
                <button
                  className="p-1 rounded hover:bg-dalam-bg-hover text-dalam-text-muted hover:text-dalam-text-primary transition-colors"
                  title="Reset to this message (clear below, edit in input)"
                  onClick={() => {
                    // Find all messages after this one and remove them
                    const msgs = useChat.getState().messages;
                    const idx = msgs.findIndex((m) => m.id === message.id);
                    if (idx >= 0) {
                      const kept = msgs.slice(0, idx + 1);
                      useChat.setState({ messages: kept });
                      // Set the message content in the input for editing
                      onResetToMessage?.(message.content);
                    }
                  }}
                >
                  <RotateCcw className="w-3 h-3" />
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Assistant message: left-aligned with subtle accent
  // Skip empty assistant messages (no content, no activities, no tool calls)
  const hasContent = !!(message.content || pending);
  const hasActivities = activities.length > 0;
  const hasToolCalls = !!(message.toolCalls && message.toolCalls.length > 0);
  const hasTodos = !!(message.todos && message.todos.length > 0);
  const hasFileChanges = !!(message.fileChanges && message.fileChanges.length > 0);
  const hasThinking = !!(message.thinking);
  if (!hasContent && !hasActivities && !hasToolCalls && !hasTodos && !hasFileChanges && !hasThinking) {
    return null;
  }

  return (
    <div className="group/msg py-2 animate-fade-in">

      {/* Thinking block — model's reasoning, collapsed by default */}
      {!pending && message.thinking && (
        <ThinkingBlock content={message.thinking} />
      )}

      {/* Activity blocks (explore / read / skill / bash / plan) */}
      {hasActivities && (() => {
        // Group context-gathering activities (explore, read) into a collapsible section
        const CONTEXT_TYPES = new Set(["explore", "read"]);
        const contextActivities = activities.filter(a => CONTEXT_TYPES.has(a.type));
        const otherActivities = activities.filter(a => !CONTEXT_TYPES.has(a.type));

        return (
          <div className="my-0.5">
            {/* Context-gathering tools: collapsible group */}
            {contextActivities.length > 0 && (
              <ContextGatheringGroup activities={contextActivities} />
            )}
            {/* Other activities: rendered individually */}
            {otherActivities.map((activity) => {
              const ak = activity.id;
              if (activity.type === "skill") {
                return <SkillBlock key={ak} name={activity.name} content={activity.content} args={activity.args} />;
              }
              if (activity.type === "bash") {
                return <BashActivityBlock key={ak} command={activity.command} result={activity.result} />;
              }
              if (activity.type === "plan") {
                return <PlanBlock key={ak} plan={activity.plan} />;
              }
              if (activity.type === "think") {
                return <ThinkingBlock key={ak} content={activity.content} />;
              }
              return null;
            })}
          </div>
        );
      })()}


      {/* Main assistant message — rendered with markdown */}
      {hasContent && (
        <div className="text-[13px] text-dalam-text-primary leading-relaxed my-0.5">
          {segments.filter((seg) => seg.type !== "text" || seg.content.trim()).map((seg, idx) =>
            seg.type === "code"
              ? <CodeBlock key={"code-" + idx} language={seg.language ?? ""} content={seg.content} />
              : <div key={"txt-" + idx} className="prose-dalam mb-2 last:mb-0">
                  {pending
                    ? <StreamingContent content={seg.content} pending={true} />
                    : <MarkdownContent content={seg.content} />
                  }
                </div>
          )}
          {pending && (
            <span className="inline-block w-[2px] h-4 bg-dalam-accent-primary ml-0.5 animate-typing-cursor rounded-sm align-middle" />
          )}
        </div>
      )}

      {/* Tool calls from this AI turn — read_file, edit_file, shell, etc. */}
      {!pending && hasToolCalls && (
        <ToolCallsList toolCalls={message.toolCalls!} />
      )}

      {/* Todo checklist */}
      {!pending && hasTodos && (
        <TodoBlock todos={message.todos!} />
      )}

      {/* Task plan checklist */}
      {!pending && message.taskPlan && message.taskPlan.length > 0 && (
        <TaskPlanBlock tasks={message.taskPlan} summary={message.taskPlanSummary} />
      )}

      {/* Changes card — shows file modifications from this AI turn */}
      {!pending && hasFileChanges && (
        <ChangesCard changes={message.fileChanges!} />
      )}

      {/* Message meta footer — only on the last message when settled. */}
      {!pending && isLast && (message.content || hasToolCalls || hasFileChanges) && (
        <div className="flex items-center gap-2 mt-1 opacity-0 group-hover/msg:opacity-100 focus-within:opacity-100 transition-opacity">
          <div className="ml-auto flex items-center gap-0.5">
            {message.content && (
              <button
                className="p-1 rounded hover:bg-dalam-bg-hover text-dalam-text-muted hover:text-dalam-text-primary transition-colors"
                title="Copy"
                onClick={() => { void navigator.clipboard.writeText(message.content); toast.success("Copied"); }}
              >
                <Copy className="w-3 h-3" />
              </button>
            )}
            <button
              className="p-1 rounded hover:bg-dalam-bg-hover text-dalam-text-muted hover:text-dalam-text-primary transition-colors"
              title="Reset to before this message"
              onClick={() => {
                const msgs = useChat.getState().messages;
                const idx = msgs.findIndex((m) => m.id === message.id);
                if (idx > 0) {
                  // Keep messages before this one (find the last user message before this)
                  const kept = msgs.slice(0, idx);
                  useChat.setState({ messages: kept });
                  // Find the last user message to put back in input
                  const lastUser = [...kept].reverse().find((m) => m.role === "user");
                  if (lastUser) onResetToMessage?.(lastUser.content);
                } else if (idx === 0) {
                  useChat.setState({ messages: [] });
                }
              }}
            >
              <RotateCcw className="w-3 h-3" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}, (prevProps, nextProps) => {
  return (
    prevProps.pending === nextProps.pending &&
    prevProps.isLast === nextProps.isLast &&
    prevProps.onResetToMessage === nextProps.onResetToMessage &&
    prevProps.message.id === nextProps.message.id &&
    prevProps.message.content === nextProps.message.content &&
    prevProps.message.role === nextProps.message.role &&
    prevProps.message.thinking === nextProps.message.thinking &&
    (prevProps.message.activities ?? []).length === (nextProps.message.activities ?? []).length &&
    (prevProps.message.toolCalls ?? []).length === (nextProps.message.toolCalls ?? []).length &&
    (prevProps.message.fileChanges ?? []).length === (nextProps.message.fileChanges ?? []).length
  );
});


function AttachFileButton() {
  const inputRef = useRef<HTMLInputElement>(null);
  const { addPendingAttachment } = useChat();
  const toast = useToast();

  const readFile = async (file: File) => {
    return new Promise<{ content: string; mimeType: string }>((resolve) => {
      if (file.type.startsWith("image/")) {
        const reader = new FileReader();
        reader.onload = () => {
          const result = reader.result as string;
          const base64 = result.split(",")[1] || "";
          resolve({ content: base64, mimeType: file.type });
        };
        reader.onerror = () => resolve({ content: "", mimeType: file.type });
        reader.readAsDataURL(file);
      } else {
        const reader = new FileReader();
        reader.onload = () => resolve({ content: reader.result as string, mimeType: file.type || "text/plain" });
        reader.onerror = () => resolve({ content: "", mimeType: file.type || "text/plain" });
        reader.readAsText(file);
      }
    });
  };

  const handleFiles = async (files: FileList | null) => {
    if (!files) return;
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (file.size > 10 * 1024 * 1024) {
        toast.warning("File too large", `${file.name} exceeds 10MB limit`);
        continue;
      }
      const { content, mimeType } = await readFile(file);
      addPendingAttachment({
        id: "att-" + crypto.randomUUID(),
        name: file.name,
        mimeType,
        content,
        size: file.size,
      });
    }
    if (inputRef.current) inputRef.current.value = "";
  };

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        className="hidden"
        multiple
        accept="image/*,.txt,.js,.ts,.tsx,.jsx,.py,.rs,.go,.java,.c,.cpp,.h,.css,.html,.json,.md,.yaml,.yml,.toml,.sh,.sql,.csv,.xml,.swift,.rb,.php"
        onChange={(e) => void handleFiles(e.target.files)}
      />
      <Tooltip content="Add context" side="top">
        <button
          className="w-7 h-7 flex items-center justify-center rounded-md text-dalam-text-muted hover:text-dalam-text-primary hover:bg-dalam-bg-hover transition-colors"
          onClick={() => inputRef.current?.click()}
          aria-label="Add context"
        >
          <Plus className="w-4 h-4" />
        </button>
      </Tooltip>
    </>
  );
}

const MARKDOWN_REMARK_PLUGINS = [remarkGfm];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const MARKDOWN_COMPONENTS: Record<string, any> = {
  p: ({ children }: { children: React.ReactNode }) => <p className="whitespace-pre-wrap break-words mb-2 last:mb-0">{children}</p>,
  strong: ({ children }: { children: React.ReactNode }) => <strong className="font-semibold text-dalam-text-primary">{children}</strong>,
  em: ({ children }: { children: React.ReactNode }) => <em className="italic">{children}</em>,
  a: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { children: React.ReactNode }) => (
    <a
      href={href}
      {...props}
      onClick={(e) => {
        if (!href) return;
        try {
          const parsed = new URL(href);
          if (parsed.protocol === "http:" || parsed.protocol === "https:") {
            e.preventDefault();
            const ui = useUI.getState();
            ui.addBrowserTab({ url: href });
            ui.setRightPanelTab("browser");
            if (!ui.rightPanelOpen) ui.setRightPanelOpen(true);
          }
        } catch {
          // Invalid URL — let the browser handle it normally
        }
      }}
      className="text-dalam-accent-primary hover:underline cursor-pointer"
    >{children}</a>
  ),
  ul: ({ children }: { children: React.ReactNode }) => <ul className="list-disc list-inside mb-2 space-y-0.5">{children}</ul>,
  ol: ({ children }: { children: React.ReactNode }) => <ol className="list-decimal list-inside mb-2 space-y-0.5">{children}</ol>,
  li: ({ children }: { children: React.ReactNode }) => <li className="text-dalam-text-secondary">{children}</li>,
  h1: ({ children }: { children: React.ReactNode }) => <h1 className="text-lg font-bold mb-2 text-dalam-text-primary">{children}</h1>,
  h2: ({ children }: { children: React.ReactNode }) => <h2 className="text-base font-bold mb-2 text-dalam-text-primary">{children}</h2>,
  h3: ({ children }: { children: React.ReactNode }) => <h3 className="text-sm font-bold mb-1 text-dalam-text-primary">{children}</h3>,
  code: ({ children, className }: { children: React.ReactNode; className?: string }) => {
    const isInline = !className;
    if (isInline) {
      return <code className="px-1 py-0.5 bg-dalam-bg-tertiary rounded text-[12px] font-mono text-dalam-accent-primary">{children}</code>;
    }
    return <code className={className}>{children}</code>;
  },
  blockquote: ({ children }: { children: React.ReactNode }) => (
    <blockquote className="border-l-2 border-dalam-accent-primary/40 pl-3 my-2 text-dalam-text-muted italic">{children}</blockquote>
  ),
  hr: () => <hr className="my-3 border-dalam-border-primary" />,
  table: ({ children }: { children: React.ReactNode }) => <div className="overflow-x-auto my-2"><table className="text-xs border-collapse">{children}</table></div>,
  th: ({ children }: { children: React.ReactNode }) => <th className="px-2 py-1 border border-dalam-border-primary text-left font-medium">{children}</th>,
  td: ({ children }: { children: React.ReactNode }) => <td className="px-2 py-1 border border-dalam-border-primary">{children}</td>,
};

const MarkdownContent = React.memo(function MarkdownContent({ content }: { content: string }) {
  return (
    <Markdown
      remarkPlugins={MARKDOWN_REMARK_PLUGINS}
      components={MARKDOWN_COMPONENTS}
    >
      {content}
    </Markdown>
  );
});

// Lightweight streaming renderer — avoids expensive react-markdown re-parsing on each delta.
// Falls to raw <pre> display during streaming; switches to full Markdown when settled.
const StreamingContent = React.memo(function StreamingContent({ content, pending }: { content: string; pending: boolean }) {
  if (!pending || content.length < 200) {
    return <MarkdownContent content={content} />;
  }
  const segments = splitCodeFences(content);
  return (
    <div className="prose-dalam mb-2 last:mb-0">
      {segments.map((seg, idx) =>
        seg.type === "code"
          ? <StreamingCodeBlock key={"sc-" + idx} language={seg.language ?? ""} content={seg.content} />
          : <p key={"st-" + idx} className="whitespace-pre-wrap break-words mb-2 last:mb-0">{seg.content}</p>
      )}
    </div>
  );
});

const CodeBlock = React.memo(function CodeBlock({ language, content }: { language: string; content: string }) {
  const toast = useToast();
  const activeFilePath = useWorkspace((s) => s.activeFilePath);
  const updateTabContent = useWorkspace((s) => s.updateTabContent);
  const [expanded, setExpanded] = useState(true);
  const lines = content.split("\n");
  const isLong = lines.length > 30;

  const escapeHtml = useCallback((s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"), []);

  // Throttle hljs highlighting — re-runs at most once per 200ms during streaming
  const [highlighted, setHighlighted] = useState(() => escapeHtml(content));
  useEffect(() => {
    const timer = setTimeout(() => {
      if (language && hljs.getLanguage(language)) {
        try { setHighlighted(hljs.highlight(content, { language }).value); } catch { setHighlighted(escapeHtml(content)); }
      } else {
        try { setHighlighted(hljs.highlight(content, { language: "plaintext" }).value); } catch { setHighlighted(escapeHtml(content)); }
      }
    }, 200);
    return () => clearTimeout(timer);
  }, [content, language, escapeHtml]);

  const handleApply = useCallback(() => {
    if (!activeFilePath) {
      toast.info("No active file open in the editor");
      return;
    }
    const { openTabs } = useWorkspace.getState();
    const currentTab = openTabs.find((t) => t.path === activeFilePath);
    const hasExistingContent = currentTab && currentTab.content.trim().length > 0;
    if (hasExistingContent) {
      if (!window.confirm(`Overwrite entire content of ${basename(activeFilePath)}? This cannot be undone.`)) return;
    }
    updateTabContent(activeFilePath, content);
    toast.success("Applied to editor");
  }, [activeFilePath, content, updateTabContent, toast]);

  return (
    <div className="my-2 bg-dalam-bg-primary border border-dalam-border-primary rounded-lg overflow-hidden">
      <div className="flex items-center justify-between px-3 py-1.5 bg-dalam-bg-tertiary border-b border-dalam-border-primary">
        <div className="flex items-center gap-1.5 text-[10px] text-dalam-text-muted"><FileCode className="w-3 h-3" />{language || "code"}<span className="text-dalam-text-muted/50">· {lines.length} lines</span></div>
        <div className="flex items-center gap-1">
          {isLong && (
            <button
              className="text-[10px] text-dalam-text-muted hover:text-dalam-text-primary flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-dalam-bg-hover transition-colors"
              onClick={() => setExpanded(!expanded)}
            >{expanded ? "Collapse" : "Expand"}</button>
          )}
          <button className="text-[10px] text-dalam-text-muted hover:text-dalam-text-primary flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-dalam-bg-hover transition-colors" onClick={handleApply}>Apply</button>
          <button className="text-[10px] text-dalam-text-muted hover:text-dalam-text-primary flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-dalam-bg-hover transition-colors"
            onClick={() => { void navigator.clipboard.writeText(content); toast.success("Copied"); }}><Copy className="w-3 h-3" /></button>
        </div>
      </div>
      <pre
        className="p-3 text-[12px] text-mono text-dalam-text-primary overflow-x-auto scrollbar-thin leading-relaxed"
        style={{ maxHeight: isLong && !expanded ? "240px" : undefined }}
      ><code dangerouslySetInnerHTML={{ __html: highlighted }} /></pre>
      {isLong && !expanded && (
        <button
          className="w-full py-1.5 text-[10px] text-dalam-accent-primary hover:bg-dalam-bg-hover border-t border-dalam-border-primary transition-colors"
          onClick={() => setExpanded(true)}
        >Show all {lines.length} lines</button>
      )}
    </div>
  );
});

// Streaming code block — shows loading state during stream, full code when complete
const StreamingCodeBlock = React.memo(function StreamingCodeBlock({ language, content }: { language: string; content: string }) {
  const [isComplete, setIsComplete] = useState(false);
  const lines = content.split("\n");
  const isLong = lines.length > 30;
  const [expanded, setExpanded] = useState(true);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => setIsComplete(true), 200);
    return () => { if (timeoutRef.current) clearTimeout(timeoutRef.current); };
  }, [content]);

  const escapeHtml = useCallback((s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"), []);
  const [highlighted, setHighlighted] = useState(() => escapeHtml(content));
  useEffect(() => {
    const timer = setTimeout(() => {
      if (language && hljs.getLanguage(language)) {
        try { setHighlighted(hljs.highlight(content, { language }).value); } catch { setHighlighted(escapeHtml(content)); }
      } else {
        try { setHighlighted(hljs.highlightAuto(content).value); } catch { setHighlighted(escapeHtml(content)); }
      }
    }, 150);
    return () => clearTimeout(timer);
  }, [content, language, escapeHtml]);

  if (!isComplete) {
    return (
      <div className="my-2 bg-dalam-bg-primary border border-dalam-border-primary/50 rounded-lg overflow-hidden">
        <div className="flex items-center gap-2 px-3 py-1.5 bg-dalam-bg-tertiary/50 border-b border-dalam-border-primary/50">
          <Loader2 className="w-3 h-3 animate-spin text-dalam-accent-primary" />
          <span className="text-[10px] text-dalam-text-muted font-mono">{language || "code"}</span>
          <span className="text-[10px] text-dalam-text-muted/50">· writing...</span>
        </div>
        <div className="p-3 text-[12px] font-mono text-dalam-text-primary/30 h-16 overflow-hidden">
          <pre className="whitespace-pre-wrap break-words">{content.slice(0, 80)}{content.length > 80 ? "..." : ""}</pre>
        </div>
      </div>
    );
  }

  return (
    <div className="my-2 bg-dalam-bg-primary border border-dalam-border-primary rounded-lg overflow-hidden animate-fade-in">
      <div className="flex items-center justify-between px-3 py-1.5 bg-dalam-bg-tertiary border-b border-dalam-border-primary">
        <div className="flex items-center gap-1.5 text-[10px] text-dalam-text-muted">
          <FileCode className="w-3 h-3" />
          {language || "code"}
          <span className="text-dalam-text-muted/50">· {lines.length} lines</span>
        </div>
        <div className="flex items-center gap-1">
          {isLong && (
            <button
              className="text-[10px] text-dalam-text-muted hover:text-dalam-text-primary px-1.5 py-0.5 rounded hover:bg-dalam-bg-hover transition-colors"
              onClick={() => setExpanded(!expanded)}
            >{expanded ? "Collapse" : "Expand"}</button>
          )}
          <button className="text-[10px] text-dalam-text-muted hover:text-dalam-text-primary px-1.5 py-0.5 rounded hover:bg-dalam-bg-hover transition-colors"
            onClick={() => { void navigator.clipboard.writeText(content); }}>Copy</button>
        </div>
      </div>
      <pre
        className="p-3 text-[12px] font-mono text-dalam-text-primary overflow-x-auto scrollbar-thin leading-relaxed"
        style={{ maxHeight: isLong && !expanded ? "240px" : undefined }}
      ><code dangerouslySetInnerHTML={{ __html: highlighted }} /></pre>
      {isLong && !expanded && (
        <button
          className="w-full py-1.5 text-[10px] text-dalam-accent-primary hover:bg-dalam-bg-hover border-t border-dalam-border-primary transition-colors"
          onClick={() => setExpanded(true)}
        >Show all {lines.length} lines</button>
      )}
    </div>
  );
});

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function splitCodeFences(text: string): { type: "text" | "code"; content: string; language?: string }[] {
  const out: { type: "text" | "code"; content: string; language?: string }[] = [];
  // Match ```lang\n...``` OR ```lang``` (no newline after opening fence)
  const re = /```(\w*)(?:\n([\s\S]*?))?\n?```/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    if (match.index > last) out.push({ type: "text", content: text.slice(last, match.index) });
    out.push({ type: "code", content: match[2] ?? "", language: match[1] });
    last = match.index + match[0].length;
  }
  if (last < text.length) {
    const rest = text.slice(last);
    const fenceIdx = rest.indexOf("```");
    if (fenceIdx !== -1) {
      if (fenceIdx > 0) {
        out.push({ type: "text", content: rest.slice(0, fenceIdx) });
      }
      const codePart = rest.slice(fenceIdx + 3);
      const newlineIdx = codePart.indexOf("\n");
      if (newlineIdx !== -1) {
        const language = codePart.slice(0, newlineIdx).trim();
        const content = codePart.slice(newlineIdx + 1);
        out.push({ type: "code", content, language });
      } else {
        out.push({ type: "code", content: "", language: codePart.trim() });
      }
    } else {
      out.push({ type: "text", content: rest });
    }
  }
  return out;
}

function findFirstFile(nodes: import("@dalam/shared-types").FileNode[]): string | null {
  for (const n of nodes) {
    if (n.type === "file" && n.name !== ".gitignore") return n.path;
    if (n.children) { const inner = findFirstFile(n.children); if (inner) return inner; }
  }
  return null;
}

function StreamingMessageWrapper({
  scrollRef,
  isUserScrolledUp,
  timestamp,
}: {
  scrollRef: React.RefObject<HTMLDivElement | null>;
  isUserScrolledUp: React.RefObject<boolean>;
  timestamp: number;
}) {
  const isStreaming = useChat((s) => s.isStreaming);
  const streamingContent = useChat((s) => s.streamingContent);
  const thinkingContent = useChat((s) => s.thinkingContent);
  const pendingToolCalls = useChat((s) => s.pendingToolCalls);
  const pendingActivities = useChat((s) => s.pendingActivities);
  const session = useChat((s) => s.session);

  const cleanRef = useRef("");
  const lastRawLenRef = useRef(0); // Track raw length for correct delta computation
  const pendingContentRef = useRef("");
  const pendingThinkingRef = useRef("");
  const cleanThinkingRef = useRef(""); // Ref for thinking comparison (avoids stale closure)
  const lastUpdateRef = useRef(0);
  const timeoutIdRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [cleanStreamingContent, setCleanStreamingContent] = useState("");
  const [cleanThinkingContent, setCleanThinkingContent] = useState("");

  useEffect(() => {
    if (!streamingContent && !thinkingContent) {
      if (cleanRef.current !== "" || cleanThinkingRef.current !== "") {
        cleanRef.current = "";
        lastRawLenRef.current = 0;
        pendingContentRef.current = "";
        pendingThinkingRef.current = "";
        cleanThinkingRef.current = "";
        setCleanStreamingContent("");
        setCleanThinkingContent("");
        lastUpdateRef.current = 0;
        if (timeoutIdRef.current) { clearTimeout(timeoutIdRef.current); timeoutIdRef.current = null; }
      }
      return;
    }
    pendingContentRef.current = streamingContent;
    pendingThinkingRef.current = thinkingContent;

    const performUpdate = () => {
      const raw = pendingContentRef.current;
      const rawThinking = pendingThinkingRef.current;
      
      const cleaned = stripXmlToolCallTags(raw);
      let changed = false;
      if (cleanRef.current !== cleaned) {
        cleanRef.current = cleaned;
        setCleanStreamingContent(cleaned);
        changed = true;
      }
      // Use ref for comparison to avoid stale closure
      if (cleanThinkingRef.current !== rawThinking) {
        cleanThinkingRef.current = rawThinking;
        setCleanThinkingContent(rawThinking);
        changed = true;
      }
      if (changed) {
        lastUpdateRef.current = Date.now();
        lastRawLenRef.current = raw.length;
      }
      timeoutIdRef.current = null;
    };

    const now = Date.now();
    const elapsed = now - lastUpdateRef.current;

    // Boundary-based batching: render only when complete sentences or lines are formed,
    // or when the fallback timeout (350ms) is reached to prevent lag feeling.
    // Use raw-to-raw delta (not stripped-to-raw) for correct boundary detection.
    const raw = streamingContent;
    const delta = raw.slice(lastRawLenRef.current);

    const hasLineBreak = delta.includes("\n");
    const hasSentenceEnd = /[.!?](\s|$)/.test(delta);
    const hasCodeBlock = delta.includes("```");
    const isBoundary = hasLineBreak || hasSentenceEnd || hasCodeBlock;

    const throttleLimit = 16; // ~1 frame for instant streaming feedback

    if (isBoundary || elapsed >= throttleLimit) {
      if (timeoutIdRef.current) { clearTimeout(timeoutIdRef.current); timeoutIdRef.current = null; }
      performUpdate();
    } else {
      if (!timeoutIdRef.current) {
        timeoutIdRef.current = setTimeout(performUpdate, Math.min(throttleLimit - elapsed, 16)); // Cap at ~1 frame for smoothness
      }
    }

    return () => {
      if (timeoutIdRef.current) { clearTimeout(timeoutIdRef.current); timeoutIdRef.current = null; }
    };
  }, [streamingContent, thinkingContent]);

  // Handle auto-scroll on content updates inside the wrapper to keep ChatView from re-rendering
  useEffect(() => {
    if (!isUserScrolledUp.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [cleanStreamingContent, cleanThinkingContent, scrollRef, isUserScrolledUp]);

  if (!isStreaming) return null;

  return (
    <>
      <StreamingActivityPanel
        activities={pendingActivities}
        toolCalls={pendingToolCalls}
        thinkingContent={cleanThinkingContent}
        sessionStartTime={session?.startedAt ?? timestamp}
      />
      {cleanStreamingContent && (
        <ChatMessage
          message={{
            id: "streaming",
            role: "assistant",
            content: cleanStreamingContent, // raw content — StreamingContent handles code fences
            timestamp: timestamp,
            ...(cleanThinkingContent ? { thinking: cleanThinkingContent } : {}),
          }}
          pending
        />
      )}
      {!cleanStreamingContent && pendingToolCalls.length === 0 && pendingActivities.length === 0 && !cleanThinkingContent && (
        <div className="py-3 animate-fade-in-up">
          <div className="flex items-center gap-3 text-[13px] text-dalam-text-secondary">
            <div className="animate-thinking-wave">
              <span /><span /><span /><span /><span />
            </div>
            <span className="opacity-70">Thinking</span>
          </div>
        </div>
      )}
    </>
  );
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function completeStreamingMarkdown(text: string): string {
  if (!text) return "";
  const lines = text.split("\n");
  let inTable = false;
  let headerColCount = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const nextLine = lines[i + 1]?.trim() ?? "";
    const isNextSeparator = nextLine && /^[|:\-\s]+$/.test(nextLine) && nextLine.includes("-");

    if (isNextSeparator && !inTable) {
      // Current line is table header. Count columns
      const cols = line.split("|").map(s => s.trim()).filter(Boolean);
      headerColCount = cols.length;
      inTable = true;
    } else if (inTable) {
      // Check if this is the separator row itself
      const isSeparator = /^[|:\-\s]+$/.test(line) && line.includes("-");
      if (isSeparator) {
        const sepCols = line.split("|").filter(Boolean);
        if (sepCols.length < headerColCount) {
          const missing = headerColCount - sepCols.length;
          // Append missing separators nicely
          let completedLine = line;
          if (!completedLine.endsWith("|") && completedLine.includes("|")) {
            completedLine += "|";
          }
          completedLine += "---|".repeat(missing);
          lines[i] = completedLine;
        }
      } else if (line.startsWith("|") || line.includes("|")) {
        // Normal row. Balance columns to prevent misaligned borders
        const rowColsCount = line.split("|").filter(Boolean).length;
        if (rowColsCount < headerColCount) {
          const missing = headerColCount - rowColsCount;
          let completedLine = line;
          if (!completedLine.endsWith("|") && completedLine.includes("|")) {
            completedLine += "|";
          }
          completedLine += " |".repeat(missing);
          lines[i] = completedLine;
        }
      } else {
        // Table ended
        inTable = false;
        headerColCount = 0;
      }
    }
  }

  let completedText = lines.join("\n");

  // Auto-close unclosed code fences during streaming.
  // Count triple-backtick occurrences; if odd, append a closing fence
  // so the markdown parser renders the in-progress code block properly.
  const fenceMatches = completedText.match(/```/g);
  const fenceCount = fenceMatches ? fenceMatches.length : 0;
  if (fenceCount % 2 !== 0) {
    completedText += "\n```";
  }

  // Auto-close inline formatting tags (bold, italic, strikethrough, inline code)
  const stack: string[] = [];
  let idx = 0;
  while (idx < completedText.length) {
    if (completedText.startsWith("```", idx)) {
      // Skip block code contents entirely
      const endIdx = completedText.indexOf("```", idx + 3);
      if (endIdx !== -1) {
        idx = endIdx + 3;
      } else {
        break;
      }
    } else if (completedText.startsWith("`", idx)) {
      if (stack[stack.length - 1] === "`") {
        stack.pop();
      } else {
        stack.push("`");
      }
      idx += 1;
    } else if (completedText.startsWith("**", idx) || completedText.startsWith("__", idx)) {
      const tag = completedText.slice(idx, idx + 2);
      if (stack[stack.length - 1] === tag) {
        stack.pop();
      } else {
        stack.push(tag);
      }
      idx += 2;
    } else if (completedText.startsWith("*", idx) || completedText.startsWith("_", idx)) {
      const tag = completedText.slice(idx, idx + 1);
      if (stack[stack.length - 1] === tag) {
        stack.pop();
      } else {
        stack.push(tag);
      }
      idx += 1;
    } else if (completedText.startsWith("~~", idx)) {
      if (stack[stack.length - 1] === "~~") {
        stack.pop();
      } else {
        stack.push("~~");
      }
      idx += 2;
    } else {
      idx += 1;
    }
  }

  while (stack.length > 0) {
    const tag = stack.pop();
    completedText += tag;
  }

  return completedText;
}
