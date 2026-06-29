/**
 * Dalam prompt autocomplete.
 *
 * Detects four trigger characters at the caret and surfaces a floating menu
 * of matching options. The four trigger surfaces, modeled directly on
 * Dalam's terminal-style chat input:
 *
 *   /  → slash commands  (init, compact, clear, help, login, model, reasoning, share)
 *   @  → workspace files (filtered by the file tree)
 *   $  → bundled skills   (from the registry)
 *   #  → related sessions (the sidebar's chat sessions)
 *
 * The component is self-contained:
 *   - It owns its own caret + activeIdx state.
 *   - It reads/writes the textarea caret via `textareaRef` and listens for
 *     click / key / select events on the textarea so the caret stays in sync.
 *   - It exposes a single `handleKeyDown` that the parent wires into the
 *     textarea's onKeyDown so the menu and the textarea share the same
 *     input loop.
 *
 * The parent only needs to render the textarea + this component as siblings
 * inside a `relative` container.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Terminal,
  FileText,
  Sparkles,
  Hash,
  CornerDownLeft,
  ChevronUp,
  ChevronDown,
} from "lucide-react";
import type { FileNode, ChatSessionSummary } from "@dalam/shared-types";
import { BUNDLED_SKILLS } from "@/lib/skills";

// ----------------------------------------------------------------------------
// Slash command list
// ----------------------------------------------------------------------------

type SlashCommand = {
  id: string;
  label: string;
  description: string;
  /** Token that gets inserted when the command is selected. */
  insert: string;
};

const SLASH_COMMANDS: SlashCommand[] = [
  { id: "init",      label: "/init",      description: "Scan the workspace and bootstrap DALAM.md",  insert: "/init " },
  { id: "compact",   label: "/compact",   description: "Compress the current session into a summary", insert: "/compact" },
  { id: "clear",     label: "/clear",     description: "Clear the current chat and start fresh",      insert: "/clear" },
  { id: "help",      label: "/help",      description: "Show the available commands and shortcuts",   insert: "/help" },
  { id: "login",     label: "/login",     description: "Authenticate the active model provider",      insert: "/login" },
  { id: "model",     label: "/model",     description: "Switch to a different model",                 insert: "/model " },
  { id: "reasoning", label: "/reasoning", description: "Toggle extended reasoning for this turn",     insert: "/reasoning" },
  { id: "share",     label: "/share",     description: "Copy a shareable link to this session",       insert: "/share" },
];

// ----------------------------------------------------------------------------
// Trigger detection
// ----------------------------------------------------------------------------

type TriggerType = "command" | "file" | "skill" | "related";
type Trigger = { type: TriggerType; query: string; start: number } | null;

/**
 * Walk backwards from the caret looking for a trigger char that's at the
 * start of a token. A trigger mid-word (e.g. `foo@bar`) doesn't open the
 * menu — that's the same rule Dalam's terminal uses.
 */
function detectTrigger(value: string, caret: number): Trigger {
  let i = caret - 1;
  while (i >= 0) {
    const ch = value[i];
    if (ch === " " || ch === "\n" || ch === "\t") break;
    if (ch === "/" || ch === "@" || ch === "$" || ch === "#") {
      const before = i === 0 ? " " : value[i - 1];
      if (before === " " || before === "\n" || before === "\t" || i === 0) {
        const type: TriggerType =
          ch === "/" ? "command" :
          ch === "@" ? "file" :
          ch === "$" ? "skill" : "related";
        return { type, query: value.slice(i + 1, caret), start: i };
      }
      return null;
    }
    i--;
  }
  return null;
}

// ----------------------------------------------------------------------------
// File-tree flattening + fuzzy match
// ----------------------------------------------------------------------------

function flattenFiles(nodes: FileNode[], out: { path: string; name: string }[] = []): { path: string; name: string }[] {
  for (const n of nodes) {
    if (n.type === "file") out.push({ path: n.path, name: n.name });
    if (n.children) flattenFiles(n.children, out);
  }
  return out;
}

function fuzzyScore(query: string, target: string): number {
  if (!query) return 1;
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  let qi = 0;
  let score = 0;
  let lastMatch = -1;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      if (lastMatch === ti - 1) score += 2;
      else if (t[ti - 1] === "/" || t[ti - 1] === "." || t[ti - 1] === "-") score += 3;
      else score += 1;
      lastMatch = ti;
      qi++;
    }
  }
  return qi === q.length ? score : 0;
}

// ----------------------------------------------------------------------------
// Component
// ----------------------------------------------------------------------------

