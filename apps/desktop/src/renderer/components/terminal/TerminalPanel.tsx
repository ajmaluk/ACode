import { useEffect, useRef, useCallback } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { useTerminal, useWorkspace, useChat } from "@/store/useAppStore";
import { Plus, X, Trash2, Bot, Wifi } from "lucide-react";
import "@xterm/xterm/css/xterm.css";
import { ensureDalamAPI } from "@/lib/dalamAPI";

const DALAM_TERM_THEME = {
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
│  ${ANSI.bold}Dalam Terminal${ANSI.reset}  ${ANSI.dim}— interactive shell${ANSI.reset}    ${ANSI.cyan}│${ANSI.reset}
╰─────────────────────────────────────────────╯${ANSI.reset}
Type ${ANSI.bold}help${ANSI.reset} to see available commands. Try ${ANSI.bold}ls${ANSI.reset}, ${ANSI.bold}cat src/App.tsx${ANSI.reset}, or ${ANSI.bold}git status${ANSI.reset}.
`;

interface TerminalTabContentProps {
  tabId: string;
  cwd: string;
  active: boolean;
  terminalsMapRef: React.MutableRefObject<Map<string, Terminal>>;
}

function TerminalTabContent({ tabId, cwd, active, terminalsMapRef }: TerminalTabContentProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const procIdRef = useRef<string | null>(null);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;

    const term = new Terminal({
      theme: DALAM_TERM_THEME,
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

    term.writeln(BANNER);
    term.write(ANSI.prompt);

    terminalsMapRef.current.set(tabId, term);
    fitAddonRef.current = fit;

    // Trigger initial fit
    setTimeout(() => {
      fit.fit();
    }, 50);

    const api = ensureDalamAPI();
    let isCleanedUp = false;
    let unsubData: (() => void) | null = null;
    let inputDisposable: { dispose: () => void } | null = null;

    const startIO = async () => {
      try {
        const procId = await api.terminal.create(cwd);
        if (isCleanedUp) {
          api.terminal.kill(procId).catch(() => {});
          return;
        }
        procIdRef.current = procId;

        unsubData = api.terminal.onData(procId, (data) => {
          term.write(data);
        });

        inputDisposable = term.onData((data) => {
          api.terminal.writeInput(procId, data).catch(() => {});
        });
      } catch (err) {
        term.writeln(`\r\n\x1b[31mError spawning terminal process: ${String(err)}\x1b[0m`);
      }
    };

    void startIO();

    const handleResize = () => {
      fit.fit();
    };

    const ro = new ResizeObserver(() => {
      if (active) {
        handleResize();
      }
    });
    ro.observe(element);

    window.addEventListener("resize", handleResize);

    return () => {
      isCleanedUp = true;
      window.removeEventListener("resize", handleResize);
      ro.disconnect();

      terminalsMapRef.current.delete(tabId);

      if (unsubData) unsubData();
      if (inputDisposable) inputDisposable.dispose();

      const procId = procIdRef.current;
      if (procId) {
        api.terminal.kill(procId).catch(() => {});
      }

      term.dispose();
    };
  }, [tabId, cwd]);

  useEffect(() => {
    if (active) {
      const t = setTimeout(() => {
        fitAddonRef.current?.fit();
      }, 50);
      return () => clearTimeout(t);
    }
  }, [active]);

  return <div ref={containerRef} className="w-full h-full" />;
}

export function TerminalPanel() {
  const { tabs, activeTabId, addTab, closeTab, setActiveTab } = useTerminal();
  const { activeWorkspaceId, workspaces } = useWorkspace();
  const isStreaming = useChat((s) => s.isStreaming);
  const session = useChat((s) => s.session);

  const cwd = session?.workspacePath ?? workspaces.find((w) => w.id === activeWorkspaceId)?.path ?? ".";

  const terminalsRef = useRef<Map<string, Terminal>>(new Map());

  const handleAddTab = useCallback(() => {
    addTab(cwd);
  }, [addTab, cwd]);

  return (
    <div className="h-full flex flex-col bg-dalam-bg-primary">
      <div className="h-8 flex items-center bg-dalam-bg-secondary border-b border-dalam-border-primary flex-shrink-0">
        {tabs.map((t) => (
          <div
            key={t.id}
            className={`group flex items-center gap-1.5 px-3 h-full border-r border-dalam-border-primary cursor-pointer text-xs transition-colors ${
              t.id === activeTabId
                ? "bg-dalam-bg-primary text-dalam-text-primary"
                : "bg-dalam-bg-secondary text-dalam-text-secondary hover:bg-dalam-bg-hover"
            }`}
            onClick={() => setActiveTab(t.id)}
          >
            <span className="w-1.5 h-1.5 rounded-full bg-dalam-git-added" />
            <span className="whitespace-nowrap">{t.title}</span>
            {tabs.length > 1 && (
              <button
                className="ml-1 opacity-0 group-hover:opacity-100 hover:bg-dalam-bg-active rounded p-0.5"
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(t.id);
                }}
              >
                <X className="w-3 h-3" />
              </button>
            )}
          </div>
        ))}
        <button
          className="px-2 h-full text-dalam-text-muted hover:text-dalam-text-primary hover:bg-dalam-bg-hover transition-colors"
          onClick={handleAddTab}
          title="New terminal"
        >
          <Plus className="w-3.5 h-3.5" />
        </button>

        <div className="flex-1" />

        <div className="flex items-center gap-1.5 px-3 text-[10px] text-dalam-text-muted">
          {isStreaming ? (
            <>
              <Bot className="w-3 h-3 text-dalam-accent-primary animate-pulse-soft" />
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
          className="px-3 h-full text-dalam-text-muted hover:text-dalam-text-primary hover:bg-dalam-bg-hover transition-colors"
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

      <div className="flex-1 min-h-0 relative">
        {tabs.map((t) => (
          <div
            key={`${t.id}-${t.cwd}`}
            className="absolute inset-0"
            style={{ display: t.id === activeTabId ? "block" : "none" }}
          >
            <TerminalTabContent
              tabId={t.id}
              cwd={t.cwd}
              active={t.id === activeTabId}
              terminalsMapRef={terminalsRef}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
