import { create } from "zustand";
import type { GitStatus } from "@dalam/shared-types";
import { createDalamAPI } from "@/lib/dalamAPI";
import { useWorkspace } from "./useWorkspace";

type GitState = {
  status: GitStatus | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
};

export const useGit = create<GitState>((set) => ({
  status: null,
  loading: false,
  error: null,
  async refresh() {
    const { activeWorkspaceId, workspaces } = useWorkspace.getState();
    const ws = workspaces.find((w) => w.id === activeWorkspaceId);
    if (!ws) {
      set({ status: null, error: null, loading: false });
      return;
    }
    const api = createDalamAPI();
    set({ loading: true, error: null });
    try {
      const status = await api.git.status(ws.path);
      set({ status, error: null });
    } catch (err) {
      const msg = (err as Error)?.message ?? "Unknown error";
      if (msg.includes("not a git repository") || msg.includes("not found") || msg.includes("No such file")) {
        set({ status: null, error: "not_initialized" });
      } else {
        set({ status: null, error: msg });
      }
    } finally {
      set({ loading: false });
    }
  },
}));
