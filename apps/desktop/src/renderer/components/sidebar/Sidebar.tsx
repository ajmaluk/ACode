import { useEffect, useMemo, useState } from "react";
import {
  useWorkspace,
  useSettingsView,
  useChat,
  usePermission,
  useQuestion,
  useCommandPalette,
} from "@/store/useAppStore";
import { shortcut } from "@/lib/platform";
import {
  Search,
  Plus,
  Settings,
  Sparkles,
  ChevronDown,
  ChevronRight,
  FolderOpen,
  Circle,
  CheckCircle2,
  Loader2,
  MessageSquare,
  PauseCircle,
  XCircle,
  Trash2,
  Pencil,
  History,
  Undo2,
} from "lucide-react";
import type { ChatSessionSummary, ChatVersion } from "@acode/shared-types";

/**
 * Map a session status to the right sidebar icon + tailwind color.
 *
 *   running   → spinning blue (AI is actively working)
 *   completed → green dot with a check (AI answered successfully)
 *   aborted   → yellow (the user pressed stop / aborted)
 *   error     → red (the agent errored out)
 *   idle      → empty gray circle (a brand-new session, no messages yet)
 */
function statusPresentation(status: ChatSessionSummary["status"], isStreaming: boolean) {
  if (isStreaming || status === "running") {
    return { Icon: Loader2, color: "text-acode-accent-primary", spin: true };
  }
  switch (status) {
    case "completed":
      return { Icon: CheckCircle2, color: "text-acode-git-added", spin: false };
    case "aborted":
      return { Icon: PauseCircle, color: "text-yellow-400", spin: false };
    case "error":
      return { Icon: XCircle, color: "text-acode-git-deleted", spin: false };
    case "idle":
    default:
      return { Icon: Circle, color: "text-acode-text-muted", spin: false };
  }
}

function formatRelative(ts: number, now: number): string {
  const diff = Math.max(0, now - ts);
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
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

function SessionRow({ session, isActive, isStreaming, onSelect, onRemove, onRename, onShowVersions }: SessionRowProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(session.title);

  useEffect(() => { setDraft(session.title); }, [session.title]);
  const { Icon, color, spin } = statusPresentation(session.status, isStreaming);

  const submit = () => {
    const next = draft.trim();
    if (next && next !== session.title) onRename(next);
    setEditing(false);
  };

  return (
    <div
      className={`group relative w-full flex items-center gap-1.5 pl-2 pr-1 py-1 rounded-md transition-colors cursor-pointer ${
        isActive ? "bg-acode-bg-active" : "hover:bg-acode-bg-hover"
      }`}
      onClick={() => !editing && onSelect()}
      title={session.preview ?? session.title}
    >
      {/* Status indicator (spinner for running, dot+icon otherwise) */}
      <div className="relative flex-shrink-0 w-3.5 h-3.5 flex items-center justify-center">
        <Icon className={`w-3.5 h-3.5 ${color} ${spin ? "animate-spin" : ""}`} />
        {/* Live pulsing ring for running sessions */}
        {(spin || session.status === "running") && (
          <span className="absolute inset-0 rounded-full bg-acode-accent-primary/30 animate-ping" />
        )}
      </div>
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
          className="flex-1 min-w-0 text-xs px-1 py-0.5 rounded border border-acode-border-primary bg-acode-bg-primary text-acode-text-primary outline-none focus:border-acode-accent-primary"
        />
      ) : (
        <div className="flex-1 min-w-0 flex items-center gap-1.5">
          <span className="truncate text-xs text-acode-text-secondary">
            {session.title}
          </span>
          {session.messageCount > 0 && (
            <span className="text-[10px] text-acode-text-muted flex-shrink-0">
              · {session.messageCount}
            </span>
          )}
          {session.versionCount > 0 && (
            <span className="text-[10px] text-acode-text-muted/50 flex-shrink-0">
              v{session.versionCount}
            </span>
          )}
        </div>
      )}
      <span className="text-[10px] text-acode-text-muted flex-shrink-0 hidden group-hover:inline">
        {formatRelative(session.lastActivityAt, Date.now())}
      </span>
      {/* Hover actions */}
      <div className="hidden group-hover:flex items-center gap-0.5 flex-shrink-0">
        <button
          className="btn-icon !p-0.5"
          title="Rename session"
          onClick={(e) => {
            e.stopPropagation();
            setEditing(true);
          }}
        >
          <Pencil className="w-3 h-3" />
        </button>
        <button
          className="btn-icon !p-0.5"
          title="Version history"
          onClick={(e) => {
            e.stopPropagation();
            onShowVersions();
          }}
        >
          <History className="w-3 h-3" />
        </button>
        <button
          className="btn-icon !p-0.5"
          title="Remove session"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
        >
          <Trash2 className="w-3 h-3" />
        </button>
      </div>
    </div>
  );
}

