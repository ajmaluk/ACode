import { useEffect, useRef, useState } from "react";
import {
  useUI,
  useChat,
  useWorkspace,
  useSettingsView,
  useSettings,
  useTerminal,
  useCommandPalette,
  useShortcuts,
} from "@/store/useAppStore";
import { useToasts } from "@/components/ui/toastStore";
import { Tooltip } from "@/components/ui/Tooltip";
import { modKey, platform, shortcut } from "@/lib/platform";
import { createDalamAPI } from "@/lib/dalamAPI";
import { joinPath } from "@/lib/pathUtils";
import {
  ChevronLeft,
  ChevronRight,
  PanelLeft,
  PanelRight,
  FolderOpen,
  Code2,
  TerminalSquare,
  FolderTree,
  Settings,
  Brain,
  Sun,
  Moon,
  Monitor,
  MessageSquare,
  MonitorDot,
} from "lucide-react";

type MenuAction =
  | {
      type: "item";
      label: string;
      shortcut?: string;
      perform: () => void;
      disabled?: boolean;
    }
  | { type: "separator" };

function useEditorMenus(): { label: string; items: MenuAction[] }[] {
  const { settings, update: updateSetting } = useSettings();
  const { open: openSettings } = useSettingsView();
  const {
    activeWorkspaceId,
    workspaces,
    openWorkspace,
    openFile,
    closeTab,
    markSaved,
  } = useWorkspace();
  const { toggleRightPanel, setViewMode } = useUI();
  const toast = useToasts((s) => s.push);
  const ws = workspaces.find((w) => w.id === activeWorkspaceId);

  const saveFile = async () => {
    const { activeFilePath, openTabs } = useWorkspace.getState();
    const tab = openTabs.find((t) => t.path === activeFilePath);
    if (!tab) return;
    try {
      const api = createDalamAPI();
      await api.fs.writeFile(tab.path, tab.content);
      markSaved(tab.path);
      toast({ kind: "success", title: "File saved", description: tab.name });
    } catch (err) {
      toast({
        kind: "error",
        title: "Save failed",
        description: (err as Error)?.message ?? "Unknown error",
      });
    }
  };

  const saveAllFiles = async () => {
    const { openTabs } = useWorkspace.getState();
    const dirty = openTabs.filter((t) => t.dirty);
    if (dirty.length === 0) return;
    try {
      const api = createDalamAPI();
      for (const tab of dirty) {
        await api.fs.writeFile(tab.path, tab.content);
        markSaved(tab.path);
      }
      toast({
        kind: "success",
        title: "All files saved",
        description: `${dirty.length} file(s)`,
      });
    } catch (err) {
      toast({
        kind: "error",
        title: "Save all failed",
        description: (err as Error)?.message ?? "Unknown error",
      });
    }
  };

  const closeAllTabs = () => {
    const { openTabs } = useWorkspace.getState();
    for (const tab of openTabs) closeTab(tab.path);
  };

  const closeOtherTabs = () => {
    const { openTabs, activeFilePath } = useWorkspace.getState();
    for (const tab of openTabs) {
      if (tab.path !== activeFilePath) closeTab(tab.path);
    }
  };

  const toggleTerminal = () => {
    const ui = useUI.getState();
    // Switch to editor mode first (terminal only visible in editor mode)
    if (ui.viewMode !== "editor") {
      ui.setViewMode("editor");
    }
    const session = useChat.getState().session;
    if (session?.workspacePath) {
      useTerminal.getState().ensureTabForCwd(session.workspacePath);
    }
    ui.setBottomPanelTab("terminal");
    ui.setBottomPanelOpen(true);
  };

  const toggleWordWrap = () => {
    void updateSetting("wordWrap", !settings.wordWrap);
  };

  return [
    {
      label: "File",
      items: [
        {
          type: "item",
          label: "New File",
          shortcut: shortcut("N"),
          perform: () => {
            if (ws) void openFile(ws.path + "/untitled");
          },
        },
        {
          type: "item",
          label: "Open File…",
          shortcut: shortcut("O"),
          perform: () => void openWorkspace(),
        },
        { type: "separator" },
        {
          type: "item",
          label: "Save",
          shortcut: shortcut("S"),
          perform: () => void saveFile(),
        },
        {
          type: "item",
          label: "Save All",
          shortcut: shortcut("S", { shift: true }),
          perform: () => void saveAllFiles(),
        },
        { type: "separator" },
        {
          type: "item",
          label: "Close Tab",
          shortcut: shortcut("W"),
          perform: () => {
            const { activeFilePath } = useWorkspace.getState();
            if (activeFilePath) closeTab(activeFilePath);
          },
        },
        {
          type: "item",
          label: "Close All",
          shortcut: `${modKey()} K W`,
          perform: closeAllTabs,
        },
        { type: "item", label: "Close Others", perform: closeOtherTabs },
        { type: "separator" },
        {
          type: "item",
          label: "Preferences",
          shortcut: `${modKey()},`,
          perform: () => openSettings(),
        },
      ],
    },
    {
      label: "Edit",
      items: [
        {
          type: "item",
          label: "Undo",
          shortcut: shortcut("Z"),
          perform: () =>
            window.dispatchEvent(
              new KeyboardEvent("keydown", {
                key: "z",
                ctrlKey: platform() !== "mac",
                metaKey: platform() === "mac",
              }),
            ),
        },
        {
          type: "item",
          label: "Redo",
          shortcut: shortcut("Z", { shift: true }),
          perform: () =>
            window.dispatchEvent(
              new KeyboardEvent("keydown", {
                key: "z",
                ctrlKey: platform() !== "mac",
                metaKey: platform() === "mac",
                shiftKey: true,
              }),
            ),
        },
        { type: "separator" },
        {
          type: "item",
          label: "Find",
          shortcut: shortcut("F"),
          perform: () => window.dispatchEvent(new CustomEvent("editor:find")),
        },
        {
          type: "item",
          label: "Replace",
          shortcut: shortcut("F", { alt: true }),
          perform: () =>
            window.dispatchEvent(new CustomEvent("editor:find-replace")),
        },
        { type: "separator" },
        {
          type: "item",
          label: "Toggle Comment",
          shortcut: `${modKey()}/`,
          perform: () =>
            window.dispatchEvent(new CustomEvent("editor:toggle-comment")),
        },
      ],
    },
    {
      label: "View",
      items: [
        {
          type: "item",
          label: "Toggle Right Panel",
          shortcut: `${modKey()}\\`,
          perform: toggleRightPanel,
        },
        { type: "separator" },
        {
          type: "item",
          label: "Toggle Word Wrap",
          shortcut: shortcut("Z", { alt: true }),
          perform: toggleWordWrap,
        },
        { type: "separator" },
        {
          type: "item",
          label: "Zoom In",
          shortcut: `${modKey()}+`,
          perform: () => {
            void updateSetting(
              "codeFontSize",
              Math.min((settings.codeFontSize ?? 14) + 1, 32),
            );
          },
        },
        {
          type: "item",
          label: "Zoom Out",
          shortcut: `${modKey()}-`,
          perform: () => {
            void updateSetting(
              "codeFontSize",
              Math.max((settings.codeFontSize ?? 14) - 1, 8),
            );
          },
        },
        { type: "separator" },
        {
          type: "item",
          label: "Agent Mode",
          shortcut: shortcut("E"),
          perform: () => setViewMode("chat"),
        },
        {
          type: "item",
          label: "Editor Mode",
          shortcut: shortcut("E", { shift: true }),
          perform: () => setViewMode("editor"),
        },
      ],
    },
    {
      label: "Go",
      items: [
        {
          type: "item",
          label: "Quick Open",
          shortcut: shortcut("P"),
          perform: () =>
            window.dispatchEvent(new CustomEvent("editor:quick-open")),
        },
        {
          type: "item",
          label: "Go to Line…",
          shortcut: shortcut("G"),
          perform: () =>
            window.dispatchEvent(new CustomEvent("editor:go-to-line")),
        },
        { type: "separator" },
        {
          type: "item",
          label: "Back",
          shortcut: `${modKey()}[`,
          perform: () => useChat.getState().goBackChat(),
        },
        {
          type: "item",
          label: "Forward",
          shortcut: `${modKey()}]`,
          perform: () => useChat.getState().goForwardChat(),
        },
      ],
    },
    {
      label: "Terminal",
      items: [
        {
          type: "item",
          label: "New Terminal",
          shortcut: `${modKey()}\``,
          perform: toggleTerminal,
        },
        {
          type: "item",
          label: "Toggle Terminal",
          shortcut: shortcut("J"),
          perform: toggleTerminal,
        },
      ],
    },
    {
      label: "Help",
      items: [
        {
          type: "item",
          label: "Keyboard Shortcuts",
          shortcut: "?",
          perform: () => useShortcuts.getState().toggle(),
        },
        {
          type: "item",
          label: "Command Palette",
          shortcut: shortcut("K"),
          perform: () => useCommandPalette.getState().toggle(),
        },
        { type: "separator" },
        {
          type: "item",
          label: "Open Settings",
          shortcut: `${modKey()},`,
          perform: () => openSettings(),
        },
      ],
    },
  ];
}

