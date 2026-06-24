import { useState, useEffect, useCallback, useMemo } from "react";
import { useGit, useChat, useWorkspace, useDiffView, useUI } from "@/store/useAppStore";
import type { GitStatus } from "@acode/shared-types";
import { ensureAcodeAPI } from "@/lib/acodeAPI";
import { useToast } from "@/components/ui/Toaster";
import { TerminalPanel } from "../terminal/TerminalPanel";
import {
  GitBranch, FileCode, Check, X,
  RefreshCw, Globe, ListTodo, Circle,
  Plus, Loader2, ArrowLeft, ArrowRight, ArrowUp, Eye,
  Code2, PanelRightClose, GitCommitHorizontal,
  Columns, WandSparkles, History, TerminalSquare,
} from "lucide-react";

type Tab = "git" | "diff" | "review" | "browser" | "progress" | "terminal";

const TABS: { id: Tab; icon: React.ElementType; label: string }[] = [
  { id: "git", icon: GitBranch, label: "Git" },
  { id: "diff", icon: Columns, label: "Diff" },
  { id: "review", icon: WandSparkles, label: "Review" },
  { id: "progress", icon: History, label: "Progress" },
  { id: "browser", icon: Globe, label: "Browser" },
  { id: "terminal", icon: TerminalSquare, label: "Terminal" },
];

export function RightPanel() {
  const { status, refresh } = useGit();
  const { todos } = useChat();
  const { activeWorkspaceId } = useWorkspace();
  const { open: diffOpen, current: diffCurrent } = useDiffView();
  const { browserTabs, activeBrowserTabId, rightPanelTab: tab, setRightPanelTab: setTab } = useUI();
  const changeCount = (status?.modified.length ?? 0) + (status?.added.length ?? 0) + (status?.deleted.length ?? 0);

  useEffect(() => { void refresh(); }, [refresh]);

  // Unified tab-switching effect with priority: diff > browser > git
  useEffect(() => {
    if (tab === "terminal") return; // Keep terminal open if explicitly selected
    if (diffOpen && diffCurrent) { setTab("diff"); return; }
    if (activeBrowserTabId && browserTabs.length > 0) { setTab("browser"); return; }
    if (activeWorkspaceId) setTab("git");
    else setTab("browser");
  }, [activeWorkspaceId, diffOpen, diffCurrent, activeBrowserTabId, browserTabs.length, tab, setTab]);

  return (
    <aside className="h-full flex flex-row-reverse bg-acode-bg-primary border-l border-acode-border-primary">
      {/* Activity bar on the right edge */}
      <div className="w-11 flex-shrink-0 bg-acode-bg-tertiary border-l border-acode-border-primary flex flex-col items-center pt-2 pb-3 gap-1 select-none">
        <div className="flex-1 flex flex-col items-center gap-1">
          {TABS.map((t) => {
            const Icon = t.icon;
            const isActive = tab === t.id;
            const hasChanges = t.id === "git" && changeCount > 0;
            return (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                title={t.label}
                className={`w-9 h-9 flex items-center justify-center rounded-lg transition-all duration-100 relative group ${
                  isActive
                    ? "bg-acode-accent-subtle text-acode-accent-primary shadow-sm"
                    : "text-acode-text-muted hover:bg-acode-bg-hover hover:text-acode-text-primary"
                }`}
              >
                <Icon className="w-[18px] h-[18px]" />
                {hasChanges && (
                  <span className="absolute top-0.5 right-0.5 w-2 h-2 rounded-full bg-acode-accent-primary" />
                )}
                {isActive && (
                  <span className="absolute right-0 top-1/2 -translate-y-1/2 w-0.5 h-5 rounded-full bg-acode-accent-primary shadow-sm shadow-acode-accent-primary/30" />
                )}
                <span className="absolute left-full ml-2 top-1/2 -translate-y-1/2 pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity bg-acode-bg-tertiary border border-acode-border-primary text-acode-text-primary text-[11px] px-2 py-1 rounded-md whitespace-nowrap shadow-xl z-50 font-medium">
                  {t.label}
                </span>
              </button>
            );
          })}
        </div>
        <div className="pt-2 border-t border-acode-border-primary/50 w-full flex flex-col items-center gap-1">
          <button
            onClick={() => useUI.getState().toggleRightPanel()}
            title="Close panel"
            className="w-9 h-9 flex items-center justify-center rounded-lg text-acode-text-muted hover:bg-acode-bg-hover hover:text-acode-text-primary transition-all"
          >
            <PanelRightClose className="w-[18px] h-[18px]" />
          </button>
        </div>
      </div>

      {/* Content panel */}
      <div className="flex-1 min-w-0 flex flex-col">
        <div className="flex items-center justify-between px-3 py-1.5 border-b border-acode-border-primary bg-acode-bg-secondary/30 flex-shrink-0 min-h-[33px]">
          <span className="text-[11px] font-medium text-acode-text-secondary uppercase tracking-wider">
            {TABS.find((t) => t.id === tab)?.label ?? ""}
          </span>
          <div className="flex items-center gap-0.5">
            {tab === "git" && (
              <button className="btn-icon !p-1" onClick={() => void refresh()} title="Refresh"><RefreshCw className="w-3 h-3" /></button>
            )}
          </div>
        </div>
        <div className="flex-1 min-h-0 overflow-hidden">
          {tab === "git" && <GitTab status={status} onRefresh={() => void refresh()} />}
          {tab === "diff" && <DiffTab />}
          {tab === "review" && <ReviewTab />}
          {tab === "browser" && <BrowserTab />}
          {tab === "progress" && <ProgressTab />}
          {tab === "terminal" && <TerminalPanel />}
        </div>
      </div>
    </aside>
  );
}

