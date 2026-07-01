import React, { useEffect, useRef, useState, useMemo, useCallback } from "react";
import { useWorkspace, useSettings, useChat, useUI, useTerminal } from "@/store/useAppStore";
import type { FileNode } from "@dalam/shared-types";
import { CodeView } from "@/components/editor/Editor";
import { Breadcrumb } from "@/components/editor/Breadcrumb";
import { FindBar } from "@/components/editor/FindBar";
import { QuickOpen } from "@/components/editor/QuickOpen";
import { GoToLine } from "@/components/editor/GoToLine";
import { ChatView } from "@/components/editor/ChatView";
import {
  X, FileCode, FilePlus, Circle,
  Check, Code2,
} from "lucide-react";
import { useToast } from "@/components/ui/toastStore";
import { createDalamAPI } from "@/lib/dalamAPI";
import { basename } from "@/lib/pathUtils";
import { modKey, platform } from "@/lib/platform";

function findFirstFile(nodes: FileNode[]): string | null {
  for (const n of nodes) {
    if (n.type === "file" && n.name !== ".gitignore") return n.path;
    if (n.children) { const inner = findFirstFile(n.children); if (inner) return inner; }
  }
  return null;
}

const MemoizedOpenFileButton = React.memo(function MemoizedOpenFileButton({ fileTree, openFile }: { fileTree: FileNode[]; openFile: (path: string) => Promise<void> }) {
  const toast = useToast();
  const mod = modKey();
  const firstFile = useMemo(() => findFirstFile(fileTree), [fileTree]);
  const handleClick = useCallback(async () => { if (firstFile) { await openFile(firstFile); toast.info("Opened file", basename(firstFile)); } }, [firstFile, openFile, toast]);
  return (
    <button
      className={`px-3 h-full transition-colors ${firstFile ? "text-dalam-text-muted hover:text-dalam-text-primary hover:bg-dalam-bg-hover" : "text-dalam-text-muted/40 cursor-not-allowed"}`}
      onClick={handleClick}
      disabled={!firstFile}
      title={firstFile ? `Open file (${mod}P)` : "No files in workspace"}
    >
      <FilePlus className="w-3.5 h-3.5" />
    </button>
  );
});