export function TitleBar() {
  const menus = useEditorMenus();
  const [openIdx, setOpenIdx] = useState<number | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const isMac = platform() === "mac";

  const {
    rightPanelOpen,
    toggleRightPanel,
    viewMode,
    setViewMode,
    sidebarOpen,
    toggleSidebar,
  } = useUI();
  const {
    goBackChat,
    goForwardChat,
    chatHistory,
    chatHistoryIdx,
    messages,
    session,
  } = useChat();
  const { activeWorkspaceId, workspaces, openWorkspace } = useWorkspace();
  const activeWorkspace =
    workspaces.find((w) => w.id === activeWorkspaceId) ?? null;
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

        const hasMemory = await exists(
          joinPath(activeWorkspace.path, ".dalam/memory.json"),
        );
        if (active) setMemoryActive(hasMemory);
      } catch (e) {
        if (import.meta.env.DEV) console.warn("[TitleBar] Failed to check memory.json exists:", e);
        if (active) setMemoryActive(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [activeWorkspace]);

  const inChat = messages.length > 0 || chatHistoryIdx >= 0;
  const canGoBack = chatHistoryIdx >= 0 || chatHistory.length > 0;
  const canGoForward =
    chatHistoryIdx >= 0 && chatHistoryIdx < chatHistory.length - 1;

  const [filePickerOpen, setFilePickerOpen] = useState(false);
  const filePickerRef = useRef<HTMLDivElement>(null);
  const [detectedIdes, setDetectedIdes] = useState<
    { name: string; command: string; kind: string }[]
  >([]);
  const [idesLoading, setIdesLoading] = useState(false);

  useEffect(() => {
    if (!filePickerOpen) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (filePickerRef.current && !filePickerRef.current.contains(target))
        setFilePickerOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [filePickerOpen]);

  // Fetch installed IDEs when dropdown opens
  useEffect(() => {
    if (!filePickerOpen) return;
    let cancelled = false;
    const fetchIdes = async () => {
      try {
        const api = createDalamAPI();
        const ides = await api.system.detectInstalledIdes();
        if (!cancelled) setDetectedIdes(ides);
      } catch (e) {
        if (import.meta.env.DEV) console.warn("[TitleBar] Failed to detect installed IDEs:", e);
        if (!cancelled) setDetectedIdes([]);
      } finally {
        if (!cancelled) setIdesLoading(false);
      }
    };
    void fetchIdes();
    return () => {
      cancelled = true;
    };
  }, [filePickerOpen]);

  const openInApp = async (app: string) => {
    setFilePickerOpen(false);
    const path = activeWorkspace?.path;
    if (!path) return;
    try {
      const api = createDalamAPI();
      if (app === "finder") {
        await api.system.revealInFinder(path);
      } else if (app === "terminal") {
        const ui = useUI.getState();
        if (ui.viewMode !== "editor") ui.setViewMode("editor");
        if (session?.workspacePath) {
          useTerminal.getState().ensureTabForCwd(session.workspacePath);
        }
        ui.setBottomPanelTab("terminal");
        ui.setBottomPanelOpen(true);
      } else {
        // For any detected IDE command, launch it with the workspace path
        const ide = detectedIdes.find((i) => i.command === app);
        const label = ide?.name ?? app;
        await api.system.launchApp(app, [path]);
        toast({
          kind: "success",
          title: `Opened in ${label}`,
          description: path,
        });
      }
    } catch (err) {
      toast({
        kind: "error",
        title: `Failed to open`,
        description: (err as Error)?.message ?? String(err),
      });
    }
  };

  // Close menu on outside click
  useEffect(() => {
    if (openIdx === null) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpenIdx(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenIdx(null);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [openIdx]);

  return (
    <div
      ref={rootRef}
      className={`flex items-center bg-dalam-bg-secondary border-b border-dalam-border-primary flex-shrink-0 select-none ${
        isMac ? "h-9" : "h-10"
      }`}
    >
      {/* Menu bar — only on Windows/Linux (macOS uses system menu bar) */}
      {!isMac && (
        <div className="flex items-center">
          {menus.map((m, i) => (
            <div key={m.label} className="relative">
              <button
                className={`px-2.5 h-7 text-[11px] text-dalam-text-secondary hover:text-dalam-text-primary hover:bg-dalam-bg-hover transition-colors ${
                  openIdx === i
                    ? "bg-dalam-bg-hover text-dalam-text-primary"
                    : ""
                }`}
                onClick={() => setOpenIdx(openIdx === i ? null : i)}
                onMouseEnter={() => openIdx !== null && setOpenIdx(i)}
                aria-expanded={openIdx === i}
                aria-haspopup="menu"
              >
                {m.label}
              </button>
              {openIdx === i && (
                <MenuPanel items={m.items} onClose={() => setOpenIdx(null)} />
              )}
            </div>
          ))}
        </div>
      )}

      {/* Left controls: Sidebar toggle + Back/Forward */}
      <div className="flex items-center gap-0.5 px-1.5">
        <Tooltip
          content={
            sidebarOpen ? `Hide sidebar (${mod}B)` : `Show sidebar (${mod}B)`
          }
          side="bottom"
        >
          <button
            className="w-7 h-7 flex items-center justify-center rounded-md text-dalam-text-secondary hover:text-dalam-text-primary hover:bg-dalam-bg-hover transition-colors"
            onClick={toggleSidebar}
          >
            <PanelLeft className="w-4 h-4" />
          </button>
        </Tooltip>
        <div className="w-px h-4 bg-dalam-border-primary mx-0.5" />
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

        <div className="w-px h-4 bg-dalam-border-primary mx-0.5" />
      </div>

      {/* Workspace name */}
      {activeWorkspace && (
        <div className="relative ml-1" ref={filePickerRef}>
          <Tooltip
            content={
              inChat ? "Open working directory in…" : "Open a different folder"
            }
            side="bottom"
          >
            <button
              onClick={() => {
                if (inChat) {
                  setFilePickerOpen((v) => !v);
                  setIdesLoading(true);
                } else void openWorkspace();
              }}
              className="flex items-center gap-1.5 px-2 py-1 rounded-md text-xs text-dalam-text-secondary hover:text-dalam-text-primary hover:bg-dalam-bg-hover transition-colors max-w-[300px]"
              aria-expanded={filePickerOpen}
              aria-haspopup="menu"
            >
              <FolderOpen className="w-3.5 h-3.5 text-dalam-text-muted flex-shrink-0" />
              <span className="font-medium truncate">
                {activeWorkspace.name}
              </span>
              {inChat && (
                <ChevronRight className="w-3 h-3 text-dalam-text-muted rotate-90 flex-shrink-0" />
              )}
            </button>
          </Tooltip>
          {filePickerOpen && (
            <div
              className="absolute left-1/2 -translate-x-1/2 top-full mt-1 w-64 bg-dalam-bg-secondary border border-dalam-border-primary rounded-lg shadow-2xl z-50 overflow-hidden"
              role="menu"
            >
              <div
                className="px-2 py-1.5 text-[10px] uppercase tracking-wider text-dalam-text-muted border-b border-dalam-border-primary"
                role="none"
              >
                Open with
              </div>
              {/* Always-available options */}
              <button
                onClick={() => openInApp("terminal")}
                role="menuitem"
                className="w-full text-left px-3 py-2 flex items-center gap-2 hover:bg-dalam-bg-hover transition-colors"
              >
                <TerminalSquare className="w-3.5 h-3.5 text-amber-400 flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-xs text-dalam-text-primary font-medium">
                    Terminal
                  </div>
                  <div className="text-[10px] text-dalam-text-muted truncate">
                    Open in integrated terminal
                  </div>
                </div>
              </button>
              <button
                onClick={() => openInApp("finder")}
                role="menuitem"
                className="w-full text-left px-3 py-2 flex items-center gap-2 hover:bg-dalam-bg-hover transition-colors"
              >
                <FolderTree className="w-3.5 h-3.5 text-sky-400 flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-xs text-dalam-text-primary font-medium">
                    File manager
                  </div>
                  <div className="text-[10px] text-dalam-text-muted truncate">
                    Reveal in file manager
                  </div>
                </div>
              </button>
              {/* Dynamically detected IDEs */}
              {detectedIdes.length > 0 && (
                <div className="border-t border-dalam-border-primary">
                  <div
                    className="px-2 py-1 text-[10px] uppercase tracking-wider text-dalam-text-muted"
                    role="none"
                  >
                    Detected editors
                  </div>
                  {detectedIdes.map((ide) => (
                    <button
                      key={ide.command}
                      onClick={() => openInApp(ide.command)}
                      role="menuitem"
                      className="w-full text-left px-3 py-2 flex items-center gap-2 hover:bg-dalam-bg-hover transition-colors"
                    >
                      <MonitorDot className="w-3.5 h-3.5 text-violet-400 flex-shrink-0" />
                      <div className="flex-1 min-w-0">
                        <div className="text-xs text-dalam-text-primary font-medium">
                          {ide.name}
                        </div>
                        <div className="text-[10px] text-dalam-text-muted truncate">
                          {ide.command}
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              )}
              {detectedIdes.length === 0 && !idesLoading && (
                <div
                  className="px-3 py-2 text-[10px] text-dalam-text-muted border-t border-dalam-border-primary"
                  role="none"
                >
                  No additional editors detected
                </div>
              )}
              {idesLoading && (
                <div
                  className="px-3 py-1.5 text-[10px] text-dalam-text-muted border-t border-dalam-border-primary"
                  role="none"
                >
                  Detecting editors…
                </div>
              )}
              <div
                className="border-t border-dalam-border-primary"
                role="separator"
              >
                <button
                  onClick={() => {
                    setFilePickerOpen(false);
                    void openWorkspace();
                  }}
                  role="menuitem"
                  className="w-full text-left px-3 py-2 flex items-center gap-2 hover:bg-dalam-bg-hover transition-colors"
                >
                  <FolderOpen className="w-3.5 h-3.5 text-dalam-text-muted flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-xs text-dalam-text-primary font-medium">
                      Open different folder…
                    </div>
                    <div className="text-[10px] text-dalam-text-muted">
                      Pick another directory
                    </div>
                  </div>
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {memoryActive && (
        <span
          title="Workspace Memory Active"
          className="flex items-center flex-shrink-0 ml-1"
        >
          <Brain className="w-3.5 h-3.5 text-dalam-accent-primary animate-pulse-soft" />
        </span>
      )}

      {isCompacted && (
        <span
          className="flex items-center gap-1.5 px-2 py-0.5 text-[9px] font-semibold bg-dalam-accent-subtle text-dalam-accent-primary rounded-full uppercase tracking-wider animate-pulse-soft flex-shrink-0 ml-1"
          title="Compacted"
        >
          Compacted
        </span>
      )}

      {/* Draggable spacer */}
      <div className="flex-1 h-full" data-tauri-drag-region />

      {/* Right controls */}
      <div className="flex items-center gap-0.5 px-1.5">
        {/* Mode switcher — pill toggle */}
        <div
          className={`relative flex items-center bg-dalam-bg-tertiary rounded-full border border-dalam-border-primary p-0.5 ${!activeWorkspaceId ? "opacity-40" : ""}`}
        >
          <button
            className={`flex items-center gap-1 px-2.5 h-6 text-[11px] font-medium rounded-full transition-all duration-200 disabled:cursor-not-allowed relative z-10 ${
              viewMode === "chat"
                ? "text-white"
                : "text-dalam-text-muted hover:text-dalam-text-primary"
            }`}
            onClick={() => activeWorkspaceId && setViewMode("chat")}
            title={
              !activeWorkspaceId
                ? "Open a folder to switch modes"
                : "Agent mode (Ctrl+E)"
            }
            disabled={!activeWorkspaceId}
          >
            <MessageSquare className="w-3 h-3" />
            <span>Agent</span>
          </button>
          <button
            className={`flex items-center gap-1 px-2.5 h-6 text-[11px] font-medium rounded-full transition-all duration-200 disabled:cursor-not-allowed relative z-10 ${
              viewMode === "editor"
                ? "text-white"
                : "text-dalam-text-muted hover:text-dalam-text-primary"
            }`}
            onClick={() => activeWorkspaceId && setViewMode("editor")}
            title={
              !activeWorkspaceId
                ? "Open a folder to switch modes"
                : "Editor mode (Ctrl+E)"
            }
            disabled={!activeWorkspaceId}
          >
            <Code2 className="w-3 h-3" />
            <span>Editor</span>
          </button>
          {/* Active indicator pill */}
          <div
            className="absolute top-0.5 bottom-0.5 w-[calc(50%-2px)] bg-dalam-accent-primary rounded-full shadow-sm transition-all duration-200 ease-out"
            style={{
              left: viewMode === "chat" ? "2px" : "calc(50%)",
            }}
          />
        </div>

        <div className="w-px h-4 bg-dalam-border-primary mx-1" />

        {/* Theme */}
        <Tooltip content={`Theme: ${settings.theme}`} side="bottom">
          <button
            className="btn-icon"
            onClick={() => {
              const next =
                settings.theme === "dark"
                  ? "light"
                  : settings.theme === "light"
                    ? "system"
                    : "dark";
              void updateSetting("theme", next);
            }}
          >
            {settings.theme === "dark" ? (
              <Moon className="w-4 h-4" />
            ) : settings.theme === "light" ? (
              <Sun className="w-4 h-4" />
            ) : (
              <Monitor className="w-4 h-4" />
            )}
          </button>
        </Tooltip>

        {/* Terminal */}
        {session && session.workspacePath && (
          <Tooltip content="Open terminal" side="bottom">
            <button
              className="w-7 h-7 flex items-center justify-center rounded-md text-dalam-text-secondary hover:text-dalam-text-primary hover:bg-dalam-bg-hover transition-colors"
              onClick={() => {
                const ui = useUI.getState();
                if (ui.viewMode !== "editor") ui.setViewMode("editor");
                if (session.workspacePath)
                  useTerminal.getState().ensureTabForCwd(session.workspacePath);
                ui.setBottomPanelTab("terminal");
                ui.setBottomPanelOpen(true);
              }}
            >
              <TerminalSquare className="w-3.5 h-3.5" />
            </button>
          </Tooltip>
        )}

        {/* Settings */}
        <Tooltip content={`Settings (${mod},)`} side="bottom">
          <button
            className="w-7 h-7 flex items-center justify-center rounded-md text-dalam-text-secondary hover:bg-dalam-bg-hover transition-colors"
            onClick={() => openSettings()}
          >
            <Settings className="w-4 h-4" />
          </button>
        </Tooltip>

        {/* Right panel — only show in agent/chat mode */}
        {viewMode === "chat" && (
          <Tooltip
            content={
              rightPanelOpen
                ? `Hide right panel (${mod}\\)`
                : `Show right panel (${mod}\\)`
            }
            side="bottom"
          >
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
        )}
      </div>
    </div>
  );
}

function MenuPanel({
  items,
  onClose,
}: {
  items: MenuAction[];
  onClose: () => void;
}) {
  return (
    <div
      className="absolute left-0 top-7 min-w-[220px] bg-dalam-bg-secondary border border-dalam-border-primary rounded-md shadow-2xl py-1 z-50 animate-fade-in"
      onMouseDown={(e) => e.stopPropagation()}
      role="menu"
    >
      {items.map((action, idx) => {
        if (action.type === "separator") {
          return (
            <div
              key={idx}
              className="h-px bg-dalam-border-primary my-1 mx-1"
              role="separator"
            />
          );
        }
        if (action.type === "item") {
          return (
            <button
              key={idx}
              disabled={action.disabled}
              onClick={() => {
                action.perform();
                onClose();
              }}
              role="menuitem"
              className="w-full flex items-center justify-between gap-3 px-2.5 py-1 text-[11px] text-dalam-text-primary hover:bg-dalam-accent-subtle hover:text-dalam-text-primary transition-colors disabled:opacity-50 disabled:hover:bg-transparent"
            >
              <span>{action.label}</span>
              {action.shortcut && (
                <kbd className="text-[10px] text-dalam-text-muted whitespace-nowrap">
                  {action.shortcut}
                </kbd>
              )}
            </button>
          );
        }
        return null;
      })}
    </div>
  );
}
