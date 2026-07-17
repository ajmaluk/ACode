import React, {
  useEffect,
  useRef,
  useState,
  useMemo,
  useCallback,
} from "react";
import {
  useWorkspace,
  useSettings,
  useChat,
  useUI,
  useTerminal,
} from "@/store/useAppStore";
import type { FileNode } from "@dalam/shared-types";
import { CodeView, type MonacoEditorInstance } from "@/components/editor/Editor";
import { Breadcrumb } from "@/components/editor/Breadcrumb";
import { FindBar } from "@/components/editor/FindBar";
import { QuickOpen } from "@/components/editor/QuickOpen";
import { GoToLine } from "@/components/editor/GoToLine";
import { ChatView } from "@/components/editor/ChatView";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";
import { X, FileCode, FilePlus, Circle, Check, Code2 } from "lucide-react";
import { useToast } from "@/components/ui/toastStore";
import { createDalamAPI } from "@/lib/dalamAPI";
import { basename, findFirstFile } from "@/lib/pathUtils";
import { modKey, platform } from "@/lib/platform";

// Efficient line counter — avoids split("\n") which creates a huge array for large files
function countLines(text: string): number {
  let count = 1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") count++;
  }
  return count;
}

const MemoizedOpenFileButton = React.memo(function MemoizedOpenFileButton({
  fileTree,
  openFile,
}: {
  fileTree: FileNode[];
  openFile: (path: string) => Promise<void>;
}) {
  const toast = useToast();
  const mod = modKey();
  const firstFile = useMemo(() => findFirstFile(fileTree), [fileTree]);
  const handleClick = useCallback(async () => {
    if (firstFile) {
      await openFile(firstFile);
      toast.info("Opened file", basename(firstFile));
    }
  }, [firstFile, openFile, toast]);
  return (
    <button type="button"
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
  const {
    openTabs,
    activeFilePath,
    setActiveFile,
    closeTab,
    updateTabContent,
    markSaved,
    fileTree,
    openFile,
  } = useWorkspace();
  const { viewMode } = useUI();
  const toast = useToast();
  const activeTab = openTabs.find((t) => t.path === activeFilePath) ?? null;
  const prevViewModeRef = useRef(viewMode);

  const [showFindBar, setShowFindBar] = useState(false);
  const [findReplaceMode, setFindReplaceMode] = useState(false);
  const [showQuickOpen, setShowQuickOpen] = useState(false);
  const [showGoToLine, setShowGoToLine] = useState(false);
  const [tabContextMenu, setTabContextMenu] = useState<{
    x: number;
    y: number;
    path: string;
  } | null>(null);
  const monacoEditorRef = useRef<MonacoEditorInstance | null>(null);

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
    const onFind = () => {
      setShowFindBar(true);
      setFindReplaceMode(false);
    };
    const onFindReplace = () => {
      setShowFindBar(true);
      setFindReplaceMode(true);
    };
    const onQuickOpen = () => setShowQuickOpen(true);
    const onGoToLine = () => setShowGoToLine(true);
    const onGoToLineNumber = (e: Event) => {
      const editor = monacoEditorRef.current;
      if (!editor) return;
      const line = (e as CustomEvent).detail?.line;
      if (typeof line === "number" && line >= 1) {
        editor.revealLineInCenter(line);
        editor.setPosition({ lineNumber: line, column: 1 });
        editor.focus();
      }
    };
    const onFindNext = () => {
      const editor = monacoEditorRef.current;
      if (editor)
        editor.trigger("findBar", "editor.action.nextMatchFindAction", null);
    };
    const onFindPrevious = () => {
      const editor = monacoEditorRef.current;
      if (editor)
        editor.trigger(
          "findBar",
          "editor.action.previousMatchFindAction",
          null,
        );
    };
    const onToggleComment = () => {
      const editor = monacoEditorRef.current;
      if (editor) editor.trigger("menu", "editor.action.commentLine", null);
    };

    window.addEventListener("editor:find", onFind);
    window.addEventListener("editor:find-replace", onFindReplace);
    window.addEventListener("editor:quick-open", onQuickOpen);
    window.addEventListener("editor:go-to-line", onGoToLine);
    window.addEventListener("editor:go-to-line-number", onGoToLineNumber);
    window.addEventListener("editor:find-next", onFindNext);
    window.addEventListener("editor:find-previous", onFindPrevious);
    window.addEventListener("editor:toggle-comment", onToggleComment);
    return () => {
      window.removeEventListener("editor:find", onFind);
      window.removeEventListener("editor:find-replace", onFindReplace);
      window.removeEventListener("editor:quick-open", onQuickOpen);
      window.removeEventListener("editor:go-to-line", onGoToLine);
      window.removeEventListener("editor:go-to-line-number", onGoToLineNumber);
      window.removeEventListener("editor:find-next", onFindNext);
      window.removeEventListener("editor:find-previous", onFindPrevious);
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
          toast.error(
            "Save failed",
            (err as Error)?.message ?? "Unknown error",
          );
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
          toast.error(
            "Save all failed",
            (err as Error)?.message ?? "Unknown error",
          );
        }
      }

      if (mod && !shift && e.key.toLowerCase() === "w") {
        e.preventDefault();
        const { activeFilePath } = useWorkspace.getState();
        if (activeFilePath) {
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
        e.preventDefault();
        // Only open bottom panel search in editor mode
        if (useUI.getState().viewMode !== "editor") return;
        useUI.getState().setBottomPanelTab("terminal");
        useUI.getState().setBottomPanelOpen(true);
      }

      if (mod && !shift && e.key.toLowerCase() === "j") {
        e.preventDefault();
        // Only open terminal in editor mode
        if (useUI.getState().viewMode !== "editor") return;
        const ui = useUI.getState();
        const session = useChat.getState().session;
        if (session?.workspacePath) {
          useTerminal.getState().ensureTabForCwd(session.workspacePath);
        }
        ui.setBottomPanelTab("terminal");
        ui.setBottomPanelOpen(true);
      }

      if (alt && (e.key.toLowerCase() === "z" || e.code === "KeyZ") && !mod) {
        e.preventDefault();
        const { settings, update } = useSettings.getState();
        void update("wordWrap", !settings.wordWrap);
      }

      if (mod && shift && e.key.toLowerCase() === "i") {
        e.preventDefault();
        const editor = monacoEditorRef.current;
        if (editor) {
          void editor.getAction("editor.action.formatDocument")?.run();
        }
      }

      if (mod && alt && e.key === "[") {
        e.preventDefault();
        const editor = monacoEditorRef.current;
        if (editor) {
          void editor.getAction("editor.fold")?.run();
        }
      }

      if (mod && alt && e.key === "]") {
        e.preventDefault();
        const editor = monacoEditorRef.current;
        if (editor) {
          void editor.getAction("editor.unfold")?.run();
        }
      }

      // Check custom shortcuts from settings
      const customShortcuts = useSettings.getState().settings.customShortcuts;
      if (customShortcuts) {
        const key = `${mod ? "Cmd" : "Ctrl"}+${shift ? "Shift+" : ""}${alt ? "Alt+" : ""}${e.key.toLowerCase()}`;
        const action = customShortcuts[key];
        if (action) {
          e.preventDefault();
          // Handle known actions
          if (action === "format") {
            const editor = monacoEditorRef.current;
            if (editor) void editor.getAction("editor.action.formatDocument")?.run();
          } else if (action === "toggleMinimap") {
            void useSettings
              .getState()
              .update(
                "showMinimap",
                !useSettings.getState().settings.showMinimap,
              );
          } else if (action === "toggleWordWrap") {
            void useSettings
              .getState()
              .update("wordWrap", !useSettings.getState().settings.wordWrap);
          }
          return;
        }
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

  const [findMatchCount, setFindMatchCount] = useState(0);
  const [findCurrentMatch, setFindCurrentMatch] = useState(0);

  const handleFindSearch = useCallback(
    (
      query: string,
      options: { caseSensitive: boolean; wholeWord: boolean; regex: boolean },
    ) => {
      const editor = monacoEditorRef.current;
      if (!editor) return;
      if (!query) {
        setFindMatchCount(0);
        setFindCurrentMatch(0);
        return;
      }
      const model = editor.getModel();
      if (!model) return;
      // Use Monaco's find controller directly
      const findController = editor.getContribution(
        "editor.contrib.findController",
      ) as {
        start: (
          searchString: string,
          options: {
            caseSensitive: boolean;
            wholeWord: boolean;
            isRegex: boolean;
          },
        ) => void;
      } | null;
      if (findController) {
        findController.start(query, {
          caseSensitive: options.caseSensitive,
          wholeWord: options.wholeWord,
          isRegex: options.regex,
        });
      }
      // Count matches using Monaco's model
      const matches = model.findMatches(
        query,
        false,
        options.regex,
        options.caseSensitive,
        options.wholeWord ? "true" : null,
        false,
      ) as Array<{ range: { startLineNumber: number; startColumn: number } }>;
      setFindMatchCount(matches.length);
      const pos = editor.getPosition();
      if (pos && matches.length > 0) {
        const idx = matches.findIndex(
          (m) =>
            m.range.startLineNumber === pos.lineNumber &&
            m.range.startColumn === pos.column,
        );
        setFindCurrentMatch(idx >= 0 ? idx + 1 : 1);
      } else {
        setFindCurrentMatch(matches.length > 0 ? 1 : 0);
      }
    },
    [],
  );

  const handleFindClose = useCallback(() => {
    setShowFindBar(false);
    // Also close Monaco's internal find widget to clean up highlights
    const editor = monacoEditorRef.current;
    if (editor) {
      editor.trigger("findBar", "closeFindWidget", null);
    }
  }, []);

  const handleFindReplace = useCallback((replacement: string) => {
    const editor = monacoEditorRef.current;
    if (!editor) return;
    editor.trigger("findBar", "editor.action.replaceOne", replacement);
  }, []);

  const handleFindReplaceAll = useCallback((replacement: string) => {
    const editor = monacoEditorRef.current;
    if (!editor) return;
    editor.trigger("findBar", "editor.action.replaceAll", replacement);
  }, []);

  if (viewMode === "editor") {
    return (
      <div className="h-full flex flex-col bg-dalam-bg-primary">
        <div className="flex-1 min-h-0 flex flex-col">
          <div className="h-9 flex items-center bg-dalam-bg-secondary border-b border-dalam-border-primary overflow-x-auto flex-shrink-0 scrollbar-thin">
            {openTabs.map((t) => {
              const active = t.path === activeFilePath;
              return (
                <div
                  key={t.path}
                  className={`group flex items-center gap-1.5 px-3 h-full border-r border-dalam-border-primary cursor-pointer transition-colors ${active ? "bg-dalam-bg-primary text-dalam-text-primary" : "bg-dalam-bg-secondary text-dalam-text-secondary hover:bg-dalam-bg-hover"}`}
                  onClick={() => setActiveFile(t.path)}
                  onAuxClick={(e) => {
                    if (e.button === 1) {
                      e.preventDefault();
                      closeTab(t.path);
                    }
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setTabContextMenu({
                      x: e.clientX,
                      y: e.clientY,
                      path: t.path,
                    });
                  }}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData("text/plain", t.path);
                    e.dataTransfer.effectAllowed = "move";
                  }}
                  onDragOver={(e) => {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "move";
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    const draggedPath = e.dataTransfer.getData("text/plain");
                    if (draggedPath && draggedPath !== t.path) {
                      const tabs = useWorkspace.getState().openTabs;
                      const fromIdx = tabs.findIndex(
                        (tab) => tab.path === draggedPath,
                      );
                      const toIdx = tabs.findIndex(
                        (tab) => tab.path === t.path,
                      );
                      if (fromIdx >= 0 && toIdx >= 0) {
                        const newTabs = [...tabs];
                        const [moved] = newTabs.splice(fromIdx, 1);
                        newTabs.splice(toIdx, 0, moved);
                        useWorkspace.setState({ openTabs: newTabs });
                      }
                    }
                  }}
                  title={`${t.path}${t.dirty ? " (unsaved)" : ""}`}
                >
                  {t.dirty && (
                    <Circle className="w-2 h-2 fill-current text-dalam-accent-primary flex-shrink-0" />
                  )}
                  <FileCode className="w-3.5 h-3.5 flex-shrink-0" />
                  <span className="text-xs whitespace-nowrap">{t.name}</span>
                  <button type="button"
                    className={`ml-1 rounded p-0.5 ${active ? "opacity-70 hover:opacity-100" : "opacity-0 group-hover:opacity-100"} hover:bg-dalam-bg-active transition-opacity`}
                    onClick={(e) => {
                      e.stopPropagation();
                      closeTab(t.path);
                    }}
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
              <button type="button"
                className="px-2 h-full text-dalam-text-muted hover:text-dalam-text-primary hover:bg-dalam-bg-hover transition-colors"
                title="Toggle word wrap"
                onClick={() => {
                  void useSettings
                    .getState()
                    .update(
                      "wordWrap",
                      !useSettings.getState().settings.wordWrap,
                    );
                }}
              >
                <span className="text-xs">W</span>
              </button>
              <button type="button"
                className="px-2 h-full text-dalam-text-muted hover:text-dalam-text-primary hover:bg-dalam-bg-hover transition-colors"
                title="Toggle minimap"
                onClick={() => {
                  void useSettings
                    .getState()
                    .update(
                      "showMinimap",
                      !useSettings.getState().settings.showMinimap,
                    );
                }}
              >
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
              onClose={handleFindClose}
              matchCount={findMatchCount}
              currentMatch={findCurrentMatch}
              showReplace={findReplaceMode}
            />
          )}

          <div className="flex-1 min-h-0 relative">
            {activeTab ? (
              <CodeView
                path={activeTab.path}
                content={activeTab.content}
                onChange={(v) => updateTabContent(activeTab.path, v)}
                onEditorReady={(e) => {
                  monacoEditorRef.current = e;
                  const active = useWorkspace
                    .getState()
                    .openTabs.find(
                      (t) => t.path === useWorkspace.getState().activeFilePath,
                    );
                  if (active?.cursor) {
                    e.setPosition({
                      lineNumber: active.cursor.line,
                      column: active.cursor.column,
                    });
                    e.revealLineInCenter(active.cursor.line);
                  }
                }}
              />
            ) : (
              <div className="h-full flex flex-col items-center justify-center text-dalam-text-muted">
                <div className="w-16 h-16 mb-4 rounded-2xl bg-dalam-bg-active flex items-center justify-center">
                  <Code2 className="w-8 h-8 text-dalam-text-muted/50" />
                </div>
                <p className="text-sm font-medium mb-1">No file open</p>
                <p className="text-xs text-dalam-text-muted/60 mb-4">
                  Select a file from the explorer or use {modKey()}P to quick
                  open
                </p>
              </div>
            )}
          </div>
          <EditorStatusBar />
        </div>

        {showQuickOpen && <QuickOpen onClose={() => setShowQuickOpen(false)} />}
        {showGoToLine && activeTab && (
          <GoToLine
            maxLine={countLines(activeTab.content)}
            onGoToLine={(line) => {
              window.dispatchEvent(
                new CustomEvent("editor:go-to-line-number", {
                  detail: { line },
                }),
              );
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
        <ErrorBoundary>
          <ChatView />
        </ErrorBoundary>
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
  const extToLang: Record<string, string> = {
    ts: "TypeScript",
    tsx: "TypeScript React",
    js: "JavaScript",
    jsx: "JavaScript React",
    py: "Python",
    rs: "Rust",
    go: "Go",
    java: "Java",
    rb: "Ruby",
    css: "CSS",
    html: "HTML",
    json: "JSON",
    md: "Markdown",
    yaml: "YAML",
    yml: "YAML",
    sh: "Shell",
    bash: "Bash",
    toml: "TOML",
    xml: "XML",
    sql: "SQL",
  };
  const ext = activeTab?.path?.split(".").pop()?.toLowerCase() ?? "";
  const language = ext ? (extToLang[ext] ?? ext.toUpperCase()) : "";
  const cursor = activeTab?.cursor;
  const wordWrap = settings.wordWrap;
  const lineCount = activeTab ? countLines(activeTab.content) : 0;
  return (
    <div className="h-6 flex items-center justify-between bg-dalam-bg-tertiary border-t border-dalam-border-primary px-3 text-[11px] text-dalam-text-muted flex-shrink-0 select-none">
      <div className="flex items-center gap-3 min-w-0 overflow-hidden">
        {activeTab && (
          <span className="flex items-center gap-1.5 flex-shrink-0">
            <FileCode className="w-3 h-3" />
            <span className="truncate max-w-[200px]" title={activeTab.path}>
              {activeTab.name}
            </span>
            {activeTab.dirty && (
              <Circle className="w-1.5 h-1.5 fill-current text-dalam-accent-primary flex-shrink-0" />
            )}
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
            <span>
              Ln {cursor.line}, Col {cursor.column}
            </span>
          </span>
        )}
        {lineCount > 0 && (
          <span className="flex-shrink-0">
            {lineCount.toLocaleString()} {lineCount === 1 ? "line" : "lines"}
          </span>
        )}
        <div className="w-px h-3 bg-dalam-border-primary flex-shrink-0" />
        <span className="flex-shrink-0">Spaces: {settings.tabSize ?? 2}</span>
        <div className="w-px h-3 bg-dalam-border-primary flex-shrink-0" />
        <span className="flex-shrink-0">UTF-8</span>
        <div className="w-px h-3 bg-dalam-border-primary flex-shrink-0" />
        <button type="button"
          className="flex-shrink-0 hover:text-dalam-text-primary transition-colors"
          onClick={() => {
            void useSettings.getState().update("wordWrap", !wordWrap);
          }}
          title={`Toggle word wrap (${platform() === "mac" ? "⌥" : "Alt"}Z)`}
        >
          {wordWrap ? "Wrap" : "No wrap"}
        </button>
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">
        {activeTab?.dirty ? (
          <button type="button"
            onClick={async () => {
              try {
                const api = createDalamAPI();
                await api.fs.writeFile(activeTab.path, activeTab.content);
                markSaved(activeTab.path);
              } catch (err) {
                toast.error(
                  "Save failed",
                  (err as Error)?.message ?? "Unknown error",
                );
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

function TabContextMenu({
  x,
  y,
  tabPath,
  onClose,
}: {
  x: number;
  y: number;
  tabPath: string;
  onClose: () => void;
}) {
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
      // Snapshot paths before iterating to avoid mutation-during-iteration bugs
      const pathsToClose = openTabs.slice(idx + 1).map((t) => t.path);
      for (const path of pathsToClose) {
        closeTab(path);
      }
    }
    onClose();
  };

  const closeToLeft = () => {
    const idx = openTabs.findIndex((t) => t.path === tabPath);
    if (idx >= 0) {
      // Snapshot paths before iterating to avoid mutation-during-iteration bugs
      const pathsToClose = openTabs.slice(0, idx).map((t) => t.path);
      for (const path of pathsToClose) {
        closeTab(path);
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
      const { writeText } =
        await import("@tauri-apps/plugin-clipboard-manager");
      await writeText(tabPath);
    } catch (e) {
      if (import.meta.env.DEV) console.warn("[EditorPane] Tauri clipboard failed, falling back:", e);
      await navigator.clipboard.writeText(tabPath);
    }
    onClose();
  };

  const items = [
    {
      label: "Close",
      shortcut: `${mod}W`,
      action: () => {
        closeTab(tabPath);
        onClose();
      },
    },
    { label: "Close Others", action: closeOthers },
    { label: "Close All", action: closeAll },
    { label: "Close To Right", action: closeToRight },
    { label: "Close To Left", action: closeToLeft },
    { label: "Close Saved", action: closeSaved },
    { type: "separator" as const },
    { label: "Copy Path", shortcut: `${mod}⇧C`, action: copyPath },
    {
      label: "Copy Relative Path",
      action: async () => {
        const { workspaces, activeWorkspaceId } = useWorkspace.getState();
        const ws = workspaces.find((w) => w.id === activeWorkspaceId);
        const relPath =
          ws && tabPath.startsWith(ws.path)
            ? tabPath.slice(ws.path.length + 1)
            : tabPath;
        try {
          const { writeText } =
            await import("@tauri-apps/plugin-clipboard-manager");
          await writeText(relPath);
        } catch (e) {
          if (import.meta.env.DEV) console.warn("[EditorPane] Tauri clipboard failed for relative path:", e);
          await navigator.clipboard.writeText(relPath);
        }
        onClose();
      },
    },
  ];

  return (
    <div
      className="fixed z-50 min-w-[200px] bg-dalam-bg-secondary border border-dalam-border-primary rounded-md shadow-2xl py-1 animate-fade-in"
      style={{ left: x, top: y }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {items.map((item, idx) => {
        if (item.type === "separator")
          return (
            <div key={idx} className="h-px bg-dalam-border-primary my-1 mx-1" />
          );
        return (
          <button type="button"
            key={idx}
            className="w-full flex items-center justify-between gap-3 px-2.5 py-1 text-[11px] text-dalam-text-primary hover:bg-dalam-accent-subtle hover:text-dalam-text-primary transition-colors"
            onClick={() => item.action()}
          >
            <span>{item.label}</span>
            {"shortcut" in item && item.shortcut && (
              <kbd className="text-[10px] text-dalam-text-muted whitespace-nowrap">
                {item.shortcut}
              </kbd>
            )}
          </button>
        );
      })}
    </div>
  );
}
