import { useEffect, useRef, useState, forwardRef } from "react";
import { ChevronRight } from "lucide-react";
import { connectContextMenu, type ContextMenuState } from "./contextMenuUtils";

export function ContextMenuProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => connectContextMenu(setMenu), []);

  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node))
        setMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(null);
    };
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
      <ContextMenuPanel
        ref={menuRef}
        state={menu}
        onClose={() => setMenu(null)}
      />
    </>
  );
}

const ContextMenuPanel = forwardRef<
  HTMLDivElement,
  { state: ContextMenuState; onClose: () => void }
>(({ state, onClose }, ref) => {
  const [openSub, setOpenSub] = useState<number | null>(null);
  const [focusedIndex, setFocusedIndex] = useState(0);
  const innerRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Build flat list of actionable items (separators excluded, disabled items skipped) for keyboard nav
  const actionableItems = state.items.filter(
    (i) => i.type === "submenu" || (i.type === "item" && !i.disabled),
  );

  // Keep itemRefs array in sync with actionable items
  const focusedItem = actionableItems[focusedIndex];

  // Keyboard navigation
  useEffect(() => {
    if (!innerRef.current) return;
    innerRef.current.focus();
    itemRefs.current = itemRefs.current.slice(0, actionableItems.length);
    const handler = (e: KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setFocusedIndex((prev) => (prev + 1) % actionableItems.length);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setFocusedIndex(
          (prev) =>
            (prev - 1 + actionableItems.length) % actionableItems.length,
        );
      } else if (e.key === "ArrowRight") {
        const focused = actionableItems[focusedIndex];
        if (focused?.type === "submenu") {
          e.preventDefault();
          setOpenSub(state.items.indexOf(focused));
        }
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        setOpenSub(null);
      } else if (e.key === "Enter") {
        e.preventDefault();
        const focused = actionableItems[focusedIndex];
        if (focused?.type === "item") {
          focused.perform();
          onClose();
        } else if (focused?.type === "submenu") {
          setOpenSub(state.items.indexOf(focused));
        }
      } else if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    innerRef.current.addEventListener("keydown", handler);
    return () => innerRef.current?.removeEventListener("keydown", handler);
  }, [actionableItems, focusedIndex, state.items, onClose]);

  useEffect(() => {
    const el = innerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    if (rect.right > vw) el.style.left = `${state.x - rect.width}px`;
    if (rect.bottom > vh) el.style.top = `${state.y - rect.height}px`;
  }, [state.x, state.y]);

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    };
  }, []);

  const handleSubEnter = (idx: number) => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    setOpenSub(idx);
  };

  const handleSubLeave = () => {
    // Delay closing submenu to prevent flickering when moving to submenu
    closeTimerRef.current = setTimeout(() => {
      setOpenSub(null);
      closeTimerRef.current = null;
    }, 150);
  };

  return (
    <div
      ref={(node) => {
        innerRef.current = node;
        if (typeof ref === "function") ref(node);
        else if (ref)
          (ref as React.MutableRefObject<HTMLDivElement | null>).current = node;
      }}
      className="fixed z-[100] min-w-[200px] bg-dalam-bg-secondary border border-dalam-border-primary rounded-lg shadow-2xl py-1 animate-fade-in"
      style={{ left: state.x, top: state.y }}
      onMouseDown={(e) => e.stopPropagation()}
      role="menu"
      tabIndex={0}
      aria-activedescendant={focusedItem ? `context-menu-item-${state.items.indexOf(focusedItem)}` : undefined}
    >
      {state.items.map((item, idx) => {
        if (item.type === "separator")
          return (
            <div
              key={idx}
              className="h-px bg-dalam-border-primary my-1 mx-1"
              role="separator"
            />
          );
        const isFocused = actionableItems[focusedIndex] === item;
        if (item.type === "submenu")
          return (
            <div
              key={idx}
              className="relative"
              onMouseEnter={() => {
                handleSubEnter(idx);
                setFocusedIndex(actionableItems.indexOf(item));
              }}
              onMouseLeave={handleSubLeave}
            >
              <button
                id={`context-menu-item-${idx}`}
                className={`w-full flex items-center justify-between gap-3 px-2.5 py-1.5 text-xs text-dalam-text-primary transition-colors ${isFocused ? "bg-dalam-accent-subtle" : "hover:bg-dalam-accent-subtle"}`}
                role="menuitem"
                aria-haspopup="menu"
                aria-expanded={openSub === idx}
              >
                <span className="flex items-center gap-2">
                  {item.icon && (
                    <span className="w-4 flex-shrink-0 flex justify-center">
                      {item.icon}
                    </span>
                  )}
                  {item.label}
                </span>
                <ChevronRight className="w-3 h-3 text-dalam-text-muted" />
              </button>
              {openSub === idx && (
                <div
                  className="absolute left-full top-0 min-w-[180px] bg-dalam-bg-secondary border border-dalam-border-primary rounded-lg shadow-2xl py-1"
                  role="menu"
                  onMouseEnter={() => handleSubEnter(idx)}
                  onMouseLeave={handleSubLeave}
                >
                      {item.items.map((sub, si) => {
                    if (sub.type === "separator")
                      return (
                        <div
                          key={si}
                          className="h-px bg-dalam-border-primary my-1 mx-1"
                          role="separator"
                        />
                      );
                    if (sub.type === "item")
                      return (
                        <button
                          key={si}
                          id={`context-menu-sub-${idx}-${si}`}
                          disabled={sub.disabled}
                          onClick={() => {
                            sub.perform();
                            onClose();
                          }}
                          role="menuitem"
                          className={`w-full flex items-center justify-between gap-3 px-2.5 py-1.5 text-xs transition-colors disabled:opacity-40 disabled:hover:bg-transparent ${
                            sub.destructive
                              ? "text-red-400 hover:bg-red-500/10"
                              : "text-dalam-text-primary hover:bg-dalam-accent-subtle"
                          }`}
                        >
                          <span className="flex items-center gap-2">
                            {sub.icon && (
                              <span className="w-4 flex-shrink-0 flex justify-center">
                                {sub.icon}
                              </span>
                            )}
                            {sub.label}
                          </span>
                          {sub.shortcut && (
                            <kbd className="text-[10px] text-dalam-text-muted">
                              {sub.shortcut}
                            </kbd>
                          )}
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
          <button
            key={idx}
            id={`context-menu-item-${idx}`}
            disabled={item.disabled}
            onClick={() => {
              item.perform();
              onClose();
            }}
            role="menuitem"
            onMouseEnter={() => setFocusedIndex(actionableItems.indexOf(item))}
            className={`w-full flex items-center justify-between gap-3 px-2.5 py-1.5 text-xs transition-colors disabled:opacity-40 disabled:hover:bg-transparent ${
              item.destructive
                ? isFocused
                  ? "text-red-400 bg-red-500/10"
                  : "text-red-400 hover:bg-red-500/10"
                : isFocused
                  ? "text-dalam-text-primary bg-dalam-accent-subtle"
                  : "text-dalam-text-primary hover:bg-dalam-accent-subtle"
            }`}
          >
            <span className="flex items-center gap-2">
              {item.icon && (
                <span className="w-4 flex-shrink-0 flex justify-center">
                  {item.icon}
                </span>
              )}
              {item.label}
            </span>
            {item.shortcut && (
              <kbd className="text-[10px] text-dalam-text-muted">
                {item.shortcut}
              </kbd>
            )}
          </button>
        );
      })}
    </div>
  );
});
