import { useEffect, useRef, useState } from "react";
import { ImperativePanelHandle, Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { Sidebar } from "@/components/sidebar/Sidebar";
import { EditorPane } from "@/components/editor/EditorPane";
import { RightPanel } from "@/components/rightpanel/RightPanel";
import { CommandPalette } from "@/components/palette/CommandPalette";
import { SettingsModal } from "@/components/settings/SettingsModal";
import { PermissionDialog } from "@/components/permissions/PermissionDialog";
import { QuestionDialog } from "@/components/permissions/QuestionDialog";
import { Toaster } from "@/components/ui/Toaster";
import { useProgressKeyframes } from "@/components/ui/toastStore";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";
import { ShortcutsCheatsheet } from "@/components/ui/ShortcutsCheatsheet";
import { ContextMenuProvider } from "@/components/ui/ContextMenu";
import { WelcomeScreen } from "@/components/onboarding/WelcomeScreen";
import { initializeConnectors } from "@/lib/connectors";
import {
  useCommandPalette,
  useSettings,
  useShortcuts,
  useSettingsView,
  useUI,
  useChat,
  useSkillsMcp,
  useWorkspace,
  loadWorkspaceConfigAndSessions,
} from "@/store/useAppStore";

// Splash / loading screen shown during initial app bootstrap
function SplashScreen() {
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState("Initializing...");

  useEffect(() => {
    // Simulate progressive loading steps
    const steps = [
      { at: 0, status: "Loading configuration..." },
      { at: 15, status: "Restoring sessions..." },
      { at: 30, status: "Building memory index..." },
      { at: 50, status: "Loading context..." },
      { at: 70, status: "Connecting services..." },
      { at: 85, status: "Preparing workspace..." },
      { at: 100, status: "Ready" },
    ];

    const timers: ReturnType<typeof setTimeout>[] = [];

    steps.forEach((step) => {
      const t = setTimeout(() => {
        setProgress(step.at);
        setStatus(step.status);
      }, step.at * 60); // ~60ms per percent = ~6s total
      timers.push(t);
    });

    return () => timers.forEach(clearTimeout);
  }, []);

  return (
    <div className="fixed inset-0 z-[9999] flex flex-col items-center justify-center bg-dalam-bg-primary text-dalam-text-primary">
      {/* Animated icon */}
      <div className="relative mb-8 animate-float">
        <img
          src="/icon.svg"
          alt=""
          className="w-32 h-32 object-contain"
          style={{
            animation: "marble-drift 3s ease-in-out infinite",
          }}
        />
        {/* Pulsing glow behind icon */}
        <div
          className="absolute inset-0 blur-2xl opacity-60"
          style={{
            background: "radial-gradient(circle, rgba(107,0,255,0.4) 0%, transparent 70%)",
            animation: "pulse-glow 2s ease-in-out infinite",
          }}
        />
      </div>

      {/* App name */}
      <h1
        className="text-3xl font-semibold tracking-tight mb-6"
        style={{
          fontFamily: "'Newsreader', 'Iowan Old Style', 'Georgia', serif",
        }}
      >
        Arun
      </h1>

      {/* Progress bar */}
      <div className="w-64 mb-3">
        <div className="h-1 bg-dalam-bg-tertiary rounded-full overflow-hidden">
          <div
            className="h-full bg-dalam-accent-primary transition-all duration-300 ease-out"
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>

      {/* Status text */}
      <p className="text-xs text-dalam-text-muted tabular-nums">{status}</p>
    </div>
  );
}

export function App() {
  useProgressKeyframes();
  const [booted, setBooted] = useState(false);
  const { load: loadSettings } = useSettings();
  const { toggle: togglePalette, open: paletteOpen, setOpen: setPaletteOpen } =
    useCommandPalette();
  const { toggle: toggleShortcuts } = useShortcuts();
  const { openState: settingsOpen } = useSettingsView();
  const { sidebarOpen, rightPanelOpen } = useUI();
  const { settings, effectiveTheme } = useSettings();
  const { mcpServers, connectMcpServer } = useSkillsMcp();

  // Handle initial bootstrap sequence
  useEffect(() => {
    let cancelled = false;

    const bootstrap = async () => {
      try {
        // Stage 1: Load settings
        await loadSettings();
        if (cancelled) return;

        // Stage 2: Load chat sessions & workspace configs
        await useChat.getState().load();
        if (cancelled) return;

        // Stage 3: Load workspace data
        const { workspaces } = useWorkspace.getState();
        await Promise.all(
          workspaces.map((ws) =>
            loadWorkspaceConfigAndSessions(ws.path).catch((err) =>
              console.error(`Failed to load workspace ${ws.name}:`, err)
            )
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
        ).catch((err) => console.error("Failed to initialize connectors:", err));

        // Stage 5: Connect MCP servers
        const { mcpServers, connectMcpServer: connectMcp } = useSkillsMcp.getState();
        await Promise.all(
          mcpServers
            .filter((s) => s.enabled && s.status === "disconnected")
            .map((s) => connectMcp(s.name).catch((err) => console.error(`MCP ${s.name} failed:`, err)))
        );

        // Done — hide splash after minimum display time
        setTimeout(() => {
          if (!cancelled) setBooted(true);
        }, 2500);
      } catch (err) {
        console.error("Bootstrap failed:", err);
        // Still boot even on error so user can see the UI
        setTimeout(() => {
          if (!cancelled) setBooted(true);
        }, 1500);
      }
    };

    void bootstrap();

    return () => {
      cancelled = true;
    };
  }, [loadSettings]);

  // Connect all enabled MCP servers on startup (after boot)
  useEffect(() => {
    mcpServers.forEach((server) => {
      if (server.enabled && server.status === "disconnected") {
        void connectMcpServer(server.name).catch((err) =>
          console.error(`Failed to auto-connect to MCP server ${server.name}:`, err)
        );
      }
    });
  }, [mcpServers, connectMcpServer]);

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

  // Imperative refs for the side panels so we can collapse/expand without
  // unmounting them (which would break react-resizable-panels autoSave and
  // cause layout jumps).
  const sidebarPanelRef = useRef<ImperativePanelHandle>(null);
  const rightPanelRef = useRef<ImperativePanelHandle>(null);

  // Sidebar is auto-managed by workspace state (see activeWorkspaceId effect below).
  // This effect only handles manual toggle from onCollapse/onExpand callbacks.
  useEffect(() => {
    const panel = sidebarPanelRef.current;
    if (!panel) return;
    if (sidebarOpen) panel.expand();
    else panel.collapse();
  }, [sidebarOpen]);

  useEffect(() => {
    const panel = rightPanelRef.current;
    if (!panel) return;
    if (rightPanelOpen) panel.expand();
    else panel.collapse();
  }, [rightPanelOpen]);

  useEffect(() => {
    void loadSettings().catch((err: unknown) => console.error("Failed to load settings:", err));
    void useChat.getState().load().catch((err: unknown) => console.error("Failed to load chat sessions:", err));
    void initializeConnectors(
      (msg) => {
        console.debug("[Connector] message received:", msg);
        // Show incoming connector message as a system notification in chat
        const chat = useChat.getState();
        if (chat.activeSessionId) {
          chat.injectSystemMessage(
            `[${msg.platform}] Message from ${msg.senderName ?? msg.senderId}: ${msg.content}`
          );
        } else {
          console.debug("[Connector] No active session — message queued:", msg.content.slice(0, 80));
        }
      },
      (id, status) => { console.debug("[Connector] status change:", id, status); },
    ).catch((err: unknown) => console.error("Failed to initialize connectors:", err));
  }, [loadSettings]);

  // Auto-restore last workspace on startup and load all workspace sessions for sidebar
  useEffect(() => {
    const { workspaces } = useWorkspace.getState();
    // Load sessions for all workspaces so sidebar displays them
    for (const ws of workspaces) {
      void loadWorkspaceConfigAndSessions(ws.path).catch((err) =>
        console.error(`Failed to load workspace ${ws.name}:`, err)
      );
    }
  }, []);


  // Auto-show sidebar when a workspace is active, auto-hide when none.
  // Track whether the collapse was manual (user dragged/resized) vs automatic
  // (no workspace) so we don't override manual collapse when a workspace becomes active.
  const manualCollapseRef = useRef(false);
  const activeWorkspaceId = useWorkspace((s) => s.activeWorkspaceId);
  useEffect(() => {
    const panel = sidebarPanelRef.current;
    if (!panel) return;
    if (activeWorkspaceId && !sidebarOpen && !manualCollapseRef.current) {
      panel.expand();
      useUI.getState().setSidebarOpen(true);
    } else if (!activeWorkspaceId && sidebarOpen) {
      manualCollapseRef.current = false; // Reset on auto-collapse
      panel.collapse();
      useUI.getState().setSidebarOpen(false);
    }
  }, [activeWorkspaceId]);

  const paletteOpenRef = useRef(paletteOpen);

  useEffect(() => {
    paletteOpenRef.current = paletteOpen;
  }, [paletteOpen]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        togglePalette();
        return;
      }
      if (e.key === "?" && !isTyping(e.target)) {
        e.preventDefault();
        toggleShortcuts();
        return;
      }
      if (mod && e.key === ",") {
        e.preventDefault();
        useSettingsView.getState().open();
        return;
      }
      // Sidebar toggle: Ctrl+B / Cmd+B re-opens sidebar (even after manual collapse, only if workspace active)
      if (mod && e.key.toLowerCase() === "b" && !isTyping(e.target) && useWorkspace.getState().activeWorkspaceId) {
        e.preventDefault();
        manualCollapseRef.current = false; // Reset manual collapse flag
        useUI.getState().setSidebarOpen(true);
        return;
      }
      if (mod && e.key.toLowerCase() === "n" && !isTyping(e.target)) {
        e.preventDefault();
        useChat.getState().newChat();
        return;
      }
      if (mod && e.key === "\\" && !isTyping(e.target)) {
        e.preventDefault();
        useUI.getState().toggleRightPanel();
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
        <div className="flex flex-col h-full w-full bg-dalam-bg-primary text-dalam-text-primary">
          <SettingsModal />
          <CommandPalette />
          <PermissionDialog />
          <QuestionDialog />
          <ShortcutsCheatsheet />
          <Toaster />
        </div>
      </ContextMenuProvider>
    );
  }

  return (
    <ContextMenuProvider>
      <div className="flex flex-col h-full w-full bg-dalam-bg-primary text-dalam-text-primary">
      <div className="flex-1 min-h-0">
        <PanelGroup direction="horizontal" autoSaveId="dalam-main-layout">
          <Panel
            ref={sidebarPanelRef}
            id="sidebar"
            order={1}
            defaultSize={20}
            minSize={12}
            maxSize={32}
            collapsible
            collapsedSize={0}
            onCollapse={() => { manualCollapseRef.current = true; useUI.getState().setSidebarOpen(false); }}
            onExpand={() => useUI.getState().setSidebarOpen(true)}
          >
            <ErrorBoundary>
              <Sidebar />
            </ErrorBoundary>
          </Panel>
          <PanelResizeHandle
            className="panel-resizer horizontal"
            hitAreaMargins={{ coarse: 6, fine: 4 }}
            disabled={!sidebarOpen}
          />
          <Panel id="editor" order={2} defaultSize={55} minSize={30}>
            <ErrorBoundary>
              <EditorPane />
            </ErrorBoundary>
          </Panel>
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
        </PanelGroup>
      </div>
      <CommandPalette />
      <ShortcutsCheatsheet />
      <WelcomeScreen />
      <PermissionDialog />
      <QuestionDialog />
      <Toaster />
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
