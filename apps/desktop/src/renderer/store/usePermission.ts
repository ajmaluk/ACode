import { create } from "zustand";
import { useWorkspace } from "./useWorkspace";
import { useAgents } from "./useAgents";
import { joinPath } from "@/lib/pathUtils";

const devWarn = import.meta.env.DEV
  ? (...args: unknown[]) => console.warn(...args)
  : () => {};

export type PermissionKind = "bash" | "edit" | "mcp" | "read";

export type PermissionRequest = {
  id: string;
  kind: PermissionKind;
  title: string;
  description: string;
  command?: string;
  output?: string;
  workspacePath?: string;
  createdAt: number;
};

const ALWAYS_ALLOWED_KEY = "dalam.alwaysAllowed.v1";

export const _toolCallResolvers = new Map<string, (decision: "approved" | "denied") => void>();
export const _pendingResolutions = new Map<string, "approved" | "denied">();

function loadAlwaysAllowed(): Record<string, true> {
  try {
    const raw = localStorage.getItem(ALWAYS_ALLOWED_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    const result: Record<string, true> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (v === true) result[k] = true;
    }
    return result;
  } catch (e) {
    if (import.meta.env.DEV) devWarn("[Store] const raw = localStorage.getItem(ALWAYS_ALLOWED_KE:", e);
    return {};
  }
}

function saveAlwaysAllowed(data: Record<string, true>) {
  try {    localStorage.setItem(ALWAYS_ALLOWED_KEY, JSON.stringify(data));} catch (e) { if (import.meta.env.DEV) devWarn("[Store] localStorage.setItem(ALWAYS_ALLOWED_KEY, JSON.stri", e); }
  void persistAlwaysAllowedToDisk(data);
}

async function persistAlwaysAllowedToDisk(data: Record<string, true>) {
  try {
    const ws = useWorkspace.getState();
    const activeWs = ws.workspaces.find((w) => w.id === ws.activeWorkspaceId);
    if (!activeWs) return;
    const { scopeSafeExists, scopeSafeMkdir, scopeSafeReadFile, scopeSafeWriteFile } = await import("@/lib/dalamAPI");
    const dotDalam = joinPath(activeWs.path, ".dalam");
    if (!(await scopeSafeExists(dotDalam))) {
      const created = await scopeSafeMkdir(dotDalam, { recursive: true });
      if (!created) return;
    }
    const configPath = joinPath(dotDalam, "config.json");
    let existing: { alwaysAllowed?: Record<string, true> } = {};
      try {
        const raw = await scopeSafeReadFile(configPath);
        if (raw) existing = JSON.parse(raw);
      } catch (e) {
        if (import.meta.env.DEV) devWarn("[Store] Failed to read existing config:", e);
      }
      existing.alwaysAllowed = data;
    await scopeSafeWriteFile(configPath, JSON.stringify(existing, null, 2));
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    if (!msg.includes("forbidden") && !msg.includes("scope")) {
      devWarn("[Store] Failed to persist alwaysAllowed to disk:", e);
    }
  }
}

async function loadAlwaysAllowedFromDisk(): Promise<Record<string, true>> {
  try {
    const ws = useWorkspace.getState();
    const activeWs = ws.workspaces.find((w) => w.id === ws.activeWorkspaceId);
    if (!activeWs) return {};
    const { scopeSafeExists, scopeSafeReadFile } = await import("@/lib/dalamAPI");
    const configPath = joinPath(activeWs.path, ".dalam", "config.json");
    if (await scopeSafeExists(configPath)) {
      const content = await scopeSafeReadFile(configPath);
      if (content) {
        const config = JSON.parse(content);
        return config.alwaysAllowed || {};
      }
    }
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    if (!msg.includes("forbidden") && !msg.includes("scope") && import.meta.env.DEV) {
      devWarn("[Store] Failed to load alwaysAllowed from disk:", e);
    }
  }
  return {};
}

type PermissionState = {
  request: PermissionRequest | null;
  alwaysAllowed: Record<string, true>;
  ask: (req: Omit<PermissionRequest, "id" | "createdAt">) => Promise<"allow" | "always" | "deny">;
  allowAlways: (req: PermissionRequest) => void;
  resolve: (decision: "allow" | "always" | "deny") => void;
  cancel: () => void;
  loadFromDisk: () => Promise<void>;
};

export const usePermission = create<PermissionState>((set, get) => {
  const pendingQueue: Array<{ resolve: (d: "allow" | "always" | "deny") => void; req: PermissionRequest }> = [];

  const showNextInQueue = () => {
    if (pendingQueue.length > 0) {
      const next = pendingQueue[0];
      set({ request: next.req });
    } else {
      set({ request: null });
    }
  };

  const ask: PermissionState["ask"] = (req) => {
    const key = `${req.workspacePath ?? ""}::${req.kind}::${req.command ?? ""}`;
    if (get().alwaysAllowed[key]) {
      return Promise.resolve("allow" as const);
    }
    const full: PermissionRequest = {
      ...req,
      id: "perm-" + crypto.randomUUID(),
      createdAt: Date.now(),
    };
    return new Promise<"allow" | "always" | "deny">((resolve) => {
      pendingQueue.push({ resolve, req: full });
      if (pendingQueue.length === 1) {
        set({ request: full });
      }
    });
  };

  return {
    request: null,
    alwaysAllowed: loadAlwaysAllowed(),
    ask,
    allowAlways(req) {
      const key = `${req.workspacePath ?? ""}::${req.kind}::${req.command ?? ""}`;
      const next: Record<string, true> = { ...get().alwaysAllowed, [key]: true };
      set({ alwaysAllowed: next });
      saveAlwaysAllowed(next);
    },
    resolve(decision) {
      const first = pendingQueue.shift();
      if (first) {
        first.resolve(decision);
      }
      showNextInQueue();
    },
    cancel() {
      while (pendingQueue.length > 0) {
        const item = pendingQueue.shift()!;
        item.resolve("deny");
      }
      set({ request: null });
    },
    async loadFromDisk() {
      try {
        const diskData = await loadAlwaysAllowedFromDisk();
        const localData = loadAlwaysAllowed();
        const merged: Record<string, true> = { ...diskData, ...localData };
        set({ alwaysAllowed: merged });
      } catch (e) {
        devWarn("Failed to load permissions from disk:", e);
      }
    },
  };
});

export async function withPermission<T>(
  params: {
    kind: PermissionKind;
    title: string;
    description: string;
    command?: string;
    output?: string;
    workspacePath?: string;
  },
  run: () => Promise<T> | T
): Promise<T | null> {
  const action = useAgents.getState().evaluatePermission(params.kind, params.command ?? "*");
  if (action === "allow") return await run();
  if (action === "deny") return null;
  const decision = await usePermission.getState().ask(params);
  if (decision === "deny") return null;
  const shouldAlways = decision === "always";
  const result = await run();
  if (shouldAlways) {
    usePermission.getState().allowAlways({
      id: "perm-" + crypto.randomUUID(),
      createdAt: Date.now(),
      ...params,
    });
  }
  return result;
}
