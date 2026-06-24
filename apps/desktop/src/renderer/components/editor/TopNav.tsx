import { useState, useEffect, useRef } from "react";
import { useUI, useChat, useWorkspace, useSettingsView } from "@/store/useAppStore";
import { useToasts } from "@/components/ui/Toaster";
import {
  ChevronLeft, ChevronRight, Plus, PanelLeft, PanelRight,
  FolderOpen, Code2, Sparkles, TerminalSquare, FolderTree, Settings,
  Brain,
} from "lucide-react";

export function TopNav() {
  const { sidebarOpen, toggleSidebar, rightPanelOpen, toggleRightPanel } = useUI();
  const { goBackChat, goForwardChat, newChat, chatHistory, chatHistoryIdx, messages } = useChat();
  const { activeWorkspaceId, workspaces, openWorkspace } = useWorkspace();
  const activeWorkspace = workspaces.find((w) => w.id === activeWorkspaceId) ?? null;
  const { open: openSettings } = useSettingsView();
  const toast = useToasts((s) => s.push);

  const activeSessionId = useChat((s) => s.activeSessionId);
  const summaries = useChat((s) => s.compactionSummaries);
  const isCompacted = !!(activeSessionId && summaries[activeSessionId]);
  const [memoryActive, setMemoryActive] = useState(false);

  useEffect(() => {
    if (!activeWorkspace) {
      setMemoryActive(false);
      return;
    }
    let active = true;
    void (async () => {
      try {
        const { exists } = await import("@tauri-apps/plugin-fs");
        const { joinPath } = await import("@/lib/pathUtils");
        const hasMemory = await exists(joinPath(activeWorkspace.path, ".acode/memory.json"));
        if (active) setMemoryActive(hasMemory);
      } catch {
        if (active) setMemoryActive(false);
      }
    })();
    return () => { active = false; };
  }, [activeWorkspace?.path]);

  // Only show file/terminal actions when the user is in an active chat
  // (i.e. not on the default empty screen).
  const inChat = messages.length > 0 || chatHistoryIdx >= 0;

  const canGoBack = chatHistoryIdx >= 0 || chatHistory.length > 0;
  const canGoForward = chatHistoryIdx >= 0 && chatHistoryIdx < chatHistory.length - 1;

  const [filePickerOpen, setFilePickerOpen] = useState(false);
  const filePickerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!filePickerOpen) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (filePickerRef.current && !filePickerRef.current.contains(target)) setFilePickerOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [filePickerOpen]);

  const openInApp = (app: "vscode" | "qoder" | "terminal" | "finder") => {
    setFilePickerOpen(false);
    const path = activeWorkspace?.path;
    const appName = app === "vscode" ? "VS Code" : app === "qoder" ? "Qoder" : app === "terminal" ? "Terminal" : "Finder";
    toast({ kind: "info", title: `Open in ${appName}`, description: path ?? "No workspace selected" });
  };

  return (
    <div className="h-9 flex items-center bg-acode-bg-secondary border-b border-acode-border-primary flex-shrink-0 select-none">
      {/* Left section: sidebar toggle, back, forward, new task */}
      <div className="flex items-center gap-0.5 px-1.5">
        <button
          className={`w-7 h-7 flex items-center justify-center rounded-md transition-colors ${
            sidebarOpen
              ? "text-acode-text-secondary hover:bg-acode-bg-hover"
              : "text-acode-accent-primary bg-acode-accent-subtle hover:bg-acode-bg-hover"
          }`}
          title={sidebarOpen ? "Hide sidebar (⌘B)" : "Show sidebar (⌘B)"}
          onClick={toggleSidebar}
        >
          <PanelLeft className="w-3.5 h-3.5" />
        </button>
        <button
          className="w-7 h-7 flex items-center justify-center rounded-md text-acode-text-secondary hover:bg-acode-bg-hover disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          title="Back (⌘[)"
          onClick={() => goBackChat()}
          disabled={!canGoBack}
        >
          <ChevronLeft className="w-4 h-4" />
        </button>
        <button
          className="w-7 h-7 flex items-center justify-center rounded-md text-acode-text-secondary hover:bg-acode-bg-hover disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          title="Forward (⌘])"
          onClick={() => goForwardChat()}
          disabled={!canGoForward}
        >
          <ChevronRight className="w-4 h-4" />
        </button>
        <button
          className="w-7 h-7 flex items-center justify-center rounded-full border border-acode-border-secondary text-acode-text-secondary hover:bg-acode-bg-hover hover:text-acode-text-primary transition-colors"
          title="New task (⌘N)"
          onClick={() => newChat()}
        >
          <Plus className="w-4 h-4" />
        </button>
      </div>

      {/* Center: working directory (only when a workspace is selected) */}
      <div className="flex-1 min-w-0 flex items-center justify-center px-3 gap-2">
        {activeWorkspace ? (
          <div className="flex items-center gap-2">
            <div className="relative" ref={filePickerRef}>
              <button
                onClick={() => {
                  // Only show the "open in" dropdown when in an active chat.
                  if (inChat) setFilePickerOpen((v) => !v);
                  else void openWorkspace();
                }}
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs text-acode-text-secondary hover:text-acode-text-primary hover:bg-acode-bg-hover transition-colors max-w-[400px]"
                title={inChat ? "Open working directory in…" : "Open a different folder"}
              >
                <FolderOpen className="w-3.5 h-3.5 text-acode-text-muted flex-shrink-0" />
                <span className="font-medium truncate">{activeWorkspace.name}</span>
                <span className="text-acode-text-muted truncate text-[10px]">· {activeWorkspace.path}</span>
                {inChat && <ChevronRight className="w-3 h-3 text-acode-text-muted rotate-90 flex-shrink-0" />}
              </button>

            {filePickerOpen && (
              <div className="absolute left-1/2 -translate-x-1/2 top-full mt-1 w-60 bg-acode-bg-secondary border border-acode-border-primary rounded-lg shadow-2xl z-50 overflow-hidden">
                <div className="px-2 py-1.5 text-[10px] uppercase tracking-wider text-acode-text-muted border-b border-acode-border-primary">Open with</div>
                {([
                  { id: "vscode", label: "VS Code", desc: "Open in Visual Studio Code", icon: Code2, color: "text-blue-400" },
                  { id: "qoder", label: "Qoder", desc: "Open in Qoder IDE", icon: Sparkles, color: "text-emerald-400" },
                  { id: "terminal", label: "Terminal", desc: "Open in integrated terminal", icon: TerminalSquare, color: "text-amber-400" },
                  { id: "finder", label: "File manager", desc: "Reveal in file manager", icon: FolderTree, color: "text-sky-400" },
                ] as const).map((app) => {
                  const Icon = app.icon;
                  return (
                    <button
                      key={app.id}
                      onClick={() => openInApp(app.id)}
                      className="w-full text-left px-3 py-2 flex items-center gap-2 hover:bg-acode-bg-hover transition-colors"
                    >
                      <Icon className={`w-3.5 h-3.5 ${app.color} flex-shrink-0`} />
                      <div className="flex-1 min-w-0">
                        <div className="text-xs text-acode-text-primary font-medium">{app.label}</div>
                        <div className="text-[10px] text-acode-text-muted truncate">{app.desc}</div>
                      </div>
                    </button>
                  );
                })}
                <div className="border-t border-acode-border-primary">
                  <button
                    onClick={() => { setFilePickerOpen(false); void openWorkspace(); }}
                    className="w-full text-left px-3 py-2 flex items-center gap-2 hover:bg-acode-bg-hover transition-colors"
                  >
                    <FolderOpen className="w-3.5 h-3.5 text-acode-text-muted flex-shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="text-xs text-acode-text-primary font-medium">Open different folder…</div>
                      <div className="text-[10px] text-acode-text-muted">Pick another directory</div>
                    </div>
                  </button>
                </div>
              </div>
            )}
            </div>

            {memoryActive && (
              <span title="Workspace Memory Active: Agent is aware of .acode/memory.json" className="flex items-center flex-shrink-0">
                <Brain className="w-3.5 h-3.5 text-acode-accent-primary animate-pulse-soft" />
              </span>
            )}

            {isCompacted && (
              <span className="flex items-center gap-1.5 px-2 py-0.5 text-[9px] font-semibold bg-acode-accent-subtle text-acode-accent-primary rounded-full uppercase tracking-wider animate-pulse-soft flex-shrink-0" title="This conversation's history has been compacted to fit the context window.">
                Compacted
              </span>
            )}
          </div>
        ) : (
          <button
            onClick={() => void openWorkspace()}
            className="flex items-center gap-1.5 px-3 py-1 rounded-md text-xs text-acode-text-muted hover:text-acode-text-primary hover:bg-acode-bg-hover transition-colors"
            title="Open a folder to start working"
          >
            <FolderOpen className="w-3.5 h-3.5 text-amber-400/80" />
            <span>Open a folder to begin</span>
          </button>
        )}
      </div>

      {/* Right section: terminal, settings, right panel toggle */}
      <div className="flex items-center gap-0.5 px-1.5">
        {inChat && activeWorkspace && (
          <button
            className="w-7 h-7 flex items-center justify-center rounded-md text-acode-text-secondary hover:text-acode-text-primary hover:bg-acode-bg-hover transition-colors"
            title="Open terminal"
            onClick={() => {
              useUI.getState().setRightPanelTab("terminal");
              useUI.getState().setRightPanelOpen(true);
            }}
          >
            <TerminalSquare className="w-3.5 h-3.5" />
          </button>
        )}
        <button
          className="w-7 h-7 flex items-center justify-center rounded-md text-acode-text-secondary hover:bg-acode-bg-hover transition-colors"
          title="Settings (⌘,)"
          onClick={() => openSettings()}
        >
          <Settings className="w-4 h-4" />
        </button>
        <button
          className={`w-7 h-7 flex items-center justify-center rounded-md transition-colors ${
            rightPanelOpen
              ? "text-acode-text-secondary hover:bg-acode-bg-hover"
              : "text-acode-accent-primary bg-acode-accent-subtle hover:bg-acode-bg-hover"
          }`}
          title={rightPanelOpen ? "Hide right panel (⌘\\)" : "Show right panel (⌘\\)"}
          onClick={toggleRightPanel}
        >
          <PanelRight className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}
