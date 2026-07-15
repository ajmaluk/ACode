import { create } from "zustand";
import type { FileChange } from "@dalam/shared-types";
import { useUI } from "./useUI";

type DiffViewState = {
  open: boolean;
  current: FileChange | null;
  history: FileChange[];
  forwardStack: FileChange[];
  setOpen: (open: boolean) => void;
  openFile: (change: FileChange) => void;
  close: () => void;
  next: () => void;
  prev: () => void;
};

export const useDiffView = create<DiffViewState>((set, get) => ({
  open: false,
  current: null,
  history: [],
  forwardStack: [],
  setOpen(open) { set((s) => open && !s.current ? s : { open }); },
  openFile(change) {
    set((s) => ({
      open: true,
      current: change,
      history: s.current && s.current.path !== change.path
        ? [...s.history, s.current]
        : s.history,
      forwardStack: [],
    }));
    const ui = useUI.getState();
    if (!ui.rightPanelOpen) ui.setRightPanelOpen(true);
    ui.setRightPanelTab("diff");
  },
  close() {
    set({ open: false, current: null, history: [], forwardStack: [] });
  },
  next() {
    const { forwardStack, current, history } = get();
    if (forwardStack.length === 0) return;
    const next = forwardStack[forwardStack.length - 1];
    set({
      current: next,
      forwardStack: forwardStack.slice(0, -1),
      history: current ? [...history, current] : history,
    });
  },
  prev() {
    const { history, current, forwardStack } = get();
    if (history.length === 0) return;
    const prev = history[history.length - 1];
    set({
      current: prev,
      history: history.slice(0, -1),
      forwardStack: current ? [...forwardStack, current] : forwardStack,
    });
  },
}));
