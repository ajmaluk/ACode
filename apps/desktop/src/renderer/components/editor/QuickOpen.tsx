import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { useWorkspace } from "@/store/useAppStore";
import { FileCode, FileText, Search, X } from "lucide-react";
import { basename } from "@/lib/pathUtils";

interface QuickOpenProps {
  onClose: () => void;
}

function flattenTree(
  nodes: { name: string; path: string; type: string; children?: unknown[] }[],
): string[] {
  const paths: string[] = [];
  for (const node of nodes) {
    if (node.type === "file") {
      paths.push(node.path);
    }
    if (node.children && Array.isArray(node.children)) {
      paths.push(
        ...flattenTree(
          node.children as {
            name: string;
            path: string;
            type: string;
            children?: unknown[];
          }[],
        ),
      );
    }
  }
  return paths;
}

function getFileIcon(name: string) {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (
    [
      "ts",
      "tsx",
      "js",
      "jsx",
      "json",
      "html",
      "css",
      "py",
      "rs",
      "go",
    ].includes(ext)
  )
    return FileCode;
  return FileText;
}

export function QuickOpen({ onClose }: QuickOpenProps) {
  const { fileTree, openFile } = useWorkspace();
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const allFiles = useMemo(() => flattenTree(fileTree), [fileTree]);

  const filtered = useMemo(() => {
    if (!query) return allFiles.slice(0, 50);
    const lower = query.toLowerCase();
    const scored = allFiles
      .map((path) => {
        const name = basename(path).toLowerCase();
        const relPath = path.toLowerCase();
        let score = 0;
        if (name === lower) score = 100;
        else if (name.startsWith(lower)) score = 80;
        else if (name.includes(lower)) score = 60;
        else if (relPath.includes(lower)) score = 40;
        // Fuzzy match
        else {
          let qi = 0;
          for (let i = 0; i < name.length && qi < lower.length; i++) {
            if (name[i] === lower[qi]) qi++;
          }
          if (qi === lower.length) score = 20;
        }
        return { path, score };
      })
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score);
    return scored.slice(0, 50).map((s) => s.path);
  }, [allFiles, query]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Clamp selectedIndex when filtered results shrink (avoid setState in effect)
  const safeIndex = Math.min(selectedIndex, Math.max(0, filtered.length - 1));

  const handleQueryChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setQuery(e.target.value);
      setSelectedIndex(0);
    },
    [],
  );

  const handleSelect = useCallback(
    async (path: string) => {
      await openFile(path);
      onClose();
    },
    [openFile, onClose],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter" && filtered[safeIndex]) {
        void handleSelect(filtered[safeIndex]);
      }
    },
    [onClose, filtered, safeIndex, handleSelect],
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]"
      onClick={onClose}
    >
      <div
        className="w-[560px] bg-dalam-bg-secondary border border-dalam-border-primary rounded-xl shadow-2xl overflow-hidden animate-fade-in"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Quick open file"
      >
        <div className="flex items-center gap-2 px-3 py-2 border-b border-dalam-border-primary">
          <Search className="w-4 h-4 text-dalam-text-muted flex-shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={handleQueryChange}
            onKeyDown={handleKeyDown}
            className="flex-1 bg-transparent border-0 outline-none text-sm text-dalam-text-primary placeholder:text-dalam-text-muted"
            placeholder="Search files by name"
          />
          <button
            onClick={onClose}
            className="text-dalam-text-muted hover:text-dalam-text-primary transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="max-h-[300px] overflow-y-auto">
          {filtered.length === 0 && (
            <div className="px-4 py-6 text-center text-xs text-dalam-text-muted">
              {query ? "No matching files" : "No files in workspace"}
            </div>
          )}
          {filtered.map((path, idx) => {
            const name = basename(path);
            const Icon = getFileIcon(name);
            const isSelected = idx === safeIndex;
            return (
              <button
                key={path}
                className={`w-full flex items-center gap-2 px-3 py-1.5 text-left transition-colors ${
                  isSelected
                    ? "bg-dalam-accent-subtle text-dalam-text-primary"
                    : "text-dalam-text-secondary hover:bg-dalam-bg-hover"
                }`}
                onClick={() => void handleSelect(path)}
                onMouseEnter={() => setSelectedIndex(idx)}
              >
                <Icon className="w-3.5 h-3.5 text-dalam-text-muted flex-shrink-0" />
                <span className="text-xs font-medium truncate">{name}</span>
                <span className="text-[10px] text-dalam-text-muted truncate ml-auto">
                  {path}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
