import React, {
  useEffect,
  useRef,
  useState,
  useCallback,
  useMemo,
} from "react";
import {
  useWorkspace,
  useChat,
  useModelProviders,
  useGit,
  useSettings,
  useSettingsView,
  stripXmlToolCallTags,
  useQuestion,
  useAgents,
  savePersistedMessages,
  savePersistedSessionSummaries,
} from "@/store/useAppStore";
import {
  X,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Sparkles,
  FileText,
  GitBranch,
  FolderOpen,
  Check,
  ClipboardList,
  Settings,
  Hash,
  Cpu,
  Square,
  Zap,
  Hammer,
} from "lucide-react";
import { useToast } from "@/components/ui/toastStore";
import { Tooltip } from "@/components/ui/Tooltip";
import { createDalamAPI } from "@/lib/dalamAPI";
import { SessionCostTracker } from "@/components/chat/SessionCostTracker";
import { MessageQueue } from "@/components/chat/MessageQueue";
import { PromptAutocomplete } from "@/components/editor/PromptAutocomplete";
import { formatTime } from "@/lib/chatUtils";
import { modKey } from "@/lib/platform";
import {
  WorkingTimer,
  InlineActivityRow,
  StreamingActivityPanel,
} from "@/components/chat/ActivityPanel";
import {
  VersionRestoreBar,
  ResetConfirmDialog,
  RestorePopup,
} from "@/components/chat/ChatDialogs";
import { ChatMessage } from "@/components/chat/ChatMessage";
import { MarkdownContent, CodeBlock } from "@/components/chat/ChatRendering";
import { ModelSubDropdown } from "@/components/editor/ModelSubDropdown";
import { AttachFileButton } from "@/components/editor/AttachFileButton";

// ============================================================================
// AgentModeSelector — dropdown to switch between build/yolo/plan modes
// ============================================================================

const AGENT_MODES = [
  {
    name: "build" as const,
    icon: Hammer,
    label: "Build",
    color: "text-green-500",
    description: "Balanced — asks before writes",
  },
  {
    name: "yolo" as const,
    icon: Zap,
    label: "Yolo",
    color: "text-red-400",
    description: "Full access — no approval needed",
  },
  {
    name: "plan" as const,
    icon: ClipboardList,
    label: "Plan",
    color: "text-blue-400",
    description: "Read-only — explores without changes",
  },
];