export function Sidebar() {
  const { openWorkspace, activeWorkspaceId, workspaces, setActiveWorkspace } = useWorkspace();
  const { open: openSettings } = useSettingsView();
  const { newChat, chatSessions, activeSessionId, setActiveSession, isStreaming, removeSession, renameSession, sessionVersions, restoreVersion, deleteVersion } = useChat();
  const { cancel: cancelPermission } = usePermission();
  const { resolve: resolveQuestion } = useQuestion();
  const [versionsSessionId, setVersionsSessionId] = useState<string | null>(null);
  // Re-render the relative timestamps every 30s so "5m ago" doesn't get stale.
  const [, force] = useState(0);
  useEffect(() => {
    const t = setInterval(() => force((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  /**
   * Bucket every chat session under its workspace. We render an empty placeholder
   * for workspaces that have no sessions yet so the user knows where the next
   * "New task" will land.
   */
  const sessionsByWorkspace = useMemo(() => {
    const map = new Map<string, ChatSessionSummary[]>();
    for (const s of chatSessions) {
      const key = s.workspacePath;
      const list = map.get(key) ?? [];
      list.push(s);
      map.set(key, list);
    }
    for (const [, list] of map) {
      list.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
    }
    return map;
  }, [chatSessions]);

  return (
    <aside className="h-full flex flex-col bg-acode-bg-secondary border-r border-acode-border-primary">
      {/* Primary actions */}
      <div className="px-3 py-2 flex flex-col gap-0.5 border-b border-acode-border-primary flex-shrink-0">
        <button
          className="w-full flex items-center gap-2.5 px-2 py-1.5 rounded-lg text-sm text-acode-text-secondary hover:bg-acode-bg-hover transition-colors"
          onClick={() => {
            // Cancel any pending permission/question prompts so the new task starts clean.
            cancelPermission();
            resolveQuestion(null);
            newChat();
          }}
        >
          <Plus className="w-4 h-4" />
          <span>New task</span>
          <span className="ml-auto text-[10px] text-acode-text-muted font-mono">{shortcut("N")}</span>
        </button>
        <button className="w-full flex items-center gap-2.5 px-2 py-1.5 rounded-lg text-sm text-acode-text-secondary hover:bg-acode-bg-hover transition-colors" onClick={() => useCommandPalette.getState().toggle()}>
          <Search className="w-4 h-4" />
          <span>Search</span>
          <span className="ml-auto text-[10px] text-acode-text-muted font-mono">{shortcut("K")}</span>
        </button>
        <button className="w-full flex items-center gap-2.5 px-2 py-1.5 rounded-lg text-sm text-acode-text-secondary hover:bg-acode-bg-hover transition-colors" onClick={() => { openSettings(); useSettingsView.getState().setActiveTab("skills"); }}>
          <Sparkles className="w-4 h-4" />
          <span>Skills</span>
        </button>
      </div>

      {/* Workspaces header */}
      <div className="flex items-center justify-between px-3 py-2 flex-shrink-0">
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] uppercase tracking-wider text-acode-text-muted font-medium">
            Workspaces
          </span>
          <ChevronRight className="w-3 h-3 text-acode-text-muted" />
        </div>
        <div className="flex items-center gap-0.5">
          <button className="btn-icon" title="Filter">
            <svg
              className="w-3.5 h-3.5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M3 6h18M7 12h10M10 18h4" />
            </svg>
          </button>
          <button className="btn-icon" title="Search">
            <Search className="w-3.5 h-3.5" />
          </button>
          <button className="btn-icon" onClick={openWorkspace} title="Add workspace">
            <Plus className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Workspace + session list */}
      <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin">
        {workspaces.map((ws) => {
          const isActive = ws.id === activeWorkspaceId;
          const wsSessions = sessionsByWorkspace.get(ws.path) ?? [];
          return (
            <div key={ws.id} className="mb-1">
              <button
                className={`w-full text-left px-3 py-1.5 flex items-center gap-2 hover:bg-acode-bg-hover transition-colors ${
                  isActive ? "bg-acode-bg-hover" : ""
                }`}
                onClick={() => setActiveWorkspace(ws.id)}
              >
                <ChevronDown
                  className={`w-3.5 h-3.5 text-acode-text-muted transition-transform ${
                    !isActive ? "-rotate-90" : ""
                  }`}
                />
                <FolderOpen className="w-4 h-4 text-acode-text-muted flex-shrink-0" />
                <span className="truncate text-sm text-acode-text-primary font-medium">
                  {ws.name}
                </span>
                {wsSessions.length > 0 && (
                  <span className="ml-auto text-[10px] text-acode-text-muted tabular-nums">
                    {wsSessions.length}
                  </span>
                )}
              </button>
              {isActive && (
                <div className="ml-4 mb-2 flex flex-col gap-0.5">
                  {wsSessions.length > 0 ? (
                    wsSessions.map((s) => (
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
                    ))
                  ) : (
                    <div className="flex flex-col items-center gap-1.5 px-2 py-3 text-center">
                      <MessageSquare className="w-4 h-4 text-acode-text-muted" />
                      <p className="text-[11px] text-acode-text-muted leading-snug">
                        No chat sessions yet.
                        <br />
                        Press <span className="font-mono text-acode-text-secondary">⌘N</span> to
                        start one.
                      </p>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
        {!workspaces.length && (
          <div className="px-3 py-2 text-xs text-acode-text-muted">
            No workspaces yet. Click + to open a folder.
          </div>
        )}
      </div>

      <div className="border-t border-acode-border-primary p-3 flex-shrink-0">
        <button
          className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-sm text-acode-text-secondary bg-acode-bg-tertiary/40 border border-acode-border-primary hover:bg-acode-bg-hover hover:text-acode-text-primary hover:border-acode-border-secondary transition-colors"
          onClick={() => openSettings()}
          title={`Open Settings (${shortcut(",")})`}
        >
          <Settings className="w-5 h-5 text-acode-text-muted" />
          <span className="font-medium">Settings</span>
          <span className="ml-auto text-[10px] text-acode-text-muted font-mono">{shortcut(",")}</span>
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
            // Use setTimeout to ensure state update completes before restore
            setTimeout(() => {
              useChat.getState().restoreVersion(versionsSessionId, versionId);
            }, 0);
            setVersionsSessionId(null);
          }}
          onDelete={(versionId) => {
            deleteVersion(versionsSessionId, versionId);
          }}
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

function VersionHistory({ sessionId, versions, onRestore, onDelete, onClose }: {
  sessionId: string;
  versions: ChatVersion[];
  onRestore: (versionId: string) => void;
  onDelete: (versionId: string) => void;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="w-96 max-h-[70vh] bg-acode-bg-primary border border-acode-border-primary rounded-xl shadow-2xl flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-acode-border-primary">
          <h3 className="text-sm font-semibold text-acode-text-primary">Version History</h3>
          <button className="btn-icon" onClick={onClose}><XCircle className="w-4 h-4" /></button>
        </div>
        <div className="flex-1 overflow-y-auto scrollbar-thin p-2">
          {versions.length === 0 ? (
            <div className="text-center text-xs text-acode-text-muted py-8">No versions saved yet.</div>
          ) : (
            <div className="space-y-1">
              {[...versions].reverse().map((v, i) => (
                <div key={v.id} className="group flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-acode-bg-hover transition-colors">
                  <div className="w-2 h-2 rounded-full bg-acode-accent-primary/60 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-xs text-acode-text-primary truncate">{v.label}</div>
                    <div className="text-[10px] text-acode-text-muted">{formatVersionDate(v.timestamp)} · {v.messages.length} message{v.messages.length !== 1 ? "s" : ""}</div>
                  </div>
                  <div className="hidden group-hover:flex items-center gap-1">
                    <button className="btn-icon !p-1" title="Restore this version" onClick={() => onRestore(v.id)}>
                      <Undo2 className="w-3.5 h-3.5" />
                    </button>
                    <button className="btn-icon !p-1" title="Delete version" onClick={() => onDelete(v.id)}>
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="px-4 py-2 border-t border-acode-border-primary text-[10px] text-acode-text-muted text-center">
          Versions are saved automatically before each message.
        </div>
      </div>
    </div>
  );
}
