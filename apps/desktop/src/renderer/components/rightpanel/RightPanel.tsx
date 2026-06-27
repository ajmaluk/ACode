import { useState, useEffect, useCallback, useMemo } from "react";
import { useGit, useChat, useWorkspace, useDiffView, useUI, useTerminal } from "@/store/useAppStore";
import type { GitStatus } from "@dalam/shared-types";
import { createDalamAPI } from "@/lib/dalamAPI";
import { computeDiff } from "@/lib/diff";
import { useToast } from "@/components/ui/toastStore";
import { TerminalPanel } from "../terminal/TerminalPanel";
import {
  GitBranch, FileCode, Check, X,
  RefreshCw, Globe, ListTodo, Circle,
  Plus, Loader2, ArrowLeft, ArrowRight, ArrowUp, ArrowDown, Eye,
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
  const { status, refresh, error } = useGit();
  const { session } = useChat();
  const { activeWorkspaceId } = useWorkspace();
  const { open: diffOpen, current: diffCurrent } = useDiffView();
  const { browserTabs, activeBrowserTabId, rightPanelTab: tab, setRightPanelTab: setTab } = useUI();
  const changeCount = (status?.modified.length ?? 0) + (status?.added.length ?? 0) + (status?.deleted.length ?? 0);

  const hasWorkspace = !!(session?.workspacePath);

  const visibleTabs = useMemo(() => {
    if (hasWorkspace) return TABS;
    return TABS.filter((t) => t.id !== "terminal");
  }, [hasWorkspace]);

  useEffect(() => { void refresh(); }, [refresh, activeWorkspaceId]);

  // Unified tab-switching + panel-opening effect with priority: terminal > diff > browser > git
  // Note: `tab` is NOT in deps — it's read from the store snapshot via `useUI.getState()`
  // to avoid the infinite loop caused by setTab() re-triggering this effect.
  useEffect(() => {
    const currentTab = useUI.getState().rightPanelTab;
    if (currentTab === "terminal" && hasWorkspace) return;
    // If terminal is active but workspace is gone, fall back to git
    if (currentTab === "terminal" && !hasWorkspace) {
      setTab("git");
    }
    const needsOpen = !useUI.getState().rightPanelOpen;
    if (diffOpen && diffCurrent) {
      if (currentTab !== "diff") setTab("diff");
      if (needsOpen) useUI.getState().setRightPanelOpen(true);
      return;
    }
    if (activeBrowserTabId && browserTabs.length > 0) {
      if (currentTab !== "browser") setTab("browser");
      if (needsOpen) useUI.getState().setRightPanelOpen(true);
      return;
    }
    // Only set a default tab if current isn't one of the main tabs
    if (currentTab !== "git" && currentTab !== "browser" && currentTab !== "diff" && currentTab !== "review" && currentTab !== "progress") {
      setTab(activeWorkspaceId ? "git" : "browser");
    }
  }, [activeWorkspaceId, diffOpen, diffCurrent, activeBrowserTabId, browserTabs.length, setTab, hasWorkspace]);

  return (
    <aside className="h-full flex flex-row-reverse bg-dalam-bg-primary border-l border-dalam-border-primary">
      {/* Activity bar on the right edge */}
      <div className="w-11 flex-shrink-0 bg-dalam-bg-tertiary border-l border-dalam-border-primary flex flex-col items-center pt-2 pb-3 gap-1 select-none">
        <div className="flex-1 flex flex-col items-center gap-1">
          {visibleTabs.map((t) => {
            const Icon = t.icon;
            const isActive = tab === t.id;
            const hasChanges = t.id === "git" && changeCount > 0;
            return (
              <button
                key={t.id}
                onClick={() => {
                  if (t.id === "terminal" && session?.workspacePath) {
                    useTerminal.getState().ensureTabForCwd(session.workspacePath);
                  }
                  setTab(t.id);
                  if (!useUI.getState().rightPanelOpen) useUI.getState().setRightPanelOpen(true);
                }}
                title={t.label}
                className={`w-9 h-9 flex items-center justify-center rounded-lg transition-all duration-100 relative group ${
                  isActive
                    ? "bg-dalam-accent-subtle text-dalam-accent-primary shadow-sm"
                    : "text-dalam-text-muted hover:bg-dalam-bg-hover hover:text-dalam-text-primary"
                }`}
              >
                <Icon className="w-[18px] h-[18px]" />
                {hasChanges && (
                  <span className="absolute top-0.5 right-0.5 w-2 h-2 rounded-full bg-dalam-accent-primary" />
                )}
                {isActive && (
                  <span className="absolute right-0 top-1/2 -translate-y-1/2 w-0.5 h-5 rounded-full bg-dalam-accent-primary shadow-sm shadow-dalam-accent-primary/30" />
                )}
                <span className="absolute left-full ml-2 top-1/2 -translate-y-1/2 pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity bg-dalam-bg-tertiary border border-dalam-border-primary text-dalam-text-primary text-[11px] px-2 py-1 rounded-md whitespace-nowrap shadow-xl z-50 font-medium">
                  {t.label}
                </span>
              </button>
            );
          })}
        </div>
        <div className="pt-2 border-t border-dalam-border-primary/50 w-full flex flex-col items-center gap-1">
          <button
            onClick={() => useUI.getState().toggleRightPanel()}
            title="Close panel"
            className="w-9 h-9 flex items-center justify-center rounded-lg text-dalam-text-muted hover:bg-dalam-bg-hover hover:text-dalam-text-primary transition-all"
          >
            <PanelRightClose className="w-[18px] h-[18px]" />
          </button>
        </div>
      </div>

      {/* Content panel */}
      <div className="flex-1 min-w-0 flex flex-col">
        <div className="flex items-center justify-between px-3 py-1.5 border-b border-dalam-border-primary bg-dalam-bg-secondary/30 flex-shrink-0 min-h-[33px]">
          <span className="text-[11px] font-medium text-dalam-text-secondary uppercase tracking-wider">
            {visibleTabs.find((t) => t.id === tab)?.label ?? ""}
          </span>
          <div className="flex items-center gap-0.5">
            {tab === "git" && (
              <button className="btn-icon !p-1" onClick={() => void refresh()} title="Refresh"><RefreshCw className="w-3 h-3" /></button>
            )}
          </div>
        </div>
        <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
          {tab === "git" && <GitTab status={status} error={error} onRefresh={() => void refresh()} />}
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
  const { current, history, forwardStack, close, prev, next } = useDiffView();
  const [originalContent, setOriginalContent] = useState<string>("");
  const [modifiedContent, setModifiedContent] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [view, setView] = useState<"unified" | "split">("unified");

  // Fetch original (old) and modified (new) content properly
  useEffect(() => {
    if (!current) return;
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    void (async () => {
      const api = createDalamAPI();
      try {
        // Modified content: always read the current file
        const currentContent = await api.fs.readFile(current.path);
        if (cancelled) return;
        setModifiedContent(currentContent);

        if (current.action === "created") {
          setOriginalContent("");
        } else if (current.action === "deleted") {
          setOriginalContent(currentContent);
          setModifiedContent("");
        } else {
          // For modified files: get the original from git (HEAD version)
          try {
            const { Command } = await import("@tauri-apps/plugin-shell");
            const wsPath = useWorkspace.getState().workspaces.find(
              (w) => w.id === useWorkspace.getState().activeWorkspaceId
            )?.path ?? "";
            // git show HEAD: requires a path relative to the repo root
            const relPath = wsPath && current.path.startsWith(wsPath)
              ? current.path.slice(wsPath.length + 1)
              : current.path.split("/").slice(-2).join("/");
            const cmd = Command.create("git", ["show", `HEAD:${relPath}`], { cwd: wsPath });
            const result = await cmd.execute();
            if (!cancelled && result.stdout) {
              setOriginalContent(result.stdout);
            } else {
              // Fallback: can't get git version, show full file as added
              setOriginalContent("");
            }
          } catch {
            // Fallback if git show fails
            if (!cancelled) setOriginalContent("");
          }
        }
      } catch {
        if (cancelled) return;
        setModifiedContent("// Unable to load file");
        setOriginalContent("// Unable to load file");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [current]);

  if (!current) {
    return (
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="text-center">
          <div className="w-14 h-14 mx-auto mb-4 rounded-2xl bg-dalam-accent-subtle flex items-center justify-center">
            <Columns className="w-7 h-7 text-dalam-accent-primary" />
          </div>
          <p className="text-sm text-dalam-text-primary font-medium mb-1">No diff selected</p>
          <p className="text-xs text-dalam-text-muted max-w-[200px] leading-relaxed">
            Click on a file in the Git tab or select a change from the chat to view its diff here.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="flex items-center justify-between px-3 py-2 border-b border-dalam-border-primary bg-dalam-bg-tertiary/50 flex-shrink-0">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <FileCode className="w-3.5 h-3.5 text-dalam-text-muted flex-shrink-0" />
          <span className="text-xs text-dalam-text-primary font-mono truncate">{current.path}</span>
          <span className="px-1.5 py-0.5 text-[9px] rounded bg-dalam-bg-active text-dalam-text-muted uppercase flex-shrink-0">{current.action}</span>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0 ml-2">
          <button className="btn-icon" onClick={prev} disabled={history.length === 0} title="Previous change"><ArrowLeft className="w-3.5 h-3.5" /></button>
          <button className="btn-icon" onClick={next} disabled={forwardStack.length === 0} title="Next change"><ArrowRight className="w-3.5 h-3.5" /></button>
          <div className="w-px h-4 bg-dalam-border-primary mx-1" />
          <button className={`btn-icon ${view === "unified" ? "text-dalam-accent-primary" : ""}`} onClick={() => setView("unified")} title="Unified view"><Code2 className="w-3.5 h-3.5" /></button>
          <button className={`btn-icon ${view === "split" ? "text-dalam-accent-primary" : ""}`} onClick={() => setView("split")} title="Split view"><Columns className="w-3.5 h-3.5" /></button>
          <div className="w-px h-4 bg-dalam-border-primary mx-1" />
          <button className="btn-icon" onClick={close} title="Close diff"><X className="w-3.5 h-3.5" /></button>
        </div>
      </div>

      {loading ? (
        <div className="flex-1 flex items-center justify-center">
          <Loader2 className="w-5 h-5 text-dalam-accent-primary animate-spin" />
        </div>
      ) : (
        <DiffContent originalContent={originalContent} modifiedContent={modifiedContent} view={view} />
      )}
    </div>
  );
}

/** Render the actual diff content using the LCS-based diff algorithm. */
function DiffContent({ originalContent, modifiedContent, view }: { originalContent: string; modifiedContent: string; view: "unified" | "split" }) {
  const diff = useMemo(() => computeDiff(originalContent, modifiedContent), [originalContent, modifiedContent]);

  if (diff.hunks.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="text-center">
          <Check className="w-8 h-8 mx-auto mb-3 text-dalam-git-added" />
          <p className="text-sm text-dalam-text-muted">No differences</p>
          <p className="text-xs text-dalam-text-muted/60 mt-1">Files are identical</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-3">
      {/* Summary bar */}
      <div className="flex items-center gap-3 mb-3 text-[11px]">
        <span className="text-dalam-git-added font-mono">+{diff.additions}</span>
        <span className="text-dalam-git-deleted font-mono">-{diff.deletions}</span>
        <span className="text-dalam-text-muted">{diff.hunks.length} hunk{diff.hunks.length !== 1 ? "s" : ""}</span>
      </div>

      {view === "unified" ? (
        <div className="font-mono text-[11px] leading-relaxed">
          {diff.hunks.map((hunk, hunkIdx) => (
            <div key={hunkIdx} className="mb-3">
              {/* Hunk header */}
              <div className="flex items-center px-2 py-1 bg-dalam-bg-tertiary/60 text-dalam-text-muted text-[10px] border-t border-b border-dalam-border-primary/40">
                <span>@@ -{hunk.oldStart},{hunk.oldCount} +{hunk.newStart},{hunk.newCount} @@</span>
              </div>
              {/* Lines */}
              {hunk.lines.map((line, lineIdx) => {
                const prefix = line.type === "add" ? "+" : line.type === "remove" ? "-" : " ";
                return (
                  <div
                    key={lineIdx}
                    className={`flex hover:bg-dalam-bg-hover/30 ${
                      line.type === "add"
                        ? "bg-dalam-git-added/10"
                        : line.type === "remove"
                          ? "bg-dalam-git-deleted/10"
                          : ""
                    }`}
                  >
                    <span className="w-[38px] text-right pr-1 opacity-35 select-none tabular-nums text-dalam-text-muted flex-shrink-0">{line.oldLineNum ?? ""}</span>
                    <span className="w-[38px] text-right pr-1 opacity-35 select-none tabular-nums text-dalam-text-muted flex-shrink-0">{line.newLineNum ?? ""}</span>
                    <span className={`w-5 text-center select-none flex-shrink-0 ${
                      line.type === "add"
                        ? "text-dalam-git-added"
                        : line.type === "remove"
                          ? "text-dalam-git-deleted"
                          : "text-dalam-text-muted/40"
                    }`}>{prefix}</span>
                    <span className={`flex-1 whitespace-pre px-1 ${
                      line.type === "add"
                        ? "text-dalam-git-added"
                        : line.type === "remove"
                          ? "text-dalam-git-deleted"
                          : "text-dalam-text-primary"
                    }`}>{line.content || "\u00A0"}</span>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      ) : (
        /* Split view: side-by-side diff */
        <SplitDiffView hunks={diff.hunks} />
      )}
    </div>
  );
}

/** Split (side-by-side) diff view aligned to hunks. */
function SplitDiffView({ hunks }: { hunks: import("@/lib/diff").DiffHunk[] }) {
  // For split view, we render each hunk as a side-by-side table.
  // Each hunk's lines are paired: context lines appear on both sides,
  // remove on left only, add on right only. Removes and adds that are
  // adjacent are paired on the same row for proper side-by-side alignment.
  const [leftLines, rightLines] = useMemo(() => {
    const left: { line: import("@/lib/diff").ComputedDiffLine; rowIdx: number }[] = [];
    const right: { line: import("@/lib/diff").ComputedDiffLine; rowIdx: number }[] = [];
    let rowIdx = 0;

    for (const hunk of hunks) {
      // Buffer consecutive removes/adds to pair them
      const removes: import("@/lib/diff").ComputedDiffLine[] = [];
      const adds: import("@/lib/diff").ComputedDiffLine[] = [];

      const flushPair = () => {
        const maxLen = Math.max(removes.length, adds.length);
        for (let i = 0; i < maxLen; i++) {
          if (i < removes.length) left.push({ line: removes[i], rowIdx });
          if (i < adds.length) right.push({ line: adds[i], rowIdx });
          rowIdx++;
        }
        removes.length = 0;
        adds.length = 0;
      };

      for (const line of hunk.lines) {
        if (line.type === "context") {
          flushPair();
          left.push({ line, rowIdx });
          right.push({ line, rowIdx });
          rowIdx++;
        } else if (line.type === "remove") {
          removes.push(line);
        } else {
          adds.push(line);
        }
      }
      flushPair();
    }

    return [left, right];
  }, [hunks]);

  const totalRows = Math.max(leftLines.length, rightLines.length);

  return (
    <div className="flex gap-0 border border-dalam-border-primary/40 rounded-lg overflow-hidden">
      {/* Left panel: old */}
      <div className="flex-1 min-w-0 overflow-y-auto border-r border-dalam-border-primary/40">
        <div className="text-[10px] uppercase tracking-wider text-dalam-text-muted mb-1 px-2 py-1 bg-dalam-bg-tertiary/40">Original</div>
        {Array.from({ length: totalRows }, (_, i) => {
          const entry = leftLines[i];
          if (!entry) return <div key={i} className="h-[20px]" />;
          const { line } = entry;
          const isRemove = line.type === "remove";
          return (
            <div key={i} className={`flex hover:bg-dalam-bg-hover/30 text-[11px] font-mono leading-relaxed ${isRemove ? "bg-dalam-git-deleted/10" : ""}`}>
              <span className="w-10 text-right pr-1 opacity-35 select-none tabular-nums text-dalam-text-muted flex-shrink-0">{line.oldLineNum ?? ""}</span>
              <span className={`w-4 text-center select-none flex-shrink-0 ${isRemove ? "text-dalam-git-deleted" : "text-dalam-text-muted/30"}`}>{isRemove ? "-" : " "}</span>
              <span className={`flex-1 whitespace-pre px-1 ${isRemove ? "text-dalam-git-deleted" : "text-dalam-text-secondary"}`}>{line.content || "\u00A0"}</span>
            </div>
          );
        })}
      </div>
      {/* Right panel: new */}
      <div className="flex-1 min-w-0 overflow-y-auto">
        <div className="text-[10px] uppercase tracking-wider text-dalam-text-muted mb-1 px-2 py-1 bg-dalam-bg-tertiary/40">Modified</div>
        {Array.from({ length: totalRows }, (_, i) => {
          const entry = rightLines[i];
          if (!entry) return <div key={i} className="h-[20px]" />;
          const { line } = entry;
          const isAdd = line.type === "add";
          return (
            <div key={i} className={`flex hover:bg-dalam-bg-hover/30 text-[11px] font-mono leading-relaxed ${isAdd ? "bg-dalam-git-added/10" : ""}`}>
              <span className="w-10 text-right pr-1 opacity-35 select-none tabular-nums text-dalam-text-muted flex-shrink-0">{line.newLineNum ?? ""}</span>
              <span className={`w-4 text-center select-none flex-shrink-0 ${isAdd ? "text-dalam-git-added" : "text-dalam-text-muted/30"}`}>{isAdd ? "+" : " "}</span>
              <span className={`flex-1 whitespace-pre px-1 ${isAdd ? "text-dalam-git-added" : "text-dalam-text-primary"}`}>{line.content || "\u00A0"}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ReviewTab() {
  const { messages, _pendingChanges } = useChat();
  const openDiff = useDiffView((s) => s.openFile);

  const fileChanges = useMemo(() => {
    const changes: { path: string; action: string; additions: number; deletions: number }[] = [];
    // Include committed changes from messages
    for (const msg of messages) {
      if (msg.fileChanges) {
        for (const fc of msg.fileChanges) {
          if (!changes.find((c) => c.path === fc.path)) {
            changes.push(fc);
          }
        }
      }
    }
    // Include pending (streaming) changes
    if (_pendingChanges) {
      for (const fc of _pendingChanges) {
        if (!changes.find((c) => c.path === fc.path)) {
          changes.push(fc);
        }
      }
    }
    return changes;
  }, [messages, _pendingChanges]);

  if (fileChanges.length === 0) {
    return (
      <div className="flex-1 flex flex-col min-h-0">
        <div className="flex-1 flex items-center justify-center p-8">
          <div className="text-center">
            <div className="w-14 h-14 mx-auto mb-4 rounded-2xl bg-dalam-accent-subtle flex items-center justify-center">
              <WandSparkles className="w-7 h-7 text-dalam-accent-primary" />
            </div>
            <p className="text-sm text-dalam-text-primary font-medium mb-1">No Changes Yet</p>
            <p className="text-xs text-dalam-text-muted max-w-[200px] leading-relaxed">
              File changes made by the agent will appear here. Click any file to review the diff.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="px-3 py-2 border-b border-dalam-border-primary">
        <span className="text-xs text-dalam-text-muted">{fileChanges.length} file(s) changed</span>
      </div>
      <div className="flex-1 overflow-y-auto scrollbar-thin">
        {fileChanges.map((fc) => (
          <div
            key={fc.path}
            className="flex items-center gap-2 px-3 py-2 hover:bg-dalam-bg-hover transition-colors cursor-pointer"
            onClick={() => { openDiff({ path: fc.path, action: fc.action as "created" | "modified" | "deleted", additions: fc.additions, deletions: fc.deletions }); }}
          >
            <FileCode className="w-3.5 h-3.5 text-dalam-text-muted flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="text-xs text-dalam-text-primary truncate">{fc.path.split("/").pop()}</div>
              <div className="text-[10px] text-dalam-text-muted truncate">{fc.path}</div>
            </div>
            <div className="flex items-center gap-1 text-[10px]">
              {fc.additions > 0 && <span className="text-dalam-git-added">+{fc.additions}</span>}
              {fc.deletions > 0 && <span className="text-dalam-git-deleted">-{fc.deletions}</span>}
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
          <ListTodo className="w-8 h-8 mx-auto mb-3 text-dalam-text-muted/50" />
          <p className="text-sm text-dalam-text-muted">No tasks yet</p>
          <p className="text-xs text-dalam-text-muted/60 mt-1">Tasks will appear here as the agent works</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-2">
      {isStreaming && activeTodos.length === 0 && (
        <div className="flex items-center gap-2 px-3 py-2 bg-dalam-bg-tertiary rounded-lg">
          <Loader2 className="w-3.5 h-3.5 text-dalam-accent-primary animate-spin" />
          <span className="text-xs text-dalam-text-secondary">Processing...</span>
        </div>
      )}
      {activeTodos.length > 0 && (
        <div>
          <div className="text-[10px] uppercase tracking-wider text-dalam-accent-primary mb-2 flex items-center gap-2">
            <Loader2 className="w-3 h-3 animate-spin" />
            In progress
          </div>
          {activeTodos.map((t) => (
            <div key={t.id} className="flex items-start gap-2 px-3 py-2 hover:bg-dalam-bg-hover rounded-lg transition-colors">
              <Loader2 className="w-3.5 h-3.5 text-dalam-accent-primary animate-spin mt-0.5 flex-shrink-0" />
              <span className="text-xs text-dalam-text-primary">{t.content}</span>
            </div>
          ))}
        </div>
      )}
      {pendingTodos.length > 0 && (
        <div>
          <div className="text-[10px] uppercase tracking-wider text-dalam-text-muted mb-2">Pending</div>
          {pendingTodos.map((t) => (
            <div key={t.id} className="flex items-start gap-2 px-3 py-2 hover:bg-dalam-bg-hover rounded-lg transition-colors">
              <Circle className="w-3.5 h-3.5 text-dalam-text-muted mt-0.5 flex-shrink-0" />
              <span className="text-xs text-dalam-text-muted">{t.content}</span>
            </div>
          ))}
        </div>
      )}
      {completedTodos.length > 0 && (
        <div>
          <div className="text-[10px] uppercase tracking-wider text-dalam-git-added mb-2">Completed</div>
          {completedTodos.map((t) => (
            <div key={t.id} className="flex items-start gap-2 px-3 py-2 hover:bg-dalam-bg-hover rounded-lg transition-colors">
              <Check className="w-3.5 h-3.5 text-dalam-git-added mt-0.5 flex-shrink-0" />
              <span className="text-xs text-dalam-text-primary line-through opacity-70">{t.content}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function GitTab({ status, error, onRefresh }: { status: GitStatus | null; error: string | null; onRefresh: () => void }) {
  const [commitMsg, setCommitMsg] = useState("");
  const toast = useToast();
  const { activeWorkspaceId, workspaces } = useWorkspace();
  const ws = workspaces.find((w) => w.id === activeWorkspaceId);

  const hasChanges = status && (status.modified.length > 0 || status.added.length > 0 || status.deleted.length > 0 || status.untracked.length > 0);

  const handleCommit = useCallback(async () => {
    if (!commitMsg.trim()) { toast.error("Empty", "Commit message is required"); return; }
    try {
      const api = createDalamAPI();
      const wsPath = useWorkspace.getState().workspaces.find(
        (w) => w.id === useWorkspace.getState().activeWorkspaceId
      )?.path ?? ".";
      await api.git.commit(wsPath, commitMsg.trim());
      toast.success("Committed", commitMsg.trim().slice(0, 50));
      setCommitMsg("");
      onRefresh();
    } catch (err) { toast.error("Error", `Failed to commit: ${(err as Error)?.message ?? "Unknown error"}`); }
  }, [commitMsg, onRefresh, toast]);

  if (!status && !error) {
    return (
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="text-center">
          <Loader2 className="w-6 h-6 mx-auto mb-3 text-dalam-text-muted/50 animate-spin" />
          <p className="text-sm text-dalam-text-muted">Loading git status...</p>
        </div>
      </div>
    );
  }

  if (error === "not_initialized" || (!status && error)) {
    return (
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="text-center">
          <div className="w-14 h-14 mx-auto mb-4 rounded-2xl bg-dalam-bg-tertiary flex items-center justify-center">
            <GitBranch className="w-7 h-7 text-dalam-text-muted/50" />
          </div>
          <p className="text-sm text-dalam-text-primary font-medium mb-1">No git repository</p>
          <p className="text-xs text-dalam-text-muted max-w-[220px] leading-relaxed mb-4">
            {ws ? `The folder "${ws.name}" is not a git repository.` : "No workspace selected."}
          </p>
          {ws && (
            <button
              onClick={async () => {
                try {
                  const { Command } = await import("@tauri-apps/plugin-shell");
                  await Command.create("git", ["init"], { cwd: ws.path }).execute();
                  toast.success("Git initialized", "Repository created successfully");
                  onRefresh();
                } catch (err) {
                  toast.error("Failed to initialize git", (err as Error)?.message ?? "Unknown error");
                }
              }}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-dalam-accent-primary hover:bg-dalam-accent-hover text-white text-xs font-medium rounded-lg transition-colors mx-auto"
            >
              <GitBranch className="w-3.5 h-3.5" />
              Initialize Git Repository
            </button>
          )}
        </div>
      </div>
    );
  }

  if (!status) {
    return (
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="text-center">
          <Loader2 className="w-6 h-6 mx-auto mb-3 text-dalam-text-muted/50 animate-spin" />
          <p className="text-sm text-dalam-text-muted">Loading git status...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin">
      {/* Branch info */}
      <div className="px-3 pt-2.5 pb-1.5 border-b border-dalam-border-primary">
        <div className="flex items-center gap-2 mb-1.5">
          <div className="flex items-center gap-1.5 px-2 py-0.5 bg-dalam-accent-subtle rounded-md">
            <GitBranch className="w-3 h-3 text-dalam-accent-primary" />
            <span className="text-[11px] font-medium text-dalam-accent-primary font-mono">{status.branch}</span>
          </div>
          <div className="flex items-center gap-1 text-[10px] text-dalam-text-muted">
            {status.ahead > 0 && <span className="flex items-center gap-0.5"><ArrowUp className="w-2.5 h-2.5" />{status.ahead}</span>}
            {status.behind > 0 && <span className="flex items-center gap-0.5"><ArrowDown className="w-2.5 h-2.5" />{status.behind}</span>}
            {status.ahead === 0 && status.behind === 0 && <span className="text-dalam-git-added">up to date</span>}
          </div>
        </div>
      </div>

      {hasChanges ? (
        <>
          {/* Commit area */}
          <div className="p-3 border-b border-dalam-border-primary bg-dalam-bg-secondary/20">
            <textarea
              className="w-full bg-dalam-bg-tertiary border border-dalam-border-primary rounded-lg px-3 py-2 text-xs font-mono text-dalam-text-primary placeholder-dalam-text-muted resize-none outline-none focus:border-dalam-accent-primary transition-colors min-h-[56px]"
              placeholder="Commit message"
              value={commitMsg}
              onChange={(e) => setCommitMsg(e.target.value)}
              onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); handleCommit(); } }}
              rows={2}
            />
            <button
              onClick={handleCommit}
              disabled={!commitMsg.trim()}
              className="mt-2 w-full flex items-center justify-center gap-1.5 px-3 py-1.5 bg-dalam-accent-primary hover:bg-dalam-accent-hover disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-medium rounded-lg transition-colors"
            >
              <GitCommitHorizontal className="w-3.5 h-3.5" />
              Commit
            </button>
          </div>

          {/* File changes */}
          <div className="py-1">
            {(status.modified?.length ?? 0) > 0 && (
              <div>
                <SectionHeader label="Modified" count={status.modified.length} color="text-dalam-git-modified" />
                {status.modified.slice(0, 50).map((f) => (
                  <FileRow key={f} path={f} action="modified" icon={<FileCode className="w-3 h-3 text-dalam-git-modified" />} />
                ))}
              </div>
            )}
            {(status.added?.length ?? 0) > 0 && (
              <div>
                <SectionHeader label="Added" count={status.added.length} color="text-dalam-git-added" />
                {status.added.slice(0, 50).map((f) => (
                  <FileRow key={f} path={f} action="created" icon={<Plus className="w-3 h-3 text-dalam-git-added" />} />
                ))}
              </div>
            )}
            {(status.deleted?.length ?? 0) > 0 && (
              <div>
                <SectionHeader label="Deleted" count={status.deleted.length} color="text-dalam-git-deleted" />
                {status.deleted.slice(0, 50).map((f) => (
                  <FileRow key={f} path={f} action="deleted" icon={<X className="w-3 h-3 text-dalam-git-deleted" />} />
                ))}
              </div>
            )}
            {(status.untracked?.length ?? 0) > 0 && (
              <div>
                <SectionHeader label="Untracked" count={status.untracked.length} color="text-dalam-text-muted" />
                {status.untracked.slice(0, 50).map((f) => (
                  <FileRow key={f} path={f} action="created" icon={<Plus className="w-3 h-3 text-dalam-text-muted" />} />
                ))}
              </div>
            )}
          </div>
        </>
      ) : (
        <div className="flex-1 flex items-center justify-center p-8">
          <div className="text-center">
            <Check className="w-8 h-8 mx-auto mb-3 text-dalam-git-added" />
            <p className="text-sm text-dalam-text-muted">No changes</p>
            <p className="text-xs text-dalam-text-muted/60 mt-1">Working tree is clean</p>
          </div>
        </div>
      )}
    </div>
  );
}

function SectionHeader({ label, count, color }: { label: string; count: number; color: string }) {
  return (
    <div className="flex items-center gap-1.5 px-3 py-1.5 text-[10px] uppercase tracking-wider text-dalam-text-muted">
      <span className={color}>{count}</span>
      <span>{label}</span>
    </div>
  );
}

function FileRow({ path, icon, action = "modified" }: { path: string; icon: React.ReactNode; action?: "created" | "modified" | "deleted" | "renamed" }) {
  const openDiff = useDiffView((s) => s.openFile);
  const fileName = path.split("/").pop() ?? path;
  const dir = path.split("/").slice(0, -1).join("/");
  const handleOpenDiff = (e: React.MouseEvent) => {
    e.stopPropagation();
    openDiff({ path, action, additions: 0, deletions: 0 });
  };
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 hover:bg-dalam-bg-hover transition-colors group" onClick={handleOpenDiff}>
      <span className="flex-shrink-0">{icon}</span>
      <div className="flex-1 min-w-0">
        <div className="text-xs text-dalam-text-primary truncate">{fileName}</div>
        {dir && <div className="text-[9px] text-dalam-text-muted/60 truncate">{dir}</div>}
      </div>
      <button className="opacity-0 group-hover:opacity-100 transition-opacity btn-icon text-dalam-text-muted hover:text-dalam-text-primary" title="Open diff" onClick={handleOpenDiff}><Eye className="w-3 h-3" /></button>
    </div>
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
    // eslint-disable-next-line react-hooks/set-state-in-effect
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
          <Globe className="w-8 h-8 mx-auto mb-3 text-dalam-text-muted/50" />
          <p className="text-sm text-dalam-text-muted">No browser tabs</p>
          <button
            className="mt-3 flex items-center gap-1.5 px-3 py-1.5 bg-dalam-accent-primary hover:bg-dalam-accent-hover text-white text-xs rounded-md transition-colors mx-auto"
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
      <div className="flex items-center bg-dalam-bg-tertiary border-b border-dalam-border-primary overflow-x-auto flex-shrink-0 scrollbar-thin">
        {browserTabs.map((t) => (
          <div
            key={t.id}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 border-r border-dalam-border-primary cursor-pointer transition-colors text-xs ${
              t.id === activeBrowserTabId
                ? "bg-dalam-bg-primary text-dalam-text-primary"
                : "bg-dalam-bg-tertiary text-dalam-text-muted hover:bg-dalam-bg-hover"
            }`}
            onClick={() => setActiveBrowserTab(t.id)}
          >
            <Globe className="w-3 h-3 flex-shrink-0" />
            <span className="truncate max-w-[100px]">{t.title}</span>
            <button
              className="ml-1 rounded p-0.5 opacity-0 hover:opacity-100 hover:bg-dalam-bg-active transition-opacity"
              onClick={(e) => { e.stopPropagation(); removeBrowserTab(t.id); }}
            >
              <X className="w-2.5 h-2.5" />
            </button>
          </div>
        ))}
        <button className="px-2 h-full text-dalam-text-muted hover:text-dalam-text-primary hover:bg-dalam-bg-hover transition-colors flex-shrink-0" onClick={() => addBrowserTab()}>
          <Plus className="w-3 h-3" />
        </button>
      </div>

      {/* URL bar */}
      <form onSubmit={onNavigate} className="flex items-center gap-1.5 px-2 py-1.5 border-b border-dalam-border-primary bg-dalam-bg-tertiary/50 flex-shrink-0">
        <button type="button" className="btn-icon" disabled={!activeTab || activeTab.historyIdx <= 0} onClick={() => activeTab && goBackBrowser(activeTab.id)} title="Back"><ArrowLeft className="w-3 h-3" /></button>
        <button type="button" className="btn-icon" disabled={!activeTab || activeTab.historyIdx >= activeTab.history.length - 1} onClick={() => activeTab && goForwardBrowser(activeTab.id)} title="Forward"><ArrowRight className="w-3 h-3" /></button>
        <button type="button" className="btn-icon" onClick={() => activeTab && refreshBrowser(activeTab.id)} title="Refresh"><RefreshCw className="w-3 h-3" /></button>
        <input
          className="flex-1 bg-dalam-bg-tertiary border border-dalam-border-primary rounded-md px-2.5 py-1 text-xs text-dalam-text-primary placeholder-dalam-text-muted outline-none focus:border-dalam-accent-primary transition-colors"
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
              sandbox="allow-same-origin allow-scripts allow-popups"
              onLoad={(e) => {
                const currentTab = useUI.getState().browserTabs.find((t) => t.id === activeTab.id);
                if (!currentTab || !currentTab.loading) return;
                const iframe = e.target as HTMLIFrameElement;
                let pageTitle = currentTab.title;
                try { pageTitle = iframe.contentDocument?.title || pageTitle; } catch { /* cross-origin */ }
                useUI.getState().updateBrowserTab(currentTab.id, {
                  loading: false,
                  ...(pageTitle !== currentTab.title ? { title: pageTitle } : {}),
                });
              }}
            />
            {activeTab.loading && (
              <div className="absolute inset-0 bg-dalam-bg-primary/50 flex items-center justify-center backdrop-blur-[1px]">
                <Loader2 className="w-6 h-6 text-dalam-accent-primary animate-spin" />
              </div>
            )}
          </>
        ) : (
          <div className="w-full h-full flex items-center justify-center p-8 bg-dalam-bg-primary">
            <div className="text-center">
              <Globe className="w-10 h-10 mx-auto mb-3 text-dalam-text-muted/40" />
              <p className="text-sm text-dalam-text-muted">Enter a URL to browse</p>
              <p className="text-xs text-dalam-text-muted/60 mt-1">Built-in web browser</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}