function DiffTab() {
  const { current, history, forwardStack, close, open, prev, next } = useDiffView();
  const [content, setContent] = useState<string>("");
  const [originalContent, setOriginalContent] = useState<string>("");
  const [view, setView] = useState<"unified" | "split">("unified");

  useEffect(() => {
    if (!current) return;
    let cancelled = false;
    void (async () => {
      const api = ensureAcodeAPI();
      try {
        const fileContent = await api.fs.readFile(current.path);
        if (cancelled) return;
        setContent(fileContent);
        if (current.action === "created") {
          setOriginalContent("");
        } else {
          // For modified/renamed, show the current content as the "original"
          // The actual diff is a semantic comparison, not line-truncation
          setOriginalContent(fileContent);
        }
      } catch {
        if (cancelled) return;
        setContent("// Unable to load file");
        setOriginalContent("// Unable to load file");
      }
    })();
    return () => { cancelled = true; };
  }, [current]);

  if (!current) {
    return (
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="text-center">
          <div className="w-14 h-14 mx-auto mb-4 rounded-2xl bg-acode-accent-subtle flex items-center justify-center">
            <Columns className="w-7 h-7 text-acode-accent-primary" />
          </div>
          <p className="text-sm text-acode-text-primary font-medium mb-1">No diff selected</p>
          <p className="text-xs text-acode-text-muted max-w-[200px] leading-relaxed">
            Click on a file in the Git tab or select a change from the chat to view its diff here.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="flex items-center justify-between px-3 py-2 border-b border-acode-border-primary bg-acode-bg-tertiary/50 flex-shrink-0">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <FileCode className="w-3.5 h-3.5 text-acode-text-muted flex-shrink-0" />
          <span className="text-xs text-acode-text-primary font-mono truncate">{current.path}</span>
          <span className="px-1.5 py-0.5 text-[9px] rounded bg-acode-bg-active text-acode-text-muted uppercase flex-shrink-0">{current.action}</span>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0 ml-2">
          <button className="btn-icon" onClick={prev} disabled={history.length === 0} title="Previous change"><ArrowLeft className="w-3.5 h-3.5" /></button>
          <button className="btn-icon" onClick={next} disabled={forwardStack.length === 0} title="Next change"><ArrowRight className="w-3.5 h-3.5" /></button>
          <div className="w-px h-4 bg-acode-border-primary mx-1" />
          <button className={`btn-icon ${view === "unified" ? "text-acode-accent-primary" : ""}`} onClick={() => setView("unified")} title="Unified view"><Code2 className="w-3.5 h-3.5" /></button>
          <button className={`btn-icon ${view === "split" ? "text-acode-accent-primary" : ""}`} onClick={() => setView("split")} title="Split view"><Columns className="w-3.5 h-3.5" /></button>
          <div className="w-px h-4 bg-acode-border-primary mx-1" />
          <button className="btn-icon" onClick={close} title="Close diff"><X className="w-3.5 h-3.5" /></button>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-3">
        {view === "unified" ? (
          <div className="space-y-0 font-mono text-[11px] leading-relaxed">
            {content.split("\n").map((line, i) => {
              const origLine = originalContent.split("\n")[i];
              const added = origLine === undefined && i >= originalContent.split("\n").length;
              const removed = line !== origLine && origLine !== undefined;
              return (
                <div key={i} className={`flex hover:bg-acode-bg-hover/40 rounded-sm px-2 ${
                  added ? "bg-acode-git-added/10" : removed ? "bg-acode-git-deleted/10" : ""
                }`}>
                  <span className="w-10 text-right pr-2 opacity-40 select-none tabular-nums text-acode-text-muted">{i + 1}</span>
                  <span className={`flex-1 whitespace-pre ${added ? "text-acode-git-added" : removed ? "text-acode-git-deleted" : "text-acode-text-primary"}`}>{line || "\u00A0"}</span>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="flex gap-0 h-full">
            <div className="flex-1 min-w-0 overflow-y-auto border-r border-acode-border-primary pr-2">
              <div className="text-[10px] uppercase tracking-wider text-acode-text-muted mb-2 px-2">Original</div>
              {originalContent.split("\n").map((line, i) => (
                <div key={i} className="flex hover:bg-acode-bg-hover/40 rounded-sm px-2 text-[11px] font-mono leading-relaxed">
                  <span className="w-8 text-right pr-1 opacity-40 select-none tabular-nums text-acode-text-muted">{i + 1}</span>
                  <span className="flex-1 whitespace-pre text-acode-text-secondary">{line || "\u00A0"}</span>
                </div>
              ))}
            </div>
            <div className="flex-1 min-w-0 overflow-y-auto pl-2">
              <div className="text-[10px] uppercase tracking-wider text-acode-text-muted mb-2 px-2">Modified</div>
              {content.split("\n").map((line, i) => {
                const origLine = originalContent.split("\n")[i];
                const added = origLine === undefined && i >= originalContent.split("\n").length;
                return (
                  <div key={i} className={`flex hover:bg-acode-bg-hover/40 rounded-sm px-2 text-[11px] font-mono leading-relaxed ${added ? "bg-acode-git-added/10" : ""}`}>
                    <span className="w-8 text-right pr-1 opacity-40 select-none tabular-nums text-acode-text-muted">{i + 1}</span>
                    <span className={`flex-1 whitespace-pre ${added ? "text-acode-git-added" : "text-acode-text-primary"}`}>{line || "\u00A0"}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ReviewTab() {
  const { messages } = useChat();
  const openDiff = useDiffView((s) => s.openFile);
  const setDiff = useDiffView((s) => s.setOpen);

  const fileChanges = useMemo(() => {
    const changes: { path: string; action: string; additions: number; deletions: number }[] = [];
    for (const msg of messages) {
      if (msg.fileChanges) {
        for (const fc of msg.fileChanges) {
          if (!changes.find((c) => c.path === fc.path)) {
            changes.push(fc);
          }
        }
      }
    }
    return changes;
  }, [messages]);

  if (fileChanges.length === 0) {
    return (
      <div className="flex-1 flex flex-col min-h-0">
        <div className="flex-1 flex items-center justify-center p-8">
          <div className="text-center">
            <div className="w-14 h-14 mx-auto mb-4 rounded-2xl bg-acode-accent-subtle flex items-center justify-center">
              <WandSparkles className="w-7 h-7 text-acode-accent-primary" />
            </div>
            <p className="text-sm text-acode-text-primary font-medium mb-1">Code Review</p>
            <p className="text-xs text-acode-text-muted max-w-[200px] leading-relaxed">
              Review your code changes with AI-powered analysis. Changes will appear here as the agent makes edits.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="px-3 py-2 border-b border-acode-border-primary">
        <span className="text-xs text-acode-text-muted">{fileChanges.length} file(s) changed</span>
      </div>
      <div className="flex-1 overflow-y-auto scrollbar-thin">
        {fileChanges.map((fc) => (
          <div
            key={fc.path}
            className="flex items-center gap-2 px-3 py-2 hover:bg-acode-bg-hover transition-colors cursor-pointer"
            onClick={() => { openDiff({ path: fc.path, action: fc.action as any, additions: fc.additions, deletions: fc.deletions }); setDiff(true); }}
          >
            <FileCode className="w-3.5 h-3.5 text-acode-text-muted flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="text-xs text-acode-text-primary truncate">{fc.path.split("/").pop()}</div>
              <div className="text-[10px] text-acode-text-muted truncate">{fc.path}</div>
            </div>
            <div className="flex items-center gap-1 text-[10px]">
              {fc.additions > 0 && <span className="text-acode-git-added">+{fc.additions}</span>}
              {fc.deletions > 0 && <span className="text-acode-git-deleted">-{fc.deletions}</span>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ProgressTab() {
  const { todos, isStreaming } = useChat();
  const activeTodos = todos.filter((t) => t.status === "in_progress");
  const pendingTodos = todos.filter((t) => t.status === "pending");
  const completedTodos = todos.filter((t) => t.status === "completed");

  if (todos.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="text-center">
          <ListTodo className="w-8 h-8 mx-auto mb-3 text-acode-text-muted/50" />
          <p className="text-sm text-acode-text-muted">No tasks yet</p>
          <p className="text-xs text-acode-text-muted/60 mt-1">Tasks will appear here as the agent works</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-2">
      {isStreaming && activeTodos.length === 0 && (
        <div className="flex items-center gap-2 px-3 py-2 bg-acode-bg-tertiary rounded-lg">
          <Loader2 className="w-3.5 h-3.5 text-acode-accent-primary animate-spin" />
          <span className="text-xs text-acode-text-secondary">Processing...</span>
        </div>
      )}
      {activeTodos.length > 0 && (
        <div>
          <div className="text-[10px] uppercase tracking-wider text-acode-accent-primary mb-2 flex items-center gap-2">
            <Loader2 className="w-3 h-3 animate-spin" />
            In progress
          </div>
          {activeTodos.map((t) => (
            <div key={t.id} className="flex items-start gap-2 px-3 py-2 hover:bg-acode-bg-hover rounded-lg transition-colors">
              <Loader2 className="w-3.5 h-3.5 text-acode-accent-primary animate-spin mt-0.5 flex-shrink-0" />
              <span className="text-xs text-acode-text-primary">{t.content}</span>
            </div>
          ))}
        </div>
      )}
      {pendingTodos.length > 0 && (
        <div>
          <div className="text-[10px] uppercase tracking-wider text-acode-text-muted mb-2">Pending</div>
          {pendingTodos.map((t) => (
            <div key={t.id} className="flex items-start gap-2 px-3 py-2 hover:bg-acode-bg-hover rounded-lg transition-colors">
              <Circle className="w-3.5 h-3.5 text-acode-text-muted mt-0.5 flex-shrink-0" />
              <span className="text-xs text-acode-text-muted">{t.content}</span>
            </div>
          ))}
        </div>
      )}
      {completedTodos.length > 0 && (
        <div>
          <div className="text-[10px] uppercase tracking-wider text-acode-git-added mb-2">Completed</div>
          {completedTodos.map((t) => (
            <div key={t.id} className="flex items-start gap-2 px-3 py-2 hover:bg-acode-bg-hover rounded-lg transition-colors">
              <Check className="w-3.5 h-3.5 text-acode-git-added mt-0.5 flex-shrink-0" />
              <span className="text-xs text-acode-text-primary line-through opacity-70">{t.content}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function GitTab({ status, onRefresh }: { status: GitStatus | null; onRefresh: () => void }) {
  const [commitMsg, setCommitMsg] = useState("");
  const toast = useToast();

  const hasChanges = status && (status.modified.length > 0 || status.added.length > 0 || status.deleted.length > 0 || status.untracked.length > 0);

  const handleCommit = useCallback(async () => {
    if (!commitMsg.trim()) { toast.error("Empty", "Commit message is required"); return; }
    try {
      const api = ensureAcodeAPI();
      await api.git.commit(".", commitMsg.trim());
      toast.success("Committed", commitMsg.trim().slice(0, 50));
      setCommitMsg("");
      onRefresh();
    } catch (err) { toast.error("Error", `Failed to commit: ${(err as Error)?.message ?? "Unknown error"}`); }
  }, [commitMsg, onRefresh, toast]);

  if (!status) {
    return (
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="text-center">
          <Loader2 className="w-6 h-6 mx-auto mb-3 text-acode-text-muted/50 animate-spin" />
          <p className="text-sm text-acode-text-muted">Loading git status...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin">
      {/* Branch info */}
      <div className="px-3 pt-2.5 pb-1.5 border-b border-acode-border-primary">
        <div className="flex items-center gap-2 mb-1.5">
          <div className="flex items-center gap-1.5 px-2 py-0.5 bg-acode-accent-subtle rounded-md">
            <GitBranch className="w-3 h-3 text-acode-accent-primary" />
            <span className="text-[11px] font-medium text-acode-accent-primary font-mono">{status.branch}</span>
          </div>
          <div className="flex items-center gap-1 text-[10px] text-acode-text-muted">
            {status.ahead > 0 && <span className="flex items-center gap-0.5"><ArrowUp className="w-2.5 h-2.5" />{status.ahead}</span>}
            {status.behind > 0 && <span className="flex items-center gap-0.5"><ArrowDown className="w-2.5 h-2.5" />{status.behind}</span>}
            {status.ahead === 0 && status.behind === 0 && <span className="text-acode-git-added">up to date</span>}
          </div>
        </div>
      </div>

      {hasChanges ? (
        <>
          {/* Commit area */}
          <div className="p-3 border-b border-acode-border-primary bg-acode-bg-secondary/20">
            <textarea
              className="w-full bg-acode-bg-tertiary border border-acode-border-primary rounded-lg px-3 py-2 text-xs font-mono text-acode-text-primary placeholder-acode-text-muted resize-none outline-none focus:border-acode-accent-primary transition-colors min-h-[56px]"
              placeholder="Commit message"
              value={commitMsg}
              onChange={(e) => setCommitMsg(e.target.value)}
              onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); handleCommit(); } }}
              rows={2}
            />
            <button
              onClick={handleCommit}
              disabled={!commitMsg.trim()}
              className="mt-2 w-full flex items-center justify-center gap-1.5 px-3 py-1.5 bg-acode-accent-primary hover:bg-acode-accent-hover disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-medium rounded-lg transition-colors"
            >
              <GitCommitHorizontal className="w-3.5 h-3.5" />
              Commit
            </button>
          </div>

          {/* File changes */}
          <div className="py-1">
            {(status.modified?.length ?? 0) > 0 && (
              <div>
                <SectionHeader label="Modified" count={status.modified.length} color="text-acode-git-modified" />
                {status.modified.slice(0, 50).map((f) => (
                  <FileRow key={f} path={f} action="modified" icon={<FileCode className="w-3 h-3 text-acode-git-modified" />} />
                ))}
              </div>
            )}
            {(status.added?.length ?? 0) > 0 && (
              <div>
                <SectionHeader label="Added" count={status.added.length} color="text-acode-git-added" />
                {status.added.slice(0, 50).map((f) => (
                  <FileRow key={f} path={f} action="created" icon={<Plus className="w-3 h-3 text-acode-git-added" />} />
                ))}
              </div>
            )}
            {(status.deleted?.length ?? 0) > 0 && (
              <div>
                <SectionHeader label="Deleted" count={status.deleted.length} color="text-acode-git-deleted" />
                {status.deleted.slice(0, 50).map((f) => (
                  <FileRow key={f} path={f} action="deleted" icon={<X className="w-3 h-3 text-acode-git-deleted" />} />
                ))}
              </div>
            )}
            {(status.untracked?.length ?? 0) > 0 && (
              <div>
                <SectionHeader label="Untracked" count={status.untracked.length} color="text-acode-text-muted" />
                {status.untracked.slice(0, 50).map((f) => (
                  <FileRow key={f} path={f} action="created" icon={<Plus className="w-3 h-3 text-acode-text-muted" />} />
                ))}
              </div>
            )}
          </div>
        </>
      ) : (
        <div className="flex-1 flex items-center justify-center p-8">
          <div className="text-center">
            <Check className="w-8 h-8 mx-auto mb-3 text-acode-git-added" />
            <p className="text-sm text-acode-text-muted">No changes</p>
            <p className="text-xs text-acode-text-muted/60 mt-1">Working tree is clean</p>
          </div>
        </div>
      )}
    </div>
  );
}

function SectionHeader({ label, count, color }: { label: string; count: number; color: string }) {
  return (
    <div className="flex items-center gap-1.5 px-3 py-1.5 text-[10px] uppercase tracking-wider text-acode-text-muted">
      <span className={color}>{count}</span>
      <span>{label}</span>
    </div>
  );
}

function FileRow({ path, icon, action = "modified" }: { path: string; icon: React.ReactNode; action?: "created" | "modified" | "deleted" | "renamed" }) {
  const openDiff = useDiffView((s) => s.openFile);
  const setDiff = useDiffView((s) => s.setOpen);
  const fileName = path.split("/").pop() ?? path;
  const dir = path.split("/").slice(0, -1).join("/");
  const handleOpenDiff = (e: React.MouseEvent) => {
    e.stopPropagation();
    openDiff({ path, action, additions: 0, deletions: 0 });
    setDiff(true);
  };
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 hover:bg-acode-bg-hover transition-colors group" onClick={handleOpenDiff}>
      <span className="flex-shrink-0">{icon}</span>
      <div className="flex-1 min-w-0">
        <div className="text-xs text-acode-text-primary truncate">{fileName}</div>
        {dir && <div className="text-[9px] text-acode-text-muted/60 truncate">{dir}</div>}
      </div>
      <button className="opacity-0 group-hover:opacity-100 transition-opacity btn-icon text-acode-text-muted hover:text-acode-text-primary" title="Open diff" onClick={handleOpenDiff}><Eye className="w-3 h-3" /></button>
    </div>
  );
}

function ArrowDown(props: React.ComponentProps<typeof ArrowRight>) {
  return (
    <svg className={props.className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 5v14M19 12l-7 7-7-7" />
    </svg>
  );
}

function BrowserTab() {
  const {
    browserTabs,
    activeBrowserTabId,
    setActiveBrowserTab,
    addBrowserTab,
    removeBrowserTab,
    navigateBrowser,
    goBackBrowser,
    goForwardBrowser,
    refreshBrowser,
  } = useUI();
  const [inputValue, setInputValue] = useState("");

  const activeTab = browserTabs.find((t) => t.id === activeBrowserTabId);

  useEffect(() => {
    if (activeTab) setInputValue(activeTab.url);
  }, [activeTab?.url, activeTab?.id]);

  const onNavigate = (e: React.FormEvent) => {
    e.preventDefault();
    if (activeTab && inputValue.trim()) {
      navigateBrowser(activeTab.id, inputValue.trim());
      setInputValue(inputValue.trim());
    }
  };

  if (browserTabs.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="text-center">
          <Globe className="w-8 h-8 mx-auto mb-3 text-acode-text-muted/50" />
          <p className="text-sm text-acode-text-muted">No browser tabs</p>
          <button
            className="mt-3 flex items-center gap-1.5 px-3 py-1.5 bg-acode-accent-primary hover:bg-acode-accent-hover text-white text-xs rounded-md transition-colors mx-auto"
            onClick={() => addBrowserTab()}
          >
            <Plus className="w-3 h-3" />
            New tab
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Tab bar */}
      <div className="flex items-center bg-acode-bg-tertiary border-b border-acode-border-primary overflow-x-auto flex-shrink-0 scrollbar-thin">
        {browserTabs.map((t) => (
          <div
            key={t.id}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 border-r border-acode-border-primary cursor-pointer transition-colors text-xs ${
              t.id === activeBrowserTabId
                ? "bg-acode-bg-primary text-acode-text-primary"
                : "bg-acode-bg-tertiary text-acode-text-muted hover:bg-acode-bg-hover"
            }`}
            onClick={() => setActiveBrowserTab(t.id)}
          >
            <Globe className="w-3 h-3 flex-shrink-0" />
            <span className="truncate max-w-[100px]">{t.title}</span>
            <button
              className="ml-1 rounded p-0.5 opacity-0 hover:opacity-100 hover:bg-acode-bg-active transition-opacity"
              onClick={(e) => { e.stopPropagation(); removeBrowserTab(t.id); }}
            >
              <X className="w-2.5 h-2.5" />
            </button>
          </div>
        ))}
        <button className="px-2 h-full text-acode-text-muted hover:text-acode-text-primary hover:bg-acode-bg-hover transition-colors flex-shrink-0" onClick={() => addBrowserTab()}>
          <Plus className="w-3 h-3" />
        </button>
      </div>

      {/* URL bar */}
      <form onSubmit={onNavigate} className="flex items-center gap-1.5 px-2 py-1.5 border-b border-acode-border-primary bg-acode-bg-tertiary/50 flex-shrink-0">
        <button type="button" className="btn-icon" disabled={!activeTab || activeTab.historyIdx <= 0} onClick={() => activeTab && goBackBrowser(activeTab.id)} title="Back"><ArrowLeft className="w-3 h-3" /></button>
        <button type="button" className="btn-icon" disabled={!activeTab || activeTab.historyIdx >= activeTab.history.length - 1} onClick={() => activeTab && goForwardBrowser(activeTab.id)} title="Forward"><ArrowRight className="w-3 h-3" /></button>
        <button type="button" className="btn-icon" onClick={() => activeTab && refreshBrowser(activeTab.id)} title="Refresh"><RefreshCw className="w-3 h-3" /></button>
        <input
          className="flex-1 bg-acode-bg-tertiary border border-acode-border-primary rounded-md px-2.5 py-1 text-xs text-acode-text-primary placeholder-acode-text-muted outline-none focus:border-acode-accent-primary transition-colors"
          placeholder="Search or enter URL"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onFocus={() => activeTab && setInputValue(activeTab.url)}
        />
      </form>

      {/* Content area */}
      <div className="flex-1 min-h-0 relative bg-white">
        {activeTab?.url ? (
          <>
            <iframe
              src={activeTab.url}
              title={activeTab.title}
              className="w-full h-full border-0 bg-white"
              sandbox="allow-same-origin allow-scripts allow-popups allow-forms"
            />
            {activeTab.loading && (
              <div className="absolute inset-0 bg-acode-bg-primary/50 flex items-center justify-center backdrop-blur-[1px]">
                <Loader2 className="w-6 h-6 text-acode-accent-primary animate-spin" />
              </div>
            )}
          </>
        ) : (
          <div className="w-full h-full flex items-center justify-center p-8 bg-acode-bg-primary">
            <div className="text-center">
              <Globe className="w-10 h-10 mx-auto mb-3 text-acode-text-muted/40" />
              <p className="text-sm text-acode-text-muted">Enter a URL to browse</p>
              <p className="text-xs text-acode-text-muted/60 mt-1">Built-in web browser</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}