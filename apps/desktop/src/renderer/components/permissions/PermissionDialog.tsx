import { useEffect, useState, useRef, useCallback } from "react";
import { usePermission } from "@/store/useAppStore";
import { Terminal, AlertCircle, Check, X, Shield } from "lucide-react";

const OPTIONS = [
  {
    key: "allow",
    label: "Allow",
    sub: "Allow only this time",
    icon: Check,
    action: "allow" as const,
  },
  {
    key: "always",
    label: "Always allow in this project",
    sub: "Do not ask again for the same command",
    icon: Shield,
    action: "always" as const,
  },
  {
    key: "deny",
    label: "Deny",
    sub: "Reject it for now",
    icon: X,
    action: "deny" as const,
  },
];
const NUM_OPTIONS = OPTIONS.length;

export function PermissionDialog() {
  const { request, resolve, cancel } = usePermission();
  const [selected, setSelected] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const selectedRef = useRef(0);
  const resolveRef = useRef(resolve);
  const cancelRef = useRef(cancel);

  useEffect(() => {
    resolveRef.current = resolve;
  }, [resolve]);
  useEffect(() => {
    cancelRef.current = cancel;
  }, [cancel]);

  const decide = useCallback((idx: number) => {
    resolveRef.current(OPTIONS[idx]?.action ?? "deny");
  }, []);

  const [requestId, setRequestId] = useState(request?.id);
  const prevRequestIdRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (request?.id !== prevRequestIdRef.current && request?.id !== requestId) {
      prevRequestIdRef.current = request?.id;
      setRequestId(request?.id);
      setSelected(0);
      selectedRef.current = 0;
    }
  }, [request?.id, requestId]);

  useEffect(() => {
    if (!request) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        cancelRef.current();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        const next = Math.min(selectedRef.current + 1, NUM_OPTIONS - 1);
        selectedRef.current = next;
        setSelected(next);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        const next = Math.max(selectedRef.current - 1, 0);
        selectedRef.current = next;
        setSelected(next);
      } else if (e.key === "Tab") {
        e.preventDefault();
        const next = (selectedRef.current + 1) % NUM_OPTIONS;
        selectedRef.current = next;
        setSelected(next);
      } else if (e.key === "Enter") {
        e.preventDefault();
        decide(selectedRef.current);
      } else if (e.key === "1") {
        decide(0);
      } else if (e.key === "2") {
        decide(1);
      } else if (e.key === "3") {
        decide(2);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [request, decide]);

  useEffect(() => {
    if (request) containerRef.current?.focus();
  }, [request]);

  if (!request) return null;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm animate-fade-in"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) {
          e.preventDefault();
          cancel();
        }
      }}
    >
      <div
        ref={containerRef}
        tabIndex={-1}
        role="dialog"
        aria-label="Permission request"
        className="w-[560px] max-w-[92vw] surface shadow-2xl outline-none"
        onKeyDown={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-dalam-border-primary">
          <div className="flex items-center gap-2">
            <span className="px-2 py-0.5 text-xs font-medium rounded-md bg-dalam-bg-tertiary text-dalam-text-primary border border-dalam-border-primary">
              {request.title}
            </span>
            <span className="text-sm text-dalam-text-secondary">
              command permission required
            </span>
          </div>
        </div>

        {/* Body */}
        <div className="px-4 py-4 space-y-3">
          {request.description && (
            <p className="text-sm text-dalam-text-primary">
              {request.description}
            </p>
          )}

          {request.kind === "bash" && (
            <div className="flex items-center gap-2 text-xs text-dalam-text-muted">
              <Terminal className="w-3.5 h-3.5" />
              <span>Awaiting approval</span>
            </div>
          )}

          {request.command && (
            <div className="bg-dalam-bg-primary border border-dalam-border-primary rounded-lg p-3 font-mono text-[12.5px] text-dalam-text-primary overflow-x-auto scrollbar-thin">
              <div className="whitespace-pre-wrap break-words">
                {request.command}
              </div>
              {request.output !== undefined && (
                <div className="mt-2 pt-2 border-t border-dalam-border-primary text-dalam-text-muted">
                  {request.output || "No output."}
                </div>
              )}
            </div>
          )}

          {/* Options */}
          <div className="space-y-1 pt-1">
            {OPTIONS.map((opt, idx) => {
              const Icon = opt.icon;
              const active = idx === selected;
              return (
                <button
                  key={opt.key}
                  onClick={() => {
                    setSelected(idx);
                    selectedRef.current = idx;
                  }}
                  className={`w-full text-left px-3 py-2.5 rounded-lg flex items-start gap-3 transition-colors ${
                    active
                      ? "bg-dalam-bg-hover border border-dalam-border-primary"
                      : "border border-transparent hover:bg-dalam-bg-hover/50"
                  }`}
                >
                  <span className="text-xs text-dalam-text-muted w-4 text-center mt-0.5">
                    {idx + 1}.
                  </span>
                  <Icon
                    className={`w-4 h-4 flex-shrink-0 ${opt.key === "deny" ? "text-dalam-git-deleted" : opt.key === "always" ? "text-dalam-git-added" : "text-dalam-accent-primary"}`}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-dalam-text-primary font-medium">
                      {opt.label}
                    </div>
                    <div className="text-xs text-dalam-text-muted">
                      {opt.sub}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-4 py-3 border-t border-dalam-border-primary">
          <div className="flex items-center gap-1.5 text-[11px] text-dalam-text-muted">
            <AlertCircle className="w-3 h-3" />
            Use Tab / arrow keys to choose, then press Enter to confirm
          </div>
          <button
            onClick={() => decide(selectedRef.current)}
            className="px-3 py-1.5 text-xs rounded-md bg-dalam-text-primary text-dalam-bg-primary hover:opacity-90 transition-opacity font-medium"
          >
            Confirm {OPTIONS[selected].label}
          </button>
        </div>
      </div>
    </div>
  );
}
