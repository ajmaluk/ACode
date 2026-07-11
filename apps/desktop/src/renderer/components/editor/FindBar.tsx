import { useState, useEffect, useRef, useCallback } from "react";
import { X, Replace, CaseSensitive, WholeWord, Regex } from "lucide-react";

interface FindBarProps {
  onSearch: (
    query: string,
    options: { caseSensitive: boolean; wholeWord: boolean; regex: boolean },
  ) => void;
  onReplace: (replacement: string) => void;
  onReplaceAll: (replacement: string) => void;
  onClose: () => void;
  matchCount: number;
  currentMatch: number;
  showReplace?: boolean;
}

export function FindBar({
  onSearch,
  onReplace,
  onReplaceAll,
  onClose,
  matchCount,
  currentMatch,
  showReplace,
}: FindBarProps) {
  const [query, setQuery] = useState("");
  const [replacement, setReplacement] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [useRegex, setUseRegex] = useState(false);
  const [showReplaceLocal, setShowReplace] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  // Use prop when provided, otherwise use local toggle state
  const showReplaceState =
    showReplace !== undefined ? showReplace : showReplaceLocal;

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const debounceTimerRef = useRef<number>(0);

  useEffect(() => {
    if (query) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = window.setTimeout(() => {
        onSearch(query, { caseSensitive, wholeWord, regex: useRegex });
      }, 150);
    }
    return () => clearTimeout(debounceTimerRef.current);
  }, [query, caseSensitive, wholeWord, useRegex, onSearch]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      } else if (e.key === "Enter" && e.shiftKey) {
        // Previous match — dispatch event for Monaco editor to handle
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("editor:find-previous"));
      } else if (e.key === "Enter") {
        // Next match — dispatch event for Monaco editor to handle
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("editor:find-next"));
      } else if (e.key === "Tab" && e.altKey) {
        e.preventDefault();
        setShowReplace((v) => !v);
      }
    },
    [onClose],
  );

  return (
    <div className="absolute top-0 right-0 z-30 bg-dalam-bg-secondary border border-dalam-border-primary border-t-0 border-r-0 rounded-bl-lg shadow-lg animate-fade-in">
      <div className="flex flex-col">
        {/* Search row */}
        <div className="flex items-center gap-1 p-1.5">
          <div className="relative flex items-center">
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              className="w-56 h-6 px-2 pr-14 text-xs bg-dalam-bg-primary border border-dalam-border-primary rounded text-dalam-text-primary placeholder:text-dalam-text-muted outline-none focus:border-dalam-accent-primary"
              placeholder="Find"
            />
            <span className="absolute right-2 text-[10px] text-dalam-text-muted">
              {query ? (matchCount > 0 ? `${currentMatch}/${matchCount}` : "No results") : ""}
            </span>
          </div>

          {/* Toggle buttons */}
          <button
            className={`w-6 h-6 flex items-center justify-center rounded transition-colors ${caseSensitive ? "bg-dalam-accent-subtle text-dalam-accent-primary" : "text-dalam-text-muted hover:text-dalam-text-primary hover:bg-dalam-bg-hover"}`}
            onClick={() => setCaseSensitive((v) => !v)}
            title="Match Case (Alt+C)"
          >
            <CaseSensitive className="w-3 h-3" />
          </button>
          <button
            className={`w-6 h-6 flex items-center justify-center rounded transition-colors ${wholeWord ? "bg-dalam-accent-subtle text-dalam-accent-primary" : "text-dalam-text-muted hover:text-dalam-text-primary hover:bg-dalam-bg-hover"}`}
            onClick={() => setWholeWord((v) => !v)}
            title="Match Whole Word (Alt+W)"
          >
            <WholeWord className="w-3 h-3" />
          </button>
          <button
            className={`w-6 h-6 flex items-center justify-center rounded transition-colors ${useRegex ? "bg-dalam-accent-subtle text-dalam-accent-primary" : "text-dalam-text-muted hover:text-dalam-text-primary hover:bg-dalam-bg-hover"}`}
            onClick={() => setUseRegex((v) => !v)}
            title="Use Regular Expression (Alt+R)"
          >
            <Regex className="w-3 h-3" />
          </button>

          <div className="w-px h-4 bg-dalam-border-primary mx-0.5" />

          {/* Replace toggle */}
          <button
            className={`w-6 h-6 flex items-center justify-center rounded transition-colors ${showReplaceState ? "bg-dalam-accent-subtle text-dalam-accent-primary" : "text-dalam-text-muted hover:text-dalam-text-primary hover:bg-dalam-bg-hover"}`}
            onClick={() => setShowReplace((v) => !v)}
            title="Toggle Replace (Alt+Tab)"
          >
            <Replace className="w-3 h-3" />
          </button>

          <button
            className="w-6 h-6 flex items-center justify-center rounded text-dalam-text-muted hover:text-dalam-text-primary hover:bg-dalam-bg-hover transition-colors"
            onClick={onClose}
            title="Close (Escape)"
          >
            <X className="w-3 h-3" />
          </button>
        </div>

        {/* Replace row */}
        {showReplaceState && (
          <div className="flex items-center gap-1 p-1.5 pt-0">
            <input
              type="text"
              value={replacement}
              onChange={(e) => setReplacement(e.target.value)}
              onKeyDown={handleKeyDown}
              className="w-56 h-6 px-2 text-xs bg-dalam-bg-primary border border-dalam-border-primary rounded text-dalam-text-primary placeholder:text-dalam-text-muted outline-none focus:border-dalam-accent-primary"
              placeholder="Replace"
            />
            <button
              className="h-6 px-2 text-[10px] text-dalam-text-secondary hover:text-dalam-text-primary hover:bg-dalam-bg-hover rounded transition-colors"
              onClick={() => onReplace(replacement)}
              title="Replace (Cmd+Shift+1)"
            >
              Replace
            </button>
            <button
              className="h-6 px-2 text-[10px] text-dalam-text-secondary hover:text-dalam-text-primary hover:bg-dalam-bg-hover rounded transition-colors"
              onClick={() => onReplaceAll(replacement)}
              title="Replace All (Cmd+Alt+Enter)"
            >
              All
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
