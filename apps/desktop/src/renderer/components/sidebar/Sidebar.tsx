import { useEffect, useMemo, useRef, useState } from "react";
import ReactDOM from "react-dom";
import {
  useWorkspace,
  useSettingsView,
  useChat,
  usePermission,
  useQuestion,
  useCommandPalette,
  useUI,
} from "@/store/useAppStore";
import { shortcut, modKey } from "@/lib/platform";
import {
  Search,
  Plus,
  Settings,
  Sparkles,
  ChevronDown,
  ChevronRight,
  Folder,
  FolderOpen,
  MessageSquare,
  XCircle,
  Trash2,
  Pencil,
  History,
  Undo2,
  MoreVertical,
  List,
  MessageSquarePlus,
  Zap,
  Webhook,
  Clock,
  FileText,
  GripVertical,
} from "lucide-react";
import type { ChatSessionSummary, ChatVersion } from "@dalam/shared-types";
import { Tooltip } from "../ui/Tooltip";
import {
  getConnectorConfigs,
  saveConnectorConfig,
  removeConnectorConfig,
} from "@/lib/connectors";
import type { ConnectorConfig } from "@/lib/connectors";
import { FileTree } from "./FileTree";

function formatRelative(ts: number, now: number): string {
  const diff = Math.max(0, now - ts);
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  return `${Math.floor(diff / 86_400_000)}d`;
}

/** Status dot for sidebar session items */
function StatusDot({
  status,
  lastVisitedAt,
  lastActivityAt,
}: {
  status: string;
  lastVisitedAt?: number;
  lastActivityAt: number;
}) {
  // Don't show dot if user has visited since the last activity
  // But always show for "running" and "questioning" states
  const userVisited =
    lastVisitedAt !== undefined && lastVisitedAt >= lastActivityAt;

  // Running state - animated loading indicator with breathing effect
  if (status === "running") {
    return (
      <span
        className="relative flex h-2.5 w-2.5 flex-shrink-0"
        title="AI is working..."
      >
        <span className="absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75 status-dot-running" />
        <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-blue-500" />
      </span>
    );
  }

  // Questioning state - animated yellow indicator with pulse effect
  if (status === "questioning") {
    return (
      <span
        className="relative flex h-2.5 w-2.5 flex-shrink-0"
        title="AI is asking a question..."
      >
        <span className="absolute inline-flex h-full w-full rounded-full bg-yellow-400 opacity-75 status-dot-questioning" />
        <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-yellow-500" />
      </span>
    );
  }

  // For other states, don't show if user has visited
  if (userVisited) return null;

  // Completed state - green dot with subtle glow
  if (status === "completed") {
    return (
      <span
        className="relative flex h-2 w-2 flex-shrink-0"
        title="Task completed"
      >
        <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-50" />
        <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
      </span>
    );
  }

  // Error state - red dot with subtle glow
  if (status === "error") {
    return (
      <span className="relative flex h-2 w-2 flex-shrink-0" title="Task failed">
        <span className="absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-50" />
        <span className="relative inline-flex rounded-full h-2 w-2 bg-red-500" />
      </span>
    );
  }

  // Aborted state - orange dot
  if (status === "aborted") {
    return (
      <span
        className="relative flex h-2 w-2 flex-shrink-0"
        title="Task aborted"
      >
        <span className="absolute inline-flex h-full w-full rounded-full bg-orange-400 opacity-50" />
        <span className="relative inline-flex rounded-full h-2 w-2 bg-orange-500" />
      </span>
    );
  }

  return null;
}

interface SessionRowProps {
  session: ChatSessionSummary;
  isActive: boolean;
  isStreaming: boolean;
  onSelect: () => void;
  onRemove: () => void;
  onRename: (title: string) => void;
  onShowVersions: () => void;
}

