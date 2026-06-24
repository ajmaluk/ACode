import { useEffect, useRef, useState, useCallback } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { useTerminal, useWorkspace } from "@/store/useAppStore";
import { Plus, X, Trash2, ChevronDown, Bot, Wifi } from "lucide-react";
import "@xterm/xterm/css/xterm.css";
import { ensureAcodeAPI } from "@/lib/acodeAPI";

const ACODE_TERM_THEME = {
  background: "#0d0d0d",
  foreground: "#e0e0e0",
  cursor: "#4f8ef7",
  cursorAccent: "#0d0d0d",
  selectionBackground: "#4f8ef744",
  black: "#000000",
  red: "#f44336",
  green: "#73c991",
  yellow: "#e2c08d",
  blue: "#4f8ef7",
  magenta: "#c792ea",
  cyan: "#7fdbca",
  white: "#e0e0e0",
  brightBlack: "#666666",
  brightRed: "#ff6b6b",
  brightGreen: "#a0f0a0",
  brightYellow: "#f0e0a0",
  brightBlue: "#7fb3ff",
  brightMagenta: "#dfb0ff",
  brightCyan: "#a0e8e0",
  brightWhite: "#ffffff",
};

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[1;36m",
  prompt: "\x1b[1;36m$ \x1b[0m",
};

const BANNER = `${ANSI.cyan}╭─────────────────────────────────────────────╮${ANSI.reset}
${ANSI.cyan}│${ANSI.reset}  ${ANSI.bold}ACode Terminal${ANSI.reset}  ${ANSI.dim}— interactive shell${ANSI.reset}    ${ANSI.cyan}│${ANSI.reset}
${ANSI.cyan}╰─────────────────────────────────────────────╯${ANSI.reset}
Type ${ANSI.bold}help${ANSI.reset} to see available commands. Try ${ANSI.bold}ls${ANSI.reset}, ${ANSI.bold}cat src/App.tsx${ANSI.reset}, or ${ANSI.bold}git status${ANSI.reset}.
`;

