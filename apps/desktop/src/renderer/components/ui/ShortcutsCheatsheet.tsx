import { useShortcuts } from "@/store/useAppStore";
import { useEffect } from "react";
import { X, Keyboard } from "lucide-react";
import { modKey } from "@/lib/platform";

function getSections() {
  const mod = modKey();
  const alt = modKey() === "⌘" ? "⌥" : "Alt";
  const shift = modKey() === "⌘" ? "⇧" : "Shift";
  return [
    {
      title: "Workspace",
      shortcuts: [
        { keys: [mod, "K"], desc: "Open command palette" },
        { keys: [mod, "P"], desc: "Quick open file" },
        { keys: [mod, "O"], desc: "Open folder" },
        { keys: [mod, "S"], desc: "Save current file" },
        { keys: [mod, shift, "S"], desc: "Save all files" },
      ],
    },
    {
      title: "Editor",
      shortcuts: [
        { keys: [mod, "W"], desc: "Close current tab" },
        { keys: [mod, "B"], desc: "Toggle sidebar" },
        { keys: [mod, "J"], desc: "Toggle terminal" },
        { keys: [mod, "/"], desc: "Toggle comment" },
        { keys: [mod, "F"], desc: "Find" },
        { keys: [alt, "F"], desc: "Find and replace" },
        { keys: [mod, "E"], desc: "Toggle agent/editor mode" },
      ],
    },
    {
      title: "Agent",
      shortcuts: [
        { keys: [mod, "N"], desc: "New task" },
        { keys: ["Esc"], desc: "Abort current run" },
        { keys: ["@"], desc: "Mention a file" },
        { keys: ["/"], desc: "Slash command" },
        { keys: ["$"], desc: "Invoke a skill" },
      ],
    },
    {
      title: "Navigation",
      shortcuts: [
        { keys: [mod, "G"], desc: "Go to line" },
        { keys: [mod, "["], desc: "Back" },
        { keys: [mod, "]"], desc: "Forward" },
        { keys: [mod, "`"], desc: "New terminal" },
        { keys: [mod, ","], desc: "Open settings" },
        { keys: [mod, "="], desc: "Zoom in" },
        { keys: [mod, "-"], desc: "Zoom out" },
        { keys: ["?"], desc: "Show this cheatsheet" },
      ],
    },
  ];
}

export function ShortcutsCheatsheet() {
  const { open, setOpen } = useShortcuts();
  const sections = getSections();
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
        className="w-[760px] max-w-[96vw] max-h-[86vh] bg-dalam-bg-secondary border border-dalam-border-primary rounded-xl shadow-2xl flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="h-12 flex items-center justify-between px-4 border-b border-dalam-border-primary">
          <div className="flex items-center gap-2 text-sm font-medium text-dalam-text-primary">
            <Keyboard className="w-4 h-4 text-dalam-accent-primary" />
            Keyboard shortcuts
          </div>
          <button className="btn-icon" onClick={() => setOpen(false)}>
            <X className="w-4 h-4" />
          </button>
        </header>
        <div className="grid grid-cols-2 gap-6 p-6 overflow-y-auto scrollbar-thin">
          {sections.map((s) => (
            <section key={s.title}>
              <h3 className="text-[11px] uppercase tracking-wider text-dalam-text-muted mb-2">
                {s.title}
              </h3>
              <div className="space-y-1.5">
                {s.shortcuts.map((sc) => (
                  <div key={sc.desc} className="flex items-center justify-between gap-3 text-sm">
                    <span className="text-dalam-text-secondary">{sc.desc}</span>
                    <span className="flex items-center gap-1 flex-shrink-0">
                      {sc.keys.map((k, i) => (
                        <kbd
                          key={i}
                          className="px-1.5 py-0.5 bg-dalam-bg-tertiary border border-dalam-border-primary rounded text-[11px] text-dalam-text-primary min-w-[20px] text-center"
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
        <footer className="border-t border-dalam-border-primary px-4 py-2 text-[11px] text-dalam-text-muted">
          Press <kbd className="px-1 bg-dalam-bg-tertiary rounded">?</kbd> anywhere to reopen this.
        </footer>
      </div>
    </div>
  );
}
