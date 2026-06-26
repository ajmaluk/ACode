import React, { useEffect, useRef, useState, useMemo, useCallback, useLayoutEffect } from "react";
import ReactDOM from "react-dom";
import { useWorkspace, useSettings, useChat, useGit, useModelProviders, useSettingsView, useUI, useAgents, PRIMARY_AGENTS, getPrimaryAgent, type ModelProvider } from "@/store/useAppStore";
import type { PrimaryAgentName, FileNode } from "@dalam/shared-types";
import { CodeView } from "@/components/editor/Editor";
import { Breadcrumb } from "@/components/editor/Breadcrumb";
import { TopNav } from "@/components/editor/TopNav";
import {
  X, FileCode, FilePlus, Circle, MoreHorizontal, Columns, ArrowUp,
  ChevronDown, ChevronUp, ChevronRight, Shield, Loader2, Sparkles,
  FileText, GitBranch, Clock, Terminal, Search,
  FolderOpen, Check, ClipboardList, Settings, Zap, Hash, Cpu, RotateCcw, History, Paperclip, Info, Copy, Code2,
} from "lucide-react";
import { useToast } from "@/components/ui/Toaster";
import { createDalamAPI } from "@/lib/dalamAPI";
import { ThinkingBlock, ToolCallsList, ChangesCard, TodoBlock, ReadBlock, ExploreBlock, SkillBlock, PlanBlock, BashActivityBlock, TaskPlanBlock, ContextGatheringGroup } from "@/components/chat/ActivityBlocks";
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

  return (
    <div className="animate-fade-in">
      {/* Task plan (if LLM declared one) */}
      {taskPlan && taskPlan.length > 0 && (
        <TaskPlanBlock tasks={taskPlan} summary={taskPlanSummary} />
      )}

      {/* Working timer */}
      <div className="mb-2">
        <WorkingTimer startTime={sessionStartTime} />
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
              const args = tc.args as Record<string, any> | undefined;
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

// Map primary agent → UI-friendly label and icon. Mirrors Dalam's
// primary agent presentation.
const AGENT_DISPLAY: Record<PrimaryAgentName, { label: string; description: string; icon: React.ElementType; color: string; short: string }> = {
  build: { label: "Build", short: "build", description: "Executes tools based on configured permissions. Asks before each operation.", icon: Zap, color: "text-amber-400" },
  plan: { label: "Plan", short: "plan", description: "Read-only analysis. Produces a plan you can review, then switches to Build to execute.", icon: ClipboardList, color: "text-emerald-400" },
  yolo: { label: "YOLO", short: "yolo", description: "Full access — reads, writes, executes everything without asking. Use with caution.", icon: Sparkles, color: "text-rose-400" },
};

export function EditorPane() {
  const { openTabs, activeFilePath, setActiveFile, closeTab, updateTabContent, markSaved, fileTree, openFile } = useWorkspace();
  const toast = useToast();
  const activeTab = openTabs.find((t) => t.path === activeFilePath) ?? null;
  const mod = modKey();

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

// Removed dead SidebarToggleButton and RightPanelToggleButton components

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
    <div className="border-t border-dalam-border-primary px-3 pt-1.5 pb-0 flex-shrink-0 bg-dalam-bg-primary">
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
  const { sendMessage, isStreaming, messages, streamingContent, thinkingContent, selectedModelId, setSelectedModel, pendingToolCalls, resolveToolApproval, chatSessions, planApproval, approvePlan, rejectPlan, restoredVersionId, sessionVersions, activeSessionId, cancelVersionRestore, confirmVersionRestore, pendingAttachments, removePendingAttachment, pendingActivities, session } = useChat();
  const { providers, getAllModels } = useModelProviders();
  const { status: gitStatus } = useGit();
  const { activeAgentName, setActiveAgent, agents } = useAgents();
  const toast = useToast();
  const activeAgent = getPrimaryAgent(activeAgentName);
  const agentInfo = AGENT_DISPLAY[activeAgentName];
  const mod = modKey();
  const AgentIcon = agentInfo.icon;
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
  const [showAgentDropdown, setShowAgentDropdown] = useState(false);
  const [showModelDropdown, setShowModelDropdown] = useState(false);
  const [hoveredProvider, setHoveredProvider] = useState<string | null>(null);
  const providerHoverTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [showFollowupAgentDropdown, setShowFollowupAgentDropdown] = useState(false);
  const [showFollowupModelDropdown, setShowFollowupModelDropdown] = useState(false);
  const [inputExpanded, setInputExpanded] = useState(false);
  const [timestamp] = useState(() => Date.now());

  // Cleanup provider hover timeout on unmount
  useEffect(() => {
    return () => { if (providerHoverTimeout.current) clearTimeout(providerHoverTimeout.current); };
  }, []);

  // Refs for click-outside detection
  const workspaceRef = useRef<HTMLDivElement>(null);
  const branchRef = useRef<HTMLDivElement>(null);
  const agentRef = useRef<HTMLDivElement>(null);
  const modelRef = useRef<HTMLDivElement>(null);
  const followupAgentRef = useRef<HTMLDivElement>(null);
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

  // Auto-scroll only if user hasn't scrolled up
  useEffect(() => {
    if (!isUserScrolledUp.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, streamingContent, thinkingContent]);

  const hasMessages = messages.length > 0;
  const hasMessagesRef = useRef(false);
  useEffect(() => {
    hasMessagesRef.current = messages.length > 0;
  }, [messages.length]);

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
      if (agentRef.current && !agentRef.current.contains(target)) setShowAgentDropdown(false);
      if (modelRef.current && !modelRef.current.contains(target)) setShowModelDropdown(false);
      if (followupAgentRef.current && !followupAgentRef.current.contains(target)) setShowFollowupAgentDropdown(false);
      if (followupModelRef.current && !followupModelRef.current.contains(target)) setShowFollowupModelDropdown(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const handleSubmit = () => {
    if (!value.trim() || isStreaming) return;
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
  /agent [id] - Switch the active agent (build / plan / yolo)
  /plan       - Switches active agent to Plan mode
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
      const targetAgentName = trimmed.slice(6).trim().toLowerCase();
      
      if (!targetAgentName) {
        const agentList = PRIMARY_AGENTS.map(a => {
          const display = AGENT_DISPLAY[a.name as import("@dalam/shared-types").PrimaryAgentName];
          return `- ${a.name} (${display?.label ?? a.name})`;
        }).join("\n");
        chat.injectSystemMessage(`Usage: /agent <agentName>\n\nAvailable Primary Agents:\n${agentList}`);
      } else {
        const found = PRIMARY_AGENTS.find(a => {
          const display = AGENT_DISPLAY[a.name as import("@dalam/shared-types").PrimaryAgentName];
          return a.name.toLowerCase() === targetAgentName || 
                 (display && display.label.toLowerCase().includes(targetAgentName));
        });
        if (found) {
          useAgents.getState().setActiveAgent(found.name as import("@dalam/shared-types").PrimaryAgentName);
          const display = AGENT_DISPLAY[found.name as import("@dalam/shared-types").PrimaryAgentName];
          chat.injectSystemMessage(`Active agent switched to: ${display?.label ?? found.name} (${found.name})`);
        } else {
          chat.injectSystemMessage(`Agent "${targetAgentName}" not found. Type "/agent" to see available options.`);
        }
      }
      setValue("");
      return;
    }

    if (trimmed === "/plan") {
      useAgents.getState().setActiveAgent("plan");
      chat.injectSystemMessage("Active agent switched to: Plan mode (Read-only analysis)");
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
      const formatted = messages.map(m => `### ${m.role.toUpperCase()}:\n\n${m.content}\n`).join("\n---\n\n");
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
            {/* Large background A watermark — low opacity, behind everything */}
            <div aria-hidden="true" className="pointer-events-none absolute inset-0 flex items-center justify-center select-none">
              <span
                className="text-dalam-text-primary"
                style={{
                  fontFamily: "'Newsreader', 'Iowan Old Style', 'Georgia', serif",
                  fontSize: "min(95vh, 1300px)",
                  fontWeight: 300,
                  lineHeight: 0.85,
                  letterSpacing: "-0.06em",
                  opacity: 0.07,
                  transform: "translateY(4.5%) rotate(90deg)",
                  userSelect: "none",
                }}
              >
                A
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
                      onClick={() => { setShowWorkspaceDropdown((v) => !v); setShowBranchDropdown(false); setShowAgentDropdown(false); setShowModelDropdown(false); }}
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
                        onClick={() => { setShowBranchDropdown((v) => !v); setShowWorkspaceDropdown(false); setShowAgentDropdown(false); setShowModelDropdown(false); }}>
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
                <div className={`px-4 py-2.5 relative ${inputExpanded ? "min-h-[200px]" : ""}`}>
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
                    className={`w-full bg-transparent border-0 outline-none text-sm text-dalam-text-primary placeholder-dalam-text-muted resize-none leading-relaxed overflow-hidden transition-all ${inputExpanded ? "min-h-[160px]" : "min-h-[28px]"}`}
                    placeholder={
                      activeAgentName === "plan"
                        ? "Describe a task to plan. The agent will explore the codebase, produce a plan, and ask you to approve before executing."
                        : activeAgentName === "yolo"
                          ? "YOLO mode — everything runs without permission prompts. Be specific about what you want."
                          : "Ask Dalam anything, @ to add files, / for commands, $ for skills, # for related conversations"
                    }
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                    onKeyDown={handleKeyDown}
                    rows={inputExpanded ? 8 : 1}
                    disabled={isStreaming}
                  />
                  <PromptAutocomplete
                    value={value}
                    onChange={setValue}
                    textareaRef={mainTextareaRef}
                    fileTree={fileTree}
                    chatSessions={chatSessions}
                    keyHandlerRef={mainAutocompleteKey}
                  />
                  {/* Expand/Collapse button */}
                  <button
                    className="absolute bottom-1 right-1 w-6 h-6 flex items-center justify-center rounded text-dalam-text-muted hover:text-dalam-text-primary hover:bg-dalam-bg-hover transition-colors"
                    onClick={() => setInputExpanded((v) => !v)}
                    title={inputExpanded ? "Collapse input" : "Expand input"}
                  >
                    {inputExpanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronUp className="w-3.5 h-3.5" />}
                  </button>
                </div>
                <div className="flex items-center justify-between px-4 pb-2.5">
                  <div className="flex items-center gap-2">
                    <AttachFileButton />
                    <div className="relative" ref={agentRef}>
                      <button className={`flex items-center gap-1.5 px-2.5 py-1 text-xs hover:bg-dalam-bg-hover rounded-md transition-colors ${agentInfo.color}`}
                        onClick={() => { setShowAgentDropdown((v) => !v); setShowWorkspaceDropdown(false); setShowBranchDropdown(false); setShowModelDropdown(false); }}
                        title={`Primary agent: ${agentInfo.label}`}
                      >
                        <AgentIcon className="w-3.5 h-3.5" />
                        <span>{agentInfo.label}</span>
                        <ChevronDown className="w-3 h-3" />
                      </button>
                      {showAgentDropdown && (
                        <div className="absolute bottom-full left-0 mb-1 w-80 bg-dalam-bg-secondary border border-dalam-border-primary rounded-xl shadow-2xl z-50 overflow-hidden">
                          <div className="px-3 py-2 border-b border-dalam-border-primary">
                            <div className="text-[10px] uppercase tracking-wider text-dalam-text-muted">Primary agent</div>
                            <div className="text-xs text-dalam-text-muted mt-0.5">Switches the active agent and its permission policy.</div>
                          </div>
                          {PRIMARY_AGENTS.map((agent) => {
                            const meta = AGENT_DISPLAY[agent.name as PrimaryAgentName];
                            const Icon = meta.icon;
                            return (
                              <button key={agent.name}
                                className={`w-full text-left px-4 py-3 flex items-start gap-3 hover:bg-dalam-bg-hover transition-colors ${activeAgentName === agent.name ? "bg-dalam-bg-hover" : ""}`}
                                onClick={() => { setActiveAgent(agent.name as PrimaryAgentName); setShowAgentDropdown(false); }}>
                                <Icon className={`w-4 h-4 mt-0.5 flex-shrink-0 ${meta.color}`} />
                                <div className="flex-1 min-w-0">
                                  <div className="text-sm text-dalam-text-primary font-medium flex items-center gap-1.5">
                                    {meta.label}
                                    {activeAgentName === agent.name && <span className="text-[9px] uppercase text-dalam-accent-primary tracking-wider">active</span>}
                                  </div>
                                  <div className="text-xs text-dalam-text-muted mt-0.5">{meta.description}</div>
                                </div>
                                {activeAgentName === agent.name && <Check className="w-4 h-4 text-dalam-accent-primary flex-shrink-0 mt-0.5" />}
                              </button>
                            );
                          })}
                          <div className="border-t border-dalam-border-primary px-3 py-2">
                            <button
                              onClick={() => { useSettingsView.getState().open("permissions"); setShowAgentDropdown(false); }}
                              className="text-xs text-dalam-text-secondary hover:text-dalam-text-primary flex items-center gap-1.5"
                            >
                              <Shield className="w-3 h-3" />
                              Configure permission rules…
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="relative" ref={modelRef}>
                      <button className="flex items-center gap-1.5 px-2.5 py-1 text-xs text-dalam-text-secondary hover:bg-dalam-bg-hover rounded-md transition-colors"
                        onClick={() => { setShowModelDropdown((v) => !v); setShowWorkspaceDropdown(false); setShowBranchDropdown(false); setShowAgentDropdown(false); }}>
                        <span className={`w-2 h-2 rounded-full ${currentModel ? "bg-dalam-git-added" : "bg-dalam-text-muted"}`} />
                        {currentModel?.model.name || (selectedModelId || "Select model")}
                        <ChevronDown className="w-3 h-3" />
                      </button>
                      {showModelDropdown && (
                        <div className="absolute bottom-full right-0 mb-1 bg-dalam-bg-secondary border border-dalam-border-primary rounded-xl shadow-2xl z-50 min-w-[220px]" data-dropdown-body>
                          <div className="max-h-80 overflow-y-auto">
                            {providers.filter((p) => p.enabled).map((p) => {
                              const enabledModels = p.models.filter((m) => (m as any).enabled !== false);
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
                    <button
                      className="w-8 h-8 flex items-center justify-center rounded-lg bg-dalam-text-primary text-dalam-bg-primary hover:opacity-90 transition-opacity disabled:opacity-30 disabled:cursor-not-allowed"
                      disabled={!value.trim() || isStreaming || !workspace || (!selectedModelId && !settings.selectedModel)}
                      onClick={handleSubmit}
                      title={!workspace ? "Open a folder first" : !selectedModelId ? "Select a model first" : isStreaming ? "Streaming…" : "Send"}
                    >
                      {isStreaming ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArrowUp className="w-4 h-4" strokeWidth={2.5} />}
                    </button>
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
            {messages.map((m) => <ChatMessage key={m.id} message={m} activeAgentName={activeAgentName} />)}
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
            {isStreaming && (
              <StreamingActivityPanel
                activities={pendingActivities}
                toolCalls={pendingToolCalls}
                thinkingContent={thinkingContent}
                sessionStartTime={session?.startedAt ?? timestamp}
              />
            )}
            {isStreaming && streamingContent && (
              <ChatMessage
                message={{
                  id: "streaming",
                  role: "assistant",
                  content: streamingContent,
                  timestamp: timestamp,
                  ...(thinkingContent ? { thinking: thinkingContent } : {}),
                }}
                pending
                activeAgentName={activeAgentName}
              />
            )}
            {isStreaming && !streamingContent && pendingToolCalls.length === 0 && pendingActivities.length === 0 && !thinkingContent && (
              <div className="py-3 animate-fade-in-up">
                <div className="flex items-center gap-3 text-[13px] text-dalam-text-secondary">
                  <div className="animate-thinking-wave">
                    <span /><span /><span /><span /><span />
                  </div>
                  <span className="opacity-70">Thinking</span>
                  <Dots />
                </div>
              </div>
            )}
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
        <div className="border-t border-dalam-border-primary p-3 flex-shrink-0 bg-dalam-bg-primary">
          <div className="bg-dalam-bg-secondary border border-dalam-border-primary rounded-xl shadow-lg">
            <div className={`px-4 py-3 relative ${inputExpanded ? "min-h-[200px]" : ""}`}>
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
                className={`w-full bg-transparent border-0 outline-none text-sm text-dalam-text-primary placeholder-dalam-text-muted resize-none overflow-hidden transition-all ${inputExpanded ? "min-h-[160px]" : "min-h-[40px]"}`}
                placeholder="Ask for follow-up changes" value={value} onChange={(e) => setValue(e.target.value)}
                onKeyDown={handleFollowupKeyDown} rows={inputExpanded ? 8 : 1} disabled={isStreaming} />
              <PromptAutocomplete
                value={value}
                onChange={setValue}
                textareaRef={followupTextareaRef}
                fileTree={fileTree}
                chatSessions={chatSessions}
                keyHandlerRef={followupAutocompleteKey}
              />
              {/* Expand/Collapse button */}
              <button
                className="absolute bottom-1 right-1 w-6 h-6 flex items-center justify-center rounded text-dalam-text-muted hover:text-dalam-text-primary hover:bg-dalam-bg-hover transition-colors"
                onClick={() => setInputExpanded((v) => !v)}
                title={inputExpanded ? "Collapse input" : "Expand input"}
              >
                {inputExpanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronUp className="w-3.5 h-3.5" />}
              </button>
            </div>
            <div className="flex items-center justify-between px-4 pb-3">
              <div className="flex items-center gap-2">
                <AttachFileButton />
                <div className="relative" ref={followupAgentRef}>
                  <button className={`flex items-center gap-1.5 px-2.5 py-1 text-xs hover:bg-dalam-bg-hover rounded-md transition-colors ${agentInfo.color}`}
                    onClick={() => { setShowFollowupAgentDropdown((v) => !v); setShowFollowupModelDropdown(false); }}>
                    <AgentIcon className="w-3.5 h-3.5" />
                    <span>{agentInfo.label}</span>
                    <ChevronDown className="w-3 h-3" />
                  </button>
                  {showFollowupAgentDropdown && (
                    <div className="absolute bottom-full left-0 mb-1 w-80 bg-dalam-bg-secondary border border-dalam-border-primary rounded-xl shadow-2xl z-50 overflow-hidden">
                      {PRIMARY_AGENTS.map((agent) => {
                        const meta = AGENT_DISPLAY[agent.name as PrimaryAgentName];
                        const Icon = meta.icon;
                        return (
                          <button key={agent.name}
                            className={`w-full text-left px-4 py-3 flex items-start gap-3 hover:bg-dalam-bg-hover transition-colors ${activeAgentName === agent.name ? "bg-dalam-bg-hover" : ""}`}
                            onClick={() => { setActiveAgent(agent.name as PrimaryAgentName); setShowFollowupAgentDropdown(false); }}>
                            <Icon className={`w-4 h-4 mt-0.5 flex-shrink-0 ${meta.color}`} />
                            <div className="flex-1 min-w-0">
                              <div className="text-sm text-dalam-text-primary font-medium">{meta.label}</div>
                              <div className="text-xs text-dalam-text-muted">{meta.description}</div>
                            </div>
                            {activeAgentName === agent.name && <Check className="w-4 h-4 text-dalam-accent-primary flex-shrink-0 mt-0.5" />}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <div className="relative" ref={followupModelRef}>
                  <button className="flex items-center gap-1.5 px-2.5 py-1 text-xs text-dalam-text-secondary hover:bg-dalam-bg-hover rounded-md transition-colors"
                    onClick={() => { setShowFollowupModelDropdown((v) => !v); setShowFollowupAgentDropdown(false); }}>
                        <span className={`w-2 h-2 rounded-full ${currentModel ? "bg-dalam-git-added" : "bg-dalam-text-muted"}`} />
                        {currentModel?.model.name || (selectedModelId || "Select model")}
                        <ChevronDown className="w-3 h-3" />
                  </button>
                  {showFollowupModelDropdown && (
                    <div className="absolute bottom-full right-0 mb-1 w-64 bg-dalam-bg-secondary border border-dalam-border-primary rounded-xl shadow-2xl z-50 overflow-hidden max-h-80 overflow-y-auto">
                      {providers.filter((p) => p.enabled).map((p) => (
                        <div key={p.id}>
                          <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-dalam-text-muted border-b border-dalam-border-primary">{p.name}</div>
                          {p.models.filter((m) => m.enabled !== false).map((m) => (
                            <button key={m.modelId}
                              className={`w-full text-left px-3 py-2 flex items-center gap-2 text-sm hover:bg-dalam-bg-hover transition-colors ${selectedModelId === m.modelId ? "bg-dalam-bg-hover" : ""}`}
                              onClick={() => { setSelectedModel(m.modelId); setShowFollowupModelDropdown(false); }}>
                              <span className="flex-1 truncate text-dalam-text-primary">{m.name}</span>
                              {selectedModelId === m.modelId && <Check className="w-3.5 h-3.5 text-dalam-accent-primary" />}
                            </button>
                          ))}
                        </div>
                      ))}
                      <div className="border-t border-dalam-border-primary">
                        <button className="w-full text-left px-3 py-2 flex items-center gap-2 text-sm text-dalam-text-secondary hover:bg-dalam-bg-hover transition-colors"
                          onClick={() => { useSettingsView.getState().open("models"); setShowFollowupModelDropdown(false); }}>
                          <Settings className="w-4 h-4 text-dalam-text-muted" />
                          <span>Manage models</span>
                        </button>
                      </div>
                    </div>
                  )}
                </div>
                <button
                  className="w-8 h-8 flex items-center justify-center rounded-lg bg-dalam-text-primary text-dalam-bg-primary hover:opacity-90 transition-opacity disabled:opacity-30 disabled:cursor-not-allowed"
                  disabled={!value.trim() || isStreaming || !workspace || (!selectedModelId && !settings.selectedModel)}
                  onClick={handleSubmit}
                  title={!workspace ? "Open a folder first" : !selectedModelId ? "Select a model first" : isStreaming ? "Streaming…" : "Send"}
                >
                  {isStreaming ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArrowUp className="w-4 h-4" strokeWidth={2.5} />}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
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
  const enabledModels = p?.models.filter((m) => (m as any).enabled !== false) ?? [];

  useLayoutEffect(() => {
    const rowEl = providerRowRefs.current[hoveredProvider];
    const dropdownEl = modelRef.current?.querySelector('[data-dropdown-body]');
    if (!rowEl || !dropdownEl) return;
    const rowRect = rowEl.getBoundingClientRect();
    const dropRect = dropdownEl.getBoundingClientRect();
    setStyle({ left: dropRect.right + 2, top: dropRect.top + rowRect.top - dropRect.top });
  }, [hoveredProvider, providerRowRefs, modelRef]);

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

function RunningToolsSection({ toolCalls }: { toolCalls: import("@dalam/shared-types").ToolCall[] }) {
  const [open, setOpen] = useState(true);
  const done = toolCalls.filter((t) => t.status === "completed").length;
  return (
    <div className="py-2 animate-fade-in opacity-60 hover:opacity-100 transition-opacity">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="group flex items-center gap-1.5 text-left text-[13px] leading-relaxed w-full text-dalam-text-secondary"
      >
        <ChevronDown
          className={`w-3 h-3 text-dalam-text-muted/70 transition-transform flex-shrink-0 ${open ? "" : "-rotate-90"}`}
        />
        <Loader2 className="w-3 h-3 text-dalam-accent-primary animate-spin flex-shrink-0" />
        <span>Running tools</span>
        <span className="text-[11px] text-dalam-text-muted tabular-nums ml-1">
          {done}/{toolCalls.length}
        </span>
      </button>
      {open && (
        <div className="ml-3.5 mt-1 pl-3 border-l border-dalam-border-primary/60">
          <ToolCallsList toolCalls={toolCalls} />
        </div>
      )}
    </div>
  );
}

const EMPTY_ACTIVITIES: never[] = [];

function ChatMessage({ message, pending, activeAgentName }: { message: import("@dalam/shared-types").ChatMessage; pending?: boolean; activeAgentName?: string }) {
  const toast = useToast();
  const segments = splitCodeFences(message.content);
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
      <div className="py-2 animate-fade-in">
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
            <div className="bg-dalam-bg-secondary border border-dalam-border-primary rounded-xl rounded-tr-sm px-4 py-2.5 text-right">
              <p className="text-[13px] text-dalam-text-primary leading-relaxed whitespace-pre-wrap break-words text-left">
                {message.content}
              </p>
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
    <div className="py-2 animate-fade-in">

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
              : <div key={"txt-" + idx} className="prose-dalam mb-2 last:mb-0"><MarkdownContent content={seg.content} /></div>
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

      {/* Message meta footer — only when the message is settled. */}
      {!pending && message.content && (
        <div className="flex items-center gap-2 mt-1 opacity-0 hover:opacity-100 focus-within:opacity-100 transition-opacity">
          <div className="ml-auto flex items-center gap-0.5">
            <button
              className="p-1 rounded hover:bg-dalam-bg-hover text-dalam-text-muted hover:text-dalam-text-primary transition-colors"
              title="Copy"
              onClick={() => { void navigator.clipboard.writeText(message.content); toast.success("Copied"); }}
            >
              <Copy className="w-3 h-3" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}


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
      <button
        className="w-7 h-7 flex items-center justify-center rounded-md text-dalam-text-muted hover:text-dalam-text-primary hover:bg-dalam-bg-hover transition-colors"
        onClick={() => inputRef.current?.click()}
        title="Attach file or image"
        aria-label="Attach file or image"
      >
        <Paperclip className="w-4 h-4" />
      </button>
    </>
  );
}

function MarkdownContent({ content }: { content: string }) {
  return (
    <Markdown
      remarkPlugins={[remarkGfm]}
      components={{
        p: ({ children }) => <p className="whitespace-pre-wrap break-words mb-2 last:mb-0">{children}</p>,
        strong: ({ children }) => <strong className="font-semibold text-dalam-text-primary">{children}</strong>,
        em: ({ children }) => <em className="italic">{children}</em>,
        a: ({ href, children }) => (
          <a
            href={href}
            onClick={(e) => {
              if (!href) return;
              // Only intercept http/https links; let other links (e.g. file://, #) behave normally
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
        ul: ({ children }) => <ul className="list-disc list-inside mb-2 space-y-0.5">{children}</ul>,
        ol: ({ children }) => <ol className="list-decimal list-inside mb-2 space-y-0.5">{children}</ol>,
        li: ({ children }) => <li className="text-dalam-text-secondary">{children}</li>,
        h1: ({ children }) => <h1 className="text-lg font-bold mb-2 text-dalam-text-primary">{children}</h1>,
        h2: ({ children }) => <h2 className="text-base font-bold mb-2 text-dalam-text-primary">{children}</h2>,
        h3: ({ children }) => <h3 className="text-sm font-bold mb-1 text-dalam-text-primary">{children}</h3>,
        code: ({ children, className }) => {
          const isInline = !className;
          if (isInline) {
            return <code className="px-1 py-0.5 bg-dalam-bg-tertiary rounded text-[12px] font-mono text-dalam-accent-primary">{children}</code>;
          }
          return <code className={className}>{children}</code>;
        },
        blockquote: ({ children }) => (
          <blockquote className="border-l-2 border-dalam-accent-primary/40 pl-3 my-2 text-dalam-text-muted italic">{children}</blockquote>
        ),
        hr: () => <hr className="my-3 border-dalam-border-primary" />,
        table: ({ children }) => <div className="overflow-x-auto my-2"><table className="text-xs border-collapse">{children}</table></div>,
        th: ({ children }) => <th className="px-2 py-1 border border-dalam-border-primary text-left font-medium">{children}</th>,
        td: ({ children }) => <td className="px-2 py-1 border border-dalam-border-primary">{children}</td>,
      }}
    >
      {content}
    </Markdown>
  );
}

function CodeBlock({ language, content }: { language: string; content: string }) {
  const toast = useToast();
  const activeFilePath = useWorkspace((s) => s.activeFilePath);
  const updateTabContent = useWorkspace((s) => s.updateTabContent);
  const [expanded, setExpanded] = useState(true);
  const lines = content.split("\n");
  const isLong = lines.length > 30;

  const highlighted = useMemo(() => {
    const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    if (language && hljs.getLanguage(language)) {
      try { return hljs.highlight(content, { language }).value; } catch { return escapeHtml(content); }
    }
    try { return hljs.highlightAuto(content).value; } catch { return escapeHtml(content); }
  }, [content, language]);

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
}

function Dots() {
  return (
    <span className="inline-flex gap-0.5 ml-1">
      <span className="w-1 h-1 rounded-full bg-dalam-text-muted animate-pulse" style={{ animationDelay: "0ms" }} />
      <span className="w-1 h-1 rounded-full bg-dalam-text-muted animate-pulse" style={{ animationDelay: "120ms" }} />
      <span className="w-1 h-1 rounded-full bg-dalam-text-muted animate-pulse" style={{ animationDelay: "240ms" }} />
    </span>
  );
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function splitCodeFences(text: string): { type: "text" | "code"; content: string; language?: string }[] {
  const out: { type: "text" | "code"; content: string; language?: string }[] = [];
  const re = /```(\w*)\n([\s\S]*?)```/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    if (match.index > last) out.push({ type: "text", content: text.slice(last, match.index) });
    out.push({ type: "code", content: match[2], language: match[1] });
    last = match.index + match[0].length;
  }
  if (last < text.length) {
    const rest = text.slice(last);
    const unclosedOpen = rest.match(/^```(\w*)\n([\s\S]*)$/);
    if (unclosedOpen) {
      out.push({ type: "code", content: unclosedOpen[2], language: unclosedOpen[1] });
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
