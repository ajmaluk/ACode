import { create } from "zustand";

type ShortcutsState = {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
};

export const useShortcuts = create<ShortcutsState>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
  toggle: () => set((s) => ({ open: !s.open })),
}));
