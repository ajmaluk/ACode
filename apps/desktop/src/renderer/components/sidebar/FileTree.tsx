import { useState } from "react";
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
} from "lucide-react";
import type { FileNode as FileNodeT } from "@dalam/shared-types";
import { useWorkspace } from "@/store/useAppStore";
import { showContextMenu, type ContextMenuItem } from "@/components/ui/ContextMenu";
import { useToast } from "@/components/ui/Toaster";

function renderFileIcon(name: string, className: string) {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const iconClass = className;
  if (["ts", "tsx", "js", "jsx", "rs", "go", "py", "rb", "java"].includes(ext))
    return <FileCode className={iconClass} />;
  if (["json", "yaml", "yml", "toml", "xml"].includes(ext)) return <FileJson className={iconClass} />;
  if (["md", "mdx", "txt", "rst"].includes(ext)) return <FileText className={iconClass} />;
  if (["png", "jpg", "jpeg", "gif", "svg", "webp"].includes(ext)) return <ImageIcon className={iconClass} />;
  if (["css", "scss", "less", "sass"].includes(ext)) return <FileType className={iconClass} />;
  return <FileIcon className={iconClass} />;
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
    showContextMenu(e, [
      {
        type: "item", label: "New File", icon: <FilePlus className="w-3.5 h-3.5" />,
        perform: () => promptCreate(e, activeWorkspace.path, "file"),
      },
      {
        type: "item", label: "New Folder", icon: <FolderPlus className="w-3.5 h-3.5" />,
        perform: () => promptCreate(e, activeWorkspace.path, "directory"),
      },
    ]);
  };

  const promptCreate = (e: React.MouseEvent, parentPath: string, kind: "file" | "directory") => {
    const name = window.prompt(`Name of new ${kind}:`);
    if (!name) return;
    const api_call = kind === "file"
      ? useWorkspace.getState().createFile(parentPath, name)
      : useWorkspace.getState().createDirectory(parentPath, name);
    api_call
      .then(() => toast.success(`${kind === "file" ? "File" : "Folder"} created`, name))
      .catch((err) => toast.error(`Failed to create ${kind}`, (err as Error)?.message));
  };

  if (!fileTree.length) {
    return (
      <div className="p-4 text-xs text-dalam-text-muted">
        Open a folder to start.
      </div>
    );
  }
  return (
    <div className="flex-1 min-h-0 overflow-y-auto py-1 text-sm scrollbar-thin" onContextMenu={handleRootContextMenu}>
      {fileTree
        .filter((n) => n.name !== "node_modules")
        .map((node) => (
          <TreeNode key={node.path} node={node} depth={0} />
        ))}
    </div>
  );
}

