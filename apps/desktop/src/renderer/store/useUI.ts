import { create } from "zustand";

const devWarn = import.meta.env.DEV
  ? (...args: unknown[]) => console.warn(...args)
  : () => {};

export type BrowserTab = {
  id: string;
  title: string;
  url: string;
  history: string[];
  historyIdx: number;
  loading: boolean;
  _refreshTimer?: ReturnType<typeof setTimeout>;
};

type UIState = {
  rightPanelOpen: boolean;
  sidebarOpen: boolean;
  bottomPanelOpen: boolean;
  viewMode: "chat" | "editor";
  browserTabs: BrowserTab[];
  activeBrowserTabId: string | null;
  rightPanelTab: "git" | "diff" | "review" | "browser" | "progress";
  bottomPanelTab: "terminal" | "output" | "problems";
  setRightPanelOpen: (open: boolean) => void;
  toggleRightPanel: () => void;
  setSidebarOpen: (open: boolean) => void;
  toggleSidebar: () => void;
  setBottomPanelOpen: (open: boolean) => void;
  toggleBottomPanel: () => void;
  setViewMode: (mode: "chat" | "editor") => void;
  toggleViewMode: () => void;
  setRightPanelTab: (tab: "git" | "diff" | "review" | "browser" | "progress") => void;
  setBottomPanelTab: (tab: "terminal" | "output" | "problems") => void;
  addBrowserTab: (tab?: Partial<BrowserTab>) => string;
  removeBrowserTab: (id: string) => void;
  setActiveBrowserTab: (id: string) => void;
  navigateBrowser: (id: string, url: string) => void;
  goBackBrowser: (id: string) => void;
  goForwardBrowser: (id: string) => void;
  refreshBrowser: (id: string) => void;
  updateBrowserTab: (id: string, patch: Partial<BrowserTab>) => void;
  clearBrowserTabs: () => void;
};

function deriveTitleFromUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.hostname.startsWith("www.google.com") && u.pathname === "/search") {
      const q = u.searchParams.get("q") ?? "";
      return q ? `Google — ${q}` : "Google";
    }
    return u.hostname.replace(/^www\./, "") + (u.pathname !== "/" ? u.pathname : "");
  } catch (e) {
    if (import.meta.env.DEV) devWarn("[Store] const u = new URL(url);:", e);
    return url;
  }
}

function isPrivateHost(hostname: string): boolean {
  if (hostname === "::1" || hostname === "[::1]") return true;
  if (/^127\./.test(hostname)) return true;
  if (/^10\./.test(hostname)) return true;
  if (/^192\.168\./.test(hostname)) return true;
  if (/^169\.254\./.test(hostname)) return true;
  if (/^0\./.test(hostname)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(hostname)) return true;
  if (/^metadata\.google\.internal$/i.test(hostname)) return true;
  if (/^instance-data\.local$/i.test(hostname)) return true;
  if (/^169\.254\.169\.254$/.test(hostname)) return true;
  if (hostname.includes(".")) {
    try {
      const testUrl = new URL(`http://${hostname}`);
      const normalized = testUrl.hostname;
      if (normalized !== hostname) return isPrivateHost(normalized);
    } catch (e) {
      if (import.meta.env.DEV) devWarn("[Store] const testUrl = new URL(`http://${hostname}`);:", e);
    }
  } else if (/^0x[0-9a-f]+$/i.test(hostname)) {
    return true;
  } else if (/^\d+$/.test(hostname)) {
    return true;
  }
  return hostname === "localhost";
}

