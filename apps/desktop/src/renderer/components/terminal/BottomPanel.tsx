import { useState, useRef, useCallback, useEffect } from "react";
import { useUI, useChat, useTerminal, useWorkspace } from "@/store/useAppStore";
import { TerminalPanel } from "./TerminalPanel";
import {
  TerminalSquare, PanelBottomClose,
  AlertTriangle, Info,
} from "lucide-react";
import { Tooltip } from "@/components/ui/Tooltip";
import { modKey } from "@/lib/platform";

type BottomTab = "terminal" | "output" | "problems";

const TABS: { id: BottomTab; icon: React.ElementType; label: string }[] = [
  { id: "terminal", icon: TerminalSquare, label: "Terminal" },
  { id: "output", icon: Info, label: "Output" },
  { id: "problems", icon: AlertTriangle, label: "Problems" },
];

export function BottomPanel() {
  const { bottomPanelTab: tab, setBottomPanelTab: setTab, setBottomPanelOpen } = useUI();
  const { session } = useChat();
  const [height, setHeight] = useState(220);
  const draggingRef = useRef(false);
  const startYRef = useRef(0);
  const startHeightRef = useRef(0);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    draggingRef.current = true;
    startYRef.current = e.clientY;
    startHeightRef.current = height;

    const handleMouseMove = (e: MouseEvent) => {
      if (!draggingRef.current) return;
      const delta = startYRef.current - e.clientY;
      const newHeight = Math.max(100, Math.min(startHeightRef.current + delta, window.innerHeight * 0.5));
      setHeight(newHeight);
    };

    const handleMouseUp = () => {
      draggingRef.current = false;
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
  }, [height]);

  // Auto-open terminal tab when bottom panel opens with a workspace
  useEffect(() => {
    const ws = useWorkspace.getState().workspaces.find((w) => w.id === useWorkspace.getState().activeWorkspaceId);
    const cwd = session?.workspacePath ?? ws?.path;
    if (cwd && useTerminal.getState().tabs.length === 0) {
      useTerminal.getState().ensureTabForCwd(cwd);
    }
  }, [session?.workspacePath]);

  return (
    <div
      className="flex-shrink-0 border-t border-dalam-border-primary bg-dalam-bg-primary flex flex-col"
      style={{ height }}
    >
      {/* Resize handle */}
      <div
        className="h-1.5 cursor-ns-resize hover:bg-dalam-accent-primary/30 active:bg-dalam-accent-primary/50 transition-colors flex-shrink-0 group"
        onMouseDown={handleMouseDown}
      >
        <div className="w-8 h-0.5 rounded-full bg-dalam-text-muted/30 group-hover:bg-dalam-accent-primary/60 mx-auto mt-1.5 transition-colors" />
      </div>

      {/* Tab bar */}
      <div className="flex items-center justify-between px-2 border-b border-dalam-border-primary bg-dalam-bg-secondary/50 flex-shrink-0">
        <div className="flex items-center gap-0">
          {TABS.map((t) => {
            const Icon = t.icon;
            const isActive = tab === t.id;
            return (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium transition-all duration-150 border-b-2 ${
                  isActive
                    ? "text-dalam-text-primary border-dalam-accent-primary"
                    : "text-dalam-text-muted hover:text-dalam-text-secondary border-transparent hover:border-dalam-border-secondary"
                }`}
              >
                <Icon className="w-3 h-3" />
                {t.label}
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-0.5">
          <Tooltip content={`Hide (${modKey()}\`)`} side="top">
            <button
              onClick={() => setBottomPanelOpen(false)}
              className="w-6 h-6 flex items-center justify-center rounded text-dalam-text-muted hover:text-dalam-text-primary hover:bg-dalam-bg-hover transition-colors"
            >
              <PanelBottomClose className="w-3.5 h-3.5" />
            </button>
          </Tooltip>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {tab === "terminal" && <TerminalPanel />}
        {tab === "output" && (
          <div className="flex-1 flex items-center justify-center p-4">
            <p className="text-xs text-dalam-text-muted">No output</p>
          </div>
        )}
        {tab === "problems" && (
          <div className="flex-1 flex items-center justify-center p-4">
            <p className="text-xs text-dalam-text-muted">No problems</p>
          </div>
        )}
      </div>
    </div>
  );
}
