import { useEffect, useState, useRef } from "react";
import { useQuestion } from "@/store/useAppStore";
import { GitBranch, FolderOpen, Info, X } from "lucide-react";

export function QuestionDialog() {
  const { request, resolve } = useQuestion();
  const [selected, setSelected] = useState(0);
  const [customText, setCustomText] = useState("");
  const [focusedInput, setFocusedInput] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (request) {
      setSelected(0);
      setCustomText("");
      setFocusedInput(false);
    }
  }, [request]);

  useEffect(() => {
    if (!request) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        resolve(null);
      } else if (focusedInput) {
        if (e.key === "ArrowUp" || (e.key === "Tab" && e.shiftKey)) {
          e.preventDefault();
          setFocusedInput(false);
          setSelected(request.options.length - 1);
          inputRef.current?.blur();
          containerRef.current?.focus();
        } else if (e.key === "ArrowDown" || (e.key === "Tab" && !e.shiftKey)) {
          e.preventDefault();
          setFocusedInput(false);
          setSelected(0);
          inputRef.current?.blur();
          containerRef.current?.focus();
        } else if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          if (customText.trim()) {
            resolve({ selectedLabel: "Custom", customText: customText.trim() });
          }
        }
        return;
      } else if (e.key === "ArrowDown" || (e.key === "Tab" && !e.shiftKey)) {
        e.preventDefault();
        const max = request.options.length; // last index is the text input
        setSelected((i) => Math.min(i + 1, max));
        if (selected + 1 > request.options.length - 1) {
          setFocusedInput(true);
          setTimeout(() => inputRef.current?.focus(), 0);
        }
      } else if (e.key === "ArrowUp" || (e.key === "Tab" && e.shiftKey)) {
        e.preventDefault();
        setSelected((i) => Math.max(i - 1, 0));
        if (selected - 1 < 0) {
          setFocusedInput(false);
        }
      } else if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        if (selected < request.options.length) {
          resolve({ selectedLabel: request.options[selected].label });
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request, selected, customText, focusedInput]);

  useEffect(() => {
    if (request) containerRef.current?.focus();
  }, [request]);

  if (!request) return null;

  return (
    <div
      className="fixed inset-0 z-[55] flex items-center justify-center bg-black/55 backdrop-blur-sm animate-fade-in p-4"
      onMouseDown={(e) => { if (e.target === e.currentTarget) resolve(null); }}
    >
      <div
        ref={containerRef}
        tabIndex={-1}
        className="w-[760px] max-w-[96vw] surface shadow-2xl outline-none overflow-hidden"
        onKeyDown={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-acode-border-primary bg-acode-bg-secondary/50">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-sm font-medium text-acode-text-primary truncate">{request.header}</span>
            <span className="text-sm text-acode-text-primary truncate">{request.question}</span>
          </div>
          <div className="flex items-center gap-1.5 text-xs text-acode-text-muted flex-shrink-0">
            {request.workspaceName && (
              <>
                <FolderOpen className="w-3.5 h-3.5" />
                <span>{request.workspaceName}</span>
              </>
            )}
            {request.branch && (
              <>
                <GitBranch className="w-3.5 h-3.5 ml-2" />
                <span>{request.branch}</span>
              </>
            )}
            <span className="ml-2 text-acode-text-muted/60">1 / 1</span>
            <button className="ml-2 btn-icon p-1" onClick={() => resolve(null)} title="Close">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="px-4 py-4 space-y-1">
          {request.options.map((opt, idx) => {
            const active = idx === selected && !focusedInput;
            return (
              <button
                key={opt.label}
                onClick={() => resolve({ selectedLabel: opt.label })}
                onMouseEnter={() => { setSelected(idx); setFocusedInput(false); }}
                className={`w-full text-left flex items-start gap-3 px-3 py-2.5 rounded-lg transition-colors ${
                  active ? "bg-acode-bg-hover" : "hover:bg-acode-bg-hover/50"
                }`}
              >
                <span className="text-xs text-acode-text-muted w-4 mt-0.5 text-center flex-shrink-0">{idx + 1}.</span>
                <div className="flex-1 min-w-0">
                  <span className="text-sm text-acode-text-primary font-medium">{opt.label}</span>
                  <span className="text-sm text-acode-text-muted ml-2">{opt.description}</span>
                </div>
              </button>
            );
          })}

          {/* Free text input as the last "option" */}
          <div
            className={`flex items-start gap-3 px-3 py-2.5 rounded-lg transition-colors ${
              focusedInput ? "bg-acode-bg-hover" : "hover:bg-acode-bg-hover/50"
            }`}
            onMouseEnter={() => { setSelected(request.options.length); setFocusedInput(true); setTimeout(() => inputRef.current?.focus(), 0); }}
          >
            <span className="text-xs text-acode-text-muted w-4 mt-2 text-center flex-shrink-0">{request.options.length + 1}.</span>
            <input
              ref={inputRef}
              type="text"
              value={customText}
              onChange={(e) => setCustomText(e.target.value)}
              onFocus={() => { setSelected(request.options.length); setFocusedInput(true); }}
              onBlur={() => setFocusedInput(false)}
              placeholder="Enter your answer…"
              className="flex-1 bg-transparent border-0 outline-none text-sm text-acode-text-primary placeholder-acode-text-muted"
            />
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-4 py-3 border-t border-acode-border-primary">
          <div className="flex items-center gap-1.5 text-[11px] text-acode-text-muted">
            <Info className="w-3 h-3" />
            Use Tab / arrow keys to choose, then Enter or Space to select
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => resolve(null)}
              className="px-3 py-1.5 text-xs rounded-md text-acode-text-secondary hover:bg-acode-bg-hover transition-colors"
            >
              Dismiss
            </button>
            <button
              onClick={() => {
                if (focusedInput && customText.trim()) {
                  resolve({ selectedLabel: "Custom", customText: customText.trim() });
                } else if (selected < request.options.length) {
                  resolve({ selectedLabel: request.options[selected].label });
                } else {
                  resolve(null);
                }
              }}
              className="px-3 py-1.5 text-xs rounded-md bg-white text-black hover:opacity-90 transition-opacity font-medium"
            >
              Submit
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
