import React, { useState, useEffect, useRef } from "react";
import {
  ChevronRight,
  ChevronDown,
  FileCode,
  FileText,
  FileJson,
  FileType,
  FolderClosed,
  FolderOpen,
  Image as ImageIcon,
  File as FileIcon,
  FilePlus,
  FolderPlus,
  Pencil,
  Trash2,
  Copy,
  TerminalSquare,
  FolderSearch,
} from "lucide-react";
import type { FileNode as FileNodeT } from "@dalam/shared-types";
import { useWorkspace, useDiffView } from "@/store/useAppStore";
import {
  showContextMenu,
  type ContextMenuItem,
} from "@/components/ui/contextMenuUtils";
import { useToast } from "@/components/ui/toastStore";
import { modKey } from "@/lib/platform";
import {
  copyToClipboard,
  revealInFinder,
  openInTerminal,
} from "@/lib/editorHelpers";

function renderFileIcon(name: string, className: string) {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const iconClass = className;
  if (["ts", "tsx"].includes(ext))
    return <FileCode className={`${iconClass} text-blue-400`} />;
  if (["js", "jsx"].includes(ext))
    return <FileCode className={`${iconClass} text-yellow-400`} />;
  if (["rs"].includes(ext))
    return <FileCode className={`${iconClass} text-orange-400`} />;
  if (["py"].includes(ext))
    return <FileCode className={`${iconClass} text-green-400`} />;
  if (["go"].includes(ext))
    return <FileCode className={`${iconClass} text-cyan-400`} />;
  if (["json"].includes(ext))
    return <FileJson className={`${iconClass} text-yellow-300`} />;
  if (["yaml", "yml", "toml", "xml"].includes(ext))
    return <FileJson className={`${iconClass} text-dalam-text-muted`} />;
  if (["md", "mdx", "txt", "rst"].includes(ext))
    return <FileText className={`${iconClass} text-blue-300`} />;
  if (["png", "jpg", "jpeg", "gif", "svg", "webp"].includes(ext))
    return <ImageIcon className={`${iconClass} text-pink-400`} />;
  if (["css", "scss", "less", "sass"].includes(ext))
    return <FileType className={`${iconClass} text-purple-400`} />;
  if (["html"].includes(ext))
    return <FileCode className={`${iconClass} text-orange-300`} />;
  return <FileIcon className={`${iconClass} text-dalam-text-muted`} />;
}

const STATUS_COLOR: Record<string, string> = {
  modified: "text-dalam-git-modified",
  added: "text-dalam-git-added",
  deleted: "text-dalam-git-deleted",
  untracked: "text-dalam-git-untracked",
};

const STATUS_LETTER: Record<string, string> = {
  modified: "M",
  added: "A",
  deleted: "D",
  untracked: "U",
};

export function FileTree() {
  const { fileTree, activeWorkspaceId, workspaces } = useWorkspace();
  const toast = useToast();
  const activeWorkspace = workspaces.find((w) => w.id === activeWorkspaceId);

  const handleRootContextMenu = (e: React.MouseEvent) => {
    if (!activeWorkspace) return;
    const mod = modKey();
    showContextMenu(e, [
      {
        type: "item",
        label: "New File",
        icon: <FilePlus className="w-3.5 h-3.5" />,
        perform: () => promptCreate(e, activeWorkspace.path, "file"),
      },
      {
        type: "item",
        label: "New Folder",
        icon: <FolderPlus className="w-3.5 h-3.5" />,
        perform: () => promptCreate(e, activeWorkspace.path, "directory"),
      },
      { type: "separator" },
      {
        type: "item",
        label: "Copy Path",
        icon: <Copy className="w-3.5 h-3.5" />,
        shortcut: `${mod}⇧C`,
        perform: () => copyToClipboard(activeWorkspace.path, toast),
      },
      {
        type: "item",
        label: "Reveal in Finder",
        icon: <FolderSearch className="w-3.5 h-3.5" />,
        perform: () => revealInFinder(activeWorkspace.path),
      },
      { type: "separator" },
      {
        type: "item",
        label: "Open in Terminal",
        icon: <TerminalSquare className="w-3.5 h-3.5" />,
        perform: () => openInTerminal(activeWorkspace.path),
      },
    ]);
  };

  const promptCreate = (
    e: React.MouseEvent,
    parentPath: string,
    kind: "file" | "directory",
  ) => {
    const name = window.prompt(`Name of new ${kind}:`);
    if (!name) return;
    const api_call =
      kind === "file"
        ? useWorkspace.getState().createFile(parentPath, name)
        : useWorkspace.getState().createDirectory(parentPath, name);
    api_call
      .then(() =>
        toast.success(`${kind === "file" ? "File" : "Folder"} created`, name),
      )
      .catch((err) =>
        toast.error(`Failed to create ${kind}`, (err as Error)?.message),
      );
  };

  if (!fileTree.length) {
    return (
      <div className="p-4 text-xs text-dalam-text-muted">
        Open a folder to start.
      </div>
    );
  }
  return (
    <div
      className="flex-1 min-h-0 overflow-y-auto py-0.5 text-[13px] scrollbar-thin"
      onContextMenu={handleRootContextMenu}
    >
      {fileTree
        .filter(
          (n) =>
            n.name !== "node_modules" &&
            n.name !== ".git" &&
            n.name !== ".DS_Store",
        )
        .map((node) => (
          <TreeNode key={node.path} node={node} depth={0} />
        ))}
    </div>
  );
}

