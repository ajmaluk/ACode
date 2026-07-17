import { useState, useRef, useCallback, useEffect } from "react";
import { useUI, useChat, useTerminal, useWorkspace } from "@/store/useAppStore";
import { TerminalPanel } from "./TerminalPanel";
import {
  TerminalSquare,
  PanelBottomClose,
  AlertTriangle,
  Info,
} from "lucide-react";
import { Tooltip } from "@/components/ui/Tooltip";
import { modKey } from "@/lib/platform";

type BottomTab = "terminal" | "output" | "problems";

const TABS: { id: BottomTab; icon: React.ElementType; label: string }[] = [
  { id: "terminal", icon: TerminalSquare, label: "Terminal" },
  { id: "output", icon: Info, label: "Output" },
  { id: "problems", icon: AlertTriangle, label: "Problems" },
];

function OutputTab() {
  const [output, setOutput] = useState<Array<{ id: number; text: string }>>([]);
  const idCounter = useRef(0);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.text) {
        const id = idCounter.current++;
        setOutput((prev) => [...prev.slice(-200), { id, text: detail.text }]);
      }
    };
    window.addEventListener("dalam:build-output", handler);
    return () => window.removeEventListener("dalam:build-output", handler);
  }, []);

  return (
    <div className="h-full overflow-auto p-3 font-mono text-xs text-dalam-text-secondary">
      {output.length === 0 ? (
        <p className="text-dalam-text-muted">
          No output yet. Build output will appear here.
        </p>
      ) : (
        output.map((line) => (
          <div key={line.id} className="whitespace-pre-wrap">
            {line.text}
          </div>
        ))
      )}
    </div>
  );
}

function ProblemsTab() {
  const [problems, setProblems] = useState<
    Array<{ id: number; severity: string; message: string; file?: string; line?: number }>
  >([]);
  const problemIdCounter = useRef(0);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.problems) {
        const withIds = detail.problems.map((p: { severity: string; message: string; file?: string; line?: number }) => ({
          ...p,
          id: problemIdCounter.current++,
        }));
        setProblems(withIds);
      }
    };
    window.addEventListener("dalam:problems-update", handler);
    return () => window.removeEventListener("dalam:problems-update", handler);
  }, []);

  return (
    <div className="h-full overflow-auto">
      {problems.length === 0 ? (
        <div className="p-3 text-xs text-dalam-text-muted">
          No problems detected.
        </div>
      ) : (
        problems.map((p) => (
          <div
            key={p.id}
            className="flex items-start gap-2 px-3 py-1.5 text-xs hover:bg-dalam-bg-hover border-b border-dalam-border-primary/30"
          >
            <span
              className={
                p.severity === "error" ? "text-dalam-git-deleted" : "text-amber-400"
              }
            >
              {p.severity === "error" ? "✕" : "⚠"}
            </span>
            <span className="text-dalam-text-primary flex-1">{p.message}</span>
            {p.file && (
              <span className="text-dalam-text-muted flex-shrink-0">
                {p.file}
                {p.line ? `:${p.line}` : ""}
              </span>
            )}
          </div>
        ))
      )}
    </div>
  );
}

export function BottomPanel() {
  const {
    bottomPanelTab: tab,
    setBottomPanelTab: setTab,
    setBottomPanelOpen,
  } = useUI();
  const { session } = useChat();
  const [height, setHeight] = useState(() => {
    try {
      const saved = localStorage.getItem("dalam.bottomPanelHeight");
      return saved ? parseInt(saved, 10) || 220 : 220;
    } catch (e) {
      if (import.meta.env.DEV) console.warn("[BottomPanel] Failed to read saved height:", e);
      return 220;
    }
  });
  const draggingRef = useRef(false);
  const startYRef = useRef(0);
  const startHeightRef = useRef(0);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      draggingRef.current = true;
      startYRef.current = e.clientY;
      startHeightRef.current = height;
      let rafId: number | null = null;
      let lastHeight = height;

      const handleMouseMove = (e: MouseEvent) => {
        if (!draggingRef.current) return;
        const delta = startYRef.current - e.clientY;
        lastHeight = Math.max(
          100,
          Math.min(startHeightRef.current + delta, window.innerHeight * 0.5),
        );
        if (rafId !== null) cancelAnimationFrame(rafId);
        rafId = requestAnimationFrame(() => {
          rafId = null;
          setHeight(lastHeight);
        });
      };

      const handleMouseUp = () => {
        draggingRef.current = false;
        if (rafId !== null) cancelAnimationFrame(rafId);
        document.removeEventListener("mousemove", handleMouseMove);
        document.removeEventListener("mouseup", handleMouseUp);
        moveHandlerRef.current = null;
        upHandlerRef.current = null;
        // Persist height once on mouseup instead of every mousemove
        try {
          localStorage.setItem("dalam.bottomPanelHeight", String(lastHeight));
        } catch (e) {
          if (import.meta.env.DEV) console.warn("[BottomPanel] Failed to persist panel height:", e);
        }
      };

      moveHandlerRef.current = handleMouseMove;
      upHandlerRef.current = handleMouseUp;
      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
    },
    [height],
  );

  // Cleanup drag listeners on unmount to prevent leaks
  const moveHandlerRef = useRef<((e: MouseEvent) => void) | null>(null);
  const upHandlerRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    return () => {
      draggingRef.current = false;
      // Remove any lingering document listeners from active drag
      if (moveHandlerRef.current) {
        document.removeEventListener("mousemove", moveHandlerRef.current);
        moveHandlerRef.current = null;
      }
      if (upHandlerRef.current) {
        document.removeEventListener("mouseup", upHandlerRef.current);
        upHandlerRef.current = null;
      }
    };
  }, []);

  // Auto-open terminal tab when bottom panel opens with a workspace
  useEffect(() => {
    const ws = useWorkspace
      .getState()
      .workspaces.find(
        (w) => w.id === useWorkspace.getState().activeWorkspaceId,
      );
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
        <div className="flex items-center gap-0" role="tablist" aria-label="Bottom panel tabs">
          {TABS.map((t) => {
            const Icon = t.icon;
            const isActive = tab === t.id;
            const tabId = `bottom-tab-${t.id}`;
            const panelId = `bottom-panel-${t.id}`;
            return (
              <button
                key={t.id}
                id={tabId}
                onClick={() => setTab(t.id)}
                role="tab"
                aria-selected={isActive}
                aria-controls={panelId}
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
              type="button"
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
        {tab === "terminal" && (
          <div role="tabpanel" id="bottom-panel-terminal" aria-labelledby="bottom-tab-terminal" className="h-full">
            <TerminalPanel />
          </div>
        )}
        {tab === "output" && (
          <div role="tabpanel" id="bottom-panel-output" aria-labelledby="bottom-tab-output" className="h-full">
            <OutputTab />
          </div>
        )}
        {tab === "problems" && (
          <div role="tabpanel" id="bottom-panel-problems" aria-labelledby="bottom-tab-problems" className="h-full">
            <ProblemsTab />
          </div>
        )}
      </div>
    </div>
  );
}
