import { create } from "zustand";
import type { SettingsTab } from "./useModelProviders";

type SettingsViewState = {
  openState: boolean;
  activeTab: SettingsTab;
  selectedProviderId: string | null;
  open: (tab?: SettingsTab) => void;
  close: () => void;
  setActiveTab: (tab: SettingsTab) => void;
  setSelectedProvider: (id: string | null) => void;
};

export const useSettingsView = create<SettingsViewState>((set) => ({
  openState: false,
  activeTab: "general",
  selectedProviderId: null,
  open: (tab) => set({ openState: true, activeTab: tab ?? "general", selectedProviderId: null }),
  close: () => set({ openState: false }),
  setActiveTab: (tab) => set({ activeTab: tab }),
  setSelectedProvider: (id) => set({ selectedProviderId: id }),
}));
