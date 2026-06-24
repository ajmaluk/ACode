import { useShortcuts } from "@/store/useAppStore";
import { useEffect } from "react";
import { X, Keyboard } from "lucide-react";

const SECTIONS = [
  {
    title: "Workspace",
    shortcuts: [
      { keys: ["⌘", "K"], desc: "Open command palette" },
      { keys: ["⌘", "P"], desc: "Quick open file" },
      { keys: ["⌘", "⇧", "F"], desc: "Search across project" },
      { keys: ["⌘", "O"], desc: "Open folder" },
      { keys: ["⌘", "S"], desc: "Save current file" },
    ],
  },
  {
    title: "Editor",
    shortcuts: [
      { keys: ["⌘", "W"], desc: "Close current tab" },
      { keys: ["⌘", "B"], desc: "Toggle sidebar" },
      { keys: ["⌘", "J"], desc: "Toggle terminal" },
      { keys: ["⌘", "/"], desc: "Toggle comment" },
      { keys: ["⌥", "↑/↓"], desc: "Move line up/down" },
    ],
  },
  {
    title: "Agent",
    shortcuts: [
      { keys: ["⌘", "N"], desc: "New task" },
      { keys: ["⌘", "⇧", "L"], desc: "Focus chat" },
      { keys: ["Esc"], desc: "Abort current run" },
      { keys: ["@"], desc: "Mention a file" },
      { keys: ["/"], desc: "Slash command" },
      { keys: ["$"], desc: "Invoke a skill" },
    ],
  },
  {
    title: "Navigation",
    shortcuts: [
      { keys: ["⌘", "⇧", "O"], desc: "Go to symbol" },
      { keys: ["⌘", "T"], desc: "Reopen closed tab" },
      { keys: ["⌃", "`"], desc: "Toggle terminal" },
      { keys: ["⌘", ","], desc: "Open settings" },
      { keys: ["?"], desc: "Show this cheatsheet" },
    ],
  },
];

export function ShortcutsCheatsheet() {
  const { open, setOpen } = useShortcuts();
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setOpen]);
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-8 animate-fade-in"
      onClick={() => setOpen(false)}
    >
      <div
        className="w-[760px] max-w-[96vw] max-h-[86vh] bg-acode-bg-secondary border border-acode-border-primary rounded-xl shadow-2xl flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="h-12 flex items-center justify-between px-4 border-b border-acode-border-primary">
          <div className="flex items-center gap-2 text-sm font-medium text-acode-text-primary">
            <Keyboard className="w-4 h-4 text-acode-accent-primary" />
            Keyboard shortcuts
          </div>
          <button className="btn-icon" onClick={() => setOpen(false)}>
            <X className="w-4 h-4" />
          </button>
        </header>
        <div className="grid grid-cols-2 gap-6 p-6 overflow-y-auto scrollbar-thin">
          {SECTIONS.map((s) => (
            <section key={s.title}>
              <h3 className="text-[11px] uppercase tracking-wider text-acode-text-muted mb-2">
                {s.title}
              </h3>
              <div className="space-y-1.5">
                {s.shortcuts.map((sc) => (
                  <div key={sc.desc} className="flex items-center justify-between gap-3 text-sm">
                    <span className="text-acode-text-secondary">{sc.desc}</span>
                    <span className="flex items-center gap-1 flex-shrink-0">
                      {sc.keys.map((k, i) => (
                        <kbd
                          key={i}
                          className="px-1.5 py-0.5 bg-acode-bg-tertiary border border-acode-border-primary rounded text-[11px] text-acode-text-primary min-w-[20px] text-center"
                        >
                          {k}
                        </kbd>
                      ))}
                    </span>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
        <footer className="border-t border-acode-border-primary px-4 py-2 text-[11px] text-acode-text-muted">
          Press <kbd className="px-1 bg-acode-bg-tertiary rounded">?</kbd> anywhere to reopen this.
        </footer>
      </div>
    </div>
  );
}
