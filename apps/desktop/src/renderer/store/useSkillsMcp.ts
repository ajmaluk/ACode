import { create } from "zustand";
import type { McpServer, SkillInfo } from "@dalam/shared-types";
import { skillRegistry, BUNDLED_SKILLS } from "@/lib/skills";
import { mcpHttpSessions } from "@/lib/dalamAPI";
import { saveWorkspaceData } from "./useWorkspace";

const devWarn = import.meta.env.DEV
  ? (...args: unknown[]) => console.warn(...args)
  : () => {};

type SkillEntry = SkillInfo & { enabled: boolean };

type SkillsMcpState = {
  skills: SkillEntry[];
  mcpServers: McpServer[];
  toggleSkill: (name: string) => void;
  toggleMcp: (name: string) => void;
  addSkill: (skill: { name: string; description: string; content: string }) => void;
  removeSkill: (name: string) => void;
  addMcpServer: (server: Omit<McpServer, "enabled" | "status">) => void;
  removeMcpServer: (name: string) => void;
  connectMcpServer: (name: string) => Promise<void>;
  disconnectMcpServer: (name: string) => Promise<void>;
};

const MCP_STORAGE_KEY = "dalam.mcpServers.v1";
const USER_SKILLS_STORAGE_KEY = "dalam.userSkills.v1";
const BUNDLED_SKILLS_STORAGE_KEY = "dalam.bundledSkillsStates.v1";

function saveMcpServers(servers: McpServer[]) {
  const userServers = servers
    .filter((m) => m.scope !== "project")
    .map(({ status: _status, tools: _tools, error: _error, ...rest }) => ({
      ...rest,
      status: "disconnected" as const,
    }));
  try {
    localStorage.setItem(MCP_STORAGE_KEY, JSON.stringify(userServers));
  } catch (e) {
    if (e instanceof DOMException && e.name === "QuotaExceededError") {
      devWarn("[Storage] Quota exceeded saving MCP servers:", e);
    } else {
      devWarn("[Storage] Failed to save MCP servers:", e);
    }
  }
  void saveWorkspaceData();
}

export function loadMcpServers(): McpServer[] {
  try {
    const raw = localStorage.getItem(MCP_STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) {
    if (import.meta.env.DEV) devWarn("[Store] const raw = localStorage.getItem(MCP_STORAGE_KEY);:", e);
  }
  return [];
}

function migrateSkillEntry(raw: Record<string, unknown>): SkillEntry | null {
  const name = String(raw.name ?? "");
  if (!name) return null;
  const description = String(raw.description ?? "");
  const source = (raw.source as SkillEntry["source"]) ?? "user";
  const enabled = raw.enabled === true;
  if (raw.content) {
    return { name, description, content: String(raw.content), location: String(raw.location ?? ""), source, enabled };
  }
  if (raw.prompt) {
    return { name, description, content: String(raw.prompt), location: "", source, enabled };
  }
  return { name, description, content: "", location: "", source, enabled };
}

function loadSkills(): SkillEntry[] {
  const registrySkills = skillRegistry.list();
  const defaultBundledStates = BUNDLED_SKILLS.reduce((acc, bs) => {
    acc[bs.name] = true;
    return acc;
  }, {} as Record<string, boolean>);

  let loadedBundledStates = defaultBundledStates;
  try {
    const raw = localStorage.getItem(BUNDLED_SKILLS_STORAGE_KEY);
    if (raw) {
      loadedBundledStates = { ...defaultBundledStates, ...JSON.parse(raw) };
    }
  } catch (e) {
    if (import.meta.env.DEV) devWarn("[Store] const raw = localStorage.getItem(BUNDLED_SKILLS_ST:", e);
  }

  const mappedRegistrySkills: SkillEntry[] = registrySkills.map((rs) => ({
    ...rs,
    enabled: rs.source === "project" ? true : (loadedBundledStates[rs.name] ?? true),
  }));

  let userSkills: SkillEntry[] = [];
  try {
    const raw = localStorage.getItem(USER_SKILLS_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        userSkills = parsed.map(migrateSkillEntry).filter((s): s is SkillEntry => s !== null);
      }
    }
  } catch (e) {
    if (import.meta.env.DEV) devWarn("[Store] const raw = localStorage.getItem(USER_SKILLS_STORA:", e);
  }

  const merged = [...mappedRegistrySkills];
  for (const us of userSkills) {
    const idx = merged.findIndex((m) => m.name.toLowerCase() === us.name.toLowerCase());
    if (idx >= 0) {
      merged[idx] = us;
    } else {
      merged.push(us);
    }
  }

  return merged;
}