const TreeNode = React.memo(function TreeNode({
  node,
  depth,
}: {
  node: FileNodeT;
  depth: number;
}) {
  const [open, setOpen] = useState(depth < 2);
  const {
    activeFilePath,
    openFile,
    createFile,
    createDirectory,
    deletePath,
    renamePath,
  } = useWorkspace();
  const openDiff = useDiffView((s) => s.openFile);
  const toast = useToast();
  const isDir = node.type === "directory";
  const isActive = !isDir && activeFilePath === node.path;
  const indent = 4 + depth * 12;

  // Reset open state when node path changes (e.g., workspace switch)
  const prevPathRef = useRef(node.path);
  useEffect(() => {
    if (prevPathRef.current !== node.path) {
      prevPathRef.current = node.path;
      setOpen(depth < 2);
    }
  }, [node.path, depth]);

  const handleContextMenu = (e: React.MouseEvent) => {
    const mod = modKey();
    const ws = useWorkspace
      .getState()
      .workspaces.find(
        (w) => w.id === useWorkspace.getState().activeWorkspaceId,
      );
    const basePath = ws?.path ?? "";
    const items: ContextMenuItem[] = isDir
      ? [
          {
            type: "item",
            label: "New File",
            icon: <FilePlus className="w-3.5 h-3.5" />,
            perform: () => promptCreate(e, node.path, "file"),
          },
          {
            type: "item",
            label: "New Folder",
            icon: <FolderPlus className="w-3.5 h-3.5" />,
            perform: () => promptCreate(e, node.path, "directory"),
          },
          { type: "separator" },
          {
            type: "item",
            label: "Copy Path",
            icon: <Copy className="w-3.5 h-3.5" />,
            shortcut: `${mod}⇧C`,
            perform: () => copyToClipboard(node.path, toast),
          },
          {
            type: "item",
            label: "Copy Relative Path",
            icon: <Copy className="w-3.5 h-3.5" />,
            perform: () =>
              copyToClipboard(
                basePath ? node.path.replace(basePath + "/", "") : node.path,
                toast,
              ),
          },
          { type: "separator" },
          {
            type: "item",
            label: "Rename",
            icon: <Pencil className="w-3.5 h-3.5" />,
            shortcut: "F2",
            perform: () => promptRename(e, node.name, node.path),
          },
          {
            type: "item",
            label: "Delete",
            icon: <Trash2 className="w-3.5 h-3.5" />,
            destructive: true,
            shortcut: "Del",
            perform: () => promptDelete(e, node.name, node.path),
          },
          { type: "separator" },
          {
            type: "item",
            label: "Reveal in Finder",
            icon: <FolderSearch className="w-3.5 h-3.5" />,
            perform: () => revealInFinder(node.path),
          },
          {
            type: "item",
            label: "Open in Terminal",
            icon: <TerminalSquare className="w-3.5 h-3.5" />,
            perform: () => openInTerminal(node.path),
          },
        ]
      : [
          {
            type: "item",
            label: "Open",
            icon: <FileCode className="w-3.5 h-3.5" />,
            shortcut: "Enter",
            perform: () => {
              void openFile(node.path);
            },
          },
          {
            type: "item",
            label: "Open Diff",
            icon: <FileCode className="w-3.5 h-3.5" />,
            perform: () =>
              openDiff({
                path: node.path,
                action: "modified",
                additions: 0,
                deletions: 0,
              }),
          },
          { type: "separator" },
          {
            type: "item",
            label: "Copy Path",
            icon: <Copy className="w-3.5 h-3.5" />,
            shortcut: `${mod}⇧C`,
            perform: () => copyToClipboard(node.path, toast),
          },
          {
            type: "item",
            label: "Copy Relative Path",
            icon: <Copy className="w-3.5 h-3.5" />,
            perform: () =>
              copyToClipboard(
                basePath ? node.path.replace(basePath + "/", "") : node.path,
                toast,
              ),
          },
          { type: "separator" },
          {
            type: "item",
            label: "Rename",
            icon: <Pencil className="w-3.5 h-3.5" />,
            shortcut: "F2",
            perform: () => promptRename(e, node.name, node.path),
          },
          {
            type: "item",
            label: "Delete",
            icon: <Trash2 className="w-3.5 h-3.5" />,
            destructive: true,
            shortcut: "Del",
            perform: () => promptDelete(e, node.name, node.path),
          },
          { type: "separator" },
          {
            type: "item",
            label: "Reveal in Finder",
            icon: <FolderSearch className="w-3.5 h-3.5" />,
            perform: () => revealInFinder(node.path),
          },
          {
            type: "item",
            label: "Open in Terminal",
            icon: <TerminalSquare className="w-3.5 h-3.5" />,
            perform: () => openInTerminal(node.path),
          },
        ];
    showContextMenu(e, items);
  };

  const promptCreate = (
    _e: React.MouseEvent,
    parentPath: string,
    kind: "file" | "directory",
  ) => {
    const name = window.prompt(`Name of new ${kind} in ${node.name}:`);
    if (!name) return;
    const call =
      kind === "file"
        ? createFile(parentPath, name)
        : createDirectory(parentPath, name);
    call
      .then(() => {
        if (isDir) setOpen(true);
        toast.success(`${kind === "file" ? "File" : "Folder"} created`, name);
      })
      .catch((err) =>
        toast.error(`Failed to create ${kind}`, (err as Error)?.message),
      );
  };

  const promptRename = (
    _e: React.MouseEvent,
    _oldName: string,
    filePath: string,
  ) => {
    const newName = window.prompt("Rename to:", _oldName);
    if (!newName || newName === _oldName) return;
    renamePath(filePath, newName)
      .then(() => toast.success("Renamed", `${_oldName} → ${newName}`))
      .catch((err) => toast.error("Rename failed", (err as Error)?.message));
  };

  const promptDelete = (
    _e: React.MouseEvent,
    itemName: string,
    filePath: string,
  ) => {
    if (!window.confirm(`Delete "${itemName}"? This cannot be undone.`)) return;
    deletePath(filePath)
      .then(() => toast.success("Deleted", itemName))
      .catch((err) => toast.error("Delete failed", (err as Error)?.message));
  };

  if (isDir) {
    return (
      <div>
        <button
          className={`group w-full flex items-center gap-1 pr-2 py-[3px] text-left transition-colors
            hover:bg-dalam-bg-hover/60 text-dalam-text-primary`}
          style={{ paddingLeft: indent }}
          onClick={() => setOpen((o) => !o)}
          onContextMenu={handleContextMenu}
        >
          <span className="text-dalam-text-muted flex-shrink-0 w-4 h-4 flex items-center justify-center">
            {open ? (
              <ChevronDown className="w-3 h-3" />
            ) : (
              <ChevronRight className="w-3 h-3" />
            )}
          </span>
          {open ? (
            <FolderOpen className="w-4 h-4 flex-shrink-0 text-blue-400/80" />
          ) : (
            <FolderClosed className="w-4 h-4 flex-shrink-0 text-blue-400/60" />
          )}
          <span className="truncate flex-1 text-[13px] font-medium text-dalam-text-primary">
            {node.name}
          </span>
          {node.gitStatus && (
            <span
              className={`text-[9px] font-mono font-bold ${STATUS_COLOR[node.gitStatus] ?? ""}`}
              title={node.gitStatus}
            >
              {STATUS_LETTER[node.gitStatus]}
            </span>
          )}
        </button>
        {open &&
          node.children
            ?.filter(
              (c) =>
                c.name !== "node_modules" &&
                c.name !== ".git" &&
                c.name !== ".DS_Store",
            )
            .map((c) => <TreeNode key={c.path} node={c} depth={depth + 1} />)}
      </div>
    );
  }

  return (
    <button
      className={`group w-full flex items-center gap-1.5 pr-2 py-[3px] text-left transition-colors
        ${
          isActive
            ? "bg-dalam-accent-subtle text-dalam-text-primary"
            : "hover:bg-dalam-bg-hover/60 text-dalam-text-primary"
        }`}
      style={{ paddingLeft: indent + 16 }}
      onClick={() => {
        void openFile(node.path);
      }}
      onContextMenu={handleContextMenu}
    >
      {renderFileIcon(node.name, "w-4 h-4 flex-shrink-0")}
      <span className="truncate flex-1 text-[13px]">{node.name}</span>
      {node.gitStatus && (
        <span
          className={`text-[9px] font-mono font-bold flex-shrink-0 ${STATUS_COLOR[node.gitStatus] ?? ""}`}
          title={node.gitStatus}
        >
          {STATUS_LETTER[node.gitStatus]}
        </span>
      )}
    </button>
  );
});
