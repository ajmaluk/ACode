import { useEffect, useRef } from "react";
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

export function App() {
  useProgressKeyframes();
  const { load: loadSettings } = useSettings();
  const { toggle: togglePalette, open: paletteOpen, setOpen: setPaletteOpen } =
    useCommandPalette();
  const { toggle: toggleShortcuts } = useShortcuts();
  const { openState: settingsOpen } = useSettingsView();
  const { sidebarOpen, rightPanelOpen } = useUI();
  const { settings, effectiveTheme } = useSettings();
  const { mcpServers, connectMcpServer } = useSkillsMcp();

  // Connect all enabled MCP servers on startup
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

  // Sync the UI store's toggle state with the imperative panel API.
  // expand()/collapse() are idempotent — calling them when already in the
  // target state is a no-op, so this is safe with onCollapse/onExpand below.
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
    void loadSettings().catch((err) => console.error("Failed to load settings:", err));
  }, [loadSettings]);

  // Auto-restore last workspace on startup
  useEffect(() => {
    const { workspaces, activeWorkspaceId } = useWorkspace.getState();
    if (activeWorkspaceId) {
      const ws = workspaces.find((w) => w.id === activeWorkspaceId);
      if (ws) {
        void loadWorkspaceConfigAndSessions(ws.path).catch((err) =>
          console.error("Failed to restore workspace:", err)
        );
      }
    }
  }, []);


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
      if (mod && e.key.toLowerCase() === "b" && !isTyping(e.target)) {
        e.preventDefault();
        useUI.getState().toggleSidebar();
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
        if (paletteOpen) {
          setPaletteOpen(false);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePalette, toggleShortcuts, paletteOpen, setPaletteOpen]);

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
            onCollapse={() => useUI.getState().setSidebarOpen(false)}
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
