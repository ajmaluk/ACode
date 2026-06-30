import { useUI, useGit, useWorkspace, useSettingsView } from "@/store/useAppStore";
import {
  FolderTree, Search, GitBranch, Sparkles, Puzzle, Settings,
} from "lucide-react";
import { Tooltip } from "@/components/ui/Tooltip";

type ActivityTab = "explorer" | "search" | "scm" | "agent" | "extensions";

const TOP_ITEMS: { id: ActivityTab; icon: React.ElementType; label: string }[] = [
  { id: "explorer", icon: FolderTree, label: "Explorer" },
  { id: "search", icon: Search, label: "Search" },
  { id: "scm", icon: GitBranch, label: "Source Control" },
  { id: "agent", icon: Sparkles, label: "Agent" },
  { id: "extensions", icon: Puzzle, label: "Extensions" },
];

export function ActivityBar() {
  const { activityBarTab, setActivityBarTab, setSidebarOpen } = useUI();
  const { status } = useGit();
  const { activeWorkspaceId } = useWorkspace();
  const changeCount = (status?.modified.length ?? 0) + (status?.added.length ?? 0) + (status?.deleted.length ?? 0);

  const handleClick = (tab: ActivityTab) => {
    if (activityBarTab === tab) {
      // Toggle sidebar off if clicking the same tab
      setSidebarOpen(false);
    } else {
      setActivityBarTab(tab);
      setSidebarOpen(true);
    }
  };

  return (
    <div className="w-11 flex-shrink-0 bg-dalam-bg-tertiary border-r border-dalam-border-primary flex flex-col items-center pt-1.5 pb-2 gap-0.5 select-none">
      {/* Top items */}
      <div className="flex-1 flex flex-col items-center gap-0.5">
        {TOP_ITEMS.map((item) => {
          const Icon = item.icon;
          const isActive = activityBarTab === item.id && useUI.getState().sidebarOpen;
          const badge = item.id === "scm" && changeCount > 0 ? changeCount : null;
          return (
            <Tooltip key={item.id} content={item.label} side="right">
              <button
                onClick={() => handleClick(item.id)}
                className={`w-9 h-9 flex items-center justify-center rounded-lg transition-all duration-100 relative group ${
                  isActive
                    ? "bg-dalam-accent-subtle text-dalam-accent-primary"
                    : "text-dalam-text-muted hover:bg-dalam-bg-hover hover:text-dalam-text-primary"
                }`}
              >
                <Icon className="w-[17px] h-[17px]" />
                {isActive && (
                  <span className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-5 rounded-full bg-dalam-accent-primary shadow-sm shadow-dalam-accent-primary/30" />
                )}
                {badge !== null && (
                  <span className="absolute top-1 right-1 min-w-[14px] h-[14px] flex items-center justify-center rounded-full bg-dalam-accent-primary text-white text-[8px] font-bold px-0.5">
                    {badge}
                  </span>
                )}
              </button>
            </Tooltip>
          );
        })}
      </div>

      {/* Bottom items */}
      <div className="pt-1.5 border-t border-dalam-border-primary/50 w-full flex flex-col items-center gap-0.5">
        <Tooltip content="Settings" side="right">
          <button
            onClick={() => useSettingsView.getState().open()}
            className="w-9 h-9 flex items-center justify-center rounded-lg text-dalam-text-muted hover:bg-dalam-bg-hover hover:text-dalam-text-primary transition-all"
          >
            <Settings className="w-[17px] h-[17px]" />
          </button>
        </Tooltip>
      </div>
    </div>
  );
}
