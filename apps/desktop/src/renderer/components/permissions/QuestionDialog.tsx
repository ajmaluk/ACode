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
  const selectedRef = useRef(0);
  const customTextRef = useRef("");
  const focusedInputRef = useRef(false);

  useEffect(() => {
    selectedRef.current = selected;
  }, [selected]);
  useEffect(() => {
    customTextRef.current = customText;
  }, [customText]);
  useEffect(() => {
    focusedInputRef.current = focusedInput;
  }, [focusedInput]);

  useEffect(() => {
    if (!request) {
      selectedRef.current = 0;
      customTextRef.current = "";
      focusedInputRef.current = false;
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        resolve(null);
      } else if (focusedInputRef.current) {
        if (e.key === "ArrowUp" || (e.key === "Tab" && e.shiftKey)) {
          e.preventDefault();
          focusedInputRef.current = false;
          selectedRef.current = request.options.length > 0 ? request.options.length - 1 : 0;
          setSelected(selectedRef.current);
          inputRef.current?.blur();
          containerRef.current?.focus();
        } else if (e.key === "ArrowDown" || (e.key === "Tab" && !e.shiftKey)) {
          e.preventDefault();
          focusedInputRef.current = false;
          selectedRef.current = 0;
          setSelected(selectedRef.current);
          inputRef.current?.blur();
          containerRef.current?.focus();
        } else if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          const text = customTextRef.current.trim();
          if (text) {
            resolve({ selectedLabel: "Custom", customText: text });
          }
        }
        return;
      } else if (e.key === "ArrowDown" || (e.key === "Tab" && !e.shiftKey)) {
        e.preventDefault();
        const max = request.options.length;
        selectedRef.current = Math.min(selectedRef.current + 1, max);
        setSelected(selectedRef.current);
        if (selectedRef.current > request.options.length - 1) {
          focusedInputRef.current = true;
          setFocusedInput(true);
          setTimeout(() => inputRef.current?.focus(), 0);
        }
      } else if (e.key === "ArrowUp" || (e.key === "Tab" && e.shiftKey)) {
        e.preventDefault();
        selectedRef.current = Math.max(selectedRef.current - 1, 0);
        setSelected(selectedRef.current);
      } else if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        if (selectedRef.current >= 0 && selectedRef.current < request.options.length) {
          resolve({ selectedLabel: request.options[selectedRef.current].label });
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [request, resolve]);

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
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-dalam-border-primary bg-dalam-bg-secondary/50">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-sm font-medium text-dalam-text-primary truncate">{request.header}</span>
            <span className="text-sm text-dalam-text-primary truncate">{request.question}</span>
          </div>
          <div className="flex items-center gap-1.5 text-xs text-dalam-text-muted flex-shrink-0">
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
            <span className="ml-2 text-dalam-text-muted/60">1 / 1</span>
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
                  active ? "bg-dalam-bg-hover" : "hover:bg-dalam-bg-hover/50"
                }`}
              >
                <span className="text-xs text-dalam-text-muted w-4 mt-0.5 text-center flex-shrink-0">{idx + 1}.</span>
                <div className="flex-1 min-w-0">
                  <span className="text-sm text-dalam-text-primary font-medium">{opt.label}</span>
                  <span className="text-sm text-dalam-text-muted ml-2">{opt.description}</span>
                </div>
              </button>
            );
          })}

          {/* Free text input as the last "option" */}
          <div
            className={`flex items-start gap-3 px-3 py-2.5 rounded-lg transition-colors ${
              focusedInput ? "bg-dalam-bg-hover" : "hover:bg-dalam-bg-hover/50"
            }`}
            onMouseEnter={() => { setSelected(request.options.length); setFocusedInput(true); setTimeout(() => inputRef.current?.focus(), 0); }}
          >
            <span className="text-xs text-dalam-text-muted w-4 mt-2 text-center flex-shrink-0">{request.options.length + 1}.</span>
            <input
              ref={inputRef}
              type="text"
              value={customText}
              onChange={(e) => setCustomText(e.target.value)}
              onFocus={() => { setSelected(request.options.length); setFocusedInput(true); }}
              onBlur={() => setFocusedInput(false)}
              placeholder="Enter your answer…"
              className="flex-1 bg-transparent border-0 outline-none text-sm text-dalam-text-primary placeholder-dalam-text-muted"
            />
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-4 py-3 border-t border-dalam-border-primary">
          <div className="flex items-center gap-1.5 text-[11px] text-dalam-text-muted">
            <Info className="w-3 h-3" />
            Use Tab / arrow keys to choose, then Enter or Space to select
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => resolve(null)}
              className="px-3 py-1.5 text-xs rounded-md text-dalam-text-secondary hover:bg-dalam-bg-hover transition-colors"
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