export function TerminalPanel() {
  const { tabs, activeTabId, addTab, closeTab, setActiveTab } = useTerminal();
  const { activeWorkspaceId, workspaces } = useWorkspace();
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const unsubRef = useRef<(() => void) | null>(null);
  const procIdsRef = useRef<Map<string, string>>(new Map());
  const [agentTyping, setAgentTyping] = useState(false);

  const cwd = workspaces.find((w) => w.id === activeWorkspaceId)?.path ?? process.cwd();

  const spawnTerminal = useCallback(async (tabId: string, dir: string) => {
    const api = ensureAcodeAPI();
    const procId = await api.terminal.create(dir);
    procIdsRef.current.set(tabId, procId);
    return procId;
  }, []);

  // Initialize xterm.js on mount
  useEffect(() => {
    if (!containerRef.current) return;
    const term = new Terminal({
      theme: ACODE_TERM_THEME,
      fontFamily: "JetBrains Mono, SF Mono, Menlo, monospace",
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      cursorStyle: "bar",
      allowTransparency: true,
      scrollback: 5000,
      macOptionIsMeta: true,
      convertEol: true,
    });
    const fit = new FitAddon();
    const webLinks = new WebLinksAddon();
    term.loadAddon(fit);
    term.loadAddon(webLinks);
    term.open(containerRef.current);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;

    term.writeln(BANNER);

    const onResize = () => fit.fit();
    window.addEventListener("resize", onResize);
    const ro = new ResizeObserver(onResize);
    ro.observe(containerRef.current);

    return () => {
      window.removeEventListener("resize", onResize);
      ro.disconnect();
      term.dispose();
      // Kill all spawned processes
      const api = ensureAcodeAPI();
      procIdsRef.current.forEach((procId) => { api.terminal.kill(procId).catch(() => {}); });
      procIdsRef.current.clear();
    };
  }, []);

  // Spawn process and wire I/O when activeTabId changes
  useEffect(() => {
    if (!activeTabId || !termRef.current) return;
    const term = termRef.current;
    const api = ensureAcodeAPI();

    // Kill previous process if switching tabs
    unsubRef.current?.();
    const prevProcId = procIdsRef.current.get(activeTabId);

    const wire = async () => {
      let procId = prevProcId;
      if (!procId) {
        procId = await spawnTerminal(activeTabId, cwd);
      }

      const unsub = api.terminal.onData(procId, (data) => {
        term.write(data);
      });
      unsubRef.current = unsub;

      // Wire xterm input → process
      const inputDisposable = term.onData((data) => {
        api.terminal.writeInput(procId!, data).catch(() => {});
      });

      // Show prompt if fresh tab
      if (!prevProcId) {
        term.write(ANSI.prompt);
      }

      return () => { inputDisposable.dispose(); };
    };

    let cleanupInput: (() => void) | undefined;
    wire().then((cleanup) => { cleanupInput = cleanup; });

    return () => {
      unsubRef.current?.();
      cleanupInput?.();
    };
  }, [activeTabId, cwd, spawnTerminal]);

  // Handle new tab creation
  const handleAddTab = useCallback(async () => {
    const id = "t-" + Math.random().toString(36).slice(2, 9);
    addTab(cwd);
    // The addTab in store sets this as activeTabId, the effect above will spawn it
  }, [addTab, cwd]);

  // Handle tab close
  const handleCloseTab = useCallback((tabId: string) => {
    const procId = procIdsRef.current.get(tabId);
    if (procId) {
      ensureAcodeAPI().terminal.kill(procId).catch(() => {});
      procIdsRef.current.delete(tabId);
    }
    closeTab(tabId);
  }, [closeTab]);

  return (
    <div className="h-full flex flex-col bg-acode-bg-primary">
      <div className="h-8 flex items-center bg-acode-bg-secondary border-b border-acode-border-primary flex-shrink-0">
        {tabs.map((t) => (
          <div
            key={t.id}
            className={`group flex items-center gap-1.5 px-3 h-full border-r border-acode-border-primary cursor-pointer text-xs transition-colors ${
              t.id === activeTabId
                ? "bg-acode-bg-primary text-acode-text-primary"
                : "bg-acode-bg-secondary text-acode-text-secondary hover:bg-acode-bg-hover"
            }`}
            onClick={() => setActiveTab(t.id)}
          >
            <span className="w-1.5 h-1.5 rounded-full bg-acode-git-added" />
            <span className="whitespace-nowrap">{t.title}</span>
            {tabs.length > 1 && (
              <button
                className="ml-1 opacity-0 group-hover:opacity-100 hover:bg-acode-bg-active rounded p-0.5"
                onClick={(e) => {
                  e.stopPropagation();
                  handleCloseTab(t.id);
                }}
              >
                <X className="w-3 h-3" />
              </button>
            )}
          </div>
        ))}
        <button
          className="px-2 h-full text-acode-text-muted hover:text-acode-text-primary hover:bg-acode-bg-hover transition-colors"
          onClick={handleAddTab}
          title="New terminal"
        >
          <Plus className="w-3.5 h-3.5" />
        </button>

        <div className="flex-1" />

        <div className="flex items-center gap-1.5 px-3 text-[10px] text-acode-text-muted">
          {agentTyping ? (
            <>
              <Bot className="w-3 h-3 text-acode-accent-primary animate-pulse-soft" />
              <span>agent running</span>
            </>
          ) : (
            <>
              <Wifi className="w-3 h-3" />
              <span>connected</span>
            </>
          )}
        </div>

        <button
          className="px-3 h-full text-acode-text-muted hover:text-acode-text-primary hover:bg-acode-bg-hover transition-colors"
          onClick={() => {
            termRef.current?.clear();
            termRef.current?.write(ANSI.prompt);
          }}
          title="Clear (Ctrl+L)"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
        <button
          className="px-3 h-full text-acode-text-muted hover:text-acode-text-primary hover:bg-acode-bg-hover transition-colors"
          title="Toggle output"
        >
          <ChevronDown className="w-3.5 h-3.5" />
        </button>
      </div>

      <div ref={containerRef} className="flex-1 min-h-0" />
    </div>
  );
}