function TreeNode({ node, depth }: { node: FileNodeT; depth: number }) {
  const [open, setOpen] = useState(depth < 2);
  const { setActiveFile, activeFilePath, openFile, createFile, createDirectory, deletePath, renamePath } = useWorkspace();
  const toast = useToast();
  const isDir = node.type === "directory";
  const isActive = !isDir && activeFilePath === node.path;
  const indent = 8 + depth * 12;

  const handleContextMenu = (e: React.MouseEvent) => {
    const items: ContextMenuItem[] = isDir
      ? [
          {
            type: "item", label: "New File", icon: <FilePlus className="w-3.5 h-3.5" />,
            perform: () => promptCreate(e, node.path, "file"),
          },
          {
            type: "item", label: "New Folder", icon: <FolderPlus className="w-3.5 h-3.5" />,
            perform: () => promptCreate(e, node.path, "directory"),
          },
          { type: "separator" },
          {
            type: "item", label: "Rename", icon: <Pencil className="w-3.5 h-3.5" />,
            perform: () => promptRename(e, node.name, node.path),
          },
          {
            type: "item", label: "Delete", icon: <Trash2 className="w-3.5 h-3.5" />, destructive: true,
            perform: () => promptDelete(e, node.name, node.path),
          },
        ]
      : [
          {
            type: "item", label: "Rename", icon: <Pencil className="w-3.5 h-3.5" />,
            perform: () => promptRename(e, node.name, node.path),
          },
          {
            type: "item", label: "Delete", icon: <Trash2 className="w-3.5 h-3.5" />, destructive: true,
            perform: () => promptDelete(e, node.name, node.path),
          },
        ];
    showContextMenu(e, items);
  };

  const promptCreate = (_e: React.MouseEvent, parentPath: string, kind: "file" | "directory") => {
    const name = window.prompt(`Name of new ${kind} in ${node.name}:`);
    if (!name) return;
    const call = kind === "file"
      ? createFile(parentPath, name)
      : createDirectory(parentPath, name);
    call
      .then(() => { if (isDir) setOpen(true); toast.success(`${kind === "file" ? "File" : "Folder"} created`, name); })
      .catch((err) => toast.error(`Failed to create ${kind}`, (err as Error)?.message));
  };

  const promptRename = (_e: React.MouseEvent, _oldName: string, filePath: string) => {
    const newName = window.prompt("Rename to:", _oldName);
    if (!newName || newName === _oldName) return;
    renamePath(filePath, newName)
      .then(() => toast.success("Renamed", `${_oldName} → ${newName}`))
      .catch((err) => toast.error("Rename failed", (err as Error)?.message));
  };

  const promptDelete = (_e: React.MouseEvent, itemName: string, filePath: string) => {
    if (!window.confirm(`Delete "${itemName}"? This cannot be undone.`)) return;
    deletePath(filePath)
      .then(() => toast.success("Deleted", itemName))
      .catch((err) => toast.error("Delete failed", (err as Error)?.message));
  };

  if (isDir) {
    return (
      <div>
        <button
          className={`group w-full flex items-center gap-1.5 pr-2 py-0.5 text-left transition-colors
            hover:bg-dalam-bg-hover text-dalam-text-primary
            ${open ? "bg-dalam-bg-hover/30" : ""}`}
          style={{ paddingLeft: indent }}
          onClick={() => setOpen((o) => !o)}
          onContextMenu={handleContextMenu}
        >
          <span className="text-dalam-text-muted flex-shrink-0 w-3 h-3 flex items-center justify-center">
            {open ? (
              <ChevronDown className="w-3 h-3" />
            ) : (
              <ChevronRight className="w-3 h-3" />
            )}
          </span>
          {isDir
            ? (open
              ? <FolderOpen className="w-3.5 h-3.5 flex-shrink-0 text-dalam-accent-primary" />
              : <FolderClosed className="w-3.5 h-3.5 flex-shrink-0 text-dalam-text-secondary" />)
            : renderFileIcon(node.name, "w-3.5 h-3.5 text-dalam-text-secondary flex-shrink-0")
          }
          <span className="truncate flex-1">{node.name}</span>
          {node.gitStatus && (
            <span
              className={`text-[10px] font-mono ${STATUS_COLOR[node.gitStatus] ?? ""}`}
              title={node.gitStatus}
            >
              {STATUS_LETTER[node.gitStatus]}
            </span>
          )}
        </button>
        {open &&
          node.children?.map((c) => <TreeNode key={c.path} node={c} depth={depth + 1} />)}
      </div>
    );
  }

  return (
    <button
      className={`group w-full flex items-center gap-1.5 pr-2 py-0.5 text-left transition-colors
        ${isActive
          ? "bg-dalam-accent-subtle text-dalam-text-primary ring-subtle"
          : "hover:bg-dalam-bg-hover text-dalam-text-primary"
        }`}
      style={{ paddingLeft: indent + 12 }}
      onClick={() => {
        setActiveFile(node.path);
        openFile(node.path);
      }}
      onContextMenu={handleContextMenu}
    >
      {renderFileIcon(node.name, "w-3.5 h-3.5 text-dalam-text-secondary flex-shrink-0")}
      <span className="truncate flex-1">{node.name}</span>
      {node.gitStatus && (
        <span
          className={`text-[10px] font-mono flex-shrink-0 ${STATUS_COLOR[node.gitStatus] ?? ""}`}
          title={node.gitStatus}
        >
          {STATUS_LETTER[node.gitStatus]}
        </span>
      )}
    </button>
  );
}
