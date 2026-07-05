import { useEffect, useRef, useState, Suspense, lazy } from "react";
import { ImperativePanelHandle, Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { TitleBar } from "@/components/editor/TitleBar";
import { Sidebar } from "@/components/sidebar/Sidebar";
import { EditorPane } from "@/components/editor/EditorPane";
import { PanelLeft, PanelRight, ChevronLeft, ChevronRight, MessageSquare, Code2, Moon, Sun, Monitor } from "lucide-react";
import { RightPanel } from "@/components/rightpanel/RightPanel";
import { BottomPanel } from "@/components/terminal/BottomPanel";
import { CommandPalette } from "@/components/palette/CommandPalette";
const SettingsModal = lazy(() => import("@/components/settings/SettingsModal").then(m => ({ default: m.SettingsModal })));
import { PermissionDialog } from "@/components/permissions/PermissionDialog";
// QuestionDialog removed — now rendered inline above input in ChatView
import { Toaster } from "@/components/ui/Toaster";
import { useProgressKeyframes } from "@/components/ui/toastStore";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";
import { ShortcutsCheatsheet } from "@/components/ui/ShortcutsCheatsheet";
import { ContextMenuProvider } from "@/components/ui/ContextMenu";
import { WelcomeScreen } from "@/components/onboarding/WelcomeScreen";
import { initializeConnectors, shutdownConnectors } from "@/lib/connectors";
import { setupNativeMenus } from "@/lib/nativeMenu";
import { createDalamAPI } from "@/lib/dalamAPI";
import {
  useCommandPalette,
  useSettings,
  useShortcuts,
  useSettingsView,
  useUI,
  useChat,
  useSkillsMcp,
  useWorkspace,
  useTerminal,
  loadWorkspaceConfigAndSessions,
} from "@/store/useAppStore";
import { platform } from "@/lib/platform";

// Splash / loading screen — icon only, no text
function SplashScreen() {
  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-dalam-bg-primary">
      <div className="relative animate-float">
        <img
          src="/icon.svg"
          alt=""
          className="w-24 h-24 object-contain"
          style={{
            animation: "marble-drift 3s ease-in-out infinite",
          }}
        />
        <div
          className="absolute inset-0 blur-2xl opacity-40"
          style={{
            background: "radial-gradient(circle, rgba(107,0,255,0.3) 0%, transparent 70%)",
            animation: "pulse-glow 2s ease-in-out infinite",
          }}
        />
      </div>
    </div>
  );
}