const queryStdioTools = async (commandName: string, commandArgs: string[], env?: Record<string, string>): Promise<{ name: string; description: string }[]> => {
  const { Command } = await import("@tauri-apps/plugin-shell");
  const cmd = Command.create(commandName, commandArgs, { env });
  let outputBuffer = "";

  return new Promise<{ name: string; description: string }[]>((resolve, reject) => {
    let resolved = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let childRef: { kill(): Promise<void> } | null = null;

    const stdoutHandler = (data: string) => {
      outputBuffer += data;
      const trimmed = outputBuffer.trim();
      if (trimmed.startsWith("{")) {
        try {
          const parsed = JSON.parse(trimmed);
          if (parsed.result?.tools || parsed.tools) {
            resolved = true;
            if (timeoutId !== undefined) clearTimeout(timeoutId);
            cleanup();
            if (childRef) childRef.kill().catch(() => {});
            resolve(parsed.result?.tools || parsed.tools);
            outputBuffer = "";
          }
        } catch (e) {
          if (import.meta.env.DEV) devWarn("[Store] JSON parse:", e);
        }
      }
    };

    const stderrHandler = (data: string) => {
      devWarn("MCP Server Stderr:", data);
    };

    const cleanup = () => {
      cmd.stdout.removeListener("data", stdoutHandler);
      cmd.stderr.removeListener("data", stderrHandler);
    };

    cmd.stdout.on("data", stdoutHandler);
    cmd.stderr.on("data", stderrHandler);

    const spawnTimeoutId = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        cleanup();
        reject(new Error(`Timeout spawning MCP server '${commandName} ${commandArgs.join(" ")}' (15s)`));
      }
    }, 15000);

    void cmd.spawn().then(async (child) => {
      clearTimeout(spawnTimeoutId);
      childRef = child;
      const req = JSON.stringify({ jsonrpc: "2.0", method: "tools/list", params: {}, id: 1 }) + "\n";
      await child.write(req);

      timeoutId = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          cleanup();
          child.kill().catch(() => {});
          reject(new Error("Timeout waiting for tools/list response (15s)"));
        }
      }, 15000);
    }).catch((err) => {
      clearTimeout(spawnTimeoutId);
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      cleanup();
      reject(err);
    });
  });
};