function SessionRow({
  session,
  isActive,
  isStreaming: _isStreaming,
  onSelect,
  onRemove,
  onRename,
  onShowVersions,
}: SessionRowProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(session.title);
  const [menuPosition, setMenuPosition] = useState<{
    top: number;
    left: number;
  } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const draftRef = useRef(session.title);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!menuPosition) return;
    const handleClose = (e: Event) => {
      const target = e.target as HTMLElement;
      if (!target.closest("[data-session-menu]")) {
        setMenuPosition(null);
      }
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuPosition(null);
    };
    document.addEventListener("mousedown", handleClose);
    document.addEventListener("scroll", handleClose, true);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handleClose);
      document.removeEventListener("scroll", handleClose, true);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [menuPosition]);

  // Sync draft when session title changes externally
  useEffect(() => {
    if (session.title !== draftRef.current && !editing) {
      draftRef.current = session.title;
      setDraft(session.title);
    }
  }, [session.title, editing]);

  // Update timestamp periodically
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60000);
    return () => clearInterval(id);
  }, []);

  const submit = () => {
    const next = draft.trim();
    if (!next) {
      setDraft(session.title);
    } else if (next !== session.title) {
      onRename(next);
    }
    setEditing(false);
  };

  return (
    <div
      className={`group relative w-full flex items-center gap-2 pl-2 pr-2.5 py-1.5 rounded-lg transition-colors cursor-pointer overflow-hidden ${
        isActive ? "bg-dalam-bg-active" : "hover:bg-dalam-bg-hover"
      }`}
      role="listitem"
      tabIndex={0}
      onClick={() => {
        if (!editing) {
          onSelect();
          setMenuPosition(null);
        }
      }}
      onKeyDown={(e) => {
        if ((e.key === "Enter" || e.key === " ") && !editing) {
          e.preventDefault();
          onSelect();
          setMenuPosition(null);
        }
      }}
      title={session.preview ?? session.title}
    >
      {editing ? (
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={submit}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
            else if (e.key === "Escape") {
              setDraft(session.title);
              setEditing(false);
            }
          }}
          onClick={(e) => e.stopPropagation()}
          className="flex-1 min-w-0 text-xs px-1 py-0.5 rounded border border-dalam-border-primary bg-dalam-bg-primary text-dalam-text-primary outline-none focus:border-dalam-accent-primary"
        />
      ) : (
        <>
          <span className="flex-1 min-w-0 truncate text-[13px] text-dalam-text-secondary">
            {session.title}
          </span>
          <StatusDot
            status={session.status}
            lastVisitedAt={session.lastVisitedAt}
            lastActivityAt={session.lastActivityAt}
          />
          <span className="text-[10px] text-dalam-text-muted flex-shrink-0 tabular-nums mr-1">
            {formatRelative(session.lastActivityAt, now)}
          </span>
          <div className="relative" ref={menuRef} data-session-menu>
            <button type="button"
              className="p-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-dalam-bg-hover transition-all"
              onClick={(e) => {
                e.stopPropagation();
                if (menuPosition) {
                  setMenuPosition(null);
                } else {
                  const rect = e.currentTarget.getBoundingClientRect();
                  setMenuPosition({
                    top: rect.bottom + 4,
                    left: rect.right - 160,
                  });
                }
              }}
              aria-expanded={!!menuPosition}
              aria-haspopup="menu"
            >
              <MoreVertical className="w-3 h-3 text-dalam-text-muted" />
            </button>
            {menuPosition &&
              typeof document !== "undefined" &&
              ReactDOM.createPortal(
                <div
                  className="fixed bg-dalam-bg-secondary border border-dalam-border-primary rounded-lg shadow-xl z-50 py-1 w-40"
                  style={{ top: menuPosition.top, left: menuPosition.left }}
                  data-session-menu
                  role="menu"
                >
                  <button type="button"
                    className="w-full text-left px-3 py-1.5 text-xs text-dalam-text-secondary hover:bg-dalam-bg-hover flex items-center gap-2"
                    role="menuitem"
                    onClick={(e) => {
                      e.stopPropagation();
                      setEditing(true);
                      setMenuPosition(null);
                    }}
                  >
                    <Pencil className="w-3 h-3" /> Rename
                  </button>
                  <button type="button"
                    className="w-full text-left px-3 py-1.5 text-xs text-dalam-text-secondary hover:bg-dalam-bg-hover flex items-center gap-2"
                    role="menuitem"
                    onClick={(e) => {
                      e.stopPropagation();
                      onShowVersions();
                      setMenuPosition(null);
                    }}
                  >
                    <History className="w-3 h-3" /> Versions
                  </button>
                  <div
                    className="border-t border-dalam-border-primary my-1"
                    role="separator"
                  />
                  <button type="button"
                    className="w-full text-left px-3 py-1.5 text-xs text-dalam-git-deleted hover:bg-dalam-bg-hover flex items-center gap-2"
                    role="menuitem"
                    onClick={(e) => {
                      e.stopPropagation();
                      onRemove();
                      setMenuPosition(null);
                    }}
                  >
                    <Trash2 className="w-3 h-3" /> Delete
                  </button>
                </div>,
                document.body,
              )}
          </div>
        </>
      )}
    </div>
  );
}

