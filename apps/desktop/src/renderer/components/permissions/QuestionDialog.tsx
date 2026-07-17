import { useLayoutEffect, useState, useRef, useCallback } from "react";
import { useQuestion } from "@/store/useAppStore";
import { GitBranch, FolderOpen, Info, X } from "lucide-react";

export function QuestionDialog() {
  const { request, resolve } = useQuestion();
  const [selected, setSelected] = useState(0);
  const [customText, setCustomText] = useState("");
  const [inputFocused, setInputFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const optionCount = request?.options?.length ?? 0;
  const maxIndex = request?.allowFreeText !== false ? optionCount : optionCount - 1;

  // Reset state when a new question appears
  const prevRequestIdRef = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    if (request?.id !== prevRequestIdRef.current) {
      prevRequestIdRef.current = request?.id;
      setSelected(0);
      setCustomText("");
      setInputFocused(false);
    }
  }, [request?.id]);

  useLayoutEffect(() => {
    if (request) {
      containerRef.current?.focus();
      // Focus the first option when dialog opens
      const buttons = containerRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]');
      if (buttons && buttons[0]) {
        buttons[0].focus();
      }
    }
  }, [request]);

  // All keyboard handling lives in the container's onKeyDown so stopPropagation
  // blocks global shortcuts (Ctrl+K etc.) while still processing dialog keys.
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!request) return;

      if (e.key === "Escape") {
        e.preventDefault();
        resolve(null);
        return;
      }

      if (e.key === "ArrowDown" || (e.key === "Tab" && !e.shiftKey)) {
        e.preventDefault();
        setSelected((prev) => {
          const next = Math.min(prev + 1, maxIndex);
          if (next === maxIndex) {
            requestAnimationFrame(() => inputRef.current?.focus());
          }
          return next;
        });
        setInputFocused(false);
      } else if (e.key === "ArrowUp" || (e.key === "Tab" && e.shiftKey)) {
        e.preventDefault();
        setSelected((prev) => {
          const next = Math.max(prev - 1, 0);
          if (next < maxIndex) {
            inputRef.current?.blur();
          }
          return next;
        });
        setInputFocused(false);
      } else if (e.key === "Enter" || (e.key === " " && !inputFocused)) {
        e.preventDefault();
        if (inputFocused && customText.trim()) {
          resolve({ selectedLabel: "Custom", customText: customText.trim() });
        } else if (selected >= 0 && selected < optionCount) {
          resolve({ selectedLabel: request.options[selected].label });
        }
      }
      // Space key falls through for input typing when inputFocused is true
    },
    [
      request,
      resolve,
      inputFocused,
      customText,
      selected,
      optionCount,
      maxIndex,
    ],
  );

  const handleSubmit = useCallback(() => {
    if (!request) return;
    if (inputFocused && customText.trim()) {
      resolve({ selectedLabel: "Custom", customText: customText.trim() });
    } else if (selected >= 0 && selected < optionCount) {
      resolve({ selectedLabel: request.options[selected].label });
    } else {
      resolve(null);
    }
  }, [request, resolve, inputFocused, customText, selected, optionCount]);

  if (!request) return null;

  return (
    <div
      className="fixed inset-0 z-[55] flex items-center justify-center bg-black/55 backdrop-blur-sm animate-fade-in p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) resolve(null);
      }}
    >
      <div
        ref={containerRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={request.question}
        className="w-[760px] max-w-[96vw] surface shadow-2xl outline-none overflow-hidden"
        onKeyDown={handleKeyDown}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-dalam-border-primary bg-dalam-bg-secondary/50">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-sm font-medium text-dalam-text-primary truncate">
              {request.header}
            </span>
            <span className="text-sm text-dalam-text-primary truncate">
              {request.question}
            </span>
          </div>
          <div className="flex items-center gap-1.5 text-xs text-dalam-text-muted flex-shrink-0">
            {request.workspaceName && (
              <>
                <FolderOpen className="w-3.5 h-3.5" aria-hidden="true" />
                <span>{request.workspaceName}</span>
              </>
            )}
            {request.branch && (
              <>
                <GitBranch className="w-3.5 h-3.5 ml-2" aria-hidden="true" />
                <span>{request.branch}</span>
              </>
            )}
            <span className="ml-2 text-dalam-text-muted/60">1 / 1</span>
            <button
              type="button"
              className="ml-2 btn-icon p-1"
              onClick={() => resolve(null)}
              title="Close"
              aria-label="Close"
            >
              <X className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="px-4 py-4 space-y-1">
          {request.options.map((opt, idx) => {
            const active = idx === selected && !inputFocused;
            return (
              <button
                key={opt.label}
                type="button"
                role="option"
                aria-selected={idx === selected && !inputFocused}
                onClick={() => {
                  setSelected(idx);
                  setInputFocused(false);
                }}
                onMouseEnter={() => {
                  setSelected(idx);
                  setInputFocused(false);
                }}
                className={`w-full text-left flex items-start gap-3 px-3 py-2.5 rounded-lg transition-colors ${
                  active ? "bg-dalam-bg-hover" : "hover:bg-dalam-bg-hover/50"
                }`}
              >
                <span className="text-xs text-dalam-text-muted w-4 mt-0.5 text-center flex-shrink-0">
                  {idx + 1}.
                </span>
                <div className="flex-1 min-w-0">
                  <span className="text-sm text-dalam-text-primary font-medium">
                    {opt.label}
                  </span>
                  {opt.description && (
                    <span className="text-sm text-dalam-text-muted ml-2">
                      {opt.description}
                    </span>
                  )}
                </div>
              </button>
            );
          })}

          {/* Free text input as the last "option" */}
          {request.allowFreeText !== false && (
            <div
              className={`flex items-start gap-3 px-3 py-2.5 rounded-lg transition-colors ${
                selected === maxIndex && inputFocused
                  ? "bg-dalam-bg-hover"
                  : "hover:bg-dalam-bg-hover/50"
              }`}
              onMouseEnter={() => {
                setSelected(maxIndex);
              }}
              onClick={() => {
                setSelected(maxIndex);
                setInputFocused(true);
                inputRef.current?.focus();
              }}
            >
              <span className="text-xs text-dalam-text-muted w-4 mt-2 text-center flex-shrink-0">
                {optionCount + 1}.
              </span>
              <input
                ref={inputRef}
                type="text"
                value={customText}
                onChange={(e) => setCustomText(e.target.value)}
                onFocus={() => {
                  setSelected(maxIndex);
                  setInputFocused(true);
                }}
                onBlur={() => setInputFocused(false)}
                placeholder="Enter your answer…"
                className="flex-1 bg-transparent border-0 outline-none text-sm text-dalam-text-primary placeholder:text-dalam-text-muted"
              />
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-4 py-3 border-t border-dalam-border-primary">
          <div className="flex items-center gap-1.5 text-[11px] text-dalam-text-muted">
            <Info className="w-3 h-3" aria-hidden="true" />
            Use Tab / arrow keys to choose, then Enter or Space to select
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => resolve(null)}
              className="px-3 py-1.5 text-xs rounded-md text-dalam-text-secondary hover:bg-dalam-bg-hover transition-colors"
            >
              Dismiss
            </button>
            <button
              type="button"
              onClick={handleSubmit}
              className="px-3 py-1.5 text-xs rounded-md bg-dalam-text-primary text-dalam-bg-primary hover:opacity-90 transition-opacity font-medium"
            >
              Submit
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