export function EditorPane() {
  const { openTabs, activeFilePath, setActiveFile, closeTab, updateTabContent, markSaved, fileTree, openFile } = useWorkspace();
  const { viewMode } = useUI();
  const toast = useToast();
  const activeTab = openTabs.find((t) => t.path === activeFilePath) ?? null;
  const prevViewModeRef = useRef(viewMode);

  const [showFindBar, setShowFindBar] = useState(false);
  const [findReplaceMode, setFindReplaceMode] = useState(false);
  const [showQuickOpen, setShowQuickOpen] = useState(false);
  const [showGoToLine, setShowGoToLine] = useState(false);
  const [tabContextMenu, setTabContextMenu] = useState<{ x: number; y: number; path: string } | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const monacoEditorRef = useRef<any>(null);

  useEffect(() => {
    if (prevViewModeRef.current !== viewMode) {
      setShowFindBar(false);
      setShowQuickOpen(false);
      setShowGoToLine(false);
      setFindReplaceMode(false);
    }
    prevViewModeRef.current = viewMode;
  }, [viewMode]);

  useEffect(() => {
    const onFind = () => { setShowFindBar(true); setFindReplaceMode(false); };
    const onFindReplace = () => { setShowFindBar(true); setFindReplaceMode(true); };
    const onQuickOpen = () => setShowQuickOpen(true);
    const onGoToLine = () => setShowGoToLine(true);
    const onToggleComment = () => {
      const editor = monacoEditorRef.current;
      if (editor) editor.trigger("menu", "editor.action.commentLine", null);
    };

    window.addEventListener("editor:find", onFind);
    window.addEventListener("editor:find-replace", onFindReplace);
    window.addEventListener("editor:quick-open", onQuickOpen);
    window.addEventListener("editor:go-to-line", onGoToLine);
    window.addEventListener("editor:toggle-comment", onToggleComment);
    return () => {
      window.removeEventListener("editor:find", onFind);
      window.removeEventListener("editor:find-replace", onFindReplace);
      window.removeEventListener("editor:quick-open", onQuickOpen);
      window.removeEventListener("editor:go-to-line", onGoToLine);
      window.removeEventListener("editor:toggle-comment", onToggleComment);
    };
  }, []);

  useEffect(() => {
    const onKey = async (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      const alt = e.altKey;
      const shift = e.shiftKey;

      if (mod && !shift && e.key.toLowerCase() === "s") {
        e.preventDefault();
        const { activeFilePath, openTabs } = useWorkspace.getState();
        const tab = openTabs.find((t) => t.path === activeFilePath);
        if (!tab) return;
        try {
          const api = createDalamAPI();
          await api.fs.writeFile(tab.path, tab.content);
          markSaved(tab.path);
          toast.success("File saved", tab.name);
        } catch (err) {
          toast.error("Save failed", (err as Error)?.message ?? "Unknown error");
        }
      }

      if (mod && shift && e.key.toLowerCase() === "s") {
        e.preventDefault();
        const { openTabs } = useWorkspace.getState();
        const dirty = openTabs.filter((t) => t.dirty);
        if (dirty.length === 0) return;
        try {
          const api = createDalamAPI();
          for (const tab of dirty) {
            await api.fs.writeFile(tab.path, tab.content);
            markSaved(tab.path);
          }
          toast.success("All files saved", `${dirty.length} file(s)`);
        } catch (err) {
          toast.error("Save all failed", (err as Error)?.message ?? "Unknown error");
        }
      }

      if (mod && !shift && e.key.toLowerCase() === "w") {
        const { activeFilePath } = useWorkspace.getState();
        if (activeFilePath) {
          e.preventDefault();
          closeTab(activeFilePath);
        }
      }

      if (mod && !shift && e.key.toLowerCase() === "p" && !alt) {
        e.preventDefault();
        setShowQuickOpen((v) => !v);
      }

      if (mod && !shift && e.key.toLowerCase() === "g") {
        e.preventDefault();
        setShowGoToLine(true);
      }

      if (mod && !shift && e.key.toLowerCase() === "f" && !alt) {
        e.preventDefault();
        setShowFindBar(true);
        setFindReplaceMode(false);
      }

      if (mod && alt && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setShowFindBar(true);
        setFindReplaceMode(true);
      }

      if (mod && shift && e.key.toLowerCase() === "f") {
        // Only open bottom panel search in editor mode
        if (useUI.getState().viewMode !== "editor") return;
        e.preventDefault();
        useUI.getState().setBottomPanelTab("terminal");
        useUI.getState().setBottomPanelOpen(true);
      }

      if (mod && !shift && e.key.toLowerCase() === "j") {
        // Only open terminal in editor mode
        if (useUI.getState().viewMode !== "editor") return;
        e.preventDefault();
        const ui = useUI.getState();
        const session = useChat.getState().session;
        if (session?.workspacePath) {
          useTerminal.getState().ensureTabForCwd(session.workspacePath);
        }
        ui.setBottomPanelTab("terminal");
        ui.setBottomPanelOpen(true);
      }

      if (alt && e.key.toLowerCase() === "z" && !mod) {
        e.preventDefault();
        const { settings, update } = useSettings.getState();
        void update("wordWrap", !settings.wordWrap);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [markSaved, toast, closeTab]);

  useEffect(() => {
    if (!tabContextMenu) return;
    const handler = () => setTabContextMenu(null);
    window.addEventListener("click", handler);
    return () => window.removeEventListener("click", handler);
  }, [tabContextMenu]);

  const handleFindSearch = useCallback((_query: string, _options: { caseSensitive: boolean; wholeWord: boolean; regex: boolean }) => {
    const editor = monacoEditorRef.current;
    if (!editor) return;
    const action = editor.getAction("actions.find");
    if (action) {
      void action.run();
      setTimeout(() => {
        editor.trigger("findBar", "editor.action.nextMatchFindAction", null);
      }, 50);
    }
  }, []);

  const handleFindReplace = useCallback((_replacement: string) => {
    const editor = monacoEditorRef.current;
    if (!editor) return;
    editor.trigger("findBar", "editor.action.replaceOne", null);
  }, []);

  const handleFindReplaceAll = useCallback((_replacement: string) => {
    const editor = monacoEditorRef.current;
    if (!editor) return;
    editor.trigger("findBar", "editor.action.replaceAll", null);
  }, []);

  if (viewMode === "editor") {
    return (
      <div className="h-full flex flex-col bg-dalam-bg-primary">
        <div className="flex-1 min-h-0 flex flex-col">
          <div className="h-9 flex items-center bg-dalam-bg-secondary border-b border-dalam-border-primary overflow-x-auto flex-shrink-0 scrollbar-thin">
            {openTabs.map((t) => {
              const active = t.path === activeFilePath;
              return (
                <div key={t.path}
                  className={`group flex items-center gap-1.5 px-3 h-full border-r border-dalam-border-primary cursor-pointer transition-colors ${active ? "bg-dalam-bg-primary text-dalam-text-primary" : "bg-dalam-bg-secondary text-dalam-text-secondary hover:bg-dalam-bg-hover"}`}
                  onClick={() => setActiveFile(t.path)}
                  onAuxClick={(e) => { if (e.button === 1) closeTab(t.path); }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setTabContextMenu({ x: e.clientX, y: e.clientY, path: t.path });
                  }}
                  title={`${t.path}${t.dirty ? " (unsaved)" : ""}`}>
                  {t.dirty && <Circle className="w-2 h-2 fill-current text-dalam-accent-primary flex-shrink-0" />}
                  <FileCode className="w-3.5 h-3.5 flex-shrink-0" />
                  <span className="text-xs whitespace-nowrap">{t.name}</span>
                  <button
                    className={`ml-1 rounded p-0.5 ${active ? "opacity-70 hover:opacity-100" : "opacity-0 group-hover:opacity-100"} hover:bg-dalam-bg-active transition-opacity`}
                    onClick={(e) => { e.stopPropagation(); closeTab(t.path); }}
                    title={t.dirty ? "Close (unsaved)" : "Close"}
                    aria-label={`Close ${t.name}`}
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              );
            })}
            <MemoizedOpenFileButton fileTree={fileTree} openFile={openFile} />
            <div className="flex-1" />
            <div className="flex items-center gap-0.5 pr-1">
              <button className="px-2 h-full text-dalam-text-muted hover:text-dalam-text-primary hover:bg-dalam-bg-hover transition-colors" title="Toggle word wrap" onClick={() => { void useSettings.getState().update("wordWrap", !useSettings.getState().settings.wordWrap); }}>
                <span className="text-xs">W</span>
              </button>
              <button className="px-2 h-full text-dalam-text-muted hover:text-dalam-text-primary hover:bg-dalam-bg-hover transition-colors" title="Toggle minimap" onClick={() => { void useSettings.getState().update("showMinimap", !useSettings.getState().settings.showMinimap); }}>
                <span className="text-xs">M</span>
              </button>
            </div>
          </div>

          {tabContextMenu && (
            <TabContextMenu
              x={tabContextMenu.x}
              y={tabContextMenu.y}
              tabPath={tabContextMenu.path}
              onClose={() => setTabContextMenu(null)}
            />
          )}

          {activeTab && <Breadcrumb />}

          {showFindBar && activeTab && (
            <FindBar
              key={findReplaceMode ? "replace" : "find"}
              onSearch={handleFindSearch}
              onReplace={handleFindReplace}
              onReplaceAll={handleFindReplaceAll}
              onClose={() => setShowFindBar(false)}
              matchCount={0}
              currentMatch={0}
              showReplace={findReplaceMode}
            />
          )}

          <div className="flex-1 min-h-0 relative">
            {activeTab ? (
              <CodeView path={activeTab.path} content={activeTab.content} onChange={(v) => updateTabContent(activeTab.path, v)} onEditorReady={(e) => { monacoEditorRef.current = e; }} />
            ) : (
              <div className="h-full flex flex-col items-center justify-center text-dalam-text-muted">
                <div className="w-16 h-16 mb-4 rounded-2xl bg-dalam-bg-active flex items-center justify-center">
                  <Code2 className="w-8 h-8 text-dalam-text-muted/50" />
                </div>
                <p className="text-sm font-medium mb-1">No file open</p>
                <p className="text-xs text-dalam-text-muted/60 mb-4">Select a file from the explorer or use Ctrl+P to quick open</p>
              </div>
            )}
          </div>
          <EditorStatusBar />
        </div>

        {showQuickOpen && <QuickOpen onClose={() => setShowQuickOpen(false)} />}
        {showGoToLine && activeTab && (
          <GoToLine
            maxLine={activeTab.content.split("\n").length}
            onGoToLine={(line) => {
              window.dispatchEvent(new CustomEvent("editor:go-to-line-number", { detail: { line } }));
            }}
            onClose={() => setShowGoToLine(false)}
          />
        )}
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-dalam-bg-primary">
      <div className="flex-1 min-h-0">
        <ChatView />
      </div>
    </div>
  );
}

function EditorStatusBar() {
  const { settings } = useSettings();
  const { openTabs, activeFilePath, markSaved } = useWorkspace();
  const toast = useToast();
  const activeTab = openTabs.find((t) => t.path === activeFilePath);
  const mod = modKey();
  const language = activeTab ? activeTab.path.split(".").pop()?.toLowerCase() ?? "text" : "";
  const cursor = activeTab?.cursor;
  const wordWrap = settings.wordWrap;
  const lineCount = activeTab ? activeTab.content.split("\n").length : 0;
  return (
    <div className="h-6 flex items-center justify-between bg-dalam-bg-tertiary border-t border-dalam-border-primary px-3 text-[11px] text-dalam-text-muted flex-shrink-0 select-none">
      <div className="flex items-center gap-3 min-w-0 overflow-hidden">
        {activeTab && (
          <span className="flex items-center gap-1.5 flex-shrink-0">
            <FileCode className="w-3 h-3" />
            <span className="truncate max-w-[200px]" title={activeTab.path}>{activeTab.name}</span>
            {activeTab.dirty && <Circle className="w-1.5 h-1.5 fill-current text-dalam-accent-primary flex-shrink-0" />}
          </span>
        )}
        <div className="w-px h-3 bg-dalam-border-primary flex-shrink-0" />
        {language && (
          <span
            className="px-1.5 py-0.5 rounded text-dalam-text-secondary uppercase tracking-wider text-[10px] flex-shrink-0 cursor-default"
            title={`Language: ${language}`}
          >
            {language}
          </span>
        )}
        {cursor && (
          <span className="flex items-center gap-1 flex-shrink-0">
            <span>Ln {cursor.line}, Col {cursor.column}</span>
          </span>
        )}
        {lineCount > 0 && (
          <span className="flex-shrink-0">
            {lineCount.toLocaleString()} {lineCount === 1 ? "line" : "lines"}
          </span>
        )}
        <div className="w-px h-3 bg-dalam-border-primary flex-shrink-0" />
        <span className="flex-shrink-0">Spaces: 2</span>
        <div className="w-px h-3 bg-dalam-border-primary flex-shrink-0" />
        <span className="flex-shrink-0">UTF-8</span>
        <div className="w-px h-3 bg-dalam-border-primary flex-shrink-0" />
        <button
          className="flex-shrink-0 hover:text-dalam-text-primary transition-colors"
          onClick={() => { void useSettings.getState().update("wordWrap", !wordWrap); }}
          title={`Toggle word wrap (${platform() === "mac" ? "⌥" : "Alt"}Z)`}
        >
          {wordWrap ? "Wrap" : "No wrap"}
        </button>
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">
        {activeTab?.dirty ? (
          <button
            onClick={async () => {
              try {
                const api = createDalamAPI();
                await api.fs.writeFile(activeTab.path, activeTab.content);
                markSaved(activeTab.path);
              } catch (err) {
                toast.error("Save failed", (err as Error)?.message ?? "Unknown error");
              }
            }}
            className="flex items-center gap-1 text-dalam-text-secondary hover:text-dalam-text-primary transition-colors"
            title={`Save (${mod}S)`}
          >
            <Circle className="w-2 h-2 fill-current text-dalam-accent-primary" />
            <span>Unsaved</span>
          </button>
        ) : activeTab ? (
          <span className="flex items-center gap-1 text-dalam-text-muted">
            <Check className="w-3 h-3" />
            <span>Saved</span>
          </span>
        ) : null}
        <div className="w-px h-3 bg-dalam-border-primary flex-shrink-0" />
        <span className="flex-shrink-0">{settings.codeFontSize}px</span>
      </div>
    </div>
  );
}

function TabContextMenu({ x, y, tabPath, onClose }: { x: number; y: number; tabPath: string; onClose: () => void }) {
  const { closeTab, openTabs } = useWorkspace();
  const mod = modKey();

  const closeOthers = () => {
    for (const t of openTabs) {
      if (t.path !== tabPath) closeTab(t.path);
    }
    onClose();
  };

  const closeAll = () => {
    for (const t of openTabs) closeTab(t.path);
    onClose();
  };

  const closeToRight = () => {
    const idx = openTabs.findIndex((t) => t.path === tabPath);
    if (idx >= 0) {
      for (let i = idx + 1; i < openTabs.length; i++) {
        closeTab(openTabs[i].path);
      }
    }
    onClose();
  };

  const closeToLeft = () => {
    const idx = openTabs.findIndex((t) => t.path === tabPath);
    if (idx >= 0) {
      for (let i = 0; i < idx; i++) {
        closeTab(openTabs[i].path);
      }
    }
    onClose();
  };

  const closeSaved = () => {
    for (const t of openTabs) {
      if (!t.dirty) closeTab(t.path);
    }
    onClose();
  };

  const copyPath = async () => {
    try {
      const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
      await writeText(tabPath);
    } catch {
      await navigator.clipboard.writeText(tabPath);
    }
    onClose();
  };

  const items = [
    { label: "Close", shortcut: `${mod}W`, action: () => { closeTab(tabPath); onClose(); } },
    { label: "Close Others", action: closeOthers },
    { label: "Close All", action: closeAll },
    { label: "Close To Right", action: closeToRight },
    { label: "Close To Left", action: closeToLeft },
    { label: "Close Saved", action: closeSaved },
    { type: "separator" as const },
    { label: "Copy Path", shortcut: `${mod}⇧C`, action: copyPath },
    { label: "Copy Relative Path", action: async () => {
      try {
        const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
        await writeText(tabPath);
      } catch {
        await navigator.clipboard.writeText(tabPath);
      }
      onClose();
    }},
  ];

  return (
    <div
      className="fixed z-50 min-w-[200px] bg-dalam-bg-secondary border border-dalam-border-primary rounded-md shadow-2xl py-1 animate-fade-in"
      style={{ left: x, top: y }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {items.map((item, idx) => {
        if (item.type === "separator") return <div key={idx} className="h-px bg-dalam-border-primary my-1 mx-1" />;
        return (
          <button
            key={idx}
            className="w-full flex items-center justify-between gap-3 px-2.5 py-1 text-[11px] text-dalam-text-primary hover:bg-dalam-accent-subtle hover:text-dalam-text-primary transition-colors"
            onClick={() => item.action()}
          >
            <span>{item.label}</span>
            {"shortcut" in item && item.shortcut && (
              <kbd className="text-[10px] text-dalam-text-muted whitespace-nowrap">{item.shortcut}</kbd>
            )}
          </button>
        );
      })}
    </div>
  );
}
