import { useRef, useState, useEffect, useCallback } from "react";
import { useWorkspace } from "@/store/useAppStore";
import { useToast } from "@/components/ui/toastStore";
import { ChevronRight, FileCode, Copy, TerminalSquare, FolderSearch } from "lucide-react";
import { splitPath } from "@/lib/pathUtils";
import { showContextMenu } from "@/components/ui/contextMenuUtils";
import { copyToClipboard, revealInFinder, openInTerminal } from "@/lib/editorHelpers";

export function Breadcrumb() {
  const { activeFilePath, workspaces, activeWorkspaceId } = useWorkspace();
  const toast = useToast();
  const activeWorkspace = workspaces.find((w) => w.id === activeWorkspaceId);
  const [focused, setFocused] = useState<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Total segments: directory segments + file segment
  const parts = activeFilePath ? splitPath(activeFilePath) : [];
  const totalSegments = parts.length; // parts includes filename at the end

  // Reset focus when file changes
  useEffect(() => { setFocused(null); }, [activeFilePath]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (!totalSegments) return;
    if (e.altKey && e.key === "ArrowLeft") {
      e.preventDefault();
      setFocused((prev) => (prev === null || prev <= 0) ? 0 : prev - 1);
    } else if (e.altKey && e.key === "ArrowRight") {
      e.preventDefault();
      setFocused((prev) => (prev === null || prev >= totalSegments - 1) ? totalSegments - 1 : prev + 1);
    } else if (e.key === "Enter" && focused !== null) {
      e.preventDefault();
      // Simulate click on the focused segment button
      const btns = containerRef.current?.querySelectorAll<HTMLElement>("button");
      btns?.[focused]?.click();
    } else if (e.key === "Escape") {
      e.preventDefault();
      setFocused(null);
    }
  }, [totalSegments, focused]);

  if (!activeFilePath) {
    return (
      <div className="h-7 px-3 flex items-center text-[11px] text-dalam-text-muted border-b border-dalam-border-primary bg-dalam-bg-secondary">
        <span>No file open</span>
      </div>
    );
  }

  const pathParts = splitPath(activeFilePath);
  const fileName = pathParts.pop() ?? "";
  const basePath = activeWorkspace?.path ?? "";

  /** Build absolute path for a directory segment at the given index */
  const segFullPath = (idx: number) => basePath
    ? basePath + "/" + pathParts.slice(0, idx + 1).join("/")
    : pathParts.slice(0, idx + 1).join("/");
  /** Absolute path to the file itself */
  const fileFullPath = basePath ? basePath + "/" + pathParts.join("/") + "/" + fileName : pathParts.join("/") + "/" + fileName;
  const fileRelPath = pathParts.join("/") + "/" + fileName;

  const handleSegmentClick = (idx: number) => copyToClipboard(segFullPath(idx), toast);

  const handleSegmentContextMenu = (e: React.MouseEvent, idx: number) => {
    e.preventDefault();
    e.stopPropagation();
    const fullPath = segFullPath(idx);
    const relPath = pathParts.slice(0, idx + 1).join("/");
    showContextMenu(e, [
      { type: "item", label: "Copy Absolute Path", icon: <Copy className="w-3.5 h-3.5" />, perform: () => copyToClipboard(fullPath, toast) },
      { type: "item", label: "Copy Relative Path", icon: <Copy className="w-3.5 h-3.5" />, perform: () => copyToClipboard(relPath, toast) },
      { type: "separator" },
      { type: "item", label: "Reveal in Finder", icon: <FolderSearch className="w-3.5 h-3.5" />, perform: () => revealInFinder(fullPath) },
      { type: "item", label: "Open in Terminal", icon: <TerminalSquare className="w-3.5 h-3.5" />, perform: () => openInTerminal(fullPath) },
    ]);
  };

  const handleFileContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    showContextMenu(e, [
      { type: "item", label: "Copy Absolute Path", icon: <Copy className="w-3.5 h-3.5" />, perform: () => copyToClipboard(fileFullPath, toast) },
      { type: "item", label: "Copy Relative Path", icon: <Copy className="w-3.5 h-3.5" />, perform: () => copyToClipboard(fileRelPath, toast) },
      { type: "separator" },
      { type: "item", label: "Reveal in Finder", icon: <FolderSearch className="w-3.5 h-3.5" />, perform: () => revealInFinder(fileFullPath) },
      { type: "item", label: "Open in Terminal", icon: <TerminalSquare className="w-3.5 h-3.5" />, perform: () => openInTerminal(activeWorkspace?.path ?? pathParts.slice(0, -1).join("/")) },
    ]);
  };

  const focusClass = "outline-none ring-1 ring-dalam-accent-primary bg-dalam-accent-subtle";

  return (
    <div
      ref={containerRef}
      className="h-7 px-3 flex items-center text-[11px] border-b border-dalam-border-primary bg-dalam-bg-secondary overflow-x-auto scrollbar-thin"
      role="toolbar"
      aria-label="Breadcrumb navigation"
      onKeyDown={handleKeyDown}
      tabIndex={-1}
    >
      {pathParts.map((part, idx) => (
        <span key={`${idx}-${part}`} className="flex items-center flex-shrink-0">
          <button
            className={`px-1 py-0.5 text-dalam-text-muted hover:text-dalam-text-primary hover:bg-dalam-bg-hover rounded transition-colors ${focused === idx ? focusClass : ""}`}
            onClick={() => handleSegmentClick(idx)}
            onContextMenu={(e) => handleSegmentContextMenu(e, idx)}
            title={`${segFullPath(idx)} — click to copy, right-click for more`}
          >
            {part}
          </button>
          <ChevronRight className="w-3 h-3 mx-0.5 text-dalam-text-muted/50" />
        </span>
      ))}
      <button
        className={`flex items-center gap-1.5 text-dalam-text-primary font-medium flex-shrink-0 px-1 py-0.5 rounded transition-colors cursor-pointer ${focused === pathParts.length ? focusClass : "hover:bg-dalam-bg-hover"}`}
        onClick={() => copyToClipboard(fileFullPath, toast)}
        onContextMenu={handleFileContextMenu}
        title={`${fileFullPath} — click to copy, right-click for more`}
      >
        <FileCode className="w-3 h-3 text-dalam-accent-primary" />
        {fileName}
      </button>
    </div>
  );
}
