import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import {
  useWorkspace,
  useSettingsView,
  useChat,
  usePermission,
  useQuestion,
  useCommandPalette,
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
  MoreHorizontal,
} from "lucide-react";
import type { ChatSessionSummary, ChatVersion } from "@dalam/shared-types";

function formatRelative(ts: number, now: number): string {
  const diff = Math.max(0, now - ts);
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  return `${Math.floor(diff / 86_400_000)}d`;
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
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!menuOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [menuOpen]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDraft(session.title);
    const id = setInterval(() => setNow(Date.now()), 60000);
    return () => clearInterval(id);
  }, [session.title]);

  const submit = () => {
    const next = draft.trim();
    if (next && next !== session.title) onRename(next);
    setEditing(false);
  };

  return (
    <div
      className={`group relative w-full flex items-center gap-2 pl-2 pr-1.5 py-1.5 rounded-md transition-colors cursor-pointer ${
        isActive ? "bg-dalam-bg-active" : "hover:bg-dalam-bg-hover"
      }`}
      onClick={() => { if (!editing) { onSelect(); setMenuOpen(false); } }}
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
            else if (e.key === "Escape") { setDraft(session.title); setEditing(false); }
          }}
          onClick={(e) => e.stopPropagation()}
          className="flex-1 min-w-0 text-xs px-1 py-0.5 rounded border border-dalam-border-primary bg-dalam-bg-primary text-dalam-text-primary outline-none focus:border-dalam-accent-primary"
        />
      ) : (
        <>
          <span className="flex-1 min-w-0 truncate text-xs text-dalam-text-secondary">
            {session.title}
          </span>
          <span className="text-[10px] text-dalam-text-muted flex-shrink-0 tabular-nums">
            {formatRelative(session.lastActivityAt, now)}
          </span>
          <div className="relative" ref={menuRef}>
            <button
              className="p-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-dalam-bg-hover transition-all"
              onClick={(e) => { e.stopPropagation(); setMenuOpen(!menuOpen); }}
            >
              <MoreHorizontal className="w-3 h-3 text-dalam-text-muted" />
            </button>
            {menuOpen && (
              <div className="absolute right-0 top-full mt-1 w-40 bg-dalam-bg-secondary border border-dalam-border-primary rounded-lg shadow-xl z-50 py-1">
                <button className="w-full text-left px-3 py-1.5 text-xs text-dalam-text-secondary hover:bg-dalam-bg-hover flex items-center gap-2" onClick={(e) => { e.stopPropagation(); setEditing(true); setMenuOpen(false); }}>
                  <Pencil className="w-3 h-3" /> Rename
                </button>
                <button className="w-full text-left px-3 py-1.5 text-xs text-dalam-text-secondary hover:bg-dalam-bg-hover flex items-center gap-2" onClick={(e) => { e.stopPropagation(); onShowVersions(); setMenuOpen(false); }}>
                  <History className="w-3 h-3" /> Versions
                </button>
                <div className="border-t border-dalam-border-primary my-1" />
                <button className="w-full text-left px-3 py-1.5 text-xs text-dalam-git-deleted hover:bg-dalam-bg-hover flex items-center gap-2" onClick={(e) => { e.stopPropagation(); onRemove(); setMenuOpen(false); }}>
                  <Trash2 className="w-3 h-3" /> Delete
                </button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

export function Sidebar() {
  const { openWorkspace, activeWorkspaceId, workspaces, setActiveWorkspace } = useWorkspace();
  const { open: openSettings } = useSettingsView();
  const { newChat, chatSessions, activeSessionId, setActiveSession, isStreaming, removeSession, renameSession, sessionVersions, deleteVersion } = useChat();
  const { cancel: cancelPermission } = usePermission();
  const { resolve: resolveQuestion } = useQuestion();
  const [versionsSessionId, setVersionsSessionId] = useState<string | null>(null);
  const [collapsedWorkspaces, setCollapsedWorkspaces] = useState<Set<string>>(new Set());
  const [showAll, setShowAll] = useState<Record<string, boolean>>({});

  const [, force] = useState(0);
  useEffect(() => {
    const t = setInterval(() => force((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);

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

  const toggleWorkspace = (wsId: string) => {
    setCollapsedWorkspaces((prev) => {
      const next = new Set(prev);
      if (next.has(wsId)) next.delete(wsId);
      else next.add(wsId);
      return next;
    });
  };

  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);

  const handleDragStart = (e: React.DragEvent, wsId: string) => {
    setDragId(wsId);
    e.dataTransfer.effectAllowed = "move";
  };

  const handleDragOver = (e: React.DragEvent, wsId: string) => {
    e.preventDefault();
    if (dragId && dragId !== wsId) {
      setDragOverId(wsId);
    }
  };

  const handleDrop = (e: React.DragEvent, targetId: string) => {
    e.preventDefault();
    if (dragId && dragId !== targetId) {
      const { workspaces } = useWorkspace.getState();
      const fromIdx = workspaces.findIndex((w) => w.id === dragId);
      const toIdx = workspaces.findIndex((w) => w.id === targetId);
      if (fromIdx !== -1 && toIdx !== -1) {
        const reordered = [...workspaces];
        const [moved] = reordered.splice(fromIdx, 1);
        reordered.splice(toIdx, 0, moved);
        useWorkspace.setState({ workspaces: reordered });
      }
    }
    setDragId(null);
    setDragOverId(null);
  };

  const handleDragEnd = () => {
    setDragId(null);
    setDragOverId(null);
  };

  const VISIBLE_LIMIT = 5;

  return (
    <aside className="h-full flex flex-col bg-dalam-bg-secondary border-r border-dalam-border-primary">
      {/* Primary actions */}
      <div className="px-3 py-2 flex flex-col gap-0.5 border-b border-dalam-border-primary flex-shrink-0">
        <button
          className="w-full flex items-center gap-2.5 px-2 py-1.5 rounded-lg text-sm text-dalam-text-secondary hover:bg-dalam-bg-hover transition-colors"
          onClick={() => { cancelPermission(); resolveQuestion(null); newChat(); }}
        >
          <Plus className="w-4 h-4" />
          <span>New task</span>
          <span className="ml-auto text-[10px] text-dalam-text-muted font-mono">{shortcut("N")}</span>
        </button>
        <button className="w-full flex items-center gap-2.5 px-2 py-1.5 rounded-lg text-sm text-dalam-text-secondary hover:bg-dalam-bg-hover transition-colors" onClick={() => useCommandPalette.getState().toggle()}>
          <Search className="w-4 h-4" />
          <span>Search</span>
          <span className="ml-auto text-[10px] text-dalam-text-muted font-mono">{shortcut("K")}</span>
        </button>
        <button className="w-full flex items-center gap-2.5 px-2 py-1.5 rounded-lg text-sm text-dalam-text-secondary hover:bg-dalam-bg-hover transition-colors" onClick={() => { openSettings(); useSettingsView.getState().setActiveTab("skills"); }}>
          <Sparkles className="w-4 h-4" />
          <span>Skills</span>
        </button>
      </div>

      {/* Workspaces header */}
      <div className="flex items-center justify-between px-3 py-2 flex-shrink-0">
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] uppercase tracking-wider text-dalam-text-muted font-medium">Workspaces</span>
          <ChevronRight className="w-3 h-3 text-dalam-text-muted" />
        </div>
        <div className="flex items-center gap-0.5">
          <button className="btn-icon" onClick={openWorkspace} title="Add workspace">
            <Plus className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Workspace + session list */}
      <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin">
        {workspaces.map((ws) => {
          const isExpanded = !collapsedWorkspaces.has(ws.id);
          const wsSessions = sessionsByWorkspace.get(ws.path) ?? [];
          const showAllSessions = showAll[ws.id] ?? false;
          const visibleSessions = showAllSessions ? wsSessions : wsSessions.slice(0, VISIBLE_LIMIT);
          const hasMore = wsSessions.length > VISIBLE_LIMIT;

          return (
            <div
              key={ws.id}
              className={`mb-1 transition-colors ${dragOverId === ws.id ? "bg-dalam-accent-primary/10 border-t border-dalam-accent-primary" : ""}`}
              draggable
              onDragStart={(e) => handleDragStart(e, ws.id)}
              onDragOver={(e) => handleDragOver(e, ws.id)}
              onDrop={(e) => handleDrop(e, ws.id)}
              onDragEnd={handleDragEnd}
            >
              <button
                className={`w-full text-left px-3 py-1.5 flex items-center gap-2 hover:bg-dalam-bg-hover transition-colors ${
                  ws.id === activeWorkspaceId ? "bg-dalam-bg-hover" : ""
                } ${dragId === ws.id ? "opacity-50" : ""}`}
                onClick={() => { toggleWorkspace(ws.id); setActiveWorkspace(ws.id); }}
              >
                {isExpanded ? (
                  <ChevronDown className="w-3.5 h-3.5 text-dalam-text-muted" />
                ) : (
                  <ChevronRight className="w-3.5 h-3.5 text-dalam-text-muted" />
                )}
                <Folder className="w-4 h-4 text-dalam-text-muted flex-shrink-0" />
                <span className="truncate text-sm text-dalam-text-primary font-medium">{ws.name}</span>
              </button>
              {isExpanded && (
                <div className="ml-4 mb-1 flex flex-col gap-0.5">
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
                        <button
                          className="text-[11px] text-dalam-text-muted hover:text-dalam-text-secondary px-2 py-1 transition-colors"
                          onClick={() => setShowAll((prev) => ({ ...prev, [ws.id]: true }))}
                        >
                          Show more ({wsSessions.length - VISIBLE_LIMIT})
                        </button>
                      )}
                    </>
                  ) : (
                    <div className="flex flex-col items-center gap-1.5 px-2 py-3 text-center">
                      <MessageSquare className="w-4 h-4 text-dalam-text-muted" />
                      <p className="text-[11px] text-dalam-text-muted leading-snug">
                        No sessions yet.
                        <br />
                        Press <span className="font-mono text-dalam-text-secondary">{modKey()}N</span> to start.
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

      <div className="border-t border-dalam-border-primary p-3 flex-shrink-0">
        <button
          className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-sm text-dalam-text-secondary bg-dalam-bg-tertiary/40 border border-dalam-border-primary hover:bg-dalam-bg-hover hover:text-dalam-text-primary hover:border-dalam-border-secondary transition-colors"
          onClick={() => openSettings()}
          title={`Open Settings (${shortcut(",")})`}
        >
          <Settings className="w-5 h-5 text-dalam-text-muted" />
          <span className="font-medium">Settings</span>
          <span className="ml-auto text-[10px] text-dalam-text-muted font-mono">{shortcut(",")}</span>
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

function VersionHistory({ sessionId, versions, onRestore, onDelete, onClose }: {
  sessionId: string;
  versions: ChatVersion[];
  onRestore: (versionId: string) => void;
  onDelete: (versionId: string) => void;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="w-96 max-h-[70vh] bg-dalam-bg-primary border border-dalam-border-primary rounded-xl shadow-2xl flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-dalam-border-primary">
          <h3 className="text-sm font-semibold text-dalam-text-primary">Version History</h3>
          <button className="btn-icon" onClick={onClose}><XCircle className="w-4 h-4" /></button>
        </div>
        <div className="flex-1 overflow-y-auto scrollbar-thin p-2">
          {versions.length === 0 ? (
            <div className="text-center text-xs text-dalam-text-muted py-8">No versions saved yet.</div>
          ) : (
            <div className="space-y-1">
              {[...versions].reverse().map((v, i) => (
                <div key={v.id} className="group flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-dalam-bg-hover transition-colors">
                  <div className="w-2 h-2 rounded-full bg-dalam-accent-primary/60 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-xs text-dalam-text-primary truncate">{v.label}</div>
                    <div className="text-[10px] text-dalam-text-muted">{formatVersionDate(v.timestamp)} · {v.messages.length} message{v.messages.length !== 1 ? "s" : ""}</div>
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
        <div className="px-4 py-2 border-t border-dalam-border-primary text-[10px] text-dalam-text-muted text-center">
          Versions are saved automatically before each message.
        </div>
      </div>
    </div>
  );
}
