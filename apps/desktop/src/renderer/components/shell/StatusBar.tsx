import { useGit, useWorkspace, useSettings, useChat, useModelProviders } from "@/store/useAppStore";
import { GitBranch, AlertCircle, Cpu, Wifi, CheckCircle2, Loader2, Circle, AlertTriangle } from "lucide-react";

export function StatusBar({ workspaceReady }: { workspaceReady: boolean }) {
  const { status } = useGit();
  const { openTabs, activeFilePath } = useWorkspace();
  const { settings } = useSettings();
  const { session, selectedModelId, doomLoopWarningCount } = useChat();
  const { getAllModels } = useModelProviders();
  const allModels = getAllModels();
  const resolvedModel = allModels.find((m) => m.model.modelId === selectedModelId || m.model.modelId === settings.selectedModel);
  const activeTab = openTabs.find((t) => t.path === activeFilePath);

  const branch = status?.branch ?? "—";
  const added = status?.added.length ?? 0;
  const deleted = status?.deleted.length ?? 0;
  const modified = status?.modified.length ?? 0;
  const changes = added + deleted + modified;

  const statusColor =
    !session ? "" :
    session.status === "running" ? "text-dalam-accent-primary animate-spin" :
    session.status === "aborted" || session.status === "error" ? "text-red-400" :
    "text-dalam-git-added";

  const StatusIcon = !session ? Circle : session.status === "running" ? Loader2 : session.status === "aborted" || session.status === "error" ? AlertCircle : CheckCircle2;

  return (
    <footer className="h-6 flex items-center justify-between bg-dalam-bg-tertiary border-t border-dalam-border-primary px-3 text-[11px] text-dalam-text-muted flex-shrink-0 select-none">
      <div className="flex items-center gap-3 min-w-0 overflow-hidden">
        <span className="flex items-center gap-1.5 flex-shrink-0">
          <GitBranch className="w-3 h-3" />
          {branch}
        </span>
        {changes > 0 ? (
          <span className="flex items-center gap-1.5 flex-shrink-0">
            {added > 0 && <span className="text-dalam-git-added">+{added}</span>}
            {deleted > 0 && <span className="text-dalam-git-deleted">-{deleted}</span>}
            {modified > 0 && <span className="text-dalam-git-modified">~{modified}</span>}
          </span>
        ) : (
          <span className="flex items-center gap-1.5 flex-shrink-0">
            <span className="w-1.5 h-1.5 rounded-full bg-dalam-git-added" />
            Clean
          </span>
        )}
        {activeTab && activeTab.cursor && (
          <span className="flex items-center gap-2 flex-shrink-0 text-dalam-text-muted">
            <span className="text-dalam-text-muted/50">·</span>
            <span>Ln {activeTab.cursor.line}, Col {activeTab.cursor.column}</span>
          </span>
        )}
        {!workspaceReady && (
          <span className="flex items-center gap-1.5 text-dalam-text-muted flex-shrink-0">
            <AlertCircle className="w-3 h-3" />
            No workspace
          </span>
        )}
      </div>
      <div className="flex items-center gap-3 flex-shrink-0">
        {doomLoopWarningCount > 0 && (
          <span className="flex items-center gap-1.5 text-amber-400 animate-pulse">
            <AlertTriangle className="w-3 h-3" />
            <span>Tool loop: {doomLoopWarningCount} failure{doomLoopWarningCount > 1 ? 's' : ''}</span>
          </span>
        )}
        {session && (
          <span className="flex items-center gap-1.5">
            <StatusIcon className={`w-3 h-3 ${statusColor}`} />
            {session.status}
          </span>
        )}
        <span className="flex items-center gap-1.5">
          <Cpu className="w-3 h-3" />
          {resolvedModel?.model.name || settings.selectedModel || "No model"}
        </span>
        <span className={`flex items-center gap-1.5 ${resolvedModel ? "text-dalam-git-added" : "text-dalam-text-muted"}`}>
          <Wifi className="w-3 h-3" />
          {resolvedModel ? "Connected" : "No model"}
        </span>
      </div>
    </footer>
  );
}