export function App() {
  useProgressKeyframes();
  const [booted, setBooted] = useState(false);
  const { settings, effectiveTheme } = useSettings();
  const { toggle: togglePalette, open: paletteOpen, setOpen: setPaletteOpen } =
    useCommandPalette();
  const { toggle: toggleShortcuts } = useShortcuts();
  const { openState: settingsOpen } = useSettingsView();
  const { rightPanelOpen, sidebarOpen, viewMode } = useUI();
  const { chatHistory, chatHistoryIdx } = useChat();
  const canGoBack = chatHistoryIdx >= 0 || chatHistory.length > 0;
  const canGoForward = chatHistoryIdx >= 0 && chatHistoryIdx < chatHistory.length - 1;
  const { workspaces, activeWorkspaceId } = useWorkspace();
  const activeWorkspace = workspaces.find((w) => w.id === activeWorkspaceId) ?? null;
  const { bottomPanelOpen } = useUI();
  const { mcpServers, connectMcpServer } = useSkillsMcp();

  // Handle initial bootstrap sequence
  // Use ref-based loadSettings to avoid re-running on every render
  useEffect(() => {
    let cancelled = false;

    const bootstrap = async () => {
      try {
        // Stage 1: Load settings
        await useSettings.getState().load();
        if (cancelled) return;

        // Stage 2: Load chat sessions & workspace configs
        await useChat.getState().load();
        if (cancelled) return;

        // Stage 3: Load workspace data
        const { workspaces } = useWorkspace.getState();
        await Promise.all(
          workspaces.map((ws) =>
            loadWorkspaceConfigAndSessions(ws.path).catch((err) => {
              const msg = (err as Error)?.message ?? String(err);
              if (msg.includes("forbidden") || msg.includes("scope")) {
                console.debug(`[Workspace] Skipped inaccessible workspace: ${ws.name}`);
              } else {
                console.warn(`Failed to load workspace ${ws.name}:`, err);
              }
            })
          )
        );
        if (cancelled) return;

        // Stage 4: Initialize connectors
        await initializeConnectors(
          (msg) => {
            console.debug("[Connector] message received:", msg);
            const chat = useChat.getState();
            if (chat.activeSessionId) {
              chat.injectSystemMessage(
                `[${msg.platform}] Message from ${msg.senderName ?? msg.senderId}: ${msg.content}`
              );
            } else {
              console.debug("[Connector] No active session — message queued:", msg.content.slice(0, 80));
            }
          },
          (id, status) => console.debug("[Connector] status change:", id, status)
        ).catch((err) => { if (import.meta.env.DEV) console.error("Failed to initialize connectors:", err); });

        // Stage 5: MCP servers are connected by the useEffect after boot completes.
        // (Removed duplicate connection logic — the useEffect at line 157 handles this.)

        // Stage 6: Set up native menus (macOS system menu bar)
        await setupNativeMenus();

        // Done — hide splash after minimum display time (short enough to feel responsive)
        setTimeout(() => {
          if (!cancelled) setBooted(true);
        }, 800);
      } catch (err) {
        if (import.meta.env.DEV) console.error("Bootstrap failed:", err);
        // Still boot even on error so user can see the UI
        setTimeout(() => {
          if (!cancelled) setBooted(true);
        }, 500);
      }
    };

    void bootstrap();

    return () => {
      cancelled = true;
      void shutdownConnectors().catch(() => {});
    };
  }, []);

  // Connect all enabled MCP servers on startup (after boot)
  useEffect(() => {
    mcpServers.forEach((server) => {
      if (server.enabled && server.status === "disconnected") {
        void connectMcpServer(server.name).catch((err) => {
          if (import.meta.env.DEV) console.error(`Failed to auto-connect to MCP server ${server.name}:`, err);
        });
      }
    });
  }, [mcpServers, connectMcpServer]);

  // Handle native menu actions (from macOS system menu bar)
  useEffect(() => {
    const handler = (e: Event) => {
      const { actionId } = (e as CustomEvent).detail;
      const ui = useUI.getState();
      const workspace = useWorkspace.getState();
      const chat = useChat.getState();
      const settingsView = useSettingsView.getState();
      const palette = useCommandPalette.getState();
      const settings = useSettings.getState();
      const { update: updateSetting } = useSettings.getState();

      switch (actionId) {
        // File
        case "file.new-file": {
          const ws = workspace.workspaces.find((w) => w.id === workspace.activeWorkspaceId);
          if (ws) void workspace.openFile(ws.path + "/untitled");
          break;
        }
        case "file.open-file":
          void workspace.openWorkspace();
          break;
        case "file.save": {
          const tab = workspace.openTabs.find((t) => t.path === workspace.activeFilePath);
          if (tab) {
            void (async () => {
              try {
                const api = createDalamAPI();
                await api.fs.writeFile(tab.path, tab.content);
                workspace.markSaved(tab.path);
              } catch (err) {
                if (import.meta.env.DEV) console.error("Save failed:", err);
              }
            })();
          }
          break;
        }
        case "file.save-all": {
          const dirty = workspace.openTabs.filter((t) => t.dirty);
          void (async () => {
            try {
              const api = createDalamAPI();
              for (const tab of dirty) {
                await api.fs.writeFile(tab.path, tab.content);
                workspace.markSaved(tab.path);
              }
            } catch (err) {
              if (import.meta.env.DEV) console.error("Save all failed:", err);
            }
          })();
          break;
        }
        case "file.close-tab":
          if (workspace.activeFilePath) workspace.closeTab(workspace.activeFilePath);
          break;
        case "file.preferences":
          settingsView.open();
          break;

        // Edit
        case "edit.find":
          window.dispatchEvent(new CustomEvent("editor:find"));
          break;
        case "edit.find-replace":
          window.dispatchEvent(new CustomEvent("editor:find-replace"));
          break;
        case "edit.toggle-comment":
          window.dispatchEvent(new CustomEvent("editor:toggle-comment"));
          break;

        // View

        case "view.toggle-right-panel":
          // Only toggle right panel in chat/agent mode
          if (ui.viewMode === "chat") {
            ui.toggleRightPanel();
          }
          break;
        case "view.toggle-word-wrap":
          void updateSetting("wordWrap", !settings.settings.wordWrap);
          break;
        case "view.zoom-in":
          void updateSetting("codeFontSize", Math.min((settings.settings.codeFontSize ?? 14) + 1, 32));
          break;
        case "view.zoom-out":
          void updateSetting("codeFontSize", Math.max((settings.settings.codeFontSize ?? 14) - 1, 8));
          break;
        case "view.agent-mode":
          ui.setViewMode("chat");
          break;
        case "view.editor-mode":
          ui.setViewMode("editor");
          break;

        // Go
        case "go.quick-open":
          window.dispatchEvent(new CustomEvent("editor:quick-open"));
          break;
        case "go.go-to-line":
          window.dispatchEvent(new CustomEvent("editor:go-to-line"));
          break;
        case "go.back":
          chat.goBackChat();
          break;
        case "go.forward":
          chat.goForwardChat();
          break;

        // Terminal
        case "terminal.new":
        case "terminal.toggle": {
          // Switch to editor mode first (terminal only visible in editor mode)
          const uiState = useUI.getState();
          if (uiState.viewMode !== "editor") {
            uiState.setViewMode("editor");
          }
          const session = chat.session;
          if (session?.workspacePath) {
            useTerminal.getState().ensureTabForCwd(session.workspacePath);
          }
          uiState.setBottomPanelTab("terminal");
          uiState.setBottomPanelOpen(true);
          break;
        }

        // Help
        case "help.shortcuts":
          useShortcuts.getState().toggle();
          break;
        case "help.command-palette":
          palette.toggle();
          break;
      }
    };

    window.addEventListener("native-menu-action", handler);
    return () => window.removeEventListener("native-menu-action", handler);
  }, []);

  // Apply the theme to the document root whenever the effective theme changes.
  useEffect(() => {
    const apply = (t: "light" | "dark") => {
      const html = document.documentElement;
      html.setAttribute("data-theme", t);
      // Tailwind's dark: variants need the class too
      if (t === "dark") html.classList.add("dark");
      else html.classList.remove("dark");
      // Update the OS chrome (macOS traffic lights blend with this color)
      html.style.colorScheme = t;
    };
    const initial = effectiveTheme();
    apply(initial);
    // Listen for system theme changes if the user picked "system".
    if (settings.theme === "system" && typeof window !== "undefined" && window.matchMedia) {
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      const handler = (e: MediaQueryListEvent) => apply(e.matches ? "dark" : "light");
      mq.addEventListener("change", handler);
      return () => mq.removeEventListener("change", handler);
    }
  }, [settings.theme, effectiveTheme]);

  // Imperative ref for the right panel so we can collapse/expand without
  // unmounting them (which would break react-resizable-panels autoSave and
  // cause layout jumps).
  const rightPanelRef = useRef<ImperativePanelHandle>(null);

  useEffect(() => {
    const panel = rightPanelRef.current;
    if (!panel) return;
    if (rightPanelOpen) panel.expand();
    else panel.collapse();  }, [rightPanelOpen]);

  const paletteOpenRef = useRef(paletteOpen);

  useEffect(() => {
    paletteOpenRef.current = paletteOpen;
  }, [paletteOpen]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      const shift = e.shiftKey;
      if (mod && e.key.toLowerCase() === "k" && !isTyping(e.target)) {
        e.preventDefault();
        togglePalette();
        return;
      }
      // Cmd/Ctrl+Shift+P: Command palette (VS Code convention)
      // On macOS, native menu handles this — skip to prevent double-toggle
      if (mod && shift && e.key.toLowerCase() === "p" && !isTyping(e.target)) {
        if (platform() === "mac") return;
        e.preventDefault();
        togglePalette();
        return;
      }

      if (e.key === "?" && !isTyping(e.target)) {
        e.preventDefault();
        toggleShortcuts();
        return;
      }
      if (mod && e.key === "," && !isTyping(e.target)) {
        e.preventDefault();
        useSettingsView.getState().open();
        return;
      }

      if (mod && e.key.toLowerCase() === "n" && !isTyping(e.target)) {
        // On macOS, native menu handles Cmd+N (file.new-file). Only handle chat creation on other platforms.
        if (platform() === "mac") return;
        e.preventDefault();
        useChat.getState().newChat();
        if (useUI.getState().viewMode !== "chat") useUI.getState().setViewMode("chat");
        return;
      }
      if (mod && e.key === "b" && !isTyping(e.target)) {
        e.preventDefault();
        useUI.getState().toggleSidebar();
        return;
      }
      if (mod && e.key === "\\" && !isTyping(e.target)) {
        e.preventDefault();
        // Only toggle right panel in chat/agent mode
        if (useUI.getState().viewMode === "chat") {
          useUI.getState().toggleRightPanel();
        }
        return;
      }
      if (mod && e.key === "`" && !isTyping(e.target)) {
        e.preventDefault();
        // Only toggle bottom panel in editor mode
        if (useUI.getState().viewMode === "editor") {
          useUI.getState().toggleBottomPanel();
        }
        return;
      }
      if (mod && e.key === "[" && !isTyping(e.target)) {
        e.preventDefault();
        useChat.getState().goBackChat();
        return;
      }
      if (mod && e.key === "]" && !isTyping(e.target)) {
        e.preventDefault();
        useChat.getState().goForwardChat();
        return;
      }
      if (e.key === "Escape") {
        if (paletteOpenRef.current) {
          setPaletteOpen(false);
        }
      }
      // Ctrl+E: Toggle between chat and editor view (only when workspace is active)
      // On macOS, native menu handles view.agent-mode/view.editor-mode — skip to prevent double-set
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "e" && !isTyping(e.target)) {
        if (platform() === "mac") return;
        if (useWorkspace.getState().activeWorkspaceId) {
          e.preventDefault();
          useUI.getState().toggleViewMode();
        }
      }
      // Zoom In/Out: Ctrl+= / Ctrl+- (works on all platforms including Windows/Linux)
      if ((e.metaKey || e.ctrlKey) && (e.key === "=" || e.key === "+") && !isTyping(e.target)) {
        e.preventDefault();
        void useSettings.getState().update("codeFontSize", Math.min((useSettings.getState().settings.codeFontSize ?? 14) + 1, 32));
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "-" && !isTyping(e.target)) {
        e.preventDefault();
        void useSettings.getState().update("codeFontSize", Math.max((useSettings.getState().settings.codeFontSize ?? 14) - 1, 8));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePalette, toggleShortcuts, setPaletteOpen]);

  // Show splash screen during initial load
  if (!booted) {
    return <SplashScreen />;
  }

  if (settingsOpen) {
    return (
      <ContextMenuProvider>
        <ErrorBoundary>
          <div className="flex flex-col h-full w-full bg-dalam-bg-primary text-dalam-text-primary">
            <Suspense fallback={<div className="flex-1 flex items-center justify-center text-dalam-text-secondary">Loading settings...</div>}>
              <SettingsModal />
            </Suspense>
            <CommandPalette />
            <PermissionDialog />
            {/* QuestionDialog removed — now rendered inline above input in ChatView */}
            <ShortcutsCheatsheet />
            <Toaster />
          </div>
        </ErrorBoundary>
      </ContextMenuProvider>
    );
  }

  const isMac = platform() === "mac";

  return (
    <ContextMenuProvider>
      <div className="flex flex-col h-full w-full bg-dalam-bg-primary text-dalam-text-primary">
      {/* TitleBar — hidden on macOS (uses native menu bar) */}
      {!isMac && <TitleBar />}

      {/* macOS: thin traffic-light padding bar with controls */}
      {isMac && (
        <div className="h-9 flex-shrink-0 flex items-center justify-between px-3 bg-dalam-bg-secondary border-b border-dalam-border-primary" data-tauri-drag-region>
          {/* Left side: sidebar toggle + back/forward + workspace name */}
          <div className="flex items-center gap-0.5" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
            <button
              onClick={() => useUI.getState().toggleSidebar()}
              className="w-7 h-7 flex items-center justify-center rounded-md text-dalam-text-secondary hover:text-dalam-text-primary hover:bg-dalam-bg-hover transition-colors"
              title={sidebarOpen ? "Hide sidebar (⌘B)" : "Show sidebar (⌘B)"}
            >
              <PanelLeft className="w-4 h-4" />
            </button>
            <div className="w-px h-4 bg-dalam-border-primary mx-1" />
            <button
              onClick={() => useChat.getState().goBackChat()}
              disabled={!canGoBack}
              className="w-7 h-7 flex items-center justify-center rounded-md text-dalam-text-secondary hover:text-dalam-text-primary hover:bg-dalam-bg-hover transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
              title="Previous session"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <button
              onClick={() => useChat.getState().goForwardChat()}
              disabled={!canGoForward}
              className="w-7 h-7 flex items-center justify-center rounded-md text-dalam-text-secondary hover:text-dalam-text-primary hover:bg-dalam-bg-hover transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
              title="Next session"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
            <span className="text-[11px] text-dalam-text-muted font-medium select-none ml-1.5" data-tauri-drag-region>
              {activeWorkspace?.name ?? "Dalam"}
            </span>
          </div>
          {/* Right side: mode switcher + theme + right panel */}
          <div className="flex items-center gap-1" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
            {activeWorkspaceId && (
              <div className="relative flex items-center bg-dalam-bg-tertiary rounded-full border border-dalam-border-primary p-0.5 mr-2">
                <button
                  className={`flex items-center gap-1 px-2 h-5 text-[10px] font-medium rounded-full transition-all duration-200 relative z-10 ${
                    viewMode === "chat" ? "text-white" : "text-dalam-text-muted hover:text-dalam-text-primary"
                  }`}
                  onClick={() => useUI.getState().setViewMode("chat")}
                  title="Agent mode"
                >
                  <MessageSquare className="w-2.5 h-2.5" />
                  <span>Agent</span>
                </button>
                <button
                  className={`flex items-center gap-1 px-2 h-5 text-[10px] font-medium rounded-full transition-all duration-200 relative z-10 ${
                    viewMode === "editor" ? "text-white" : "text-dalam-text-muted hover:text-dalam-text-primary"
                  }`}
                  onClick={() => useUI.getState().setViewMode("editor")}
                  title="Editor mode"
                >
                  <Code2 className="w-2.5 h-2.5" />
                  <span>Editor</span>
                </button>
                <div
                  className="absolute top-0.5 bottom-0.5 w-[calc(50%-2px)] bg-dalam-accent-primary rounded-full shadow-sm transition-all duration-200 ease-out"
                  style={{ left: viewMode === "chat" ? "2px" : "calc(50%)" }}
                />
              </div>
            )}
            <button
              onClick={() => {
                const next = settings.theme === "dark" ? "light" : settings.theme === "light" ? "system" : "dark";
                void useSettings.getState().update("theme", next);
              }}
              className="w-7 h-7 flex items-center justify-center rounded-md text-dalam-text-secondary hover:text-dalam-text-primary hover:bg-dalam-bg-hover transition-colors"
              title="Toggle theme"
            >
              {settings.theme === "dark" ? <Moon className="w-4 h-4" /> : settings.theme === "light" ? <Sun className="w-4 h-4" /> : <Monitor className="w-4 h-4" />}
            </button>
            {/* Right panel toggle button — only visible in chat/agent mode */}
            {viewMode === "chat" && (
              <button
                onClick={() => useUI.getState().toggleRightPanel()}
                className="w-7 h-7 flex items-center justify-center rounded-md text-dalam-text-secondary hover:text-dalam-text-primary hover:bg-dalam-bg-hover transition-colors"
                title="Toggle right panel"
              >
                <PanelRight className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>
      )}

      {/* Main layout: horizontal panels + optional bottom panel */}
      <div className="flex-1 min-h-0 flex flex-col">
        <div className="flex-1 min-h-0">
          <PanelGroup direction="horizontal">

            {/* Sidebar — visible in chat mode when sidebarOpen, or in editor mode when sidebarOpen */}
            {sidebarOpen && (
              <>
                <Panel id="sidebar" order={1} defaultSize={20} minSize={12} maxSize={32}>
                  <ErrorBoundary>
                    <Sidebar />
                  </ErrorBoundary>
                </Panel>
                <PanelResizeHandle
                  className="panel-resizer horizontal"
                  hitAreaMargins={{ coarse: 6, fine: 4 }}
                />
              </>
            )}
            <Panel id="editor" order={2} defaultSize={rightPanelOpen ? (viewMode === "editor" ? 75 : 55) : 100} minSize={30}>
              <ErrorBoundary>
                <EditorPane />
              </ErrorBoundary>
            </Panel>
            {/* Right panel — only available in chat/agent mode */}
            {viewMode === "chat" && (
              <>
                <PanelResizeHandle
                  className="panel-resizer horizontal"
                  hitAreaMargins={{ coarse: 6, fine: 4 }}
                  disabled={!rightPanelOpen}
                />
                <Panel
                  ref={rightPanelRef}
                  id="right-panel"
                  order={3}
                  defaultSize={25}
                  minSize={16}
                  maxSize={42}
                  collapsible
                  collapsedSize={0}
                  onCollapse={() => useUI.getState().setRightPanelOpen(false)}
                  onExpand={() => useUI.getState().setRightPanelOpen(true)}
                >
                  <ErrorBoundary>
                    <RightPanel />
                  </ErrorBoundary>
                </Panel>
              </>
            )}
          </PanelGroup>
        </div>

        {/* Bottom Panel (Terminal, Output, Problems) — editor mode only */}
        {viewMode === "editor" && bottomPanelOpen && (
          <ErrorBoundary>
            <BottomPanel />
          </ErrorBoundary>
        )}
      </div>

      <ErrorBoundary>
        <CommandPalette />
      </ErrorBoundary>
      <ErrorBoundary>
        <ShortcutsCheatsheet />
      </ErrorBoundary>
      <ErrorBoundary>
        <WelcomeScreen />
      </ErrorBoundary>
      <ErrorBoundary>
        <PermissionDialog />
      </ErrorBoundary>
      {/* QuestionDialog removed — now rendered inline above input in ChatView */}
      <ErrorBoundary>
        <Toaster />
      </ErrorBoundary>
      </div>
    </ContextMenuProvider>
  );
}

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select";
}
