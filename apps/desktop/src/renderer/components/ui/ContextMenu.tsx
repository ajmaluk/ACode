import { useEffect, useRef, useState, forwardRef } from "react";
import { ChevronRight } from "lucide-react";

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

export function showContextMenu(e: React.MouseEvent, items: ContextMenuItem[]) {
  e.preventDefault();
  e.stopPropagation();
  globalSetMenu?.({ x: e.clientX, y: e.clientY, items });
}

export function ContextMenuProvider({ children }: { children: React.ReactNode }) {
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => { globalSetMenu = setMenu; return () => { globalSetMenu = null; }; }, []);

  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenu(null);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setMenu(null); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  if (!menu) return <>{children}</>;

  return (
    <>
      {children}
      <ContextMenuPanel ref={menuRef} state={menu} onClose={() => setMenu(null)} />
    </>
  );
}

const ContextMenuPanel = forwardRef<HTMLDivElement, { state: ContextMenuState; onClose: () => void }>(({ state, onClose }, ref) => {
  const [openSub, setOpenSub] = useState<number | null>(null);
  const innerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = innerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    if (rect.right > vw) el.style.left = `${state.x - rect.width}px`;
    if (rect.bottom > vh) el.style.top = `${state.y - rect.height}px`;
  }, [state.x, state.y]);

  return (
    <div
      ref={(node) => { innerRef.current = node; if (typeof ref === "function") ref(node); else if (ref) (ref as React.MutableRefObject<HTMLDivElement | null>).current = node; }}
      className="fixed z-[100] min-w-[200px] bg-dalam-bg-secondary border border-dalam-border-primary rounded-lg shadow-2xl py-1 animate-fade-in"
      style={{ left: state.x, top: state.y }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {state.items.map((item, idx) => {
        if (item.type === "separator") return <div key={idx} className="h-px bg-dalam-border-primary my-1 mx-1" />;
        if (item.type === "submenu") return (
          <div key={idx} className="relative"
            onMouseEnter={() => setOpenSub(idx)}
            onMouseLeave={() => setOpenSub(null)}
          >
            <button className="w-full flex items-center justify-between gap-3 px-2.5 py-1.5 text-xs text-dalam-text-primary hover:bg-dalam-accent-subtle transition-colors">
              <span className="flex items-center gap-2">
                {item.icon && <span className="w-4 flex-shrink-0 flex justify-center">{item.icon}</span>}
                {item.label}
              </span>
              <ChevronRight className="w-3 h-3 text-dalam-text-muted" />
            </button>
            {openSub === idx && (
              <div className="absolute left-full top-0 min-w-[180px] bg-dalam-bg-secondary border border-dalam-border-primary rounded-lg shadow-2xl py-1">
                {item.items.map((sub, si) => {
                  if (sub.type === "separator") return <div key={si} className="h-px bg-dalam-border-primary my-1 mx-1" />;
                  if (sub.type === "item") return (
                    <button key={si} disabled={sub.disabled} onClick={() => { sub.perform(); onClose(); }}
                      className={`w-full flex items-center justify-between gap-3 px-2.5 py-1.5 text-xs transition-colors disabled:opacity-40 disabled:hover:bg-transparent ${
                        sub.destructive
                          ? "text-red-400 hover:bg-red-500/10"
                          : "text-dalam-text-primary hover:bg-dalam-accent-subtle"
                      }`}
                    >
                      <span className="flex items-center gap-2">
                        {sub.icon && <span className="w-4 flex-shrink-0 flex justify-center">{sub.icon}</span>}
                        {sub.label}
                      </span>
                      {sub.shortcut && <kbd className="text-[10px] text-dalam-text-muted">{sub.shortcut}</kbd>}
                    </button>
                  );
                  return null;
                })}
              </div>
            )}
          </div>
        );
        // item.type === "item"
        return (
          <button key={idx} disabled={item.disabled} onClick={() => { item.perform(); onClose(); }}
            className={`w-full flex items-center justify-between gap-3 px-2.5 py-1.5 text-xs transition-colors disabled:opacity-40 disabled:hover:bg-transparent ${
              item.destructive
                ? "text-red-400 hover:bg-red-500/10"
                : "text-dalam-text-primary hover:bg-dalam-accent-subtle"
            }`}
          >
            <span className="flex items-center gap-2">
              {item.icon && <span className="w-4 flex-shrink-0 flex justify-center">{item.icon}</span>}
              {item.label}
            </span>
            {item.shortcut && <kbd className="text-[10px] text-dalam-text-muted">{item.shortcut}</kbd>}
          </button>
        );
      })}
    </div>
  );
});
