import { useEffect, useRef, useCallback } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { useTerminal, useWorkspace, useChat } from "@/store/useAppStore";
import { Plus, X, Trash2, Bot, Wifi } from "lucide-react";
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
│  ${ANSI.bold}ACode Terminal${ANSI.reset}  ${ANSI.dim}— interactive shell${ANSI.reset}    ${ANSI.cyan}│${ANSI.reset}
╰─────────────────────────────────────────────╯${ANSI.reset}
Type ${ANSI.bold}help${ANSI.reset} to see available commands. Try ${ANSI.bold}ls${ANSI.reset}, ${ANSI.bold}cat src/App.tsx${ANSI.reset}, or ${ANSI.bold}git status${ANSI.reset}.
`;

export function TerminalPanel() {
  const { tabs, activeTabId, addTab, closeTab, setActiveTab } = useTerminal();
  const { activeWorkspaceId, workspaces } = useWorkspace();
  const isStreaming = useChat((s) => s.isStreaming);
  const containerRef = useRef<HTMLDivElement>(null);
  const procIdsRef = useRef<Map<string, string>>(new Map());

  const terminalsRef = useRef<Map<string, Terminal>>(new Map());
  const fitAddonsRef = useRef<Map<string, FitAddon>>(new Map());
  const termCleanupsRef = useRef<Map<string, () => void>>(new Map());

  const activeTabIdRef = useRef(activeTabId);
  useEffect(() => {
    activeTabIdRef.current = activeTabId;
  }, [activeTabId]);

  const cwd = workspaces.find((w) => w.id === activeWorkspaceId)?.path ?? process.cwd();

  const initializeTerminal = useCallback((tabId: string, element: HTMLDivElement) => {
    if (terminalsRef.current.has(tabId)) {
      if (tabId === activeTabId) {
        setTimeout(() => {
          fitAddonsRef.current.get(tabId)?.fit();
        }, 0);
      }
      return;
    }

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
    term.open(element);
    setTimeout(() => {
      fit.fit();
    }, 0);

    term.writeln(BANNER);
    term.write(ANSI.prompt);

    terminalsRef.current.set(tabId, term);
    fitAddonsRef.current.set(tabId, fit);

    // Spawn process and wire I/O
    const api = ensureAcodeAPI();
    
    const startIO = async () => {
      try {
        const procId = await api.terminal.create(cwd);
        procIdsRef.current.set(tabId, procId);

        const unsub = api.terminal.onData(procId, (data) => {
          term.write(data);
        });

        const inputDisposable = term.onData((data) => {
          api.terminal.writeInput(procId, data).catch(() => {});
        });

        termCleanupsRef.current.set(tabId, () => {
          unsub();
          inputDisposable.dispose();
        });
      } catch (err) {
        term.writeln(`\r\n\x1b[31mError spawning terminal process: ${String(err)}\x1b[0m`);
      }
    };

    void startIO();
  }, [cwd, activeTabId]);

  // Master resize observer and cleanup on unmount
  useEffect(() => {
    const onResize = () => {
      const activeId = activeTabIdRef.current;
      if (activeId) {
        fitAddonsRef.current.get(activeId)?.fit();
      }
    };
    window.addEventListener("resize", onResize);
    const ro = new ResizeObserver(onResize);
    if (containerRef.current) {
      ro.observe(containerRef.current);
    }
    return () => {
      window.removeEventListener("resize", onResize);
      ro.disconnect();
      // Dispose all terminals
      terminalsRef.current.forEach((term) => term.dispose());
      terminalsRef.current.clear();
      fitAddonsRef.current.clear();
      // Clean up subscriptions
      termCleanupsRef.current.forEach((cleanup) => cleanup());
      termCleanupsRef.current.clear();
      // Kill all processes
      const api = ensureAcodeAPI();
      procIdsRef.current.forEach((procId) => {
        api.terminal.kill(procId).catch(() => {});
      });
      procIdsRef.current.clear();
    };
  }, []);

  // Handle new tab creation
  const handleAddTab = useCallback(async () => {
    addTab(cwd);
  }, [addTab, cwd]);

  // Handle tab close
  const handleCloseTab = useCallback((tabId: string) => {
    const procId = procIdsRef.current.get(tabId);
    if (procId) {
      ensureAcodeAPI().terminal.kill(procId).catch(() => {});
      procIdsRef.current.delete(tabId);
    }
    const cleanup = termCleanupsRef.current.get(tabId);
    if (cleanup) {
      cleanup();
      termCleanupsRef.current.delete(tabId);
    }
    const term = terminalsRef.current.get(tabId);
    if (term) {
      term.dispose();
      terminalsRef.current.delete(tabId);
    }
    fitAddonsRef.current.delete(tabId);

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
          {isStreaming ? (
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
          title="Clear (Ctrl+L)"
          onClick={() => {
            if (!activeTabId) return;
            const term = terminalsRef.current.get(activeTabId);
            if (term) {
              term.clear();
              term.write(ANSI.prompt);
            }
          }}
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>

      <div ref={containerRef} className="flex-1 min-h-0 relative">
        {tabs.map((t) => (
          <div
            key={t.id}
            ref={(el) => {
              if (el) {
                initializeTerminal(t.id, el);
              }
            }}
            className="absolute inset-0"
            style={{ display: t.id === activeTabId ? "block" : "none" }}
          />
        ))}
      </div>
    </div>
  );
}
