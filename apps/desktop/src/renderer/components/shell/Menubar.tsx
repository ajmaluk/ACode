import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";

export type MenuAction =
  | { type: "item"; label: string; shortcut?: string; perform: () => void; disabled?: boolean }
  | { type: "separator" }
  | { type: "submenu"; label: string; items: MenuAction[] };

export type MenuItem = { label: string; items: MenuAction[] };

/**
 * macOS-style menubar — used inside the frameless title bar.
 * Each top-level label is a button that opens a dropdown panel.
 */
export function Menubar({ menus }: { menus: MenuItem[] }) {
  const [openIdx, setOpenIdx] = useState<number | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (openIdx === null) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpenIdx(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenIdx(null);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [openIdx]);

  return (
    <div ref={rootRef} className="flex items-center h-9">
      {menus.map((m, i) => (
        <div key={m.label} className="relative">
          <button
            className={`px-2.5 h-7 text-xs rounded text-acode-text-primary hover:bg-acode-bg-hover transition-colors ${
              openIdx === i ? "bg-acode-bg-hover" : ""
            }`}
            onClick={() => setOpenIdx(openIdx === i ? null : i)}
            onMouseEnter={() => openIdx !== null && setOpenIdx(i)}
          >
            {m.label}
          </button>
          {openIdx === i && (
            <Panel
              items={m.items}
              onClose={() => setOpenIdx(null)}
            />
          )}
        </div>
      ))}
    </div>
  );
}

function Panel({
  items,
  onClose,
}: {
  items: MenuAction[];
  onClose: () => void;
}) {
  return (
    <div
      className="absolute left-0 top-9 min-w-[220px] bg-acode-bg-secondary border border-acode-border-primary rounded-md shadow-2xl py-1 z-50 animate-fade-in"
      onMouseDown={(e) => e.stopPropagation()}
    >
      {items.map((action, idx) => {
        if (action.type === "separator") {
          return <div key={idx} className="h-px bg-acode-border-primary my-1 mx-1" />;
        }
        if (action.type === "item") {
          return (
            <button
              key={idx}
              disabled={action.disabled}
              onClick={() => {
                action.perform();
                onClose();
              }}
              className="w-full flex items-center justify-between gap-3 px-2.5 py-1 text-xs text-acode-text-primary hover:bg-acode-accent-subtle hover:text-acode-text-primary transition-colors disabled:opacity-50 disabled:hover:bg-transparent"
            >
              <span>{action.label}</span>
              {action.shortcut && (
                <kbd className="text-[10px] text-acode-text-muted">{action.shortcut}</kbd>
              )}
            </button>
          );
        }
        if (action.type === "submenu") {
          return (
            <div key={idx} className="relative group">
              <button
                className="w-full flex items-center justify-between gap-3 px-2.5 py-1 text-xs text-acode-text-primary hover:bg-acode-accent-subtle hover:text-acode-text-primary transition-colors"
              >
                <span>{action.label}</span>
                <span className="text-acode-text-muted">▸</span>
              </button>
              <div className="absolute left-full top-0 min-w-[200px] bg-acode-bg-secondary border border-acode-border-primary rounded-md shadow-2xl py-1 z-50 hidden group-hover:block">
                {action.items.map((sub, si) => {
                  if (sub.type === "separator") return <div key={si} className="h-px bg-acode-border-primary my-1 mx-1" />;
                  if (sub.type === "item") return (
                    <button key={si} disabled={sub.disabled} onClick={() => { sub.perform(); onClose(); }}
                      className="w-full flex items-center justify-between gap-3 px-2.5 py-1 text-xs text-acode-text-primary hover:bg-acode-accent-subtle hover:text-acode-text-primary transition-colors disabled:opacity-50 disabled:hover:bg-transparent">
                      <span>{sub.label}</span>
                      {sub.shortcut && <kbd className="text-[10px] text-acode-text-muted">{sub.shortcut}</kbd>}
                    </button>
                  );
                  return null;
                })}
              </div>
            </div>
          );
        }
        return null;
      })}
    </div>
  );
}
