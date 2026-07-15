import { create } from "zustand";

type CommandPaletteState = {
  open: boolean;
  query: string;
  setOpen: (open: boolean) => void;
  setQuery: (query: string) => void;
  toggle: () => void;
};

export const useCommandPalette = create<CommandPaletteState>((set) => ({
  open: false,
  query: "",
  setOpen: (open) => set((s) => ({ open, query: open ? s.query : "" })),
  setQuery: (query) => set({ query }),
  toggle: () => set((s) => ({ open: !s.open, query: "" })),
}));
