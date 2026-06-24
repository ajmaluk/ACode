import { useGit, useWorkspace, useSettings, useChat, useModelProviders } from "@/store/useAppStore";
import { GitBranch, AlertCircle, Cpu, Wifi, CheckCircle2, Loader2, Circle } from "lucide-react";

export function StatusBar({ workspaceReady }: { workspaceReady: boolean }) {
  const { status } = useGit();
  const { openTabs, activeFilePath } = useWorkspace();
  const { settings } = useSettings();
  const { session, selectedModelId } = useChat();
  const { getAllModels } = useModelProviders();
  const allModels = getAllModels();
  const resolvedModel = allModels.find((m) => m.model.modelId === selectedModelId || m.model.modelId === settings.selectedModel);
  const activeTab = openTabs.find((t) => t.path === activeFilePath);

  const branch = status?.branch ?? "—";
  const added = status?.added.length ?? 0;
  const deleted = status?.deleted.length ?? 0;
  const modified = status?.modified.length ?? 0;
  const changes = added + deleted + modified;

  const StatusIcon = !session ? Circle : session.status === "running" ? Loader2 : CheckCircle2;

  return (
    <footer className="h-6 flex items-center justify-between bg-acode-bg-tertiary border-t border-acode-border-primary px-3 text-[11px] text-acode-text-muted flex-shrink-0 select-none">
      <div className="flex items-center gap-3 min-w-0 overflow-hidden">
        <span className="flex items-center gap-1.5 flex-shrink-0">
          <GitBranch className="w-3 h-3" />
          {branch}
        </span>
        {changes > 0 ? (
          <span className="flex items-center gap-1.5 flex-shrink-0">
            {added > 0 && <span className="text-acode-git-added">+{added}</span>}
            {deleted > 0 && <span className="text-acode-git-deleted">-{deleted}</span>}
            {modified > 0 && <span className="text-acode-git-modified">~{modified}</span>}
          </span>
        ) : (
          <span className="flex items-center gap-1.5 flex-shrink-0">
            <span className="w-1.5 h-1.5 rounded-full bg-acode-git-added" />
            Clean
          </span>
        )}
        {activeTab && activeTab.cursor && (
          <span className="flex items-center gap-2 flex-shrink-0 text-acode-text-muted">
            <span className="text-acode-text-muted/50">·</span>
            <span>Ln {activeTab.cursor.line}, Col {activeTab.cursor.column}</span>
          </span>
        )}
        {!workspaceReady && (
          <span className="flex items-center gap-1.5 text-acode-text-muted flex-shrink-0">
            <AlertCircle className="w-3 h-3" />
            No workspace
          </span>
        )}
      </div>
      <div className="flex items-center gap-3 flex-shrink-0">
        {session && (
          <span className="flex items-center gap-1.5">
            <StatusIcon className={`w-3 h-3 ${session.status === "running" ? "text-acode-accent-primary animate-spin" : "text-acode-git-added"}`} />
            {session.status}
          </span>
        )}
        <span className="flex items-center gap-1.5">
          <Cpu className="w-3 h-3" />
          {resolvedModel?.model.name || settings.selectedModel || "No model"}
        </span>
        <span className="flex items-center gap-1.5 text-acode-git-added">
          <Wifi className="w-3 h-3" />
        </span>
      </div>
    </footer>
  );
}
