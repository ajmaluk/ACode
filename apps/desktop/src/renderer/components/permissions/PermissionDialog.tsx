import { useEffect, useState, useRef } from "react";
import { usePermission } from "@/store/useAppStore";
import { Terminal, AlertCircle, Check, X, Shield } from "lucide-react";

export function PermissionDialog() {
  const { request, resolve, cancel } = usePermission();
  const [selected, setSelected] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (request) setSelected(0);
  }, [request]);

  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  useEffect(() => {
    if (!request) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        cancel();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelected((i) => Math.min(i + 1, NUM_OPTIONS - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelected((i) => Math.max(i - 1, 0));
      } else if (e.key === "Tab") {
        e.preventDefault();
        setSelected((i) => (i + 1) % NUM_OPTIONS);
      } else if (e.key === "Enter" || e.key === " ") {
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);

  useEffect(() => {
    if (request) containerRef.current?.focus();
  }, [request]);

  if (!request) return null;

  const decide = (idx: number) => {
    if (idx === 0) resolve("allow");
    else if (idx === 1) resolve("always");
    else resolve("deny");
  };

  const options = [
    { key: "allow",  label: "Allow",  sub: "Allow only this time",              icon: Check },
    { key: "always", label: "Always allow in this project", sub: "Do not ask again for the same command", icon: Shield },
    { key: "deny",   label: "Deny",   sub: "Reject it for now",                 icon: X },
  ];
  const NUM_OPTIONS = options.length;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm animate-fade-in"
      onMouseDown={(e) => { if (e.target === e.currentTarget) { e.preventDefault(); cancel(); } }}
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
        <div className="flex items-center gap-2 px-4 py-3 border-b border-acode-border-primary">
          <div className="flex items-center gap-2">
            <span className="px-2 py-0.5 text-xs font-medium rounded-md bg-acode-bg-tertiary text-acode-text-primary border border-acode-border-primary">
              {request.title}
            </span>
            <span className="text-sm text-acode-text-secondary">command permission required</span>
          </div>
        </div>

        {/* Body */}
        <div className="px-4 py-4 space-y-3">
          {request.description && (
            <p className="text-sm text-acode-text-primary">{request.description}</p>
          )}

          {request.kind === "bash" && (
            <div className="flex items-center gap-2 text-xs text-acode-text-muted">
              <Terminal className="w-3.5 h-3.5" />
              <span>Awaiting approval</span>
            </div>
          )}

          {request.command && (
            <div className="bg-acode-bg-primary border border-acode-border-primary rounded-lg p-3 font-mono text-[12.5px] text-acode-text-primary overflow-x-auto scrollbar-thin">
              <div className="whitespace-pre-wrap break-words">{request.command}</div>
              {request.output !== undefined && (
                <div className="mt-2 pt-2 border-t border-acode-border-primary text-acode-text-muted">
                  {request.output || "No output."}
                </div>
              )}
            </div>
          )}

          {/* Options */}
          <div className="space-y-1 pt-1">
            {options.map((opt, idx) => {
              const Icon = opt.icon;
              const active = idx === selected;
              return (
                <button
                  key={opt.key}
                  onClick={() => decide(idx)}
                  onMouseEnter={() => setSelected(idx)}
                  className={`w-full text-left px-3 py-2.5 rounded-lg flex items-center gap-3 transition-colors ${
                    active ? "bg-acode-bg-hover border border-acode-border-primary" : "border border-transparent hover:bg-acode-bg-hover/50"
                  }`}
                >
                  <span className="text-xs text-acode-text-muted w-4 text-center">{idx + 1}.</span>
                  <Icon className={`w-4 h-4 flex-shrink-0 ${opt.key === "deny" ? "text-acode-git-deleted" : opt.key === "always" ? "text-acode-git-added" : "text-acode-accent-primary"}`} />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-acode-text-primary font-medium">{opt.label}</div>
                    <div className="text-xs text-acode-text-muted">{opt.sub}</div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-4 py-3 border-t border-acode-border-primary">
          <div className="flex items-center gap-1.5 text-[11px] text-acode-text-muted">
            <AlertCircle className="w-3 h-3" />
            Use Tab / arrow keys to choose, then press Enter to confirm
          </div>
          <button
            onClick={() => decide(selectedRef.current)}
            className="px-3 py-1.5 text-xs rounded-md bg-acode-text-primary text-acode-bg-primary hover:opacity-90 transition-opacity font-medium"
          >
            Confirm {options[selected].label}
          </button>
        </div>
      </div>
    </div>
  );
}
