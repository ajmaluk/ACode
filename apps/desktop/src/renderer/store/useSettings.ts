import { create } from "zustand";
import type { AppSettings } from "@dalam/shared-types";
import { DEFAULT_SETTINGS } from "@dalam/shared-types";
import { createDalamAPI } from "@/lib/dalamAPI";

const devWarn = import.meta.env.DEV
  ? (...args: unknown[]) => console.warn(...args)
  : () => {};

type SettingsState = {
  settings: AppSettings;
  loaded: boolean;
  load: () => Promise<void>;
  update: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => Promise<void>;
  updateSettings: (updates: Partial<AppSettings>) => Promise<void>;
  effectiveTheme: () => "dark" | "light";
};

const SYSTEM_DARK_MQ = "(prefers-color-scheme: dark)";

export const useSettings = create<SettingsState>((set, get) => ({
  settings: { ...DEFAULT_SETTINGS },
  loaded: false,
  async load() {
    const api = createDalamAPI();
    try {
      const all = await api.settings.getAll();
      set((s) => ({
        settings: { ...s.settings, ...all },
        loaded: true,
      }));
      if (all.selectedModel) {
        void import("./events").then(({ eventBus }) => {
          eventBus.emit("chat:model-selected", { modelId: all.selectedModel! });
        });
      }
    } catch (err) {
      if (import.meta.env.DEV) console.error("Failed to load settings, using defaults:", err);
      set({ loaded: true });
    }
  },
  async update(key, value) {
    const api = createDalamAPI();
    await api.settings.set(key, value as AppSettings[typeof key]);
    set((s) => ({ settings: { ...s.settings, [key]: value } }));
  },
  async updateSettings(updates) {
    const api = createDalamAPI();
    const entries = Object.entries(updates);
    const results = await Promise.allSettled(
      entries.map(([key, value]) =>
        api.settings.set(key as keyof AppSettings, value as AppSettings[keyof AppSettings])
      )
    );
    const applied: Record<string, unknown> = {};
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.status === "fulfilled") {
        applied[entries[i][0]] = entries[i][1];
      } else {
        devWarn(`Failed to save setting ${entries[i][0]}:`, (r as PromiseRejectedResult).reason);
      }
    }
    if (Object.keys(applied).length > 0) {
      set((s) => ({ settings: { ...s.settings, ...applied } }));
    }
  },
  effectiveTheme() {
    const { theme } = get().settings;
    if (theme !== "system") return theme;
    if (typeof window === "undefined") return "dark";
    return window.matchMedia(SYSTEM_DARK_MQ).matches ? "dark" : "light";
  },
}));