function normalizeBrowserUrl(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  if (/^(file|data|javascript|vbscript):/i.test(raw)) return null;

  if (/^https?:\/\//i.test(raw)) {
    try {
      const url = new URL(raw);
      if (isPrivateHost(url.hostname)) return null;
      return url.href;
    } catch (e) {
      if (import.meta.env.DEV) devWarn("[Store] const url = new URL(raw);:", e);
      return null;
    }
  }

  try {
    const testUrl = new URL(`https://${raw}`);
    if (isPrivateHost(testUrl.hostname)) return null;
  } catch (e) {
    if (import.meta.env.DEV) devWarn("[Store] const testUrl = new URL(`https://${raw}`);:", e);
  }

  if (/\s/.test(raw)) return "https://www.google.com/search?q=" + encodeURIComponent(raw);
  return "https://" + raw.replace(/^https?:\/\//i, "");
}

export const useUI = create<UIState>((set, get) => ({
  rightPanelOpen: false,
  sidebarOpen: true,
  bottomPanelOpen: false,
  viewMode: "chat",
  browserTabs: [],
  activeBrowserTabId: null,
  rightPanelTab: "git",
  bottomPanelTab: "terminal",
  setRightPanelOpen: (open) => set({ rightPanelOpen: open }),
  toggleRightPanel: () => set((s) => ({ rightPanelOpen: !s.rightPanelOpen })),
  setSidebarOpen: (open) => set({ sidebarOpen: open }),
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  setBottomPanelOpen: (open) => set({ bottomPanelOpen: open }),
  toggleBottomPanel: () => set((s) => ({ bottomPanelOpen: !s.bottomPanelOpen })),
  setViewMode: (mode) => {
    const prevMode = get().viewMode;
    const patch: Partial<UIState> = { viewMode: mode };
    if (mode === "chat" && get().rightPanelOpen) {
      patch.rightPanelOpen = false;
    }
    set(patch);
    if (prevMode !== mode) {
      void import("./events").then(({ eventBus }) => {
        eventBus.emit("ui:view-mode-changed", { mode });
      });
    }
  },
  toggleViewMode: () => {
    const nextMode = get().viewMode === "chat" ? "editor" : "chat";
    get().setViewMode(nextMode);
  },
  setRightPanelTab: (tab) => set({ rightPanelTab: tab }),
  setBottomPanelTab: (tab) => set({ bottomPanelTab: tab }),
  addBrowserTab: (tab) => {
    const id = "bt-" + crypto.randomUUID();
    const newTab: BrowserTab = {
      id,
      title: tab?.title ?? "New tab",
      url: tab?.url ?? "",
      history: tab?.url ? [tab.url] : [],
      historyIdx: tab?.url ? 0 : -1,
      loading: false,
    };
    set((s) => ({
      browserTabs: [...s.browserTabs, newTab],
      activeBrowserTabId: id,
    }));
    return id;
  },
  removeBrowserTab: (id) => {
    set((s) => {
      const tab = s.browserTabs.find((t) => t.id === id);
      if (tab?._refreshTimer) clearTimeout(tab._refreshTimer);
      const remaining = s.browserTabs.filter((t) => t.id !== id);
      const newActive = s.activeBrowserTabId === id
        ? (remaining[remaining.length - 1]?.id ?? null)
        : s.activeBrowserTabId;
      return { browserTabs: remaining, activeBrowserTabId: newActive };
    });
  },
  setActiveBrowserTab: (id) => set({ activeBrowserTabId: id }),
  navigateBrowser: (id, url) => {
    const normalizedUrl = normalizeBrowserUrl(url);
    if (!normalizedUrl) return;
    set((s) => ({
      browserTabs: s.browserTabs.map((t) => {
        if (t.id !== id) return t;
        const truncated = normalizedUrl.slice(0, 200);
        const isSameUrl = t.history[t.historyIdx] === truncated;
        return {
          ...t,
          url: truncated,
          title: deriveTitleFromUrl(truncated),
          history: isSameUrl
            ? t.history
            : (() => {
                const newHistory = [...t.history.slice(0, t.historyIdx + 1), truncated];
                const MAX_BROWSER_HISTORY = 100;
                if (newHistory.length > MAX_BROWSER_HISTORY) {
                  return newHistory.slice(newHistory.length - MAX_BROWSER_HISTORY);
                }
                return newHistory;
              })(),
          historyIdx: isSameUrl ? t.historyIdx : Math.min(t.historyIdx + 1, 99),
          loading: false,
        };
      }),
    }));
  },
  goBackBrowser: (id) => {
    set((s) => ({
      browserTabs: s.browserTabs.map((t) => {
        if (t.id !== id || t.historyIdx <= 0) return t;
        const newIdx = t.historyIdx - 1;
        return { ...t, historyIdx: newIdx, url: t.history[newIdx], title: deriveTitleFromUrl(t.history[newIdx]) };
      }),
    }));
  },
  goForwardBrowser: (id) => {
    set((s) => ({
      browserTabs: s.browserTabs.map((t) => {
        if (t.id !== id || t.historyIdx >= t.history.length - 1) return t;
        const newIdx = t.historyIdx + 1;
        return { ...t, historyIdx: newIdx, url: t.history[newIdx], title: deriveTitleFromUrl(t.history[newIdx]) };
      }),
    }));
  },
  refreshBrowser: (id) => {
    set((s) => ({
      browserTabs: s.browserTabs.map((t) => {
        if (t.id !== id) return t;
        if (t._refreshTimer) clearTimeout(t._refreshTimer);
        const base = t.url.replace(/[?&]_r=\d+/, "");
        const sep = base.includes("?") ? "&" : "?";
        const refreshedUrl = base + sep + "_r=" + Date.now();
        const timer = setTimeout(() => {
          useUI.setState((s2) => ({
            browserTabs: s2.browserTabs.map((tab) => tab.id === id ? { ...tab, loading: false, _refreshTimer: undefined } : tab),
          }));
        }, 5000);
        return { ...t, url: refreshedUrl, loading: true, _refreshTimer: timer };
      }),
    }));
  },
  updateBrowserTab: (id, patch) => {
    set((s) => ({
      browserTabs: s.browserTabs.map((t) => {
        if (t.id !== id) return t;
        if (patch.loading === false && t._refreshTimer) { clearTimeout(t._refreshTimer); return { ...t, ...patch, _refreshTimer: undefined }; }
        return { ...t, ...patch };
      }),
    }));
  },
  clearBrowserTabs: () => {
    const { browserTabs } = get();
    for (const tab of browserTabs) {
      if (tab._refreshTimer) clearTimeout(tab._refreshTimer);
    }
    set({ browserTabs: [], activeBrowserTabId: null });
  },
}));

void import("./events").then(({ eventBus }) => {
  eventBus.on("workspace:file-opened", () => {
    useUI.getState().setViewMode("editor");
  });
});