// ─── Connectors Section ────────────────────────────────────
function ConnectorsSection() {
  const [expanded, setExpanded] = useState(false);
  const [configs, setConfigs] = useState<ConnectorConfig[]>(() =>
    getConnectorConfigs(),
  );
  const [showAdd, setShowAdd] = useState(false);
  const [newName, setNewName] = useState("");
  const [newType, setNewType] = useState<"webhook" | "file-watcher" | "cron">(
    "webhook",
  );

  const handleAdd = () => {
    if (!newName.trim()) return;
    const config: ConnectorConfig = {
      id: `conn-${Date.now().toString(36)}`,
      name: newName.trim(),
      type: newType,
      enabled: true,
      config: {},
    };
    void saveConnectorConfig(config);
    setConfigs(getConnectorConfigs());
    setNewName("");
    setShowAdd(false);
  };

  const handleRemove = (id: string) => {
    removeConnectorConfig(id);
    setConfigs(getConnectorConfigs());
  };

  const typeIcon = (type: string) => {
    switch (type) {
      case "webhook":
        return <Webhook className="w-3 h-3" />;
      case "file-watcher":
        return <FileText className="w-3 h-3" />;
      case "cron":
        return <Clock className="w-3 h-3" />;
      default:
        return <Zap className="w-3 h-3" />;
    }
  };

  return (
    <div className="border-t border-dalam-border-primary mt-1 pt-1">
      <button type="button"
        className="w-full flex items-center gap-2.5 px-2 py-1.5 rounded-lg text-sm text-dalam-text-secondary hover:bg-dalam-bg-hover transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? (
          <ChevronDown className="w-4 h-4" />
        ) : (
          <ChevronRight className="w-4 h-4" />
        )}
        <Zap className="w-4 h-4" />
        <span>Connectors</span>
        {configs.length > 0 && (
          <span className="ml-auto text-[10px] bg-dalam-bg-active rounded-full px-1.5 py-0.5 text-dalam-text-muted">
            {configs.length}
          </span>
        )}
      </button>
      {expanded && (
        <div className="ml-4 space-y-0.5">
          {configs.length === 0 && !showAdd && (
            <div className="text-[11px] text-dalam-text-muted px-2 py-1">
              No connectors configured
            </div>
          )}
          {configs.map((c) => (
            <div
              key={c.id}
              className="flex items-center gap-1.5 px-2 py-1 rounded hover:bg-dalam-bg-hover group text-xs"
            >
              {typeIcon(c.type)}
              <span className="flex-1 truncate text-dalam-text-secondary">
                {c.name}
              </span>
              <span
                className={`w-1.5 h-1.5 rounded-full ${c.enabled ? "bg-dalam-git-added" : "bg-dalam-text-muted"}`}
              />
              <button type="button"
                className="opacity-0 group-hover:opacity-100 p-0.5"
                onClick={() => handleRemove(c.id)}
              >
                <XCircle className="w-3 h-3 text-dalam-text-muted hover:text-dalam-git-deleted" />
              </button>
            </div>
          ))}
          {showAdd ? (
            <div className="px-2.5 py-2 space-y-2 mr-2 bg-dalam-bg-secondary/40 rounded-lg border border-dalam-border-primary/60">
              <input
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleAdd();
                  else if (e.key === "Escape") setShowAdd(false);
                }}
                placeholder="Connector name..."
                className="w-full text-xs px-2.5 py-1.5 rounded-md border border-dalam-border-primary bg-dalam-bg-input text-dalam-text-primary outline-none focus:border-dalam-accent-primary focus:ring-1 focus:ring-dalam-accent-primary transition-all"
              />
              <div className="relative">
                <select
                  value={newType}
                  onChange={(e) => setNewType(e.target.value as typeof newType)}
                  className="w-full text-xs px-2.5 py-1.5 pr-7 rounded-md border border-dalam-border-primary bg-dalam-bg-input text-dalam-text-primary outline-none focus:border-dalam-accent-primary focus:ring-1 focus:ring-dalam-accent-primary transition-all cursor-pointer appearance-none"
                >
                  <option value="webhook">Webhook</option>
                  <option value="file-watcher">File Watcher</option>
                  <option value="cron">Cron</option>
                </select>
                <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-3 h-3 text-dalam-text-muted pointer-events-none" />
              </div>
              <div className="flex gap-1.5 pt-0.5 justify-end">
                <button type="button"
                  className="text-xs px-2.5 py-1 rounded-md text-dalam-text-secondary hover:bg-dalam-bg-hover transition-colors font-medium"
                  onClick={() => setShowAdd(false)}
                >
                  Cancel
                </button>
                <button type="button"
                  className="text-xs px-3 py-1 rounded-md bg-dalam-accent-primary hover:bg-dalam-accent-hover text-white font-medium transition-colors"
                  onClick={handleAdd}
                >
                  Add
                </button>
              </div>
            </div>
          ) : (
            <button type="button"
              className="w-full flex items-center gap-1.5 px-2 py-1 rounded text-xs text-dalam-text-muted hover:bg-dalam-bg-hover hover:text-dalam-text-secondary transition-colors"
              onClick={() => setShowAdd(true)}
            >
              <Plus className="w-3 h-3" /> Add connector
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function Sidebar() {
  const { openWorkspace, workspaces, setActiveWorkspace, removeWorkspace } =
    useWorkspace();
  const { open: openSettings } = useSettingsView();
  const {
    newChat,
    chatSessions,
    activeSessionId,
    setActiveSession,
    isStreaming,
    removeSession,
    renameSession,
    sessionVersions,
    deleteVersion,
  } = useChat();
  const { cancel: cancelPermission } = usePermission();
  const { resolve: resolveQuestion } = useQuestion();
  const viewMode = useUI((s) => s.viewMode);

  const [versionsSessionId, setVersionsSessionId] = useState<string | null>(
    null,
  );
  const [collapsedWorkspaces, setCollapsedWorkspaces] = useState<Set<string>>(
    () => {
      try {
        const v = localStorage.getItem("dalam.sidebar.collapsed");
        return v ? new Set(JSON.parse(v)) : new Set();
      } catch (e) {
        if (import.meta.env.DEV) console.warn("[Sidebar] Failed to parse collapsed workspaces:", e);
        return new Set();
      }
    },
  );
  const [showAll, setShowAll] = useState<Record<string, boolean>>(() => {
    try {
      const v = localStorage.getItem("dalam.sidebar.showAll");
      return v ? JSON.parse(v) : {};
    } catch (e) {
      if (import.meta.env.DEV) console.warn("[Sidebar] Failed to parse showAll state:", e);
      return {};
    }
  });
  const [workspaceMenuPosition, setWorkspaceMenuPosition] = useState<{
    id: string;
    top: number;
    left: number;
  } | null>(null);

  // Persist collapsedWorkspaces to localStorage
  useEffect(() => {
    try {
      localStorage.setItem(
        "dalam.sidebar.collapsed",
        JSON.stringify([...collapsedWorkspaces]),
      );
    } catch (e) {
      if (import.meta.env.DEV) console.warn("[Sidebar] Failed to persist collapsed workspaces:", e);
    }
  }, [collapsedWorkspaces]);

  // Persist showAll to localStorage
  useEffect(() => {
    try {
      localStorage.setItem("dalam.sidebar.showAll", JSON.stringify(showAll));
    } catch (e) {
      if (import.meta.env.DEV) console.warn("[Sidebar] Failed to persist showAll state:", e);
    }
  }, [showAll]);

  // Auto-collapse workspaces with no sessions
  const sessionsByWorkspace = useMemo(() => {
    const map = new Map<string, ChatSessionSummary[]>();
    for (const s of chatSessions) {
      const list = map.get(s.workspacePath) ?? [];
      list.push(s);
      map.set(s.workspacePath, list);
    }
    for (const [, list] of map) {
      list.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
    }
    return map;
  }, [chatSessions]);

  // No need for force re-render — SessionRow manages its own timestamp interval

  useEffect(() => {
    if (!workspaceMenuPosition) return;
    const handleClose = (e: Event) => {
      const target = e.target as HTMLElement;
      if (!target.closest("[data-workspace-menu]")) {
        setWorkspaceMenuPosition(null);
      }
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") setWorkspaceMenuPosition(null);
    };
    document.addEventListener("mousedown", handleClose);
    document.addEventListener("scroll", handleClose, true);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handleClose);
      document.removeEventListener("scroll", handleClose, true);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [workspaceMenuPosition]);

  const toggleWorkspace = (wsId: string) => {
    setCollapsedWorkspaces((prev) => {
      const next = new Set(prev);
      if (next.has(wsId)) next.delete(wsId);
      else next.add(wsId);
      return next;
    });
  };

  const [dragId, setDragId] = useState<string | null>(null);
  const dragIdRef = useRef<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [dragPosition, setDragPosition] = useState<"above" | "below" | null>(
    null,
  );
  const dragPositionRef = useRef<"above" | "below">("below");

  const handleDragStart = (e: React.DragEvent, wsId: string) => {
    dragIdRef.current = wsId;
    setDragId(wsId);
    setIsDragging(true);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", wsId);
  };

  const handleDragOver = (e: React.DragEvent, wsId: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const currentDragId = dragIdRef.current;
    if (currentDragId && currentDragId !== wsId) {
      setDragOverId(wsId);
      const rect = e.currentTarget.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      const pos = e.clientY < midY ? "above" : "below";
      dragPositionRef.current = pos;
      setDragPosition(pos);
    }
  };

  const handleDragLeave = (e: React.DragEvent, wsId: string) => {
    const related = e.relatedTarget as HTMLElement | null;
    if (related && e.currentTarget.contains(related)) return;
    setDragOverId((prev) => (prev === wsId ? null : prev));
    setDragPosition(null);
  };

  const handleDrop = (e: React.DragEvent, targetId: string) => {
    e.preventDefault();
    const currentDragId = dragIdRef.current;
    if (currentDragId && currentDragId !== targetId) {
      const { workspaces } = useWorkspace.getState();
      const fromIdx = workspaces.findIndex((w) => w.id === currentDragId);
      const toIdx = workspaces.findIndex((w) => w.id === targetId);
      if (fromIdx !== -1 && toIdx !== -1) {
        const reordered = [...workspaces];
        const [moved] = reordered.splice(fromIdx, 1);
        const pos = dragPositionRef.current;
        let insertIdx: number;
        if (fromIdx < toIdx) {
          insertIdx = pos === "above" ? toIdx - 1 : toIdx;
        } else {
          insertIdx = pos === "above" ? toIdx : toIdx + 1;
        }
        insertIdx = Math.max(0, Math.min(insertIdx, reordered.length));
        reordered.splice(insertIdx, 0, moved);
        useWorkspace.getState().reorderWorkspaces(reordered);
      }
    }
    dragIdRef.current = null;
    setDragId(null);
    setDragOverId(null);
    setIsDragging(false);
    setDragPosition(null);
  };

  const handleDragEnd = () => {
    dragIdRef.current = null;
    setDragId(null);
    setDragOverId(null);
    setIsDragging(false);
    setDragPosition(null);
  };

  const handleNewTask = (wsId: string) => {
    setActiveWorkspace(wsId);
    cancelPermission();
    resolveQuestion(null);
    newChat();
    // Ensure we're in chat mode for the new task
    if (useUI.getState().viewMode !== "chat") {
      useUI.getState().setViewMode("chat");
    }
  };

  const VISIBLE_LIMIT = 5;

  // Editor mode: show file tree
  if (viewMode === "editor") {
    return (
      <aside className="h-full flex flex-col bg-dalam-bg-secondary">
        <FileTree />
        <div className="p-3 flex-shrink-0 border-t border-dalam-border-primary">
          <button type="button"
            className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-sm text-dalam-text-secondary hover:bg-dalam-bg-hover hover:text-dalam-text-primary transition-colors"
            onClick={() => openSettings()}
            title={`Open Settings (${shortcut(",")})`}
          >
            <Settings className="w-5 h-5 text-dalam-text-muted" />
            <span className="font-medium">Settings</span>
            <span className="ml-auto text-[10px] text-dalam-text-muted font-mono">
              {shortcut(",")}
            </span>
          </button>
        </div>
      </aside>
    );
  }

  // Chat/agent mode: sidebar content
  return (
    <aside className="h-full flex flex-col bg-dalam-bg-secondary">
      {/* Primary actions */}
      <div className="px-3 py-2.5 flex flex-col gap-1 border-b border-dalam-border-primary flex-shrink-0">
        <button type="button"
          className="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-sm text-dalam-text-secondary hover:bg-dalam-bg-hover transition-colors"
          onClick={() => {
            cancelPermission();
            resolveQuestion(null);
            newChat();
            if (useUI.getState().viewMode !== "chat") {
              useUI.getState().setViewMode("chat");
            }
          }}
          aria-label="New task"
        >
          <Plus className="w-4 h-4" />
          <span>New task</span>
          <span className="ml-auto text-[10px] text-dalam-text-muted font-mono">
            {shortcut("N")}
          </span>
        </button>
        <button type="button"
          className="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-sm text-dalam-text-secondary hover:bg-dalam-bg-hover transition-colors"
          onClick={() => useCommandPalette.getState().toggle()}
          aria-label="Search command palette"
        >
          <Search className="w-4 h-4" />
          <span>Search</span>
          <span className="ml-auto text-[10px] text-dalam-text-muted font-mono">
            {shortcut("K")}
          </span>
        </button>
        <button type="button"
          className="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-sm text-dalam-text-secondary hover:bg-dalam-bg-hover transition-colors"
          onClick={() => openSettings("skills")}
          aria-label="Open skills settings"
        >
          <Sparkles className="w-4 h-4" />
          <span>Skills</span>
        </button>
        <ConnectorsSection />
      </div>

      {/* Workspaces header */}
      <div className="flex items-center justify-between px-3 py-2.5 flex-shrink-0">
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] uppercase tracking-wider text-dalam-text-muted font-medium">
            Workspaces
          </span>
          <ChevronRight className="w-3 h-3 text-dalam-text-muted" />
        </div>
        <div className="flex items-center gap-0.5">
          {isDragging && (
            <span className="text-[10px] text-dalam-accent-primary animate-pulse mr-2">
              Reordering...
            </span>
          )}
          <button type="button"
            className="btn-icon"
            onClick={openWorkspace}
            title="Add workspace"
            aria-label="Add workspace"
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Workspace + session list */}
      <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden scrollbar-thin">
        {workspaces.map((ws) => {
          const wsSessions = sessionsByWorkspace.get(ws.path) ?? [];
          // When dragging, collapse all workspaces
          const isExpanded = isDragging
            ? false
            : !collapsedWorkspaces.has(ws.id) && wsSessions.length > 0;
          const showAllSessions = showAll[ws.id] ?? false;
          const visibleSessions = showAllSessions
            ? wsSessions
            : wsSessions.slice(0, VISIBLE_LIMIT);
          const hasMore = wsSessions.length > VISIBLE_LIMIT;
          const isDragOver = dragOverId === ws.id;

          return (
            <div
              key={ws.id}
              className={`mb-0.5 transition-all duration-150 ${
                isDragOver
                  ? dragPosition === "above"
                    ? "border-t-2 border-dalam-accent-primary"
                    : "border-b-2 border-dalam-accent-primary"
                  : ""
              }`}
              onDragOver={(e) => handleDragOver(e, ws.id)}
              onDragLeave={(e) => handleDragLeave(e, ws.id)}
              onDrop={(e) => handleDrop(e, ws.id)}
              onDragEnd={handleDragEnd}
            >
              <div
                className={`relative w-full text-left pl-2 pr-2 py-1.5 flex items-center gap-1.5 group/workspace rounded-lg mx-1 transition-colors overflow-hidden ${
                  dragId === ws.id ? "bg-dalam-bg-tertiary opacity-50" : ""
                } ${isDragOver && dragId !== ws.id ? "bg-dalam-bg-tertiary" : ""}`}
                draggable
                onDragStart={(e) => handleDragStart(e, ws.id)}
              >
                {/* Drag handle visual indicator */}
                <div className="absolute left-0 top-0 bottom-0 w-5 flex items-center justify-center opacity-0 group-hover/workspace:opacity-100 transition-opacity cursor-grab active:cursor-grabbing">
                  <GripVertical className="w-3 h-3 text-dalam-text-muted/50" />
                </div>
                <button type="button"
                  className="flex items-center gap-1.5 flex-1 min-w-0 cursor-pointer overflow-hidden"
                  draggable={false}
                  onClick={() => {
                    if (!isDragging) {
                      toggleWorkspace(ws.id);
                      setActiveWorkspace(ws.id);
                    }
                  }}
                  aria-label={`${ws.name} workspace (${isExpanded ? "expanded" : "collapsed"})`}
                >
                  {isExpanded ? (
                    <ChevronDown className="w-3 h-3 text-dalam-text-muted flex-shrink-0" />
                  ) : (
                    <ChevronRight className="w-3 h-3 text-dalam-text-muted flex-shrink-0" />
                  )}
                  {isExpanded ? (
                    <FolderOpen className="w-3.5 h-3.5 text-dalam-text-muted flex-shrink-0" />
                  ) : (
                    <Folder className="w-3.5 h-3.5 text-dalam-text-muted flex-shrink-0" />
                  )}
                  <span className="truncate text-[13px] text-dalam-text-primary font-medium min-w-0">
                    {ws.name}
                  </span>
                  {wsSessions.length > 0 && (
                    <span className="text-[10px] text-dalam-text-muted flex-shrink-0 ml-0.5">
                      {wsSessions.length}
                    </span>
                  )}
                </button>

                {/* Workspace action icons - visible on hover, positioned absolute */}
                <div
                  className="absolute right-1 top-1/2 -translate-y-1/2 hidden group-hover/workspace:flex items-center gap-0.5 bg-dalam-bg-tertiary rounded px-0.5"
                  draggable={false}
                >
                  <Tooltip content="Show files" side="top">
                    <button type="button"
                      className="p-1 rounded hover:bg-dalam-bg-hover transition-colors"
                      draggable={false}
                      onClick={() => {
                        setActiveWorkspace(ws.id);
                        void useWorkspace.getState().loadFileTree(ws.path);
                        useUI.getState().setViewMode("editor");
                      }}
                      aria-label={`Show files for ${ws.name}`}
                    >
                      <List className="w-3.5 h-3.5 text-dalam-text-muted" />
                    </button>
                  </Tooltip>
                  <Tooltip content="New task" side="top">
                    <button type="button"
                      className="p-1 rounded hover:bg-dalam-bg-hover transition-colors"
                      draggable={false}
                      onClick={() => handleNewTask(ws.id)}
                      aria-label={`New task in ${ws.name}`}
                    >
                      <MessageSquarePlus className="w-3.5 h-3.5 text-dalam-text-muted" />
                    </button>
                  </Tooltip>
                  <div className="relative" data-workspace-menu>
                    <Tooltip content="More" side="top">
                      <button type="button"
                        className="p-1 rounded hover:bg-dalam-bg-hover transition-colors"
                        draggable={false}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (
                            workspaceMenuPosition &&
                            workspaceMenuPosition.id === ws.id
                          ) {
                            setWorkspaceMenuPosition(null);
                          } else {
                            const rect =
                              e.currentTarget.getBoundingClientRect();
                            setWorkspaceMenuPosition({
                              id: ws.id,
                              top: rect.bottom + 4,
                              left: rect.right - 144,
                            });
                          }
                        }}
                        aria-expanded={workspaceMenuPosition?.id === ws.id}
                        aria-haspopup="menu"
                      >
                        <MoreVertical className="w-3.5 h-3.5 text-dalam-text-muted" />
                      </button>
                    </Tooltip>
                    {workspaceMenuPosition &&
                      workspaceMenuPosition.id === ws.id &&
                      typeof document !== "undefined" &&
                      ReactDOM.createPortal(
                        <div
                          className="fixed bg-dalam-bg-secondary border border-dalam-border-primary rounded-lg shadow-xl z-50 py-1 w-36"
                          style={{
                            top: workspaceMenuPosition.top,
                            left: workspaceMenuPosition.left,
                          }}
                          data-workspace-menu
                          role="menu"
                        >
                          <button type="button"
                            className="w-full text-left px-2.5 py-1.5 text-xs text-dalam-git-deleted hover:bg-dalam-bg-hover flex items-center gap-2"
                            role="menuitem"
                            onClick={(e) => {
                              e.stopPropagation();
                              removeWorkspace(ws.id);
                              setWorkspaceMenuPosition(null);
                            }}
                          >
                            <Trash2 className="w-3.5 h-3.5" /> Remove
                          </button>
                        </div>,
                        document.body,
                      )}
                  </div>
                </div>
              </div>

              {isExpanded && (
                <div className="ml-3 mb-0.5 flex flex-col">
                  {visibleSessions.length > 0 ? (
                    <>
                      {visibleSessions.map((s) => (
                        <SessionRow
                          key={s.id}
                          session={s}
                          isActive={s.id === activeSessionId}
                          isStreaming={isStreaming && s.id === activeSessionId}
                          onSelect={() => setActiveSession(s.id)}
                          onRemove={() => removeSession(s.id)}
                          onRename={(title) => renameSession(s.id, title)}
                          onShowVersions={() => setVersionsSessionId(s.id)}
                        />
                      ))}
                      {hasMore && !showAllSessions && (
                        <button type="button"
                          className="text-[10px] text-dalam-text-muted hover:text-dalam-text-secondary px-1.5 py-0.5 transition-colors"
                          onClick={() =>
                            setShowAll((prev) => ({ ...prev, [ws.id]: true }))
                          }
                          aria-label={`Show more sessions for ${ws.name}`}
                        >
                          Show more ({wsSessions.length - VISIBLE_LIMIT})
                        </button>
                      )}
                      {hasMore && showAllSessions && (
                        <button type="button"
                          className="text-[10px] text-dalam-text-muted hover:text-dalam-text-secondary px-1.5 py-0.5 transition-colors"
                          onClick={() =>
                            setShowAll((prev) => ({ ...prev, [ws.id]: false }))
                          }
                          aria-label={`Show fewer sessions for ${ws.name}`}
                        >
                          Show less
                        </button>
                      )}
                    </>
                  ) : (
                    <div className="flex flex-col items-center gap-1.5 px-2 py-3 text-center">
                      <MessageSquare className="w-4 h-4 text-dalam-text-muted/50" />
                      <p className="text-[11px] text-dalam-text-muted/60 leading-snug">
                        No sessions yet.
                        <br />
                        Press{" "}
                        <span className="font-mono text-dalam-text-secondary">
                          {modKey()}N
                        </span>{" "}
                        to start.
                      </p>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
        {!workspaces.length && (
          <div className="px-3 py-2 text-xs text-dalam-text-muted">
            No workspaces yet. Click + to open a folder.
          </div>
        )}
      </div>

      <div className="p-3 flex-shrink-0">
        <button type="button"
          className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-sm text-dalam-text-secondary hover:bg-dalam-bg-hover hover:text-dalam-text-primary transition-colors"
          onClick={() => openSettings()}
          title={`Open Settings (${shortcut(",")})`}
        >
          <Settings className="w-5 h-5 text-dalam-text-muted" />
          <span className="font-medium">Settings</span>
          <span className="ml-auto text-[10px] text-dalam-text-muted font-mono">
            {shortcut(",")}
          </span>
        </button>
      </div>

      {versionsSessionId && (
        <VersionHistory
          sessionId={versionsSessionId}
          versions={sessionVersions[versionsSessionId] ?? []}
          onRestore={(versionId) => {
            const currentId = useChat.getState().activeSessionId;
            if (currentId !== versionsSessionId) {
              useChat.getState().setActiveSession(versionsSessionId);
            }
            setTimeout(() => {
              useChat.getState().restoreVersion(versionsSessionId, versionId);
            }, 0);
            setVersionsSessionId(null);
          }}
          onDelete={(versionId) => deleteVersion(versionsSessionId, versionId)}
          onClose={() => setVersionsSessionId(null)}
        />
      )}
    </aside>
  );
}

function formatVersionDate(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const diff = Math.max(0, now.getTime() - d.getTime());
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return d.toLocaleDateString();
}

function VersionHistory({
  sessionId: _sessionId,
  versions,
  onRestore,
  onDelete,
  onClose,
}: {
  sessionId: string;
  versions: ChatVersion[];
  onRestore: (versionId: string) => void;
  onDelete: (versionId: string) => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    dialogRef.current?.focus();
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return ReactDOM.createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="version-history-title"
    >
      <div
        ref={dialogRef}
        className="w-96 max-h-[70vh] bg-dalam-bg-primary border border-dalam-border-primary rounded-xl shadow-2xl flex flex-col overflow-hidden outline-none"
        onClick={(e) => e.stopPropagation()}
        tabIndex={-1}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-dalam-border-primary">
          <h3
            id="version-history-title"
            className="text-sm font-semibold text-dalam-text-primary"
          >
            Version History
          </h3>
          <button type="button" className="btn-icon" onClick={onClose} aria-label="Close">
            <XCircle className="w-4 h-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto scrollbar-thin p-2">
          {versions.length === 0 ? (
            <div className="text-center text-xs text-dalam-text-muted py-8">
              No versions saved yet.
            </div>
          ) : (
            <div className="space-y-1">
              {[...versions].reverse().map((v) => (
                <div
                  key={v.id}
                  className="group flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-dalam-bg-hover transition-colors"
                >
                  <div className="w-2 h-2 rounded-full bg-dalam-accent-primary/60 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-xs text-dalam-text-primary truncate">
                      {v.label || "Untitled version"}
                    </div>
                    <div className="text-[10px] text-dalam-text-muted">
                      {formatVersionDate(v.timestamp)} · {v.messages.length}{" "}
                      message{v.messages.length !== 1 ? "s" : ""}
                    </div>
                  </div>
                  <div className="hidden group-hover:flex items-center gap-1">
                    <button type="button"
                      className="btn-icon !p-1"
                      title="Restore this version"
                      onClick={() => onRestore(v.id)}
                    >
                      <Undo2 className="w-3.5 h-3.5" />
                    </button>
                    <button type="button"
                      className="btn-icon !p-1"
                      title="Delete version"
                      onClick={() => onDelete(v.id)}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="px-4 py-2 border-t border-dalam-border-primary text-[10px] text-dalam-text-muted text-center">
          Versions are saved automatically before each message.
        </div>
      </div>
    </div>,
    document.body,
  );
}
