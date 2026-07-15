import { create } from "zustand";
import type { TerminalTab } from "@dalam/shared-types";
import { useWorkspace } from "./useWorkspace";
import { basename } from "@/lib/pathUtils";

type TerminalState = {
  tabs: TerminalTab[];
  activeTabId: string | null;
  output: Record<string, string>;
  pendingCommands: Record<string, string>;
  addTab: (cwd: string, shell?: string, command?: string) => void;
  closeTab: (id: string) => void;
  setActiveTab: (id: string) => void;
  appendOutput: (id: string, data: string) => void;
  consumePendingCommand: (id: string) => string | undefined;
  ensureTabForCwd: (cwd: string) => void;
  updateTabShell: (id: string, shell: string) => void;
  saveForSession: (sessionId: string) => void;
  restoreForSession: (sessionId: string) => void;
  writeToTerminal: (tabId: string, command: string) => void;
};

const _terminalStateCache = new Map<string, { tabs: TerminalTab[]; activeTabId: string | null }>();
const MAX_TERMINAL_CACHE_SIZE = 20;

export const useTerminal = create<TerminalState>((set, get) => ({
  tabs: [] as TerminalTab[],
  activeTabId: null,
  output: {},
  pendingCommands: {},
  addTab(cwd, shell = "bash", command?) {
    const id = "t-" + crypto.randomUUID();
    set((s) => ({
      tabs: [...s.tabs, { id, title: shell, cwd, shell } as TerminalTab],
      activeTabId: id,
      pendingCommands: command ? { ...s.pendingCommands, [id]: command } : s.pendingCommands,
    }));
  },
  consumePendingCommand(id) {
    const { pendingCommands } = get();
    const cmd = pendingCommands[id];
    if (cmd !== undefined) {
      const { [id]: _, ...rest } = pendingCommands;
      set({ pendingCommands: rest });
    }
    return cmd;
  },
  closeTab(id) {
    set((s) => {
      const remaining = s.tabs.filter((t) => t.id !== id);
      const newActive =
        s.activeTabId === id ? remaining[0]?.id ?? null : s.activeTabId;
      const { [id]: _removedOutput, ...restOutput } = s.output;
      const { [id]: _removedPending, ...restPending } = s.pendingCommands;
      return { tabs: remaining, activeTabId: newActive, output: restOutput, pendingCommands: restPending };
    });
  },
  setActiveTab(id) {
    set({ activeTabId: id });
  },
  appendOutput(id, data) {
    set((s) => ({
      output: { ...s.output, [id]: ((s.output[id] ?? "") + data).slice(-102400) },
    }));
  },
  ensureTabForCwd(cwd) {
    const { tabs, setActiveTab, addTab } = get();
    const existing = tabs.find((t) => t.cwd === cwd);
    if (existing) {
      setActiveTab(existing.id);
    } else {
      addTab(cwd);
    }
  },
  updateTabShell(id, shell) {
    set((s) => ({
      tabs: s.tabs.map((t) => t.id === id ? { ...t, shell: shell as TerminalTab["shell"] } : t),
    }));
  },
  writeToTerminal(tabId, command) {
    set((s) => ({
      pendingCommands: { ...s.pendingCommands, [tabId]: command },
    }));
  },
  saveForSession(sessionId) {
    const { tabs, activeTabId } = get();
    if (_terminalStateCache.size >= MAX_TERMINAL_CACHE_SIZE && !_terminalStateCache.has(sessionId)) {
      const firstKey = _terminalStateCache.keys().next().value;
      if (firstKey !== undefined) _terminalStateCache.delete(firstKey);
    }
    _terminalStateCache.set(sessionId, { tabs: tabs as TerminalTab[], activeTabId });
  },
  restoreForSession(sessionId) {
    const cached = _terminalStateCache.get(sessionId);
    if (cached) {
      set({ tabs: cached.tabs as TerminalTab[], activeTabId: cached.activeTabId });
    } else {
      const { activeWorkspaceId, workspaces } = useWorkspace.getState();
      const ws = workspaces.find(w => w.id === activeWorkspaceId);
      const cwd = ws?.path ?? ".";
      set({
        tabs: [{ id: "t-1", title: basename(cwd) || "bash", cwd, shell: "bash" }] as TerminalTab[],
        activeTabId: "t-1",
      });
    }
  },
}));
