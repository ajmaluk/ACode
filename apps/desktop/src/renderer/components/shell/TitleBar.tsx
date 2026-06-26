import { Settings as SettingsIcon, ChevronDown, Sparkles, Zap, ClipboardList, Loader2, Sun, Moon, Monitor, ChevronLeft, ChevronRight, MoreHorizontal } from "lucide-react";
import { useSettingsView, useWorkspace, useGit, useAgents, useChat, useSettings } from "@/store/useAppStore";

const AGENT_META: Record<string, { label: string; icon: React.ElementType; color: string }> = {
  build: { label: "Build", icon: Zap, color: "text-amber-400" },
  plan: { label: "Plan", icon: ClipboardList, color: "text-emerald-400" },
  yolo: { label: "YOLO", icon: Sparkles, color: "text-rose-400" },
};

export function TitleBar() {
  const { open: openSettings } = useSettingsView();
  const { activeWorkspaceId, workspaces } = useWorkspace();
  const { status: gitStatus } = useGit();
  const { activeAgentName } = useAgents();
  const { session, isStreaming, chatSessions, activeSessionId, goBackChat, goForwardChat } = useChat();
  const { settings, update: updateSetting } = useSettings();
  const active = workspaces.find((w) => w.id === activeWorkspaceId);
  const activeSession = chatSessions.find((s) => s.id === activeSessionId);
  const agentMeta = AGENT_META[activeAgentName] ?? AGENT_META.build;
  const AgentIcon = agentMeta.icon;
  const sessionStatus = session?.status ?? "idle";

  return (
    <header className="titlebar h-10 flex items-center bg-dalam-bg-secondary border-b border-dalam-border-primary flex-shrink-0 select-none px-2">
      <div className="flex items-center gap-1.5 pl-1 pr-3 no-drag">
        <div className="w-3 h-3 rounded-full bg-[#ff5f57] shadow-sm" />
        <div className="w-3 h-3 rounded-full bg-[#febc2e] shadow-sm" />
        <div className="w-3 h-3 rounded-full bg-[#28c840] shadow-sm" />
      </div>
      <div className="flex items-center gap-0.5 no-drag mr-2">
        <button className="btn-icon p-1" title="Back" onClick={() => goBackChat()}>
          <ChevronLeft className="w-4 h-4" />
        </button>
        <button className="btn-icon p-1" title="Forward" onClick={() => goForwardChat()}>
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>
      <div className="flex-1 min-w-0 drag flex items-center justify-center gap-2">
        {activeSession ? (
          <>
            <span className="text-sm text-dalam-text-primary truncate max-w-[400px]">
              {activeSession.title}
            </span>
            {active && (
              <span className="px-2 py-0.5 text-[10px] rounded-md bg-dalam-bg-active text-dalam-text-secondary border border-dalam-border-primary flex-shrink-0 flex items-center gap-1">
                <span>📁</span>
                {active.name}
              </span>
            )}
            {gitStatus && (
              <span className="px-2 py-0.5 text-[10px] rounded-md bg-dalam-bg-active text-dalam-text-secondary border border-dalam-border-primary flex-shrink-0 flex items-center gap-1 no-drag cursor-pointer">
                <span>🔀</span>
                {gitStatus.branch}
                <ChevronDown className="w-2.5 h-2.5" />
              </span>
            )}
            <button className="no-drag text-dalam-text-muted hover:text-dalam-text-primary transition-colors" title="More actions">
              <MoreHorizontal className="w-4 h-4" />
            </button>
          </>
        ) : (
          <span className="text-sm text-dalam-text-primary truncate">
            {active?.name || "Dalam"}
          </span>
        )}
      </div>

      {/* Agent indicator with status dot */}
      <div className="flex items-center gap-0.5 no-drag mr-1">
        <div className="relative group">
          <button
            onClick={() => useSettingsView.getState().open("agents")}
            className="flex items-center gap-1.5 px-2 h-7 text-xs text-dalam-text-secondary hover:text-dalam-text-primary bg-dalam-bg-active hover:bg-dalam-bg-tertiary rounded-md border border-dalam-border-primary transition-colors"
            title="Active agent (click to change)"
          >
            <span className="relative">
              <AgentIcon className={`w-3.5 h-3.5 ${agentMeta.color}`} />
              <span className={`absolute -bottom-0.5 -right-0.5 w-1.5 h-1.5 rounded-full border border-dalam-bg-active ${
                sessionStatus === "running" ? "bg-dalam-accent-primary animate-pulse" :
                sessionStatus === "aborted" || sessionStatus === "error" ? "bg-dalam-git-deleted" :
                "bg-dalam-git-added"
              }`} />
            </span>
            <span>{agentMeta.label}</span>
          </button>
        </div>
        {/* Streaming indicator */}
        {isStreaming && (
          <div className="flex items-center gap-1 px-2 h-7 text-[10px] text-dalam-accent-primary bg-dalam-accent-subtle rounded-md border border-dalam-border-primary">
            <Loader2 className="w-3 h-3 animate-spin" />
            <span>streaming</span>
          </div>
        )}
      </div>

      <div className="flex items-center gap-0.5 no-drag">
        {/* Theme switcher — cycles through dark → light → system */}
        <button
          className="btn-icon"
          aria-label="Toggle theme"
          title={`Theme: ${settings.theme} (click to cycle)`}
          onClick={() => {
            const next = settings.theme === "dark" ? "light" : settings.theme === "light" ? "system" : "dark";
            void updateSetting("theme", next);
          }}
        >
          {settings.theme === "dark" ? <Moon className="w-4 h-4" /> :
           settings.theme === "light" ? <Sun className="w-4 h-4" /> :
           <Monitor className="w-4 h-4" />}
        </button>
        <button className="btn-icon" aria-label="Settings" title="Settings (⌘,)" onClick={() => openSettings()}>
          <SettingsIcon className="w-4 h-4" />
        </button>
      </div>
    </header>
  );
}
