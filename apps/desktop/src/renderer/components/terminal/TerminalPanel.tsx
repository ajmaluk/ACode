import { useEffect, useRef, useCallback, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { useTerminal, useWorkspace, useChat, useSettings } from "@/store/useAppStore";
import { Tooltip } from "../ui/Tooltip";
import { Plus, X, Trash2, Bot, Wifi, ChevronDown, TerminalSquare, FolderOpen } from "lucide-react";
import "@xterm/xterm/css/xterm.css";
import { createDalamAPI } from "@/lib/dalamAPI";
import { basename } from "@/lib/pathUtils";

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

type ShellType = "bash" | "zsh" | "fish" | "powershell" | "cmd" | "pwsh" | "sh";

interface ShellOption {
  value: ShellType;
  label: string;
  icon: string;
}

interface TerminalTabContentProps {
  tabId: string;
  cwd: string;
  shell: ShellType;
  active: boolean;
  terminalsMapRef: React.MutableRefObject<Map<string, Terminal>>;
}

function TerminalTabContent({ tabId, cwd, shell, active, terminalsMapRef }: TerminalTabContentProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const procIdRef = useRef<string | null>(null);
  const { settings } = useSettings();

  useEffect(() => {
    const term = terminalsMapRef.current.get(tabId);
    if (term) {
      term.options.fontFamily = settings.terminalFont ? `${settings.terminalFont}, SF Mono, Menlo, monospace` : "JetBrains Mono, SF Mono, Menlo, monospace";
      term.options.fontSize = settings.terminalFontSize || 13;
      setTimeout(() => {
        fitAddonRef.current?.fit();
      }, 50);
    }
  }, [settings.terminalFont, settings.terminalFontSize, terminalsMapRef, tabId]);

  const activeRef = useRef(active);
  useEffect(() => { activeRef.current = active; });

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;

    const term = new Terminal({
      theme: DALAM_TERM_THEME,
      fontFamily: settings.terminalFont ? `${settings.terminalFont}, SF Mono, Menlo, monospace` : "JetBrains Mono, SF Mono, Menlo, monospace",
      fontSize: settings.terminalFontSize || 13,
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

    terminalsMapRef.current.set(tabId, term);
    fitAddonRef.current = fit;

    setTimeout(() => {
      fit.fit();
    }, 50);

    const api = createDalamAPI();
    let isCleanedUp = false;
    let unsubData: (() => void) | null = null;
    let inputDisposable: { dispose: () => void } | null = null;
    let shellProcId: string | null = null;

    const startIO = async () => {
      try {
        const procId = await api.terminal.create(cwd, shell);
        if (isCleanedUp) {
          api.terminal.kill(procId).catch(() => {});
          return;
        }
        procIdRef.current = procId;
        shellProcId = procId;

        unsubData = api.terminal.onData(procId, (data) => {
          if (activeRef.current) {
            term.write(data);
          }
        });

        inputDisposable = term.onData((data) => {
          if (procIdRef.current === procId) {
            api.terminal.writeInput(procId, data).catch(() => {});
          }
        });

        const pendingCmd = useTerminal.getState().consumePendingCommand(tabId);
        if (pendingCmd) {
          api.terminal.writeInput(procId, pendingCmd + "\n").catch(() => {});
        }
      } catch (err) {
        term.writeln(`\r\n\x1b[31mError spawning terminal: ${String(err)}\x1b[0m`);
      }
    };

    void startIO();

    let resizeRaf: number | null = null;
    const handleResize = () => {
      if (resizeRaf !== null) cancelAnimationFrame(resizeRaf);
      resizeRaf = requestAnimationFrame(() => {
        resizeRaf = null;
        fit.fit();
      });
    };

    const ro = new ResizeObserver(() => {
      if (activeRef.current) {
        handleResize();
      }
    });
    ro.observe(element);

    window.addEventListener("resize", handleResize);

    return () => {
      isCleanedUp = true;
      if (resizeRaf !== null) cancelAnimationFrame(resizeRaf);
      window.removeEventListener("resize", handleResize);
      ro.disconnect();

      const currentTerminals = terminalsMapRef.current;
      currentTerminals.delete(tabId);

      if (unsubData) unsubData();
      if (inputDisposable) inputDisposable.dispose();

      const procId = procIdRef.current;
      if (procId) {
        api.terminal.kill(procId).catch(() => {});
      }

      term.dispose();
    };
  }, [tabId, cwd, shell]);

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
  const { tabs, activeTabId, addTab, closeTab, setActiveTab, updateTabShell, ensureTabForCwd } = useTerminal();
  const { activeWorkspaceId, workspaces } = useWorkspace();
  const isStreaming = useChat((s) => s.isStreaming);
  const session = useChat((s) => s.session);
  const [showShellDropdown, setShowShellDropdown] = useState(false);
  const [showAddDropdown, setShowAddDropdown] = useState(false);
  const [availableShells, setAvailableShells] = useState<ShellOption[]>([]);

  // Auto-create terminal for current workspace when panel opens with no tabs
  const cwd = session?.workspacePath ?? workspaces.find((w) => w.id === activeWorkspaceId)?.path ?? "";
  useEffect(() => {
    if (cwd && tabs.length === 0) {
      ensureTabForCwd(cwd);
    }
  }, [cwd]);

  // Close dropdowns on outside click
  useEffect(() => {
    if (!showAddDropdown && !showShellDropdown) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest("[data-dropdown]")) {
        setShowAddDropdown(false);
        setShowShellDropdown(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showAddDropdown, showShellDropdown]);

  const workspaceName = basename(cwd);

  const terminalsRef = useRef<Map<string, Terminal>>(new Map());

  // Detect available shells on mount and when platform changes
  useEffect(() => {
    let cancelled = false;
    const detect = async () => {
      try {
        const api = createDalamAPI();
        const shells = await api.system.detectAvailableShells();
        if (cancelled) return;

        // Map detected shells to our ShellOption format
        const shellMap: Record<string, ShellOption> = {
          bash: { value: "bash", label: "Bash", icon: "\u{1F41A}" },
          zsh: { value: "zsh", label: "Zsh", icon: "z" },
          fish: { value: "fish", label: "Fish", icon: "\u{1F41F}" },
          powershell: { value: "powershell", label: "PowerShell", icon: "\u{26A1}" },
          pwsh: { value: "pwsh", label: "PowerShell Core", icon: "P" },
          cmd: { value: "cmd", label: "Command Prompt", icon: ">" },
          sh: { value: "sh", label: "sh", icon: "$" },
        };

        const detected = shells
          .map((s) => shellMap[s.name])
          .filter((s): s is ShellOption => !!s);

        // Always show at least the platform default
        if (detected.length === 0) {
          const isWin = navigator.userAgent.includes("Windows");
          detected.push(isWin ? shellMap.powershell : shellMap.bash);
        }

        setAvailableShells(detected);
      } catch {
        // Fallback: show platform defaults
        const isWin = navigator.userAgent.includes("Windows");
        setAvailableShells(isWin ? [
          { value: "powershell", label: "PowerShell", icon: "\u{26A1}" },
          { value: "cmd", label: "Command Prompt", icon: ">" },
        ] : [
          { value: "bash", label: "Bash", icon: "\u{1F41A}" },
          { value: "zsh", label: "Zsh", icon: "z" },
        ]);
      }
    };
    void detect();
    return () => { cancelled = true; };
  }, []);

  const handleAddTab = useCallback((shell?: ShellType) => {
    const defaultShell = availableShells[0]?.value ?? "bash";
    addTab(cwd, shell ?? defaultShell);
    setShowAddDropdown(false);
  }, [addTab, cwd, availableShells]);

  const handleShellChange = useCallback((tabId: string, shell: ShellType) => {
    updateTabShell(tabId, shell);
    setShowShellDropdown(false);
  }, [updateTabShell]);

  const activeTab = tabs.find(t => t.id === activeTabId);

  return (
    <div className="h-full flex flex-col bg-dalam-bg-primary">
      {/* Tab bar */}
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
            <TerminalSquare className="w-3 h-3 flex-shrink-0" />
            <span className="truncate max-w-[120px] font-mono text-[11px]" title={t.cwd}>
              {t.cwd === "." || t.cwd === "/" ? t.shell : t.cwd.split("/").pop() || t.shell}
            </span>
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

        {/* Add terminal dropdown */}
        <div className="relative" data-dropdown>
          <Tooltip content="New terminal in this project" side="top">
            <button
              className="px-2 h-full text-dalam-text-muted hover:text-dalam-text-primary hover:bg-dalam-bg-hover transition-colors flex items-center gap-0.5"
              onClick={() => setShowAddDropdown(!showAddDropdown)}
            >
              <Plus className="w-3.5 h-3.5" />
              <ChevronDown className="w-2.5 h-2.5" />
            </button>
          </Tooltip>
          {showAddDropdown && (
            <div className="absolute top-full left-0 mt-1 bg-dalam-bg-secondary border border-dalam-border-primary rounded-lg shadow-xl py-1 z-50 min-w-[200px]">
              <div className="px-2 py-1 text-[10px] uppercase tracking-wider text-dalam-text-muted border-b border-dalam-border-primary">
                Shell
              </div>
              {availableShells.map((shell) => (
                <button
                  key={shell.value}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-dalam-text-primary hover:bg-dalam-bg-hover transition-colors"
                  onClick={() => handleAddTab(shell.value)}
                >
                  <span className="text-sm w-5 text-center">{shell.icon}</span>
                  <span>{shell.label}</span>
                </button>
              ))}
              <div className="border-t border-dalam-border-primary mt-1 pt-1">
                <button
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-dalam-text-primary hover:bg-dalam-bg-hover transition-colors"
                  onClick={() => handleAddTab()}
                >
                  <span className="text-sm w-5 text-center">+</span>
                  <span>New terminal in {workspaceName}</span>
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="flex-1" />

        {/* Shell type selector for active tab */}
        {activeTab && (
          <div className="relative" data-dropdown>
            <Tooltip content="Change shell type" side="top">
              <button
                className="flex items-center gap-1 px-2 h-full text-dalam-text-muted hover:text-dalam-text-primary hover:bg-dalam-bg-hover transition-colors text-[10px]"
                onClick={() => setShowShellDropdown(!showShellDropdown)}
              >
                <TerminalSquare className="w-3 h-3" />
                <span className="max-w-[70px] truncate">{activeTab.shell}</span>
                <ChevronDown className="w-2.5 h-2.5" />
              </button>
            </Tooltip>
            {showShellDropdown && (
              <div className="absolute top-full right-0 mt-1 bg-dalam-bg-secondary border border-dalam-border-primary rounded-lg shadow-xl py-1 z-50 min-w-[180px]">
                {availableShells.map((shell) => (
                  <button
                    key={shell.value}
                    className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs transition-colors ${
                      shell.value === activeTab.shell
                        ? "bg-dalam-accent-subtle text-dalam-accent-primary"
                        : "text-dalam-text-primary hover:bg-dalam-bg-hover"
                    }`}
                    onClick={() => { if (activeTabId) handleShellChange(activeTabId, shell.value); }}
                  >
                    <span className="text-sm w-5 text-center">{shell.icon}</span>
                    <span>{shell.label}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Status */}
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

        {/* Clear */}
        <Tooltip content="Clear (Ctrl+L)" side="top">
          <button
            className="px-3 h-full text-dalam-text-muted hover:text-dalam-text-primary hover:bg-dalam-bg-hover transition-colors"
            onClick={() => {
              if (!activeTabId) return;
              const term = terminalsRef.current.get(activeTabId);
              if (term) {
                term.clear();
                term.scrollToBottom();
              }
            }}
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </Tooltip>
      </div>

      {/* PWD indicator */}
      {activeTab && (
        <div className="h-6 flex items-center gap-1.5 px-3 bg-dalam-bg-secondary border-b border-dalam-border-primary text-[11px] text-dalam-text-secondary flex-shrink-0 font-mono">
          <FolderOpen className="w-3 h-3 text-dalam-text-muted flex-shrink-0" />
          <span className="truncate" title={activeTab.cwd}>{activeTab.cwd}</span>
        </div>
      )}

      {/* Terminal content */}
      <div className="flex-1 min-h-0 relative">
        {tabs.length === 0 ? (
          <div className="flex-1 flex items-center justify-center h-full">
            <div className="text-center">
              <TerminalSquare className="w-8 h-8 mx-auto mb-3 text-dalam-text-muted/40" />
              <p className="text-xs text-dalam-text-muted mb-3">No terminal open</p>
              {cwd && (
                <button
                  onClick={() => ensureTabForCwd(cwd)}
                  className="px-3 py-1.5 text-[11px] bg-dalam-accent-primary text-white rounded-md hover:bg-dalam-accent-hover transition-colors"
                >
                  New Terminal in {workspaceName}
                </button>
              )}
            </div>
          </div>
        ) : (
          tabs.map((t) => (
            <div
              key={`${t.id}-${t.cwd}`}
              className="absolute inset-0"
              style={{ display: t.id === activeTabId ? "block" : "none" }}
            >
              <TerminalTabContent
                tabId={t.id}
                cwd={t.cwd}
                shell={t.shell}
                active={t.id === activeTabId}
                terminalsMapRef={terminalsRef}
              />
            </div>
          ))
        )}
      </div>
    </div>
  );
}