export const useSkillsMcp = create<SkillsMcpState>((set, get) => ({
  skills: loadSkills(),
  mcpServers: loadMcpServers(),
  toggleSkill(name) {
    set((s) => ({
      skills: s.skills.map((sk) =>
        sk.name === name ? { ...sk, enabled: !sk.enabled } : sk
      ),
    }));
    const nextSkills = get().skills;
    const bundledStates: Record<string, boolean> = {};
    const userSkillsOnly: SkillEntry[] = [];
    nextSkills.forEach((sk) => {
      if (sk.source === "bundled") {
        bundledStates[sk.name] = sk.enabled;
      } else {
        userSkillsOnly.push(sk);
      }
    });
    try {
      localStorage.setItem(BUNDLED_SKILLS_STORAGE_KEY, JSON.stringify(bundledStates));
    } catch (e) {
      devWarn("[Storage] Failed to save bundled skills states:", e);
    }
    try {
      localStorage.setItem(USER_SKILLS_STORAGE_KEY, JSON.stringify(userSkillsOnly));
    } catch (e) {
      devWarn("[Storage] Failed to save user skills:", e);
    }
  },
  toggleMcp(name) {
    set((s) => ({
      mcpServers: s.mcpServers.map((m) =>
        m.name === name ? { ...m, enabled: !m.enabled } : m
      ),
    }));
    saveMcpServers(get().mcpServers);
    const server = get().mcpServers.find((m) => m.name === name);
    if (server) {
      if (server.enabled) {
        void get().connectMcpServer(name);
      } else {
        void get().disconnectMcpServer(name);
      }
    }
  },
  addSkill(skill) {
    set((s) => {
      if (s.skills.some((sk) => sk.name === skill.name)) return s;
      const entry: SkillEntry = {
        name: skill.name,
        description: skill.description,
        content: skill.content,
        location: "",
        source: "user",
        enabled: true,
      };
      return { skills: [...s.skills, entry] };
    });
    const userSkillsOnly = get().skills.filter(sk => sk.source === "user");
    try {
      localStorage.setItem(USER_SKILLS_STORAGE_KEY, JSON.stringify(userSkillsOnly));
    } catch (e) {
      devWarn("[Storage] Failed to save user skills:", e);
    }
  },
  removeSkill(name) {
    set((s) => ({
      skills: s.skills.filter((sk) => sk.name !== name),
    }));
    const userSkillsOnly = get().skills.filter(sk => sk.source === "user");
    try {
      localStorage.setItem(USER_SKILLS_STORAGE_KEY, JSON.stringify(userSkillsOnly));
    } catch (e) {
      devWarn("[Storage] Failed to save user skills:", e);
    }
  },
  addMcpServer(server) {
    set((s) => {
      if (s.mcpServers.some((m) => m.name === server.name)) return s;
      const newServer: McpServer = { scope: "user", ...server, enabled: true, status: "disconnected" };
      return { mcpServers: [...s.mcpServers, newServer] };
    });
    saveMcpServers(get().mcpServers);
    void get().connectMcpServer(server.name);
  },
  removeMcpServer(name) {
    set((s) => ({
      mcpServers: s.mcpServers.filter((m) => m.name !== name),
    }));
    saveMcpServers(get().mcpServers);
  },
  async connectMcpServer(name) {
    set((s) => ({
      mcpServers: s.mcpServers.map((m) =>
        m.name === name ? { ...m, status: "connecting", error: undefined } : m
      ),
    }));

    const server = get().mcpServers.find((m) => m.name === name);
    if (!server) return;

    const { getCachedTools, cacheTools } = await import("../lib/mcpCache");
    const cached = getCachedTools(name);
    if (cached) {
      set((s) => ({
        mcpServers: s.mcpServers.map((m) =>
          m.name === name ? { ...m, status: "connected", tools: cached.tools, error: undefined } : m
        ),
      }));
      return;
    }

    try {
      let tools: { name: string; description: string }[] = [];
      if (server.transport === "http") {
        const url = server.url;
        if (!url) throw new Error("HTTP Endpoint URL is required");
        const { validateMcpUrl } = await import("../lib/security");
        validateMcpUrl(url);
        const resp = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", params: {}, id: 1 }),
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const json = await resp.json();
        tools = json.result?.tools || json.tools || [];
      } else {
        const command = server.command;
        if (!command) throw new Error("Stdio command is required");
        tools = await queryStdioTools(command, server.args ?? [], server.env);
      }

      set((s) => ({
        mcpServers: s.mcpServers.map((m) =>
          m.name === name ? { ...m, status: "connected", tools, error: undefined } : m
        ),
      }));

      cacheTools(name, tools, server.url);
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      if (import.meta.env.DEV) console.error(`MCP server "${name}" connection failed:`, errorMsg);
      set((s) => ({
        mcpServers: s.mcpServers.map((m) =>
          m.name === name ? { ...m, status: "error", error: errorMsg } : m
        ),
      }));
    }
  },
  async disconnectMcpServer(name) {
    mcpHttpSessions.delete(name);
    const { invalidateCache } = await import("../lib/mcpCache");
    invalidateCache(name);
    set((s) => ({
      mcpServers: s.mcpServers.map((m) =>
        m.name === name ? { ...m, status: "disconnected", tools: [] } : m
      ),
    }));
  },
}));

skillRegistry.subscribe(() => {
  useSkillsMcp.setState({ skills: loadSkills() });
});
