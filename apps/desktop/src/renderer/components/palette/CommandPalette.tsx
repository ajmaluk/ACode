import { useMemo } from "react";
import { Command } from "cmdk";
import { useCommandPalette, useSettingsView, useWorkspace, useShortcuts, useChat, useUI } from "@/store/useAppStore";
import { basename } from "@/lib/pathUtils";
import { modKey, shortcut } from "@/lib/platform";
import {
  Settings,
  FolderOpen,
  Sparkles,
  TerminalSquare,
  Code2,
  Search,
  RefreshCcw,
  Keyboard,
  FileCode,
  History,
  ChevronRight,
} from "lucide-react";
import { getRecentFiles } from "@/lib/dalamAPI";

type Item = {
  id: string;
  label: string;
  hint?: string;
  group: string;
  icon: React.ReactNode;
  shortcut?: string;
  perform: () => void;
};

export function CommandPalette() {
  const { open, setOpen, query, setQuery } = useCommandPalette();
  const { open: openSettings } = useSettingsView();
  const { openWorkspace, loadWorkspace, fileTree, openFile } = useWorkspace();
  const { toggle: toggleShortcuts } = useShortcuts();
  const recent = useMemo(() => (open ? getRecentFiles() : []), [open]);

  const items = useMemo<Item[]>(
    () => [
      {
        id: "open-settings",
        label: "Open Settings",
        hint: "Themes, models, skills, MCP servers",
        group: "Preferences",
        icon: <Settings className="w-3.5 h-3.5" />,
        shortcut: `${modKey()},`,
        perform: () => {
          setOpen(false);
          openSettings();
        },
      },
      {
        id: "shortcuts",
        label: "Keyboard Shortcuts",
        hint: "View the cheatsheet",
        group: "Help",
        icon: <Keyboard className="w-3.5 h-3.5" />,
        shortcut: "?",
        perform: () => {
          setOpen(false);
          toggleShortcuts();
        },
      },
      {
        id: "open-folder",
        label: "Open Folder…",
        hint: "Open a different project",
        group: "Workspace",
        icon: <FolderOpen className="w-3.5 h-3.5" />,
        perform: () => {
          setOpen(false);
          void openWorkspace();
        },
      },
      {
        id: "reload-sample",
        label: "Reload workspace",
        group: "Workspace",
        icon: <RefreshCcw className="w-3.5 h-3.5" />,
        perform: () => {
          setOpen(false);
          void loadWorkspace();
        },
      },
      {
        id: "new-task",
        label: "Start a new agent task",
        hint: "Open the empty prompt",
        group: "Agent",
        icon: <Sparkles className="w-3.5 h-3.5" />,
        shortcut: shortcut("N"),
        perform: () => {
          useChat.getState().newChat();
          if (useUI.getState().viewMode !== "chat") useUI.getState().setViewMode("chat");
          setOpen(false);
        },
      },
      {
        id: "new-terminal",
        label: "New Terminal",
        group: "View",
        icon: <TerminalSquare className="w-3.5 h-3.5" />,
        shortcut: `${modKey()}\``,
        perform: () => { const ui = useUI.getState(); if (ui.viewMode !== "editor") ui.setViewMode("editor"); ui.setBottomPanelTab("terminal"); ui.setBottomPanelOpen(true); setOpen(false); },
      },
      {
        id: "search-files",
        label: "Quick open file",
        group: "View",
        icon: <Search className="w-3.5 h-3.5" />,
        shortcut: shortcut("P"),
        perform: () => { window.dispatchEvent(new CustomEvent("editor:quick-open")); setOpen(false); },
      },
      {
        id: "go-symbol",
        label: "Go to line",
        group: "View",
        icon: <Code2 className="w-3.5 h-3.5" />,
        shortcut: shortcut("O", { shift: true }),
        perform: () => { window.dispatchEvent(new CustomEvent("editor:go-to-line")); setOpen(false); },
      },
    ],
    [setOpen, openSettings, openWorkspace, loadWorkspace, toggleShortcuts]
  );

  const fileItems = useMemo<Item[]>(() => {
    const out: Item[] = [];
    const visit = (n: { name: string; path: string; type: string; children?: typeof fileTree }) => {
      if (n.type === "file") {
        out.push({
          id: n.path,
          label: n.name,
          hint: n.path,
          group: "Files",
          icon: <FileCode className="w-3.5 h-3.5" />,
          perform: () => {
            void openFile(n.path);
            setOpen(false);
          },
        });
      } else {
        n.children?.forEach((c) => visit(c as never));
      }
    };
    fileTree.forEach((n) => visit(n as never));
    return out;
  }, [fileTree, openFile, setOpen]);

  const recentItems = useMemo<Item[]>(
    () =>
      recent.map((p) => ({
        id: "recent-" + p,
        label: basename(p),
        hint: p,
        group: "Recent",
        icon: <History className="w-3.5 h-3.5" />,
        perform: () => {
          void openFile(p);
          setOpen(false);
        },
      })),
    [recent, openFile, setOpen]
  );

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/55 dark:bg-black/55 backdrop-blur-sm flex items-start justify-center pt-[12vh] animate-fade-in"
      role="dialog" aria-modal="true" aria-label="Command palette"
      onClick={() => setOpen(false)}
    >
      <div
        className="w-[680px] max-w-[92vw] bg-dalam-bg-secondary dark:bg-dalam-bg-secondary border border-dalam-border-primary dark:border-dalam-border-primary rounded-xl shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <Command shouldFilter loop className="flex flex-col">
          <div className="flex items-center px-3 border-b border-dalam-border-primary">
            <Search className="w-4 h-4 text-dalam-text-muted mr-2 flex-shrink-0" />
            <Command.Input
              value={query}
              onValueChange={setQuery}
              placeholder="Type a command, search files, or jump to a setting…"
              className="flex-1 bg-transparent border-0 outline-none py-3 text-sm text-dalam-text-primary placeholder:text-dalam-text-muted"
              autoFocus
            />
            {query ? (
              <button
                className="text-[10px] text-dalam-text-muted hover:text-dalam-text-primary px-1.5"
                onClick={() => setQuery("")}
              >
                clear
              </button>
            ) : null}
            <kbd className="text-[10px] text-dalam-text-muted px-1.5 py-0.5 bg-dalam-bg-tertiary rounded ml-2">
              esc
            </kbd>
          </div>

          <Command.List className="max-h-[55vh] overflow-y-auto py-2 scrollbar-thin">
            <Command.Empty className="px-3 py-8 text-center text-sm text-dalam-text-muted">
              <p>No results for "{query}"</p>
              <p className="text-[11px] mt-1">Try a different search or check the help (?)</p>
            </Command.Empty>

            {recentItems.length > 0 && !query && (
              <Command.Group heading="Recent" className="px-1">
                {recentItems.slice(0, 5).map((i) => <Row key={i.id} item={i} />)}
              </Command.Group>
            )}

            <Command.Group heading="Commands" className="px-1">
              {items.map((i) => <Row key={i.id} item={i} />)}
            </Command.Group>

            {fileItems.length > 0 && (
              <Command.Group heading="Files" className="px-1">
                {fileItems.slice(0, 30).map((i) => <Row key={i.id} item={i} />)}
              </Command.Group>
            )}
          </Command.List>

          <div className="border-t border-dalam-border-primary px-3 py-1.5 flex items-center justify-between text-[10px] text-dalam-text-muted bg-dalam-bg-tertiary/30">
            <div className="flex items-center gap-2">
              <span className="flex items-center gap-1">
                <kbd className="px-1 bg-dalam-bg-tertiary rounded">↑↓</kbd> navigate
              </span>
              <span className="flex items-center gap-1">
                <kbd className="px-1 bg-dalam-bg-tertiary rounded">↵</kbd> open
              </span>
              <span className="flex items-center gap-1">
                <kbd className="px-1 bg-dalam-bg-tertiary rounded">esc</kbd> close
              </span>
            </div>
            <span className="flex items-center gap-1 text-dalam-accent-primary">
              <Sparkles className="w-3 h-3" />
              Dalam
            </span>
          </div>
        </Command>
      </div>
    </div>
  );
}

function Row({ item }: { item: Item }) {
  return (
    <Command.Item
      value={item.label + " " + (item.hint ?? "")}
      onSelect={item.perform}
      className="group flex items-center gap-2 px-2 py-1.5 mx-1 rounded cursor-pointer text-sm aria-selected:bg-dalam-accent-subtle data-[selected=true]:bg-dalam-accent-subtle"
    >
      <span className="text-dalam-text-secondary flex-shrink-0">{item.icon}</span>
      <span className="flex-1 text-dalam-text-primary truncate">{item.label}</span>
      {item.hint && (
        <span className="text-[10px] text-dalam-text-secondary truncate max-w-[200px]">{item.hint}</span>
      )}
      {item.shortcut && (
        <kbd className="text-[10px] text-dalam-text-secondary px-1.5 py-0.5 bg-dalam-bg-tertiary rounded flex-shrink-0">
          {item.shortcut}
        </kbd>
      )}
      <ChevronRight className="w-3 h-3 text-dalam-text-secondary opacity-0 group-aria-selected:opacity-100" />
    </Command.Item>
  );
}
