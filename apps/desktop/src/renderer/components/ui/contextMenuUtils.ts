/**
 * Context menu utilities — shared state and helper function.
 * Separated from ContextMenu.tsx to satisfy react-refresh/only-export-components.
 */

export type ContextMenuItem =
  | { type: "item"; label: string; shortcut?: string; icon?: React.ReactNode; perform: () => void; destructive?: boolean; disabled?: boolean }
  | { type: "separator" }
  | { type: "submenu"; label: string; icon?: React.ReactNode; items: ContextMenuItem[] };

type ContextMenuState = {
  x: number;
  y: number;
  items: ContextMenuItem[];
};

let globalSetMenu: ((s: ContextMenuState | null) => void) | null = null;

/**
 * Connect the ContextMenuProvider to the shared menu state.
 * Returns an unsubscribe function (call on unmount).
 */
export function connectContextMenu(setter: (s: ContextMenuState | null) => void): () => void {
  globalSetMenu = setter;
  return () => { globalSetMenu = null; };
}

/**
 * Show a context menu at the mouse event position.
 * Must be called after ContextMenuProvider has been mounted.
 */
export function showContextMenu(e: React.MouseEvent, items: ContextMenuItem[]) {
  e.preventDefault();
  e.stopPropagation();
  globalSetMenu?.({ x: e.clientX, y: e.clientY, items });
}
