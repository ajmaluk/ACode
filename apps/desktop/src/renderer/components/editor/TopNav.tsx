import { useState, useEffect, useRef } from "react";
import { useUI, useChat, useWorkspace, useSettingsView, useSettings, useTerminal } from "@/store/useAppStore";
import { useToasts } from "@/components/ui/toastStore";
import { Tooltip } from "@/components/ui/Tooltip";
import { modKey } from "@/lib/platform";
import { createDalamAPI } from "@/lib/dalamAPI";
import {
  ChevronLeft, ChevronRight, PanelRight,
  FolderOpen, Code2, Sparkles, TerminalSquare, FolderTree, Settings,
  Brain, Sun, Moon, Monitor,
} from "lucide-react";



export function TopNav() {
  const { sidebarOpen, rightPanelOpen, toggleRightPanel } = useUI();
  const { goBackChat, goForwardChat, chatHistory, chatHistoryIdx, messages, session } = useChat();
  const { activeWorkspaceId, workspaces, openWorkspace } = useWorkspace();
  const activeWorkspace = workspaces.find((w) => w.id === activeWorkspaceId) ?? null;
  const { open: openSettings } = useSettingsView();
  const { settings, update: updateSetting } = useSettings();

  const toast = useToasts((s) => s.push);
  const mod = modKey();

  const activeSessionId = useChat((s) => s.activeSessionId);
  const summaries = useChat((s) => s.compactionSummaries);
  const isCompacted = !!(activeSessionId && summaries[activeSessionId]);
  const [memoryActive, setMemoryActive] = useState(false);

  useEffect(() => {
    if (!activeWorkspace) return;
    let active = true;
    void (async () => {
      try {
        const { exists } = await import("@tauri-apps/plugin-fs");
        const { joinPath } = await import("@/lib/pathUtils");
        const hasMemory = await exists(joinPath(activeWorkspace.path, ".dalam/memory.json"));
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

  const openInApp = async (app: "vscode" | "qoder" | "terminal" | "finder") => {
    setFilePickerOpen(false);
    const path = activeWorkspace?.path;
    if (!path) return;
    try {
      const api = createDalamAPI();
      if (app === "finder") {
        await api.system.revealInFinder(path);
      } else if (app === "terminal") {
        if (session?.workspacePath) {
          useTerminal.getState().ensureTabForCwd(session.workspacePath);
        }
        useUI.getState().setRightPanelTab("terminal");
        useUI.getState().setRightPanelOpen(true);
      } else {
        const appName = app === "vscode" ? "code" : "qoder";
        await api.system.launchApp(appName, [path]);
      }
    } catch (err) {
      toast({ kind: "error", title: `Failed to open in ${app}`, description: (err as Error)?.message ?? String(err) });
    }
  };

  return (
    <div className="h-9 flex items-center bg-dalam-bg-secondary flex-shrink-0 select-none">
      {/* Left section: back, forward */}
      <div className="flex items-center gap-0.5 px-1.5">
        <Tooltip content={`Back (${mod}[)`} side="bottom">
          <button
            className="w-7 h-7 flex items-center justify-center rounded-md text-dalam-text-secondary hover:bg-dalam-bg-hover disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            onClick={() => goBackChat()}
            disabled={!canGoBack}
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
        </Tooltip>
        <Tooltip content={`Forward (${mod}])`} side="bottom">
          <button
            className="w-7 h-7 flex items-center justify-center rounded-md text-dalam-text-secondary hover:bg-dalam-bg-hover disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            onClick={() => goForwardChat()}
            disabled={!canGoForward}
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </Tooltip>
      </div>

      {/* Center: working directory (only when a workspace is selected) */}
      <div className="flex-1 min-w-0 flex items-center justify-center px-3 gap-2">
        {activeWorkspace ? (
          <div className="flex items-center gap-2">
            <div className="relative" ref={filePickerRef}>
              <Tooltip content={inChat ? "Open working directory in…" : "Open a different folder"} side="bottom">
                <button
                  onClick={() => {
                    // Only show the "open in" dropdown when in an active chat.
                    if (inChat) setFilePickerOpen((v) => !v);
                    else void openWorkspace();
                  }}
                  className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs text-dalam-text-secondary hover:text-dalam-text-primary hover:bg-dalam-bg-hover transition-colors max-w-[400px]"
                >
                  <FolderOpen className="w-3.5 h-3.5 text-dalam-text-muted flex-shrink-0" />
                  <span className="font-medium truncate">{activeWorkspace.name}</span>
                  <span className="text-dalam-text-muted truncate text-[10px]">· {activeWorkspace.path}</span>
                  {inChat && <ChevronRight className="w-3 h-3 text-dalam-text-muted rotate-90 flex-shrink-0" />}
                </button>
              </Tooltip>

            {filePickerOpen && (
              <div className="absolute left-1/2 -translate-x-1/2 top-full mt-1 w-60 bg-dalam-bg-secondary border border-dalam-border-primary rounded-lg shadow-2xl z-50 overflow-hidden">
                <div className="px-2 py-1.5 text-[10px] uppercase tracking-wider text-dalam-text-muted border-b border-dalam-border-primary">Open with</div>
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
                      className="w-full text-left px-3 py-2 flex items-center gap-2 hover:bg-dalam-bg-hover transition-colors"
                    >
                      <Icon className={`w-3.5 h-3.5 ${app.color} flex-shrink-0`} />
                      <div className="flex-1 min-w-0">
                        <div className="text-xs text-dalam-text-primary font-medium">{app.label}</div>
                        <div className="text-[10px] text-dalam-text-muted truncate">{app.desc}</div>
                      </div>
                    </button>
                  );
                })}
                <div className="border-t border-dalam-border-primary">
                  <button
                    onClick={() => { setFilePickerOpen(false); void openWorkspace(); }}
                    className="w-full text-left px-3 py-2 flex items-center gap-2 hover:bg-dalam-bg-hover transition-colors"
                  >
                    <FolderOpen className="w-3.5 h-3.5 text-dalam-text-muted flex-shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="text-xs text-dalam-text-primary font-medium">Open different folder…</div>
                      <div className="text-[10px] text-dalam-text-muted">Pick another directory</div>
                    </div>
                  </button>
                </div>
              </div>
            )}
            </div>

            {memoryActive && (
              <span title="Workspace Memory Active: Agent is aware of .dalam/memory.json" className="flex items-center flex-shrink-0">
                <Brain className="w-3.5 h-3.5 text-dalam-accent-primary animate-pulse-soft" />
              </span>
            )}

            {isCompacted && (
              <span className="flex items-center gap-1.5 px-2 py-0.5 text-[9px] font-semibold bg-dalam-accent-subtle text-dalam-accent-primary rounded-full uppercase tracking-wider animate-pulse-soft flex-shrink-0" title="This conversation's history has been compacted to fit the context window.">
                Compacted
              </span>
            )}
          </div>
        ) : (
          <Tooltip content="Open a folder to start working" side="bottom">
            <button
              onClick={() => void openWorkspace()}
              className="flex items-center gap-1.5 px-3 py-1 rounded-md text-xs text-dalam-text-muted hover:text-dalam-text-primary hover:bg-dalam-bg-hover transition-colors"
            >
              <FolderOpen className="w-3.5 h-3.5 text-amber-400/80" />
              <span>Open a folder to begin</span>
            </button>
          </Tooltip>
        )}
      </div>

      {/* Right section: agent, theme, terminal, settings, right panel toggle */}
      <div className="flex items-center gap-0.5 px-1.5">

        {/* Theme switcher */}
        <Tooltip content={`Theme: ${settings.theme}`} side="bottom">
          <button
            className="btn-icon"
            aria-label="Toggle theme"
            onClick={() => {
              const next = settings.theme === "dark" ? "light" : settings.theme === "light" ? "system" : "dark";
              void updateSetting("theme", next);
            }}
          >
            {settings.theme === "dark" ? <Moon className="w-4 h-4" /> :
             settings.theme === "light" ? <Sun className="w-4 h-4" /> :
             <Monitor className="w-4 h-4" />}
          </button>
        </Tooltip>

        {session && session.workspacePath && (
          <Tooltip content="Open terminal" side="bottom">
            <button
              className="w-7 h-7 flex items-center justify-center rounded-md text-dalam-text-secondary hover:text-dalam-text-primary hover:bg-dalam-bg-hover transition-colors"
              onClick={() => {
                if (session.workspacePath) {
                  useTerminal.getState().ensureTabForCwd(session.workspacePath);
                }
                useUI.getState().setRightPanelTab("terminal");
                useUI.getState().setRightPanelOpen(true);
              }}
            >
              <TerminalSquare className="w-3.5 h-3.5" />
            </button>
          </Tooltip>
        )}
        <Tooltip content={`Settings (${mod},)`} side="bottom">
          <button
            className="w-7 h-7 flex items-center justify-center rounded-md text-dalam-text-secondary hover:bg-dalam-bg-hover transition-colors"
            onClick={() => openSettings()}
          >
            <Settings className="w-4 h-4" />
          </button>
        </Tooltip>
        <Tooltip content={rightPanelOpen ? `Hide right panel (${mod}\\)` : `Show right panel (${mod}\\)`} side="bottom">
          <button
            className={`w-7 h-7 flex items-center justify-center rounded-md transition-colors ${
              rightPanelOpen
                ? "text-dalam-text-secondary hover:bg-dalam-bg-hover"
                : "text-dalam-accent-primary bg-dalam-accent-subtle hover:bg-dalam-bg-hover"
            }`}
            onClick={toggleRightPanel}
          >
            <PanelRight className="w-3.5 h-3.5" />
          </button>
        </Tooltip>
      </div>
    </div>
  );
}
