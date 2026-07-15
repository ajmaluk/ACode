import { create } from "zustand";
import type { AgentInfo, PrimaryAgentName, PermissionRule, SkillInfo } from "@dalam/shared-types";
import { ALL_AGENTS, getPrimaryAgent, mergeRulesets, evaluate } from "@/lib/agents";
import { skillRegistry } from "@/lib/skills";
import { useChat } from "./useChat";
import { saveWorkspaceData } from "./useWorkspace";

const devWarn = import.meta.env.DEV
  ? (...args: unknown[]) => console.warn(...args)
  : () => {};

type AgentStoreState = {
  agents: AgentInfo[];
  activeAgentName: PrimaryAgentName;
  userRules: PermissionRule[];
  enabledSkills: Set<string>;
  selectedSubagent: string | null;

  setActiveAgent: (name: PrimaryAgentName) => void;
  upsertRule: (rule: PermissionRule) => void;
  removeRule: (permission: string, pattern: string) => void;
  resetRules: () => void;
  toggleSkill: (name: string) => void;
  selectSubagent: (name: string | null) => void;
  evaluatePermission: (permission: string, pattern: string) => "allow" | "deny" | "ask";
  loadSkills: () => SkillInfo[];
};

const ENABLED_SKILLS_STORAGE = "dalam.enabledSkills.v1";
const SESSION_AGENTS_KEY = "dalam.sessionAgents.v1";

function loadEnabledSkills(): Set<string> {
  if (typeof window === "undefined") return new Set();
  const defaults = ["accessibility-compliance", "explain", "code-review", "plan"];
  try {
    const raw = window.localStorage.getItem(ENABLED_SKILLS_STORAGE);
    if (!raw) return new Set(defaults);
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set(defaults);
    return new Set(parsed as string[]);
  } catch (err) {
    devWarn("[useChat] Failed to load persisted data:", err);
    return new Set(defaults);
  }
}

function saveEnabledSkills(s: Set<string>) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(ENABLED_SKILLS_STORAGE, JSON.stringify(Array.from(s)));
  } catch (err) {
    devWarn("[useChat] Failed to save enabled skills:", err);
  }
}

function savePersistedAgents(agents: Record<string, PrimaryAgentName>) {
  try { localStorage.setItem(SESSION_AGENTS_KEY, JSON.stringify(agents)); } catch (e) { devWarn("Failed to save agents:", e); }
  void saveWorkspaceData();
}

export const useAgents = create<AgentStoreState>((set, get) => ({
  agents: ALL_AGENTS,
  activeAgentName: "build" as PrimaryAgentName,
  userRules: [],
  enabledSkills: loadEnabledSkills(),
  selectedSubagent: null,

  setActiveAgent(name) {
    set({ activeAgentName: name });
    useChat.setState({ activeAgentName: name });
    const { activeSessionId, sessionAgentName } = useChat.getState();
    if (activeSessionId) {
      const updated = { ...sessionAgentName, [activeSessionId]: name };
      useChat.setState({ sessionAgentName: updated });
      savePersistedAgents(updated);
    }
  },
  upsertRule(rule) {
    set((s) => {
      const idx = s.userRules.findIndex(
        (r) => r.permission === rule.permission && r.pattern === rule.pattern
      );
      const next = [...s.userRules];
      if (idx >= 0) next[idx] = rule;
      else next.push(rule);
      return { userRules: next };
    });
  },
  removeRule(permission, pattern) {
    set((s) => ({
      userRules: s.userRules.filter(
        (r) => !(r.permission === permission && r.pattern === pattern)
      ),
    }));
  },
  resetRules() {
    set({ userRules: [] });
  },
  toggleSkill(name) {
    const prev = get().enabledSkills;
    const next = new Set(prev);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    set({ enabledSkills: next });
    saveEnabledSkills(next);
  },
  selectSubagent(name) {
    set({ selectedSubagent: name });
  },
  evaluatePermission(permission, pattern) {
    const { activeAgentName, userRules } = get();
    const agent = getPrimaryAgent(activeAgentName);
    const merged = mergeRulesets(agent.permission, userRules);
    return evaluate(merged, permission, pattern);
  },
  loadSkills() {
    return skillRegistry.list();
  },
}));
