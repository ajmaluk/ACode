import React, { useEffect, useRef, useState, useMemo, useCallback } from "react";
import ReactDOM from "react-dom";
import { useWorkspace, useSettings, useChat, useGit, useModelProviders, useSettingsView, useUI, useAgents, PRIMARY_AGENTS, getPrimaryAgent } from "@/store/useAppStore";
import type { PrimaryAgentName } from "@acode/shared-types";
import { CodeView } from "@/components/editor/Editor";
import { Breadcrumb } from "@/components/editor/Breadcrumb";
import { TopNav } from "@/components/editor/TopNav";
import {
  X, FileCode, FilePlus, Circle, MoreHorizontal, Columns, ArrowUp,
  ChevronDown, ChevronUp, ChevronRight, Shield, Loader2, Sparkles,
  FileText, GitBranch, Clock,
  FolderOpen, Check, ClipboardList, Settings, Zap, Hash, Cpu, RotateCcw, History, Paperclip, Info, Copy,
} from "lucide-react";
import { useToast } from "@/components/ui/Toaster";
import { ensureAcodeAPI } from "@/lib/acodeAPI";
import { ThinkingBlock, ToolCallsList, ChangesCard, TodoBlock, ReadBlock, ExploreBlock, SkillBlock, PlanBlock, BashActivityBlock } from "@/components/chat/ActivityBlocks";
import { PromptAutocomplete } from "@/components/editor/PromptAutocomplete";
import { basename } from "@/lib/pathUtils";
import { modKey } from "@/lib/platform";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import hljs from "highlight.js";

const MemoizedOpenFileButton = React.memo(function MemoizedOpenFileButton({ fileTree, openFile }: { fileTree: any; openFile: (path: string) => Promise<void> }) {
  const toast = useToast();
  const mod = modKey();
  const firstFile = useMemo(() => findFirstFile(fileTree), [fileTree]);
  const handleClick = useCallback(async () => { if (firstFile) { await openFile(firstFile); toast.info("Opened file", basename(firstFile)); } }, [firstFile, openFile, toast]);
  return (
    <button
      className={`px-3 h-full transition-colors ${firstFile ? "text-acode-text-muted hover:text-acode-text-primary hover:bg-acode-bg-hover" : "text-acode-text-muted/40 cursor-not-allowed"}`}
      onClick={handleClick}
      disabled={!firstFile}
      title={firstFile ? `Open file (${mod}P)` : "No files in workspace"}
    >
      <FilePlus className="w-3.5 h-3.5" />
    </button>
  );
});