export type PromptAutocompleteProps = {
  value: string;
  onChange: (next: string) => void;
  /** Ref to the textarea that owns the caret. */
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  fileTree: FileNode[];
  chatSessions: ChatSessionSummary[];
  /**
   * The parent wires this ref to the textarea's onKeyDown. The component
   * stores its key-handler in the ref so the parent can call it as part of
   * its own key handling. Returns true if the menu consumed the event
   * (parent should NOT also act on it).
   */
  keyHandlerRef?: React.MutableRefObject<((e: React.KeyboardEvent<HTMLTextAreaElement>) => boolean) | null>;
};

type Option =
  | { kind: "command";  id: string; label: string; description: string; insert: string }
  | { kind: "file";     path: string; name: string }
  | { kind: "skill";    name: string; description: string }
  | { kind: "related";  id: string; title: string; status: string };

export function PromptAutocomplete({
  value,
  onChange,
  textareaRef,
  fileTree,
  chatSessions,
  keyHandlerRef,
}: PromptAutocompleteProps) {
  const [caret, setCaret] = useState(0);
  const [activeIdx, setActiveIdx] = useState(0);
  const activeIdxRef = useRef(0);

  useEffect(() => {
    activeIdxRef.current = activeIdx;
  }, [activeIdx]);

  // Keep the caret in sync with the textarea. Mouse / arrow / select events
  // all move the caret, so we listen for them all.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    const sync = () => setCaret(el.selectionStart ?? value.length);
    el.addEventListener("keyup", sync);
    el.addEventListener("click", sync);
    el.addEventListener("select", sync);
    el.addEventListener("focus", sync);
    return () => {
      el.removeEventListener("keyup", sync);
      el.removeEventListener("click", sync);
      el.removeEventListener("select", sync);
      el.removeEventListener("focus", sync);
    };
  }, [textareaRef, value.length]);

  const trigger = useMemo(() => detectTrigger(value, caret), [value, caret]);

  const options = useMemo<Option[]>(() => {
    if (!trigger) return [];
    if (trigger.type === "command") {
      const q = trigger.query.toLowerCase();
      return SLASH_COMMANDS
        .filter((c) => !q || c.id.includes(q) || c.label.toLowerCase().includes(q))
        .slice(0, 8)
        .map((c) => ({ kind: "command" as const, id: c.id, label: c.label, description: c.description, insert: c.insert }));
    }
    if (trigger.type === "file") {
      const files = flattenFiles(fileTree);
      return files
        .map((f) => ({ kind: "file" as const, path: f.path, name: f.name, _s: fuzzyScore(trigger.query, f.path) }))
        .filter((f) => f._s > 0)
        .sort((a, b) => b._s - a._s)
        .slice(0, 8)
        .map(({ _s, ...rest }) => rest);
    }
    if (trigger.type === "skill") {
      const q = trigger.query.toLowerCase();
      return BUNDLED_SKILLS
        .filter((s) => !q || s.name.includes(q) || s.description.toLowerCase().includes(q))
        .slice(0, 8)
        .map((s) => ({ kind: "skill" as const, name: s.name, description: s.description }));
    }
    const q = trigger.query.toLowerCase();
    return chatSessions
      .filter((s) => !q || s.title.toLowerCase().includes(q))
      .slice(0, 8)
      .map((s) => ({ kind: "related" as const, id: s.id, title: s.title, status: s.status }));
  }, [trigger, fileTree, chatSessions]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setActiveIdx(0);
  }, [options.length, trigger?.type, trigger?.query]);

  const accept = (idx: number) => {
    if (!trigger) return;
    const opt = options[idx];
    if (!opt) return;
    const insert =
      opt.kind === "file"    ? `@${opt.path} ` :
      opt.kind === "skill"   ? `$${opt.name} ` :
      opt.kind === "related" ? `#${opt.title} ` :
                               opt.insert;
    const before = value.slice(0, trigger.start);
    const after = value.slice(trigger.start + 1 + trigger.query.length);
    const next = before + insert + after;
    onChange(next);
    const newCaret = before.length + insert.length;
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(newCaret, newCaret);
      setCaret(newCaret);
    });
  };

  /**
   * Public API: the parent wires this into the textarea's onKeyDown. We
   * intercept ↑/↓/Tab/Enter/Escape when the menu is open, and return `true`
   * to tell the parent "I've handled this, don't also submit on Enter".
   */
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!trigger || options.length === 0) return false;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => (i + 1) % options.length);
      return true;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => (i - 1 + options.length) % options.length);
      return true;
    }
    if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey)) {
      e.preventDefault();
      accept(activeIdxRef.current);
      return true;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      const before = value.slice(0, trigger.start);
      const after = value.slice(trigger.start + 1 + trigger.query.length);
      onChange(before + after);
      return true;
    }
    return false;
  };

  // Publish the handler so the parent can call it from its textarea onKeyDown.
  // Use a ref to always have the latest handler without re-registering the effect.
  const latestHandler = useRef(handleKeyDown);
  useEffect(() => {
    latestHandler.current = handleKeyDown;
  });
  useEffect(() => {
    if (keyHandlerRef) {
      // biome-ignore lint/suspicious/noExplicitAny: bridge React.KeyboardEvent to native KeyboardEvent
      keyHandlerRef.current = ((e: any) => latestHandler.current(e)) as any;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyHandlerRef]);

  if (!trigger || options.length === 0) return null;

  return (
    <div
      className="absolute z-50 left-0 right-0 bottom-full mb-1.5 mx-3 bg-dalam-bg-secondary border border-dalam-border-primary rounded-xl shadow-2xl overflow-hidden"
      onMouseDown={(e) => e.preventDefault()}
    >
      <div className="px-3 py-1.5 flex items-center gap-2 text-[10px] uppercase tracking-wider text-dalam-text-muted border-b border-dalam-border-primary">
        {trigger.type === "command" ? <Terminal className="w-3 h-3" /> :
         trigger.type === "file"    ? <FileText className="w-3 h-3" /> :
         trigger.type === "skill"   ? <Sparkles className="w-3 h-3" /> :
                                      <Hash className="w-3 h-3" />}
        <span>{triggerHeader(trigger.type)}</span>
        <span className="ml-auto flex items-center gap-2 normal-case tracking-normal text-dalam-text-muted">
          <span className="flex items-center gap-0.5"><ChevronUp className="w-2.5 h-2.5" /><ChevronDown className="w-2.5 h-2.5" /> navigate</span>
          <span className="flex items-center gap-0.5"><CornerDownLeft className="w-2.5 h-2.5" /> select</span>
          <span>esc dismiss</span>
        </span>
      </div>
      <ul className="max-h-64 overflow-y-auto scrollbar-thin">
        {options.map((opt, idx) => (
          <li key={optionKey(opt, idx)}>
            <button
              type="button"
              onClick={() => accept(idx)}
              onMouseEnter={() => setActiveIdx(idx)}
              className={`w-full text-left px-3 py-1.5 flex items-center gap-2 ${
                idx === activeIdx ? "bg-dalam-bg-hover" : "hover:bg-dalam-bg-hover/50"
              }`}
            >
              {renderOption(opt)}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ----------------------------------------------------------------------------
// Render helpers
// ----------------------------------------------------------------------------

function triggerHeader(type: TriggerType): string {
  switch (type) {
    case "command": return "Commands";
    case "file":    return "Workspace files";
    case "skill":   return "Skills";
    case "related": return "Related sessions";
  }
}

function optionKey(opt: Option, idx: number): string {
  if (opt.kind === "file")    return `f:${opt.path}`;
  if (opt.kind === "skill")   return `s:${opt.name}`;
  if (opt.kind === "related") return `r:${opt.id}`;
  return `c:${opt.id ?? idx}`;
}

function renderOption(opt: Option) {
  if (opt.kind === "command") {
    return (
      <>
        <Terminal className="w-3.5 h-3.5 text-dalam-text-muted flex-shrink-0" />
        <span className="text-sm text-dalam-text-primary font-mono">{opt.label}</span>
        <span className="text-xs text-dalam-text-muted truncate ml-2">{opt.description}</span>
      </>
    );
  }
  if (opt.kind === "file") {
    return (
      <>
        <FileText className="w-3.5 h-3.5 text-dalam-text-muted flex-shrink-0" />
        <span className="text-sm text-dalam-text-primary truncate">{opt.name}</span>
        <span className="text-[11px] text-dalam-text-muted font-mono truncate ml-2">{opt.path}</span>
      </>
    );
  }
  if (opt.kind === "skill") {
    return (
      <>
        <Sparkles className="w-3.5 h-3.5 text-dalam-accent-primary flex-shrink-0" />
        <span className="text-sm text-dalam-text-primary font-mono">${opt.name}</span>
        <span className="text-xs text-dalam-text-muted truncate ml-2">{opt.description}</span>
      </>
    );
  }
  return (
    <>
      <Hash className="w-3.5 h-3.5 text-dalam-text-muted flex-shrink-0" />
      <span className="text-sm text-dalam-text-primary truncate">{opt.title}</span>
      <span className="text-[10px] text-dalam-text-muted ml-2 flex-shrink-0">{opt.status}</span>
    </>
  );
}