function AgentModeSelector() {
  const { activeAgentName, setActiveAgent } = useAgents();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const currentMode =
    AGENT_MODES.find((m) => m.name === activeAgentName) || AGENT_MODES[0];

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node))
        setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        className={`flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-md transition-colors hover:bg-dalam-bg-hover ${currentMode.color}`}
        title={currentMode.description}
      >
        <currentMode.icon className="w-3 h-3" />
        <span>{currentMode.label}</span>
        <ChevronDown
          className={`w-2.5 h-2.5 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open && (
        <div className="absolute bottom-full left-0 mb-1 bg-dalam-bg-secondary border border-dalam-border-primary rounded-lg shadow-xl z-50 min-w-[200px] py-1 animate-fade-in">
          {AGENT_MODES.map((mode) => (
            <button
              key={mode.name}
              onClick={() => {
                setActiveAgent(mode.name);
                setOpen(false);
              }}
              className={`w-full flex items-center gap-2.5 px-3 py-2 text-left text-xs transition-colors ${
                activeAgentName === mode.name
                  ? "bg-dalam-accent-subtle text-dalam-text-primary"
                  : "text-dalam-text-secondary hover:bg-dalam-bg-hover"
              }`}
            >
              <mode.icon className={`w-3.5 h-3.5 ${mode.color}`} />
              <div className="flex-1 min-w-0">
                <div className="font-medium">{mode.label}</div>
                <div className="text-[10px] text-dalam-text-muted truncate">
                  {mode.description}
                </div>
              </div>
              {activeAgentName === mode.name && (
                <Check className="w-3 h-3 text-dalam-accent-primary" />
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// InlineQuestionDialog — shows question options above input (Claude Code style)
// ============================================================================

function InlineQuestionDialog() {
  const { request, resolve } = useQuestion();
  const [selected, setSelected] = useState(0);
  const [customText, setCustomText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset state when a new question appears
  const prevRequestIdRef = useRef<string | undefined>(undefined);
  const optionCount = request?.options?.length ?? 0;

  useEffect(() => {
    if (request?.id !== prevRequestIdRef.current) {
      prevRequestIdRef.current = request?.id;
      setSelected(0);
      setCustomText("");
    }
  }, [request?.id]);

  // Number key handler — pressing 1-9 submits immediately
  useEffect(() => {
    if (!request) return;
    const handler = (e: KeyboardEvent) => {
      // Ignore if typing in input
      if (
        (e.target as HTMLElement)?.tagName === "INPUT" ||
        (e.target as HTMLElement)?.tagName === "TEXTAREA"
      )
        return;
      const n = parseInt(e.key);
      if (n >= 1 && n <= optionCount) {
        e.preventDefault();
        resolve({ selectedLabel: request.options[n - 1].label });
      } else if (e.key === "Escape") {
        e.preventDefault();
        resolve(null);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [request, optionCount, resolve]);

  if (!request) return null;

  return (
    <div className="mb-3 bg-dalam-bg-secondary border border-dalam-border-primary rounded-xl shadow-lg overflow-hidden animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-dalam-border-primary/50">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[11px] font-medium text-dalam-accent-primary bg-dalam-accent-subtle px-2 py-0.5 rounded">
            {request.header}
          </span>
          <span className="text-sm text-dalam-text-primary truncate">
            {request.question}
          </span>
        </div>
        <button
          onClick={() => resolve(null)}
          className="p-1 rounded hover:bg-dalam-bg-hover text-dalam-text-muted"
          title="Dismiss"
          aria-label="Dismiss question"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Options */}
      <div className="px-4 py-2 space-y-0.5">
        {request.options.map((opt, idx) => (
          <button
            key={opt.label}
            onClick={() => {
              setSelected(idx);
              resolve({ selectedLabel: opt.label });
            }}
            onMouseEnter={() => setSelected(idx)}
            className={`w-full text-left flex items-start gap-3 px-3 py-2 rounded-lg transition-colors cursor-pointer ${
              selected === idx
                ? "bg-dalam-accent-primary/10 border border-dalam-accent-primary/30"
                : "hover:bg-dalam-bg-hover/50 border border-transparent"
            }`}
          >
            <span className="text-xs text-dalam-accent-primary font-medium w-4 mt-0.5 text-center flex-shrink-0">
              {idx + 1}.
            </span>
            <div className="flex-1 min-w-0">
              <span className="text-sm text-dalam-text-primary font-medium">
                {opt.label}
              </span>
              {opt.description && (
                <span className="text-sm text-dalam-text-muted ml-2">
                  {opt.description}
                </span>
              )}
            </div>
          </button>
        ))}

        {/* Custom answer input */}
        {request.allowFreeText !== false && (
          <div
            className={`flex items-start gap-3 px-3 py-2 rounded-lg transition-colors ${
              selected === optionCount
                ? "bg-dalam-bg-hover"
                : "hover:bg-dalam-bg-hover/50"
            }`}
            onClick={() => {
              setSelected(optionCount);
              inputRef.current?.focus();
            }}
          >
            <span className="text-xs text-dalam-text-muted w-4 mt-2 text-center flex-shrink-0">
              {optionCount + 1}.
            </span>
            <input
              ref={inputRef}
              type="text"
              value={customText}
              onChange={(e) => setCustomText(e.target.value)}
              placeholder="Enter your answer..."
              className="flex-1 bg-transparent border-0 outline-none text-sm text-dalam-text-primary placeholder:text-dalam-text-muted"
              onKeyDown={(e) => {
                if (e.key === "Enter" && customText.trim()) {
                  e.preventDefault();
                  resolve({
                    selectedLabel: "Custom",
                    customText: customText.trim(),
                  });
                }
              }}
            />
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between px-4 py-2 border-t border-dalam-border-primary/50">
        <div className="text-[10px] text-dalam-text-muted">
          Click an option or press 1-{optionCount} to select
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => resolve(null)}
            className="px-3 py-1 text-xs rounded-md text-dalam-text-secondary hover:bg-dalam-bg-hover transition-colors"
          >
            Dismiss
          </button>
          {request.allowFreeText !== false && (
            <button
              onClick={() => {
                if (customText.trim()) {
                  resolve({
                    selectedLabel: "Custom",
                    customText: customText.trim(),
                  });
                }
              }}
              disabled={!customText.trim()}
              className="px-3 py-1 text-xs rounded-md bg-dalam-text-primary text-dalam-bg-primary hover:opacity-90 transition-opacity font-medium disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Submit Custom
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function ChatView() {
  const {
    workspaces,
    activeWorkspaceId,
    setActiveWorkspace,
    openWorkspace,
    fileTree,
  } = useWorkspace();
  const { settings } = useSettings();
  // Individual selectors to prevent full re-render on unrelated chat state changes.
  // During streaming, only the relevant slice triggers a re-render.
  const sendMessage = useChat((s) => s.sendMessage);
  const isStreaming = useChat((s) => s.isStreaming);
  const messages = useChat((s) => s.messages);
  const selectedModelId = useChat((s) => s.selectedModelId);
  const setSelectedModel = useChat((s) => s.setSelectedModel);
  const chatSessions = useChat((s) => s.chatSessions);
  const planApproval = useChat((s) => s.planApproval);
  const approvePlan = useChat((s) => s.approvePlan);
  const rejectPlan = useChat((s) => s.rejectPlan);
  const restoredVersionId = useChat((s) => s.restoredVersionId);
  const sessionVersions = useChat((s) => s.sessionVersions);
  const activeSessionId = useChat((s) => s.activeSessionId);
  const cancelVersionRestore = useChat((s) => s.cancelVersionRestore);
  const confirmVersionRestore = useChat((s) => s.confirmVersionRestore);
  const pendingAttachments = useChat((s) => s.pendingAttachments);
  const removePendingAttachment = useChat((s) => s.removePendingAttachment);
  const messageQueue = useChat((s) => s.messageQueue);
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
  const mainAutocompleteKey = useRef<
    ((e: React.KeyboardEvent<HTMLTextAreaElement>) => boolean) | null
  >(null);
  const followupAutocompleteKey = useRef<
    ((e: React.KeyboardEvent<HTMLTextAreaElement>) => boolean) | null
  >(null);
  const [showWorkspaceDropdown, setShowWorkspaceDropdown] = useState(false);
  const [workspaceSearch, setWorkspaceSearch] = useState("");
  const [showBranchDropdown, setShowBranchDropdown] = useState(false);
  const [showModelDropdown, setShowModelDropdown] = useState(false);
  const [hoveredProvider, setHoveredProvider] = useState<string | null>(null);
  const providerHoverTimeout = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const [showFollowupModelDropdown, setShowFollowupModelDropdown] =
    useState(false);
  const [hoveredFollowupProvider, setHoveredFollowupProvider] = useState<
    string | null
  >(null);
  const followupProviderHoverTimeout = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);
  const followupProviderRowRefs = useRef<Record<string, HTMLDivElement | null>>(
    {},
  );

  const [timestamp] = useState(() => Date.now());

  // Memoize filtered messages to avoid new array on every render
  const visibleMessages = useMemo(
    () =>
      messages.filter(
        (m) => !m.isToolResult && !m.content?.startsWith("[Tool result for "),
      ),
    [messages],
  );

  // Virtualization: only render last 200 messages to avoid DOM bloat
  const VISIBLE_WINDOW = 200;
  const [showOlderCount, setShowOlderCount] = useState(0);
  const totalVisible = VISIBLE_WINDOW + showOlderCount * VISIBLE_WINDOW;
  const hiddenCount = Math.max(0, visibleMessages.length - totalVisible);
  const displayedMessages = visibleMessages.slice(hiddenCount);
  const showLoadOlder = hiddenCount > 0;

  // Reset confirmation dialog state
  const [resetConfirmState, setResetConfirmState] = useState<{
    messageId: string;
    messageContent: string;
    messageAttachments?: import("@dalam/shared-types").FileAttachment[];
    loading: boolean;
    fileChanges: {
      path: string;
      action: string;
      additions: number;
      deletions: number;
    }[];
  } | null>(null);

  // Stack of removed message groups for restore functionality
  const [removedMessagesStack, setRemovedMessagesStack] = useState<
    {
      messages: import("@dalam/shared-types").ChatMessage[];
      versionId: string;
    }[]
  >([]);

  // Control restore popup visibility
  const [showRestorePopup, setShowRestorePopup] = useState(false);

  // Auto-resize the textareas dynamically based on scrollHeight
  useEffect(() => {
    const mainTextarea = mainTextareaRef.current;
    if (mainTextarea) {
      mainTextarea.style.height = "auto";
      mainTextarea.style.height = `${Math.min(mainTextarea.scrollHeight, 400)}px`;
    }
    const followupTextarea = followupTextareaRef.current;
    if (followupTextarea) {
      followupTextarea.style.height = "auto";
      followupTextarea.style.height = `${Math.min(followupTextarea.scrollHeight, 400)}px`;
    }
  }, [value]);

  // Cleanup both provider hover timeouts on unmount
  useEffect(() => {
    return () => {
      if (providerHoverTimeout.current)
        clearTimeout(providerHoverTimeout.current);
      if (followupProviderHoverTimeout.current)
        clearTimeout(followupProviderHoverTimeout.current);
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
  const currentModel = allModels.find(
    (m) => m.model.modelId === selectedModelId,
  );

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
  }, [messages, isUserScrolledUp, scrollRef]);

  const hasMessages = messages.length > 0;

  // Auto-focus the chat input on mount and when switching between empty/non-empty
  const prevMsgCountRef = useRef(messages.length);
  useEffect(() => {
    const prevCount = prevMsgCountRef.current;
    const justEmptied = prevCount > 0 && messages.length === 0;
    prevMsgCountRef.current = messages.length;
    const t = setTimeout(() => {
      if (justEmptied || messages.length === 0)
        mainTextareaRef.current?.focus();
      else if (messages.length > 0) followupTextareaRef.current?.focus();
    }, 200);
    return () => clearTimeout(t);
  }, [messages.length]);

  // Click-outside to close dropdowns
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      // Skip if click is inside a portal-rendered model sub-dropdown
      if ((target as HTMLElement)?.closest?.("[data-model-subdropdown]"))
        return;
      if (workspaceRef.current && !workspaceRef.current.contains(target))
        setShowWorkspaceDropdown(false);
      if (branchRef.current && !branchRef.current.contains(target))
        setShowBranchDropdown(false);
      if (modelRef.current && !modelRef.current.contains(target))
        setShowModelDropdown(false);
      if (
        followupModelRef.current &&
        !followupModelRef.current.contains(target)
      )
        setShowFollowupModelDropdown(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  // Handle reset confirmation - compute file changes from messages that will be removed
  const handleResetClick = useCallback(
    (
      messageId: string,
      messageContent: string,
      attachments?: import("@dalam/shared-types").FileAttachment[],
    ) => {
      const chatState = useChat.getState();
      if (chatState.isStreaming) return;
      const msgs = chatState.messages;
      const idx = msgs.findIndex((m) => m.id === messageId);
      if (idx < 0) return;
      // Messages that will be removed (from idx onward)
      const removedMsgs = msgs.slice(idx);
      // Collect file changes from removed messages
      const allFileChanges: {
        path: string;
        action: string;
        additions: number;
        deletions: number;
      }[] = [];
      const fileChangeMap = new Map<
        string,
        { path: string; action: string; additions: number; deletions: number }
      >();
      for (const msg of removedMsgs) {
        if (msg.fileChanges) {
          for (const fc of msg.fileChanges) {
            const existing = fileChangeMap.get(fc.path);
            if (existing) {
              existing.additions += fc.additions;
              existing.deletions += fc.deletions;
            } else {
              fileChangeMap.set(fc.path, {
                path: fc.path,
                action: fc.action,
                additions: fc.additions,
                deletions: fc.deletions,
              });
            }
          }
        }
      }
      allFileChanges.push(...fileChangeMap.values());
      // Show confirmation dialog
      setResetConfirmState({
        messageId,
        messageContent,
        messageAttachments: attachments,
        loading: false,
        fileChanges: allFileChanges,
      });
    },
    [],
  );

  // Confirm the reset operation
  const handleResetConfirm = useCallback(() => {
    if (!resetConfirmState) return;
    const chatState = useChat.getState();
    const {
      activeSessionId,
      messages,
      sessionMessages,
      sessionVersions,
      chatSessions,
    } = chatState;
    if (!activeSessionId) return;
    const idx = messages.findIndex((m) => m.id === resetConfirmState.messageId);
    if (idx < 0) return;
    // Save version before resetting
    if (messages.length > 0) {
      chatState.saveVersion(activeSessionId, "Before reset");
    }
    // Keep messages before the target (not including the target)
    const kept = messages.slice(0, idx);
    const removed = messages.slice(idx);
    // Update sessionMessages
    const sessionMsgs = { ...sessionMessages, [activeSessionId]: kept };
    // Save removed messages to stack for restore
    const versions = sessionVersions[activeSessionId] ?? [];
    const lastVersion = versions.slice(-1)[0];
    setRemovedMessagesStack((prev) => {
      const next = [
        ...prev,
        { messages: removed, versionId: lastVersion?.id ?? "" },
      ];
      // Cap stack at 50 entries to prevent unbounded memory growth
      return next.length > 50 ? next.slice(-50) : next;
    });
    // Update preview and chatSessions
    const lastUserMsg = [...kept].reverse().find((m) => m.role === "user");
    const preview = lastUserMsg
      ? lastUserMsg.content.length > 60
        ? lastUserMsg.content.slice(0, 57) + "…"
        : lastUserMsg.content
      : undefined;
    const updatedSessions = chatSessions.map((cs) =>
      cs.id === activeSessionId
        ? {
            ...cs,
            messageCount: kept.length,
            lastActivityAt: Date.now(),
            ...(preview ? { preview } : {}),
          }
        : cs,
    );
    // Update state and persist via store's debounced persistence
    useChat.setState({
      messages: kept,
      sessionMessages: sessionMsgs,
      chatSessions: updatedSessions,
    });
    savePersistedMessages(sessionMsgs);
    savePersistedSessionSummaries(updatedSessions);
    // Populate input
    setValue(resetConfirmState.messageContent);
    // Set attachments
    if (
      resetConfirmState.messageAttachments &&
      resetConfirmState.messageAttachments.length > 0
    ) {
      for (const att of resetConfirmState.messageAttachments) {
        chatState.addPendingAttachment(att);
      }
    }
    // Close dialog
    setResetConfirmState(null);
    // Show restore popup
    setShowRestorePopup(true);
    // If no messages remain, the default screen will show automatically
  }, [resetConfirmState]);

  // Cancel the reset operation
  const handleResetCancel = useCallback(() => {
    setResetConfirmState(null);
  }, []);

  // Handle restore from popup
  const handleRestoreMessages = useCallback(() => {
    if (removedMessagesStack.length === 0) return;
    const chatState = useChat.getState();
    const { activeSessionId, messages, sessionMessages, chatSessions } =
      chatState;
    if (!activeSessionId) return;
    // Combine all removed messages from the stack
    const allRemoved = removedMessagesStack.flatMap((group) => group.messages);
    // Restore: add removed messages back
    const restored = [...messages, ...allRemoved];
    const sessionMsgs = { ...sessionMessages, [activeSessionId]: restored };
    const lastUserMsg = [...restored].reverse().find((m) => m.role === "user");
    const preview = lastUserMsg
      ? lastUserMsg.content.length > 60
        ? lastUserMsg.content.slice(0, 57) + "…"
        : lastUserMsg.content
      : undefined;
    const updatedSessions = chatSessions.map((cs) =>
      cs.id === activeSessionId
        ? {
            ...cs,
            messageCount: restored.length,
            lastActivityAt: Date.now(),
            ...(preview ? { preview } : {}),
          }
        : cs,
    );
    useChat.setState({
      messages: restored,
      sessionMessages: sessionMsgs,
      chatSessions: updatedSessions,
      restoredVersionId: null,
      preRestoreMessages: null,
    });
    savePersistedMessages(sessionMsgs);
    savePersistedSessionSummaries(updatedSessions);
    // Clear the stack and hide popup
    setRemovedMessagesStack([]);
    setShowRestorePopup(false);
    setValue("");
  }, [removedMessagesStack]);

  // Dismiss restore popup
  const handleDismissRestore = useCallback(() => {
    setShowRestorePopup(false);
    setRemovedMessagesStack([]);
  }, []);

  // Handle reset to message (populate input with message content)
  const handleResetToMessage = useCallback((content: string) => {
    setValue(content);
  }, []);

  const handleSubmit = () => {
    if (isStreaming) {
      const chat = useChat.getState();
      if (chat.session?.id) {
        void chat.abort(chat.session.id);
        toast.info("Generation aborted");
      }
      return;
    }
    if (!value.trim()) return;
    if (!workspace) {
      toast.warning("Open a folder first");
      return;
    }
    if (!selectedModelId && !settings.selectedModel) {
      toast.warning("Select a model in Settings first");
      return;
    }
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
  /cost       - Show token usage and cost breakdown for this session
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
        chat
          .compactSessionHistory(sessionId)
          .then(() => {
            chat.injectSystemMessage(
              "Conversation history compacted successfully. Selected messages have been compressed to free up context window space.",
            );
          })
          .catch((err: unknown) => {
            chat.injectSystemMessage(
              `Compaction failed: ${(err as Error).message || String(err)}`,
            );
          });
      } else {
        toast.warning("No active chat session to compact.");
      }
      setValue("");
      return;
    }

    if (trimmed === "/cost") {
      const sessionId = chat.activeSessionId;
      if (sessionId) {
        void import("@/lib/costTracker").then(({ formatCostDetailed }) => {
          chat.injectSystemMessage(formatCostDetailed(sessionId));
        });
      } else {
        toast.warning("No active chat session.");
      }
      setValue("");
      return;
    }

    if (trimmed.startsWith("/metrics")) {
      void import("@/lib/metrics").then(({ formatMetrics, resetMetrics }) => {
        if (trimmed === "/metrics reset") {
          resetMetrics();
          chat.injectSystemMessage("Performance metrics reset.");
        } else {
          chat.injectSystemMessage(formatMetrics());
        }
      });
      setValue("");
      return;
    }

    if (trimmed === "/dream") {
      const workspacePath = useWorkspace
        .getState()
        .workspaces.find(
          (w) => w.id === useWorkspace.getState().activeWorkspaceId,
        )?.path;
      if (workspacePath) {
        toast.info("Running memory consolidation cycle...");
        void import("@/lib/dreamAgent").then(({ runDreamCycle }) => {
          runDreamCycle(workspacePath)
            .then((result) => {
              const r = result.report;
              const p = result.proposals;
              let reportText = `### 🌙 Dream Cycle Report\nConsolidation cycle completed:\n- **Purged**: ${r.purgedCount} memories\n- **Validated**: ${r.validatedCount} file references\n- **Merged & Deduplicated**: ${r.deduplicatedCount} memories\n- **Adjusted relative dates**: ${r.dateAdjustedCount} memories`;
              if (p.autoAccepted.length > 0) {
                reportText += `\n- **Auto-applied**: ${p.autoAccepted.length} proposals (score >= 7)`;
              }
              if (p.queuedForReview.length > 0) {
                reportText += `\n- **Awaiting review**: ${p.queuedForReview.length} proposal${p.queuedForReview.length === 1 ? "" : "s"} (score >= 4)`;
              }
              if (p.rejected.length > 0) {
                reportText += `\n- **Rejected**: ${p.rejected.length} low-scoring proposal${p.rejected.length === 1 ? "" : "s"}`;
              }
              chat.injectSystemMessage(reportText);
            })
            .catch((err: unknown) => {
              chat.injectSystemMessage(
                `Dream cycle failed: ${(err as Error).message || String(err)}`,
              );
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
      const workspacePath = useWorkspace
        .getState()
        .workspaces.find(
          (w) => w.id === useWorkspace.getState().activeWorkspaceId,
        )?.path;
      if (sessionId && workspacePath) {
        toast.info("Assessing chat history for skill crystallization...");
        import("@/lib/skillCrystallizer")
          .then(({ proposeSkillFromSession }) => {
            void proposeSkillFromSession(sessionId, workspacePath, true);
          })
          .catch((err) => {
            chat.injectSystemMessage(
              `Crystallization failed to load: ${err.message || err}`,
            );
          });
      } else {
        toast.warning("No active chat session or workspace open.");
      }
      setValue("");
      return;
    }

    if (trimmed === "/login") {
      useSettingsView.getState().open("models");
      chat.injectSystemMessage(
        "Settings modal opened on the Models configuration tab.",
      );
      setValue("");
      return;
    }

    if (trimmed.startsWith("/model")) {
      const targetModelId = trimmed.slice(7).trim();
      const allModels = getAllModels();

      if (!targetModelId) {
        const modelList = allModels
          .map((m) => `- ${m.model.modelId} (${m.model.name})`)
          .join("\n");
        chat.injectSystemMessage(
          `Usage: /model <modelId>\n\nAvailable Models:\n${modelList}`,
        );
      } else {
        const found = allModels.find(
          (m) =>
            m.model.modelId.toLowerCase() === targetModelId.toLowerCase() ||
            m.model.name.toLowerCase().includes(targetModelId.toLowerCase()),
        );
        if (found) {
          void chat.setSelectedModel(found.model.modelId);
          chat.injectSystemMessage(
            `Active model switched to: ${found.model.name} (${found.model.modelId})`,
          );
        } else {
          chat.injectSystemMessage(
            `Model "${targetModelId}" not found. Type "/model" to see available options.`,
          );
        }
      }
      setValue("");
      return;
    }

    if (trimmed.startsWith("/agent")) {
      chat.injectSystemMessage(
        "Mode selection is no longer available. The assistant always has full access to read, write, and execute.",
      );
      setValue("");
      return;
    }

    if (trimmed === "/reasoning") {
      const model = chat.selectedModelId;
      const isReasoningModel =
        model.includes("o1") ||
        model.includes("o3") ||
        model.includes("deepseek-r1");
      const statusText = isReasoningModel
        ? `Model "${model}" supports native thinking output. Reasoning is active.`
        : `Model "${model}" does not natively output deep thinking tokens. Use o1/o3-mini/deepseek-r1 models for extended reasoning.`;
      chat.injectSystemMessage(statusText);
      setValue("");
      return;
    }

    if (trimmed === "/undo") {
      // Phase 1: Try file-level undo (revert the last write_file/edit_file change)
      void import("@/lib/changeStack").then(
        async ({ applyUndo, peekChange, getChangeStackSize }) => {
          const change = peekChange();
          if (change) {
            const result = await applyUndo();
            if (result) {
              chat.injectSystemMessage(
                `**Undo**: Reverted changes in \`${result.filePath}\`.\n` +
                  `**Stack**: ${getChangeStackSize()} change(s) remaining.`,
              );
              return;
            }
            // applyUndo failed — fall through to message undo
          }

          // Phase 2: Message-level undo (restore previously removed messages)
          if (removedMessagesStack.length === 0) {
            chat.injectSystemMessage("Nothing to undo.");
            return;
          }
          const lastGroup =
            removedMessagesStack[removedMessagesStack.length - 1];
          const restored = lastGroup.messages;
          const chatState = useChat.getState();
          const sessionMsgs = {
            ...chatState.sessionMessages,
            [chat.activeSessionId!]: [...chatState.messages, ...restored],
          };
          setRemovedMessagesStack((prev) => prev.slice(0, -1));
          useChat.setState({
            messages: [...chatState.messages, ...restored],
            sessionMessages: sessionMsgs,
          });
          savePersistedMessages(sessionMsgs);
          chat.injectSystemMessage(`Restored ${restored.length} message(s).`);
        },
      );
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
      const formatted = messages
        .filter(
          (m) => !m.isToolResult && !m.content?.startsWith("[Tool result for "),
        )
        .map((m) => `### ${m.role.toUpperCase()}:\n\n${m.content}\n`)
        .join("\n---\n\n");
      const title = `Dalam Session Share log - ${new Date().toLocaleString()}\n\n`;
      const shareContent = title + formatted;

      void (async () => {
        try {
          const { writeText } =
            await import("@tauri-apps/plugin-clipboard-manager");
          await writeText(shareContent);
          toast.success(
            "Share link created",
            "Conversation copied to clipboard!",
          );
          chat.injectSystemMessage(
            "Conversation history copied to clipboard successfully!",
          );
        } catch (e) {
          if (import.meta.env.DEV) console.warn("[ChatView] Tauri clipboard failed, falling back:", e);
          try {
            await navigator.clipboard.writeText(shareContent);
            toast.success(
              "Share link created",
              "Conversation copied to clipboard!",
            );
            chat.injectSystemMessage(
              "Conversation history copied to clipboard successfully!",
            );
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
          const filesText =
            files.length > 0
              ? files.map((f) => `  - \`${f.name}\` (${f.type})`).join("\n")
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
          const hasConfig = files.some(
            (f) =>
              f.name === "package.json" ||
              f.name === "Cargo.toml" ||
              f.name === "pyproject.toml",
          );

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
          chat.injectSystemMessage(
            `Workspace bootstrap failed: ${String(err)}`,
          );
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
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleFollowupKeyDown = (
    e: React.KeyboardEvent<HTMLTextAreaElement>,
  ) => {
    if (followupAutocompleteKey.current?.(e)) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const totalAdded = gitStatus?.added.length ?? 0;
  const totalDeleted = gitStatus?.deleted.length ?? 0;
  const totalModified = gitStatus?.modified.length ?? 0;

  return (
    <div className="h-full flex flex-col bg-dalam-bg-primary">
      <div
        ref={scrollRef}
        className="flex-1 min-h-0 overflow-y-auto scrollbar-thin"
      >
        {!hasMessages && !isStreaming ? (
          <div className="relative h-full flex flex-col items-center justify-center px-8 -mt-10">
            {/* Large background D watermark — low opacity, behind everything */}
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 flex items-center justify-center select-none"
            >
              <span
                style={{
                  fontFamily:
                    "'Newsreader', 'Iowan Old Style', 'Georgia', serif",
                  fontSize: "min(95vh, 1300px)",
                  fontWeight: 300,
                  lineHeight: 0.85,
                  letterSpacing: "-0.06em",
                  transform: "translateY(4.5%) rotate(90deg)",
                  userSelect: "none",
                  background:
                    "linear-gradient(to left, color-mix(in srgb, var(--dalam-text-primary) 0.5%, transparent), color-mix(in srgb, var(--dalam-text-primary) 9.5%, transparent))",
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
                style={{
                  fontFamily:
                    "'Newsreader', 'Iowan Old Style', 'Georgia', serif",
                  fontWeight: 500,
                }}
              >
                {workspace ? (
                  <>
                    Start a new task in{" "}
                    <span className="text-dalam-accent-primary">
                      {workspace.name}
                    </span>
                  </>
                ) : (
                  "Open a folder to begin"
                )}
              </h1>
              {/* Removed overflow-hidden so dropdowns can render above the card */}
              <div className="bg-dalam-bg-secondary border border-dalam-border-primary rounded-xl shadow-2xl">
                <div className="px-4 pt-2.5 flex items-center gap-3">
                  <div className="relative" ref={workspaceRef}>
                    <button
                      className={`flex items-center gap-1.5 text-sm transition-colors ${workspace ? "text-dalam-text-secondary hover:text-dalam-text-primary" : "text-dalam-text-muted hover:text-dalam-text-secondary"}`}
                      onClick={() => {
                        setShowWorkspaceDropdown((v) => !v);
                        setShowBranchDropdown(false);
                        setShowModelDropdown(false);
                      }}
                      title={
                        workspace
                          ? `Active workspace: ${workspace.name}`
                          : "Select a folder to start working"
                      }
                    >
                      <FolderOpen
                        className={`w-4 h-4 ${workspace ? "text-dalam-text-muted" : "text-amber-400/80"}`}
                      />
                      <span>{workspace?.name || "Select a folder"}</span>
                      <ChevronDown className="w-3.5 h-3.5 text-dalam-text-muted" />
                    </button>
                    {showWorkspaceDropdown && (
                      <div className="absolute top-full left-0 mt-1 w-64 bg-dalam-bg-secondary border border-dalam-border-primary rounded-xl shadow-2xl z-50 overflow-hidden">
                        <div className="p-2 border-b border-dalam-border-primary">
                          <input
                            className="input-base w-full text-xs"
                            placeholder="Search workspaces"
                            autoFocus
                            value={workspaceSearch}
                            onChange={(e) => setWorkspaceSearch(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Escape") {
                                setShowWorkspaceDropdown(false);
                                setWorkspaceSearch("");
                              }
                            }}
                          />
                        </div>
                        <div className="max-h-60 overflow-y-auto">
                          {workspaces.length === 0 && (
                            <div className="px-3 py-3 text-xs text-dalam-text-muted">
                              No workspaces yet. Open a folder to get started.
                            </div>
                          )}
                          {workspaces
                            .filter(
                              (ws) =>
                                !workspaceSearch ||
                                ws.name
                                  .toLowerCase()
                                  .includes(workspaceSearch.toLowerCase()),
                            )
                            .map((ws) => (
                              <button
                                key={ws.id}
                                className={`w-full text-left px-3 py-2 flex items-center gap-2 text-sm hover:bg-dalam-bg-hover transition-colors ${ws.id === activeWorkspaceId ? "bg-dalam-bg-hover" : ""}`}
                                onClick={() => {
                                  setActiveWorkspace(ws.id);
                                  setShowWorkspaceDropdown(false);
                                  setWorkspaceSearch("");
                                }}
                              >
                                <FolderOpen className="w-4 h-4 text-dalam-text-muted flex-shrink-0" />
                                <span className="flex-1 truncate text-dalam-text-primary">
                                  {ws.name}
                                </span>
                                {ws.id === activeWorkspaceId && (
                                  <Check className="w-4 h-4 text-dalam-accent-primary" />
                                )}
                              </button>
                            ))}
                          {workspaceSearch &&
                            workspaces.filter((ws) =>
                              ws.name
                                .toLowerCase()
                                .includes(workspaceSearch.toLowerCase()),
                            ).length === 0 && (
                              <div className="px-3 py-2 text-xs text-dalam-text-muted">
                                No matching workspaces
                              </div>
                            )}
                          <div className="border-t border-dalam-border-primary">
                            <button
                              className="w-full text-left px-3 py-2 flex items-center gap-2 text-sm text-dalam-text-secondary hover:bg-dalam-bg-hover transition-colors"
                              onClick={() => {
                                void openWorkspace();
                                setShowWorkspaceDropdown(false);
                                setWorkspaceSearch("");
                              }}
                            >
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
                      <button
                        className="flex items-center gap-1.5 text-xs text-dalam-text-muted hover:text-dalam-text-secondary transition-colors"
                        onClick={() => {
                          setShowBranchDropdown((v) => !v);
                          setShowWorkspaceDropdown(false);
                          setShowModelDropdown(false);
                        }}
                      >
                        <GitBranch className="w-3.5 h-3.5" />
                        <span>{gitStatus.branch}</span>
                        <ChevronDown className="w-3 h-3" />
                      </button>
                      {showBranchDropdown && (
                        <div className="absolute top-full left-0 mt-1 w-40 bg-dalam-bg-secondary border border-dalam-border-primary rounded-lg shadow-2xl z-50 overflow-hidden">
                          <button className="w-full text-left px-3 py-2 flex items-center gap-2 text-sm text-dalam-text-primary hover:bg-dalam-bg-hover">
                            <Check className="w-3.5 h-3.5 text-dalam-accent-primary" />
                            {gitStatus.branch}
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
                        <div
                          key={att.id}
                          className="flex items-center gap-1.5 px-2 py-1 bg-dalam-bg-active border border-dalam-border-primary rounded-md text-xs text-dalam-text-primary"
                        >
                          {att.mimeType.startsWith("image/") ? (
                            <img
                              src={`data:${att.mimeType};base64,${att.content}`}
                              alt={att.name}
                              className="w-5 h-5 rounded object-cover"
                            />
                          ) : (
                            <FileText className="w-3.5 h-3.5 text-dalam-text-muted" />
                          )}
                          <span className="max-w-[120px] truncate">
                            {att.name}
                          </span>
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
                    className="chat-input w-full bg-transparent border-0 outline-none text-sm text-dalam-text-primary placeholder:text-dalam-text-muted resize-none overflow-y-auto min-h-[28px] max-h-[400px]"
                    placeholder="Ask Dalam anything, @ to add files, / for commands, $ for skills, # for related conversations"
                    aria-label="Chat message input"
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
                    <AgentModeSelector />
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="relative" ref={modelRef}>
                      <Tooltip
                        content={
                          currentModel?.model.name ||
                          selectedModelId ||
                          "Select model"
                        }
                        side="top"
                      >
                        <button
                          className="flex items-center gap-1.5 px-2.5 py-1 text-xs text-dalam-text-secondary hover:bg-dalam-bg-hover rounded-md transition-colors"
                          onClick={() => {
                            setShowModelDropdown((v) => !v);
                            setShowWorkspaceDropdown(false);
                            setShowBranchDropdown(false);
                          }}
                        >
                          <span
                            className={`w-2 h-2 rounded-full ${currentModel ? "bg-dalam-git-added" : "bg-dalam-text-muted"}`}
                          />
                          {currentModel?.model.name ||
                            selectedModelId ||
                            "Select model"}
                          <ChevronDown className="w-3 h-3" />
                        </button>
                      </Tooltip>
                      {showModelDropdown && (
                        <div
                          className="absolute bottom-full right-0 mb-1 bg-dalam-bg-secondary border border-dalam-border-primary rounded-xl shadow-2xl z-50 min-w-[220px]"
                          data-dropdown-body
                        >
                          <div className="max-h-80 overflow-y-auto">
                            {providers
                              .filter((p) => p.enabled)
                              .map((p) => {
                                const enabledModels = p.models.filter(
                                  (m) => m.enabled !== false,
                                );
                                if (enabledModels.length === 0) return null;
                                const hasActiveModel = enabledModels.some(
                                  (m) => m.modelId === selectedModelId,
                                );
                                return (
                                  <div
                                    key={p.id}
                                    ref={(el) => {
                                      providerRowRefs.current[p.id] = el;
                                    }}
                                    onMouseEnter={() => {
                                      if (providerHoverTimeout.current)
                                        clearTimeout(
                                          providerHoverTimeout.current,
                                        );
                                      setHoveredProvider(p.id);
                                    }}
                                    onMouseLeave={() => {
                                      providerHoverTimeout.current = setTimeout(
                                        () => setHoveredProvider(null),
                                        200,
                                      );
                                    }}
                                  >
                                    <div
                                      className={`flex items-center justify-between px-3 py-2 cursor-pointer transition-colors ${hasActiveModel ? "text-dalam-accent-primary" : "text-dalam-text-primary hover:bg-dalam-bg-hover"}`}
                                    >
                                      <span className="text-sm">{p.name}</span>
                                      <div className="flex items-center gap-1">
                                        {hasActiveModel && (
                                          <Check className="w-3.5 h-3.5 text-dalam-accent-primary" />
                                        )}
                                        <ChevronRight className="w-3 h-3 text-dalam-text-muted" />
                                      </div>
                                    </div>
                                  </div>
                                );
                              })}
                          </div>
                          <div className="border-t border-dalam-border-primary">
                            <button
                              className="w-full text-left px-3 py-2 flex items-center gap-2 text-sm text-dalam-text-secondary hover:bg-dalam-bg-hover transition-colors"
                              onClick={() => {
                                useSettingsView.getState().open("models");
                                setShowModelDropdown(false);
                              }}
                            >
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
                          onSelect={(modelId) => {
                            void setSelectedModel(modelId);
                            setShowModelDropdown(false);
                          }}
                          onClose={() => setHoveredProvider(null)}
                          hoverTimeoutRef={providerHoverTimeout}
                        />
                      )}
                    </div>
                    <Tooltip
                      content={
                        isStreaming
                          ? "Stop generating"
                          : !workspace
                            ? "Open a folder first"
                            : !selectedModelId
                              ? "Select a model first"
                              : "Send"
                      }
                      side="top"
                    >
                      <button
                        className="w-8 h-8 flex items-center justify-center rounded-full bg-dalam-text-primary text-dalam-bg-primary hover:opacity-90 transition-opacity disabled:opacity-30 disabled:cursor-not-allowed"
                        disabled={
                          !isStreaming &&
                          (!value.trim() ||
                            !workspace ||
                            (!selectedModelId && !settings.selectedModel))
                        }
                        onClick={handleSubmit}
                        aria-label={isStreaming ? "Stop generation" : "Send message"}
                      >
                        {isStreaming ? (
                          <Square className="w-4 h-4 fill-current" />
                        ) : (
                          <ArrowUp className="w-4 h-4" strokeWidth={2.5} />
                        )}
                      </button>
                    </Tooltip>
                  </div>
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className="max-w-3xl mx-auto py-6 px-6 space-y-1">
            {gitStatus && totalAdded + totalDeleted + totalModified > 0 && (
              <div className="flex items-center gap-2 mb-4 text-[11px] text-dalam-text-muted">
                <FileText className="w-3 h-3" />
                <span>Changes</span>
                {totalAdded > 0 && (
                  <span className="text-dalam-git-added">+{totalAdded}</span>
                )}
                {totalDeleted > 0 && (
                  <span className="text-dalam-git-deleted">
                    -{totalDeleted}
                  </span>
                )}
                {totalModified > 0 && (
                  <span className="text-dalam-git-modified">
                    ~{totalModified}
                  </span>
                )}
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
                  {messages.length}{" "}
                  {messages.length === 1 ? "message" : "messages"}
                </span>
                <span className="text-dalam-text-muted/40">·</span>
                <SessionCostTracker
                  modelId={useSettings.getState().settings.selectedModel}
                />
                <span
                  className="flex items-center gap-1"
                  title="Approximate token count (1 token ≈ 4 chars)"
                >
                  <Sparkles className="w-3 h-3" />
                  {Math.ceil(
                    messages.reduce((sum, m) => sum + m.content.length, 0) / 4,
                  ).toLocaleString()}{" "}
                  tokens
                </span>
                <span className="text-dalam-text-muted/40">·</span>
                <span className="flex items-center gap-1">
                  {formatTime(messages[0].timestamp)}
                </span>
                <span className="ml-auto flex items-center gap-1">
                  <Cpu className="w-3 h-3" />
                  {currentModel?.model.name ||
                    settings.selectedModel ||
                    "No model"}
                </span>
              </div>
            )}
            {showLoadOlder && (
              <button
                onClick={() => setShowOlderCount((c) => c + 1)}
                className="mx-auto block px-4 py-1.5 text-xs text-dalam-text-muted hover:text-dalam-text-primary hover:bg-dalam-bg-active rounded-lg transition-colors"
              >
                Show {Math.min(hiddenCount, VISIBLE_WINDOW)} older messages (
                {hiddenCount} hidden)
              </button>
            )}
            {displayedMessages.map((m, idx, arr) => (
              <ChatMessage
                key={m.id}
                message={m}
                onResetToMessage={handleResetToMessage}
                onResetClick={handleResetClick}
                isLast={idx === arr.length - 1}
              />
            ))}
            {planApproval && planApproval.status === "pending" && (
              <div className="mx-4 my-3 p-4 bg-dalam-accent-subtle border border-dalam-accent-primary/30 rounded-xl animate-fade-in">
                <div className="flex items-center gap-2 mb-2">
                  <ClipboardList className="w-4 h-4 text-dalam-accent-primary" />
                  <span className="text-sm font-medium text-dalam-text-primary">
                    Plan ready for review
                  </span>
                </div>
                <p className="text-xs text-dalam-text-muted mb-3">
                  The AI has produced a plan. Approve to switch to Build mode
                  and execute it.
                </p>
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
            <StreamingMessageWrapper
              scrollRef={scrollRef}
              isUserScrolledUp={isUserScrolledUp}
              timestamp={timestamp}
            />
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

      {/* Reset confirmation dialog */}
      {resetConfirmState && (
        <ResetConfirmDialog
          fileChanges={resetConfirmState.fileChanges}
          loading={resetConfirmState.loading}
          onConfirm={handleResetConfirm}
          onCancel={handleResetCancel}
        />
      )}

      {/* Only show follow-up input when there are actual messages */}
      {hasMessages && (
        <div className="p-3 flex-shrink-0 bg-dalam-bg-primary">
          {/* Restore popup — shown after reset */}
          {showRestorePopup && removedMessagesStack.length > 0 && (
            <RestorePopup
              removedMessages={removedMessagesStack.flatMap((g) => g.messages)}
              onRestore={handleRestoreMessages}
              onDismiss={handleDismissRestore}
            />
          )}
          {/* Inline question dialog — appears above input when agent asks a question */}
          <InlineQuestionDialog />
          {/* Message queue — follow-up messages waiting to be sent */}
          <MessageQueue />
          <div className="max-w-2xl w-full mx-auto bg-dalam-bg-secondary border border-dalam-border-primary rounded-xl shadow-lg">
            <div className="px-4 py-3 relative">
              {pendingAttachments.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {pendingAttachments.map((att) => (
                    <div
                      key={att.id}
                      className="flex items-center gap-1.5 px-2 py-1 bg-dalam-bg-active border border-dalam-border-primary rounded-md text-xs text-dalam-text-primary"
                    >
                      {att.mimeType.startsWith("image/") ? (
                        <img
                          src={`data:${att.mimeType};base64,${att.content}`}
                          alt={att.name}
                          className="w-5 h-5 rounded object-cover"
                        />
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
                ref={followupTextareaRef}
                className="chat-input w-full bg-transparent border-0 outline-none text-sm text-dalam-text-primary placeholder:text-dalam-text-muted resize-none overflow-y-auto leading-relaxed min-h-[40px] max-h-[400px]"
                placeholder={
                  messageQueue.length > 0
                    ? "Keep typing to queue follow-up changes"
                    : "Ask for follow-up changes"
                }
                aria-label="Follow-up message input"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                onKeyDown={handleFollowupKeyDown}
                rows={1}
              />
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
                <AgentModeSelector />
              </div>
              <div className="flex items-center gap-2">
                <div className="relative" ref={followupModelRef}>
                  <button
                    className="flex items-center gap-1.5 px-2.5 py-1 text-xs text-dalam-text-secondary hover:bg-dalam-bg-hover rounded-md transition-colors"
                    onClick={() => {
                      setShowFollowupModelDropdown((v) => !v);
                    }}
                  >
                    <span
                      className={`w-2 h-2 rounded-full ${currentModel ? "bg-dalam-git-added" : "bg-dalam-text-muted"}`}
                    />
                    {currentModel?.model.name ||
                      selectedModelId ||
                      "Select model"}
                    <ChevronDown className="w-3 h-3" />
                  </button>
                  {showFollowupModelDropdown && (
                    <div
                      className="absolute bottom-full right-0 mb-1 bg-dalam-bg-secondary border border-dalam-border-primary rounded-xl shadow-2xl z-50 min-w-[220px]"
                      data-dropdown-body
                    >
                      <div className="max-h-80 overflow-y-auto">
                        {providers
                          .filter((p) => p.enabled)
                          .map((p) => {
                            const enabledModels = p.models.filter(
                              (m) => m.enabled !== false,
                            );
                            if (enabledModels.length === 0) return null;
                            const hasActiveModel = enabledModels.some(
                              (m) => m.modelId === selectedModelId,
                            );
                            return (
                              <div
                                key={p.id}
                                ref={(el) => {
                                  followupProviderRowRefs.current[p.id] = el;
                                }}
                                onMouseEnter={() => {
                                  if (followupProviderHoverTimeout.current)
                                    clearTimeout(
                                      followupProviderHoverTimeout.current,
                                    );
                                  setHoveredFollowupProvider(p.id);
                                }}
                                onMouseLeave={() => {
                                  followupProviderHoverTimeout.current =
                                    setTimeout(
                                      () => setHoveredFollowupProvider(null),
                                      200,
                                    );
                                }}
                              >
                                <div
                                  className={`flex items-center justify-between px-3 py-2 cursor-pointer transition-colors ${hasActiveModel ? "text-dalam-accent-primary" : "text-dalam-text-primary hover:bg-dalam-bg-hover"}`}
                                >
                                  <span className="text-sm">{p.name}</span>
                                  <div className="flex items-center gap-1">
                                    {hasActiveModel && (
                                      <Check className="w-3.5 h-3.5 text-dalam-accent-primary" />
                                    )}
                                    <ChevronRight className="w-3 h-3 text-dalam-text-muted" />
                                  </div>
                                </div>
                              </div>
                            );
                          })}
                      </div>
                      <div className="border-t border-dalam-border-primary">
                        <button
                          className="w-full text-left px-3 py-2 flex items-center gap-2 text-sm text-dalam-text-secondary hover:bg-dalam-bg-hover transition-colors"
                          onClick={() => {
                            useSettingsView.getState().open("models");
                            setShowFollowupModelDropdown(false);
                          }}
                        >
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
                        onSelect={(modelId) => {
                          void setSelectedModel(modelId);
                          setShowFollowupModelDropdown(false);
                      }}
                      onClose={() => setHoveredFollowupProvider(null)}
                      hoverTimeoutRef={followupProviderHoverTimeout}
                    />
                  )}
                </div>
                <button
                  className="w-8 h-8 flex items-center justify-center rounded-full bg-dalam-text-primary text-dalam-bg-primary hover:opacity-90 transition-opacity disabled:opacity-30 disabled:cursor-not-allowed"
                  disabled={
                    !isStreaming &&
                    (!value.trim() ||
                      !workspace ||
                      (!selectedModelId && !settings.selectedModel))
                  }
                  onClick={handleSubmit}
                  aria-label={isStreaming ? "Stop generating" : "Send message"}
                  title={
                    isStreaming
                      ? "Stop generating"
                      : !workspace
                        ? "Open a folder first"
                        : !selectedModelId
                          ? "Select a model first"
                          : "Send"
                  }
                >
                  {isStreaming ? (
                    <Square className="w-4 h-4 fill-current" />
                  ) : (
                    <ArrowUp className="w-4 h-4" strokeWidth={2.5} />
                  )}
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
 * StreamingMessageWrapper — renders live streaming content with frame-synced throttling.
 *
 * Instead of fragile delta-based boundary detection (which breaks when content
 * is trimmed by the 200K char safety limit), this uses a simple rAF throttle:
 * every state change schedules one rAF callback that compares cleaned content
 * to the previous cleaned content. This gives smooth 60fps updates without
 * flickering or lag, regardless of content trimming or batch size.
 */
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

  // Refs hold latest values for rAF callback (no stale closures)
  const streamingContentRef = useRef(streamingContent);
  const thinkingContentRef = useRef(thinkingContent);
  const mountedRef = useRef(true);

  // Sync refs with state via effect
  useEffect(() => {
    streamingContentRef.current = streamingContent;
    thinkingContentRef.current = thinkingContent;
  }, [streamingContent, thinkingContent]);

  // Track unmount for rAF guard
  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const prevCleanRef = useRef("");
  const prevThinkingRef = useRef("");
  const rafIdRef = useRef<number | null>(null);
  const [cleanStreamingContent, setCleanStreamingContent] = useState("");
  const [cleanThinkingContent, setCleanThinkingContent] = useState("");

  useEffect(() => {
    // Both empty: reset immediately (stream ended or hasn't started)
    if (!streamingContent && !thinkingContent) {
      if (prevCleanRef.current !== "" || prevThinkingRef.current !== "") {
        prevCleanRef.current = "";
        prevThinkingRef.current = "";
        setCleanStreamingContent("");
        setCleanThinkingContent("");
      }
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
      return;
    }

    // Schedule one rAF callback per frame (deduped via rafIdRef)
    if (rafIdRef.current === null) {
      rafIdRef.current = requestAnimationFrame(() => {
        rafIdRef.current = null;
        if (!mountedRef.current) return;
        const raw = streamingContentRef.current;
        const rawThinking = thinkingContentRef.current;

        // Only run expensive XML stripping when content likely contains tags
        const cleaned =
          raw &&
          (raw.includes("<") || raw.match(/(?:^|[\s<])question\s+question=/))
            ? stripXmlToolCallTags(raw)
            : raw || "";

        if (prevCleanRef.current !== cleaned) {
          prevCleanRef.current = cleaned;
          setCleanStreamingContent(cleaned);
        }
        if (prevThinkingRef.current !== rawThinking) {
          prevThinkingRef.current = rawThinking;
          setCleanThinkingContent(rawThinking);
        }
      });
    }

    return () => {
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
    };
  }, [streamingContent, thinkingContent]);

  // Handle auto-scroll on content updates — throttled via RAF
  const streamScrollRafRef = useRef<number>(0);
  useEffect(() => {
    if (!isUserScrolledUp.current && scrollRef.current) {
      cancelAnimationFrame(streamScrollRafRef.current);
      streamScrollRafRef.current = requestAnimationFrame(() => {
        if (scrollRef.current) {
          scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
      });
    }
    return () => cancelAnimationFrame(streamScrollRafRef.current);
  }, [
    cleanStreamingContent,
    cleanThinkingContent,
    isUserScrolledUp,
    scrollRef,
  ]);

  // Memoize streaming message object to prevent re-render cascade
  const streamingMessage = React.useMemo(
    () => ({
      id: "streaming",
      role: "assistant" as const,
      content: cleanStreamingContent,
      timestamp: timestamp,
      ...(cleanThinkingContent ? { thinking: cleanThinkingContent } : {}),
    }),
    [cleanStreamingContent, cleanThinkingContent, timestamp],
  );

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
        <ChatMessage message={streamingMessage} pending />
      )}
      {!cleanStreamingContent &&
        pendingToolCalls.length === 0 &&
        pendingActivities.length === 0 &&
        !cleanThinkingContent && (
          <div className="py-3 animate-fade-in-up">
            <div className="flex items-center gap-3 text-[13px] text-dalam-text-secondary">
              <div className="animate-thinking-wave">
                <span />
                <span />
                <span />
                <span />
                <span />
              </div>
              <span className="opacity-70">Thinking</span>
            </div>
          </div>
        )}
    </>
  );
}

// Export ChatView as default and individual components as named exports
export {
  ChatView,
  ChatMessage,
  StreamingMessageWrapper,
  WorkingTimer,
  StreamingActivityPanel,
  InlineActivityRow,
  ModelSubDropdown,
  AttachFileButton,
  CodeBlock,
  MarkdownContent,
};
export default ChatView;