// Map primary agent → UI-friendly label and icon. Mirrors ACode's
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
          const api = ensureAcodeAPI();
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
      <div className="h-full flex flex-col bg-acode-bg-primary">
        <div className="h-9 flex items-center bg-acode-bg-secondary border-b border-acode-border-primary overflow-x-auto flex-shrink-0 scrollbar-thin">
          {openTabs.map((t) => {
            const active = t.path === activeFilePath;
            return (
              <div key={t.path}
                className={`group flex items-center gap-1.5 px-3 h-full border-r border-acode-border-primary cursor-pointer transition-colors ${active ? "bg-acode-bg-primary text-acode-text-primary" : "bg-acode-bg-secondary text-acode-text-secondary hover:bg-acode-bg-hover"}`}
                onClick={() => setActiveFile(t.path)}
                onAuxClick={(e) => { if (e.button === 1) closeTab(t.path); }}
                title={`${t.path}${t.dirty ? " (unsaved)" : ""}`}>
                <FileCode className="w-3.5 h-3.5 flex-shrink-0" />
                <span className="text-xs whitespace-nowrap">{t.name}</span>
                <button
                  className={`ml-1 rounded p-0.5 ${active ? "opacity-70 hover:opacity-100" : "opacity-0 group-hover:opacity-100"} hover:bg-acode-bg-active transition-opacity`}
                  onClick={(e) => { e.stopPropagation(); closeTab(t.path); }}
                  title={t.dirty ? "Close (unsaved)" : "Close"}
                  aria-label={`Close ${t.name}`}
                >
                  {t.dirty
                    ? <Circle className="w-2.5 h-2.5 fill-current text-acode-accent-primary" />
                    : <X className="w-3 h-3" />}
                </button>
              </div>
            );
          })}
          <MemoizedOpenFileButton fileTree={fileTree} openFile={openFile} />
          <div className="flex-1" />
          <div className="flex items-center gap-0.5 pr-1">
            <button className="px-2 h-full text-acode-text-muted hover:text-acode-text-primary hover:bg-acode-bg-hover transition-colors" title="Split editor" onClick={() => toast.info("Split", "Coming soon")}>
              <Columns className="w-3.5 h-3.5" />
            </button>
            <button className="px-2 h-full text-acode-text-muted hover:text-acode-text-primary hover:bg-acode-bg-hover transition-colors" title="More actions" onClick={() => toast.info("More", "Coming soon")}>
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
    <div className="h-6 flex items-center justify-between bg-acode-bg-tertiary border-t border-acode-border-primary px-3 text-[11px] text-acode-text-muted flex-shrink-0 select-none">
      <div className="flex items-center gap-3 min-w-0 overflow-hidden">
        <span className="flex items-center gap-1.5 flex-shrink-0">
          <FileCode className="w-3 h-3" />
          {activeTab.name}
        </span>
        <span className="px-1.5 py-0.5 rounded bg-acode-bg-active text-acode-text-secondary uppercase tracking-wider text-[10px] flex-shrink-0">{language}</span>
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
                const api = ensureAcodeAPI();
                await api.fs.writeFile(activeTab.path, activeTab.content);
                markSaved(activeTab.path);
              } catch (err) {
                toast.error("Save failed", (err as Error)?.message ?? "Unknown error");
              }
            }}
            className="flex items-center gap-1 text-acode-text-secondary hover:text-acode-text-primary transition-colors"
            title={`Save (${mod}S)`}
          >
            <Circle className="w-2 h-2 fill-current text-acode-accent-primary" />
            <span>Unsaved</span>
          </button>
        ) : (
          <span className="flex items-center gap-1 text-acode-text-muted">
            <Check className="w-3 h-3" />
            Saved
          </span>
        )}
        <span className="flex items-center gap-1 flex-shrink-0 text-acode-text-muted">
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
  sessionVersions: Record<string, import("@acode/shared-types").ChatVersion[]>;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const versions = sessionVersions[activeSessionId] ?? [];
  const ver = versions.find((v) => v.id === restoredVersionId);
  if (!ver) return null;
  return (
    <div className="border-t border-acode-border-primary px-3 pt-1.5 pb-0 flex-shrink-0 bg-acode-bg-primary">
      <div className="flex items-center gap-2 px-3 py-1.5 bg-acode-accent-subtle/40 border border-acode-accent-primary/20 rounded-lg text-xs">
        <History className="w-3.5 h-3.5 text-acode-accent-primary flex-shrink-0" />
        <div className="flex-1 min-w-0">
          <span className="text-acode-text-primary font-medium truncate">{ver.label}</span>
          <span className="text-acode-text-muted ml-1.5">· {ver.messages.length} message{ver.messages.length !== 1 ? "s" : ""}</span>
        </div>
        <button
          className="flex items-center gap-1 px-2 py-1 bg-acode-accent-primary/10 hover:bg-acode-accent-primary/20 text-acode-accent-primary rounded-md transition-colors"
          title="Reset to this version"
          onClick={onConfirm}
        >
          <RotateCcw className="w-3 h-3" />
          <span>Reset</span>
        </button>
        <button
          className="text-acode-text-muted hover:text-acode-text-primary transition-colors"
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
  const { sendMessage, isStreaming, messages, streamingContent, thinkingContent, selectedModelId, setSelectedModel, pendingToolCalls, resolveToolApproval, chatSessions, planApproval, approvePlan, rejectPlan, restoredVersionId, sessionVersions, activeSessionId, cancelVersionRestore, confirmVersionRestore, pendingAttachments, removePendingAttachment } = useChat();
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
  /init       - Scans workspace & creates/bootstraps ACODE.md

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
          const display = AGENT_DISPLAY[a.name as import("@acode/shared-types").PrimaryAgentName];
          return `- ${a.name} (${display?.label ?? a.name})`;
        }).join("\n");
        chat.injectSystemMessage(`Usage: /agent <agentName>\n\nAvailable Primary Agents:\n${agentList}`);
      } else {
        const found = PRIMARY_AGENTS.find(a => {
          const display = AGENT_DISPLAY[a.name as import("@acode/shared-types").PrimaryAgentName];
          return a.name.toLowerCase() === targetAgentName || 
                 (display && display.label.toLowerCase().includes(targetAgentName));
        });
        if (found) {
          useAgents.getState().setActiveAgent(found.name as import("@acode/shared-types").PrimaryAgentName);
          const display = AGENT_DISPLAY[found.name as import("@acode/shared-types").PrimaryAgentName];
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
      const title = `ACode Session Share log - ${new Date().toLocaleString()}\n\n`;
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
          const api = ensureAcodeAPI();
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
          
          const acodeMdContent = `# ${workspace.name} — ACode Workspace Instructions

> Generated by \`/init\` on ${new Date().toLocaleDateString()}.\n> Edit this file to teach ACode about your project conventions.\n> ACode loads instructions from a 4-layer hierarchy (lowest → highest priority):\n>\n>   1. **Global** — \`~/.acode/ACODE.md\` (your personal rules, all projects)\n>   2. **Org** — \`.acode/org/ACODE.md\` (team rules, shared via repo)\n>   3. **Project** — \`ACODE.md\` (this file — project-specific rules)\n>   4. **Local** — \`.acode/local/ACODE.md\` (your overrides for this project, gitignored)

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

Add your project's common commands here so ACode knows how to build:

| Command | Purpose |
|---------|----------|
| (add yours) | (e.g. \`pnpm build\`, \`cargo check\`) |

---

## Notes

- ACode reads this file at the start of every conversation
- Changes take effect on the next prompt submission
- For personal overrides, create \`.acode/local/ACODE.md\` (gitignored)
- For team-shared rules, create \`.acode/org/ACODE.md\` and commit it
`;
          const dotAcode = `${workspace.path}/.acode`;
          const plansDir = `${dotAcode}/plans`;
          const acodeMdPath = `${workspace.path}/ACODE.md`;
          
          const { exists, mkdir } = await import("@tauri-apps/plugin-fs");
          
          if (!(await exists(dotAcode))) {
            await mkdir(dotAcode);
          }
          if (!(await exists(plansDir))) {
            await mkdir(plansDir);
          }
          
          await api.fs.writeFile(acodeMdPath, acodeMdContent);
          await useWorkspace.getState().refreshFileTree();
          
          chat.injectSystemMessage(`Workspace bootstrap completed:
  1. Created ACODE.md overview at: ${acodeMdPath}
  2. Setup .acode/plans directory for Plan mode.
  3. Active workspace memory loaded.`);
          toast.success("Workspace bootstrapped", "ACODE.md generated.");
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
    <div className="h-full flex flex-col bg-acode-bg-primary">
      <TopNav />

      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto scrollbar-thin">
        {!hasMessages ? (
          <div className="relative h-full flex flex-col items-center justify-center px-8 -mt-10">
            {/* Large background A watermark — low opacity, behind everything */}
            <div aria-hidden="true" className="pointer-events-none absolute inset-0 flex items-center justify-center select-none">
              <span
                className="text-acode-text-primary"
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
                className="text-4xl text-acode-text-primary text-center mb-10 tracking-tight"
                style={{ fontFamily: "'Newsreader', 'Iowan Old Style', 'Georgia', serif", fontWeight: 500 }}
              >
                {workspace
                  ? <>Start a new task in <span className="text-acode-accent-primary">{workspace.name}</span></>
                  : "Open a folder to begin"}
              </h1>
              {/* Removed overflow-hidden so dropdowns can render above the card */}
              <div className="bg-acode-bg-secondary border border-acode-border-primary rounded-xl shadow-2xl">
                <div className="px-4 pt-2.5 flex items-center gap-3">
                  <div className="relative" ref={workspaceRef}>
                    <button
                      className={`flex items-center gap-1.5 text-sm transition-colors ${workspace ? "text-acode-text-secondary hover:text-acode-text-primary" : "text-acode-text-muted hover:text-acode-text-secondary"}`}
                      onClick={() => { setShowWorkspaceDropdown((v) => !v); setShowBranchDropdown(false); setShowAgentDropdown(false); setShowModelDropdown(false); }}
                      title={workspace ? `Active workspace: ${workspace.name}` : "Select a folder to start working"}
                    >
                      <FolderOpen className={`w-4 h-4 ${workspace ? "text-acode-text-muted" : "text-amber-400/80"}`} />
                      <span>{workspace?.name || "Select a folder"}</span>
                      <ChevronDown className="w-3.5 h-3.5 text-acode-text-muted" />
                    </button>
                    {showWorkspaceDropdown && (
                      <div className="absolute top-full left-0 mt-1 w-64 bg-acode-bg-secondary border border-acode-border-primary rounded-xl shadow-2xl z-50 overflow-hidden">
                        <div className="p-2 border-b border-acode-border-primary">
                          <input className="input-base w-full text-xs" placeholder="Search workspaces" autoFocus />
                        </div>
                        <div className="max-h-60 overflow-y-auto">
                          {workspaces.length === 0 && (
                            <div className="px-3 py-3 text-xs text-acode-text-muted">No workspaces yet. Open a folder to get started.</div>
                          )}
                          {workspaces.map((ws) => (
                            <button key={ws.id}
                              className={`w-full text-left px-3 py-2 flex items-center gap-2 text-sm hover:bg-acode-bg-hover transition-colors ${ws.id === activeWorkspaceId ? "bg-acode-bg-hover" : ""}`}
                              onClick={() => { setActiveWorkspace(ws.id); setShowWorkspaceDropdown(false); }}>
                              <FolderOpen className="w-4 h-4 text-acode-text-muted flex-shrink-0" />
                              <span className="flex-1 truncate text-acode-text-primary">{ws.name}</span>
                              {ws.id === activeWorkspaceId && <Check className="w-4 h-4 text-acode-accent-primary" />}
                            </button>
                          ))}
                          <div className="border-t border-acode-border-primary">
                            <button className="w-full text-left px-3 py-2 flex items-center gap-2 text-sm text-acode-text-secondary hover:bg-acode-bg-hover transition-colors"
                              onClick={() => { void openWorkspace(); setShowWorkspaceDropdown(false); }}>
                              <FolderOpen className="w-4 h-4 text-acode-text-muted flex-shrink-0" />
                              <span>Open folder…</span>
                            </button>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                  {gitStatus && (
                    <div className="relative" ref={branchRef}>
                      <button className="flex items-center gap-1.5 text-xs text-acode-text-muted hover:text-acode-text-secondary transition-colors"
                        onClick={() => { setShowBranchDropdown((v) => !v); setShowWorkspaceDropdown(false); setShowAgentDropdown(false); setShowModelDropdown(false); }}>
                        <GitBranch className="w-3.5 h-3.5" />
                        <span>{gitStatus.branch}</span>
                        <ChevronDown className="w-3 h-3" />
                      </button>
                      {showBranchDropdown && (
                        <div className="absolute top-full left-0 mt-1 w-40 bg-acode-bg-secondary border border-acode-border-primary rounded-lg shadow-2xl z-50 overflow-hidden">
                          <button className="w-full text-left px-3 py-2 flex items-center gap-2 text-sm text-acode-text-primary hover:bg-acode-bg-hover">
                            <Check className="w-3.5 h-3.5 text-acode-accent-primary" />{gitStatus.branch}
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
                        <div key={att.id} className="flex items-center gap-1.5 px-2 py-1 bg-acode-bg-active border border-acode-border-primary rounded-md text-xs text-acode-text-primary">
                          {att.mimeType.startsWith("image/") ? (
                            <img src={`data:${att.mimeType};base64,${att.content}`} alt={att.name} className="w-5 h-5 rounded object-cover" />
                          ) : (
                            <FileText className="w-3.5 h-3.5 text-acode-text-muted" />
                          )}
                          <span className="max-w-[120px] truncate">{att.name}</span>
                          <button
                            className="text-acode-text-muted hover:text-acode-text-primary transition-colors ml-0.5"
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
                    className={`w-full bg-transparent border-0 outline-none text-sm text-acode-text-primary placeholder-acode-text-muted resize-none leading-relaxed overflow-hidden transition-all ${inputExpanded ? "min-h-[160px]" : "min-h-[28px]"}`}
                    placeholder={
                      activeAgentName === "plan"
                        ? "Describe a task to plan. The agent will explore the codebase, produce a plan, and ask you to approve before executing."
                        : activeAgentName === "yolo"
                          ? "YOLO mode — everything runs without permission prompts. Be specific about what you want."
                          : "Ask ACode anything, @ to add files, / for commands, $ for skills, # for related conversations"
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
                    className="absolute bottom-1 right-1 w-6 h-6 flex items-center justify-center rounded text-acode-text-muted hover:text-acode-text-primary hover:bg-acode-bg-hover transition-colors"
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
                      <button className={`flex items-center gap-1.5 px-2.5 py-1 text-xs hover:bg-acode-bg-hover rounded-md transition-colors ${agentInfo.color}`}
                        onClick={() => { setShowAgentDropdown((v) => !v); setShowWorkspaceDropdown(false); setShowBranchDropdown(false); setShowModelDropdown(false); }}
                        title={`Primary agent: ${agentInfo.label}`}
                      >
                        <AgentIcon className="w-3.5 h-3.5" />
                        <span>{agentInfo.label}</span>
                        <ChevronDown className="w-3 h-3" />
                      </button>
                      {showAgentDropdown && (
                        <div className="absolute bottom-full left-0 mb-1 w-80 bg-acode-bg-secondary border border-acode-border-primary rounded-xl shadow-2xl z-50 overflow-hidden">
                          <div className="px-3 py-2 border-b border-acode-border-primary">
                            <div className="text-[10px] uppercase tracking-wider text-acode-text-muted">Primary agent</div>
                            <div className="text-xs text-acode-text-muted mt-0.5">Switches the active agent and its permission policy.</div>
                          </div>
                          {PRIMARY_AGENTS.map((agent) => {
                            const meta = AGENT_DISPLAY[agent.name as PrimaryAgentName];
                            const Icon = meta.icon;
                            return (
                              <button key={agent.name}
                                className={`w-full text-left px-4 py-3 flex items-start gap-3 hover:bg-acode-bg-hover transition-colors ${activeAgentName === agent.name ? "bg-acode-bg-hover" : ""}`}
                                onClick={() => { setActiveAgent(agent.name as PrimaryAgentName); setShowAgentDropdown(false); }}>
                                <Icon className={`w-4 h-4 mt-0.5 flex-shrink-0 ${meta.color}`} />
                                <div className="flex-1 min-w-0">
                                  <div className="text-sm text-acode-text-primary font-medium flex items-center gap-1.5">
                                    {meta.label}
                                    {activeAgentName === agent.name && <span className="text-[9px] uppercase text-acode-accent-primary tracking-wider">active</span>}
                                  </div>
                                  <div className="text-xs text-acode-text-muted mt-0.5">{meta.description}</div>
                                </div>
                                {activeAgentName === agent.name && <Check className="w-4 h-4 text-acode-accent-primary flex-shrink-0 mt-0.5" />}
                              </button>
                            );
                          })}
                          <div className="border-t border-acode-border-primary px-3 py-2">
                            <button
                              onClick={() => { useSettingsView.getState().open("permissions"); setShowAgentDropdown(false); }}
                              className="text-xs text-acode-text-secondary hover:text-acode-text-primary flex items-center gap-1.5"
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
                      <button className="flex items-center gap-1.5 px-2.5 py-1 text-xs text-acode-text-secondary hover:bg-acode-bg-hover rounded-md transition-colors"
                        onClick={() => { setShowModelDropdown((v) => !v); setShowWorkspaceDropdown(false); setShowBranchDropdown(false); setShowAgentDropdown(false); }}>
                        <span className={`w-2 h-2 rounded-full ${currentModel ? "bg-acode-git-added" : "bg-acode-text-muted"}`} />
                        {currentModel?.model.name || (selectedModelId || "Select model")}
                        <ChevronDown className="w-3 h-3" />
                      </button>
                      {showModelDropdown && (
                        <div className="absolute bottom-full right-0 mb-1 bg-acode-bg-secondary border border-acode-border-primary rounded-xl shadow-2xl z-50 min-w-[220px]" data-dropdown-body>
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
                                  <div className={`flex items-center justify-between px-3 py-2 cursor-pointer transition-colors ${hasActiveModel ? "text-acode-accent-primary" : "text-acode-text-primary hover:bg-acode-bg-hover"}`}>
                                    <span className="text-sm">{p.name}</span>
                                    <div className="flex items-center gap-1">
                                      {hasActiveModel && <Check className="w-3.5 h-3.5 text-acode-accent-primary" />}
                                      <ChevronRight className="w-3 h-3 text-acode-text-muted" />
                                    </div>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                          <div className="border-t border-acode-border-primary">
                            <button className="w-full text-left px-3 py-2 flex items-center gap-2 text-sm text-acode-text-secondary hover:bg-acode-bg-hover transition-colors"
                              onClick={() => { useSettingsView.getState().open("models"); setShowModelDropdown(false); }}>
                              <Settings className="w-4 h-4 text-acode-text-muted" />
                              <span>Manage models</span>
                            </button>
                          </div>
                        </div>
                      )}
                      {/* Sub-dropdown rendered OUTSIDE the scrollable container via portal-like approach */}
                      {showModelDropdown && hoveredProvider && (() => {
                        const p = providers.find((pr) => pr.id === hoveredProvider);
                        if (!p) return null;
                        const enabledModels = p.models.filter((m) => (m as any).enabled !== false);
                        const rowEl = providerRowRefs.current[hoveredProvider];
                        const dropdownEl = modelRef.current?.querySelector('[data-dropdown-body]');
                        if (!rowEl || !dropdownEl) return null;
                        const rowRect = rowEl.getBoundingClientRect();
                        const dropRect = dropdownEl.getBoundingClientRect();
                        const topOffset = rowRect.top - dropRect.top;
                        return ReactDOM.createPortal(
                          <div className="fixed w-56 bg-acode-bg-secondary border border-acode-border-primary rounded-xl shadow-2xl z-[100]"
                            style={{ left: dropRect.right + 2, top: dropRect.top + topOffset }}
                            onMouseEnter={() => { if (providerHoverTimeout.current) clearTimeout(providerHoverTimeout.current); }}
                            onMouseLeave={() => { providerHoverTimeout.current = setTimeout(() => setHoveredProvider(null), 200); }}>
                            <div className="max-h-64 overflow-y-auto">
                              {enabledModels.map((m) => (
                                <button key={m.modelId}
                                  className={`w-full text-left px-3 py-2 flex items-center gap-2 text-sm transition-colors ${selectedModelId === m.modelId ? "bg-acode-bg-hover text-acode-accent-primary" : "text-acode-text-primary hover:bg-acode-bg-hover"}`}
                                  onClick={() => { setSelectedModel(m.modelId); setShowModelDropdown(false); }}>
                                  <span className="flex-1 truncate">{m.name}</span>
                                  {selectedModelId === m.modelId && <Check className="w-3.5 h-3.5 text-acode-accent-primary" />}
                                </button>
                              ))}
                            </div>
                          </div>,
                          document.body
                        );
                      })()}
                    </div>
                    <button
                      className="w-8 h-8 flex items-center justify-center rounded-lg bg-acode-text-primary text-acode-bg-primary hover:opacity-90 transition-opacity disabled:opacity-30 disabled:cursor-not-allowed"
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
              <div className="flex items-center gap-2 mb-4 text-[11px] text-acode-text-muted">
                <FileText className="w-3 h-3" />
                <span>Changes</span>
                {totalAdded > 0 && <span className="text-acode-git-added">+{totalAdded}</span>}
                {totalDeleted > 0 && <span className="text-acode-git-deleted">-{totalDeleted}</span>}
                <span className="ml-auto flex items-center gap-1">
                  <Cpu className="w-2.5 h-2.5" />
                  {currentModel?.model.name || "Select model"}
                </span>
              </div>
            )}
            {hasMessages && (
              <div className="max-w-3xl mx-auto mt-4 mb-6 px-6 text-[10px] text-acode-text-muted flex items-center gap-2">
                <span className="flex items-center gap-1">
                  <Hash className="w-3 h-3" />
                  {messages.length} {messages.length === 1 ? "message" : "messages"}
                </span>
                <span className="text-acode-text-muted/40">·</span>
                <span className="flex items-center gap-1" title="Approximate token count (1 token ≈ 4 chars)">
                  <Sparkles className="w-3 h-3" />
                  {Math.ceil(messages.reduce((sum, m) => sum + m.content.length, 0) / 4).toLocaleString()} tokens
                </span>
                <span className="text-acode-text-muted/40">·</span>
                <span className="flex items-center gap-1">
                  {formatTime(messages[0].timestamp)}
                </span>
                <span className="ml-auto flex items-center gap-1">
                  <Cpu className="w-3 h-3" />
                  {currentModel?.model.name || settings.selectedModel || "No model"}
                </span>
              </div>
            )}
            {messages.map((m) => <ChatMessage key={m.id} message={m} />)}
            {planApproval && planApproval.status === "pending" && (
              <div className="mx-4 my-3 p-4 bg-acode-accent-subtle border border-acode-accent-primary/30 rounded-xl animate-fade-in">
                <div className="flex items-center gap-2 mb-2">
                  <ClipboardList className="w-4 h-4 text-acode-accent-primary" />
                  <span className="text-sm font-medium text-acode-text-primary">Plan ready for review</span>
                </div>
                <p className="text-xs text-acode-text-muted mb-3">The AI has produced a plan. Approve to switch to Build mode and execute it.</p>
                <div className="flex gap-2">
                  <button
                    onClick={approvePlan}
                    className="px-4 py-1.5 bg-acode-accent-primary hover:bg-acode-accent-hover text-white text-sm rounded-lg transition-colors"
                  >
                    Approve & Build
                  </button>
                  <button
                    onClick={rejectPlan}
                    className="px-4 py-1.5 bg-acode-bg-active hover:bg-acode-bg-tertiary text-acode-text-primary text-sm rounded-lg border border-acode-border-primary transition-colors"
                  >
                    Reject
                  </button>
                </div>
              </div>
            )}
            {isStreaming && pendingToolCalls.length > 0 && (
              <RunningToolsSection toolCalls={pendingToolCalls} />
            )}
            {isStreaming && streamingContent && (
              <ChatMessage
                message={{
                  id: "streaming",
                  role: "assistant",
                  content: streamingContent,
                  timestamp: Date.now(),
                  ...(thinkingContent ? { thinking: thinkingContent } : {}),
                }}
                pending
              />
            )}
            {isStreaming && !streamingContent && (
              <div className="py-3 animate-fade-in">
                {thinkingContent ? (
                  <ThinkingBlock content={thinkingContent} streaming />
                ) : (
                  <div className="flex items-center gap-2 text-[13px] text-acode-text-secondary">
                    <Loader2 className="w-3.5 h-3.5 text-acode-accent-primary animate-spin" />
                    <span>Thinking</span>
                    <Dots />
                  </div>
                )}
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
        <div className="border-t border-acode-border-primary p-3 flex-shrink-0 bg-acode-bg-primary">
          <div className="bg-acode-bg-secondary border border-acode-border-primary rounded-xl shadow-lg">
            <div className={`px-4 py-3 relative ${inputExpanded ? "min-h-[200px]" : ""}`}>
              {pendingAttachments.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {pendingAttachments.map((att) => (
                    <div key={att.id} className="flex items-center gap-1.5 px-2 py-1 bg-acode-bg-active border border-acode-border-primary rounded-md text-xs text-acode-text-primary">
                      {att.mimeType.startsWith("image/") ? (
                        <img src={`data:${att.mimeType};base64,${att.content}`} alt={att.name} className="w-5 h-5 rounded object-cover" />
                      ) : (
                        <FileText className="w-3.5 h-3.5 text-acode-text-muted" />
                      )}
                      <span className="max-w-[120px] truncate">{att.name}</span>
                      <button
                        className="text-acode-text-muted hover:text-acode-text-primary transition-colors ml-0.5"
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
                className={`w-full bg-transparent border-0 outline-none text-sm text-acode-text-primary placeholder-acode-text-muted resize-none overflow-hidden transition-all ${inputExpanded ? "min-h-[160px]" : "min-h-[40px]"}`}
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
                className="absolute bottom-1 right-1 w-6 h-6 flex items-center justify-center rounded text-acode-text-muted hover:text-acode-text-primary hover:bg-acode-bg-hover transition-colors"
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
                  <button className={`flex items-center gap-1.5 px-2.5 py-1 text-xs hover:bg-acode-bg-hover rounded-md transition-colors ${agentInfo.color}`}
                    onClick={() => { setShowFollowupAgentDropdown((v) => !v); setShowFollowupModelDropdown(false); }}>
                    <AgentIcon className="w-3.5 h-3.5" />
                    <span>{agentInfo.label}</span>
                    <ChevronDown className="w-3 h-3" />
                  </button>
                  {showFollowupAgentDropdown && (
                    <div className="absolute bottom-full left-0 mb-1 w-80 bg-acode-bg-secondary border border-acode-border-primary rounded-xl shadow-2xl z-50 overflow-hidden">
                      {PRIMARY_AGENTS.map((agent) => {
                        const meta = AGENT_DISPLAY[agent.name as PrimaryAgentName];
                        const Icon = meta.icon;
                        return (
                          <button key={agent.name}
                            className={`w-full text-left px-4 py-3 flex items-start gap-3 hover:bg-acode-bg-hover transition-colors ${activeAgentName === agent.name ? "bg-acode-bg-hover" : ""}`}
                            onClick={() => { setActiveAgent(agent.name as PrimaryAgentName); setShowFollowupAgentDropdown(false); }}>
                            <Icon className={`w-4 h-4 mt-0.5 flex-shrink-0 ${meta.color}`} />
                            <div className="flex-1 min-w-0">
                              <div className="text-sm text-acode-text-primary font-medium">{meta.label}</div>
                              <div className="text-xs text-acode-text-muted">{meta.description}</div>
                            </div>
                            {activeAgentName === agent.name && <Check className="w-4 h-4 text-acode-accent-primary flex-shrink-0 mt-0.5" />}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <div className="relative" ref={followupModelRef}>
                  <button className="flex items-center gap-1.5 px-2.5 py-1 text-xs text-acode-text-secondary hover:bg-acode-bg-hover rounded-md transition-colors"
                    onClick={() => { setShowFollowupModelDropdown((v) => !v); setShowFollowupAgentDropdown(false); }}>
                        <span className={`w-2 h-2 rounded-full ${currentModel ? "bg-acode-git-added" : "bg-acode-text-muted"}`} />
                        {currentModel?.model.name || (selectedModelId || "Select model")}
                        <ChevronDown className="w-3 h-3" />
                  </button>
                  {showFollowupModelDropdown && (
                    <div className="absolute bottom-full right-0 mb-1 w-64 bg-acode-bg-secondary border border-acode-border-primary rounded-xl shadow-2xl z-50 overflow-hidden max-h-80 overflow-y-auto">
                      {providers.filter((p) => p.enabled).map((p) => (
                        <div key={p.id}>
                          <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-acode-text-muted border-b border-acode-border-primary">{p.name}</div>
                          {p.models.filter((m) => m.enabled !== false).map((m) => (
                            <button key={m.modelId}
                              className={`w-full text-left px-3 py-2 flex items-center gap-2 text-sm hover:bg-acode-bg-hover transition-colors ${selectedModelId === m.modelId ? "bg-acode-bg-hover" : ""}`}
                              onClick={() => { setSelectedModel(m.modelId); setShowFollowupModelDropdown(false); }}>
                              <span className="flex-1 truncate text-acode-text-primary">{m.name}</span>
                              {selectedModelId === m.modelId && <Check className="w-3.5 h-3.5 text-acode-accent-primary" />}
                            </button>
                          ))}
                        </div>
                      ))}
                      <div className="border-t border-acode-border-primary">
                        <button className="w-full text-left px-3 py-2 flex items-center gap-2 text-sm text-acode-text-secondary hover:bg-acode-bg-hover transition-colors"
                          onClick={() => { useSettingsView.getState().open("models"); setShowFollowupModelDropdown(false); }}>
                          <Settings className="w-4 h-4 text-acode-text-muted" />
                          <span>Manage models</span>
                        </button>
                      </div>
                    </div>
                  )}
                </div>
                <button
                  className="w-8 h-8 flex items-center justify-center rounded-lg bg-acode-text-primary text-acode-bg-primary hover:opacity-90 transition-opacity disabled:opacity-30 disabled:cursor-not-allowed"
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
function RunningToolsSection({ toolCalls }: { toolCalls: import("@acode/shared-types").ToolCall[] }) {
  const [open, setOpen] = useState(true);
  const done = toolCalls.filter((t) => t.status === "completed").length;
  return (
    <div className="py-2 animate-fade-in opacity-60 hover:opacity-100 transition-opacity">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="group flex items-center gap-1.5 text-left text-[13px] leading-relaxed w-full text-acode-text-secondary"
      >
        <ChevronDown
          className={`w-3 h-3 text-acode-text-muted/70 transition-transform flex-shrink-0 ${open ? "" : "-rotate-90"}`}
        />
        <Loader2 className="w-3 h-3 text-acode-accent-primary animate-spin flex-shrink-0" />
        <span>Running tools</span>
        <span className="text-[11px] text-acode-text-muted tabular-nums ml-1">
          {done}/{toolCalls.length}
        </span>
      </button>
      {open && (
        <div className="ml-3.5 mt-1 pl-3 border-l border-acode-border-primary/60">
          <ToolCallsList toolCalls={toolCalls} />
        </div>
      )}
    </div>
  );
}

function ChatMessage({ message, pending }: { message: import("@acode/shared-types").ChatMessage; pending?: boolean }) {
  const toast = useToast();
  const { status: gitStatus } = useGit();
  const { settings } = useSettings();
  const segments = splitCodeFences(message.content);
  const activeAgentName = useAgents((s) => s.activeAgentName);
  // For settled messages, activities come from message.activities (no store subscription needed).
  // For the streaming message, subscribe to pendingActivities.
  const pendingActivities = useChat((s) => pending ? s.pendingActivities : []);
  const activities = message.activities ?? (pending ? pendingActivities : []);

  // System message: styled notification box
  if (message.role === "system") {
    return (
      <div className="py-2.5 px-3.5 my-3 bg-acode-bg-secondary border border-acode-border-primary rounded-xl text-xs text-acode-text-secondary flex items-start gap-3 animate-fade-in shadow-sm max-w-2xl mx-auto">
        <Info className="w-4 h-4 text-acode-accent-primary mt-0.5 flex-shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="font-semibold text-acode-text-primary mb-1">System Notification</div>
          <div className="whitespace-pre-wrap leading-relaxed font-mono text-[11px] text-acode-text-secondary">{message.content}</div>
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
            <div className="flex items-center gap-1.5 mb-1 justify-end">
              <span className="text-[10px] text-acode-text-muted font-medium uppercase tracking-wider">You</span>
            </div>
            {message.attachments && message.attachments.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mb-2 justify-end">
                {message.attachments.map((att) => (
                  <div key={att.id} className="flex items-center gap-1.5 px-2 py-1 bg-acode-bg-active border border-acode-border-primary rounded-md text-xs text-acode-text-primary">
                    {att.mimeType.startsWith("image/") ? (
                      <img src={`data:${att.mimeType};base64,${att.content}`} alt={att.name} className="w-10 h-10 rounded object-cover" />
                    ) : (
                      <>
                        <FileText className="w-3.5 h-3.5 text-acode-text-muted" />
                        <span className="max-w-[120px] truncate">{att.name}</span>
                      </>
                    )}
                  </div>
                ))}
              </div>
            )}
            <div className="bg-acode-bg-secondary border border-acode-border-primary rounded-xl rounded-tr-sm px-4 py-2.5 text-right">
              <p className="text-[13px] text-acode-text-primary leading-relaxed whitespace-pre-wrap break-words text-left">
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
      {/* Assistant label */}
      {!pending && (
        <div className="flex items-center gap-1.5 mb-1">
          <div className="w-1.5 h-1.5 rounded-full bg-acode-accent-primary" />
          <span className="text-[10px] text-acode-text-muted font-medium uppercase tracking-wider">Assistant</span>
          {activeAgentName && (
            <span className="text-[9px] text-acode-text-muted/60 ml-1">({activeAgentName})</span>
          )}
        </div>
      )}

      {/* Thinking block — model's reasoning, collapsed by default */}
      {!pending && message.thinking && (
        <ThinkingBlock content={message.thinking} />
      )}

      {/* Activity blocks (explore / read / skill / bash / plan) */}
      {hasActivities && (
        <div className="my-0.5">
          {activities.map((activity, idx) => {
            const ak = activity.type + "-" + idx;
            if (activity.type === "explore") {
              return <ExploreBlock key={ak} result={activity} />;
            }
            if (activity.type === "read") {
              return <ReadBlock key={ak} path={activity.path} content={activity.content} lineRange={activity.lineRange} />;
            }
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
      )}

      {/* Main assistant message — rendered with markdown */}
      {hasContent && (
        <div className="text-[13px] text-acode-text-primary leading-relaxed my-0.5">
          {segments.filter((seg) => seg.type !== "text" || seg.content.trim()).map((seg, idx) =>
            seg.type === "code"
              ? <CodeBlock key={"code-" + idx} language={seg.language ?? ""} content={seg.content} />
              : <div key={"txt-" + idx} className="prose-acode mb-2 last:mb-0"><MarkdownContent content={seg.content} /></div>
          )}
          {pending && (
            <span className="inline-block w-1.5 h-3.5 bg-acode-accent-primary ml-0.5 animate-pulse-soft rounded-sm align-middle" />
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

      {/* Changes card — shows file modifications from this AI turn */}
      {!pending && hasFileChanges && (
        <ChangesCard changes={message.fileChanges!} />
      )}

      {/* Message meta footer — only when the message is settled. */}
      {!pending && (
        <div className="flex items-center gap-2 mt-1 opacity-0 hover:opacity-100 focus-within:opacity-100 transition-opacity">
          <span className="text-[10px] text-acode-text-muted">{activeAgentName}</span>
          <div className="ml-auto flex items-center gap-0.5">
            <button
              className="p-1 rounded hover:bg-acode-bg-hover text-acode-text-muted hover:text-acode-text-primary transition-colors"
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
        className="w-7 h-7 flex items-center justify-center rounded-md text-acode-text-muted hover:text-acode-text-primary hover:bg-acode-bg-hover transition-colors"
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
        strong: ({ children }) => <strong className="font-semibold text-acode-text-primary">{children}</strong>,
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
            className="text-acode-accent-primary hover:underline cursor-pointer"
          >{children}</a>
        ),
        ul: ({ children }) => <ul className="list-disc list-inside mb-2 space-y-0.5">{children}</ul>,
        ol: ({ children }) => <ol className="list-decimal list-inside mb-2 space-y-0.5">{children}</ol>,
        li: ({ children }) => <li className="text-acode-text-secondary">{children}</li>,
        h1: ({ children }) => <h1 className="text-lg font-bold mb-2 text-acode-text-primary">{children}</h1>,
        h2: ({ children }) => <h2 className="text-base font-bold mb-2 text-acode-text-primary">{children}</h2>,
        h3: ({ children }) => <h3 className="text-sm font-bold mb-1 text-acode-text-primary">{children}</h3>,
        code: ({ children, className }) => {
          const isInline = !className;
          if (isInline) {
            return <code className="px-1 py-0.5 bg-acode-bg-tertiary rounded text-[12px] font-mono text-acode-accent-primary">{children}</code>;
          }
          return <code className={className}>{children}</code>;
        },
        blockquote: ({ children }) => (
          <blockquote className="border-l-2 border-acode-accent-primary/40 pl-3 my-2 text-acode-text-muted italic">{children}</blockquote>
        ),
        hr: () => <hr className="my-3 border-acode-border-primary" />,
        table: ({ children }) => <div className="overflow-x-auto my-2"><table className="text-xs border-collapse">{children}</table></div>,
        th: ({ children }) => <th className="px-2 py-1 border border-acode-border-primary text-left font-medium">{children}</th>,
        td: ({ children }) => <td className="px-2 py-1 border border-acode-border-primary">{children}</td>,
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
    <div className="my-2 bg-acode-bg-primary border border-acode-border-primary rounded-lg overflow-hidden">
      <div className="flex items-center justify-between px-3 py-1.5 bg-acode-bg-tertiary border-b border-acode-border-primary">
        <div className="flex items-center gap-1.5 text-[10px] text-acode-text-muted"><FileCode className="w-3 h-3" />{language || "code"}<span className="text-acode-text-muted/50">· {lines.length} lines</span></div>
        <div className="flex items-center gap-1">
          {isLong && (
            <button
              className="text-[10px] text-acode-text-muted hover:text-acode-text-primary flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-acode-bg-hover transition-colors"
              onClick={() => setExpanded(!expanded)}
            >{expanded ? "Collapse" : "Expand"}</button>
          )}
          <button className="text-[10px] text-acode-text-muted hover:text-acode-text-primary flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-acode-bg-hover transition-colors" onClick={handleApply}>Apply</button>
          <button className="text-[10px] text-acode-text-muted hover:text-acode-text-primary flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-acode-bg-hover transition-colors"
            onClick={() => { void navigator.clipboard.writeText(content); toast.success("Copied"); }}><Copy className="w-3 h-3" /></button>
        </div>
      </div>
      <pre
        className="p-3 text-[12px] text-mono text-acode-text-primary overflow-x-auto scrollbar-thin leading-relaxed"
        style={{ maxHeight: isLong && !expanded ? "240px" : undefined }}
      ><code dangerouslySetInnerHTML={{ __html: highlighted }} /></pre>
      {isLong && !expanded && (
        <button
          className="w-full py-1.5 text-[10px] text-acode-accent-primary hover:bg-acode-bg-hover border-t border-acode-border-primary transition-colors"
          onClick={() => setExpanded(true)}
        >Show all {lines.length} lines</button>
      )}
    </div>
  );
}

function Dots() {
  return (
    <span className="inline-flex gap-0.5 ml-1">
      <span className="w-1 h-1 rounded-full bg-acode-text-muted animate-pulse" style={{ animationDelay: "0ms" }} />
      <span className="w-1 h-1 rounded-full bg-acode-text-muted animate-pulse" style={{ animationDelay: "120ms" }} />
      <span className="w-1 h-1 rounded-full bg-acode-text-muted animate-pulse" style={{ animationDelay: "240ms" }} />
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

function findFirstFile(nodes: import("@acode/shared-types").FileNode[]): string | null {
  for (const n of nodes) {
    if (n.type === "file" && n.name !== ".gitignore") return n.path;
    if (n.children) { const inner = findFirstFile(n.children); if (inner) return inner; }
  }
  return null;
}
