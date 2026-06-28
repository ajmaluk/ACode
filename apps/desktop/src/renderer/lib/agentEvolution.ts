/**
 * Agent Evolution — Self-reproducing agent system with population control.
 *
 * Agents can "reproduce" by spawning specialized sub-agents when:
 * 1. The agent is mature (enough sessions completed)
 * 2. A complex task requires specialization
 * 3. Population is below the cap
 *
 * Self-destruction: Agents that haven't been used recently are archived.
 *
 * Population rules:
 * - Max 15 agents total (5 primary + 10 sub-agents)
 * - Reproduction only when population < 12
 * - Auto-archive agents unused for 7+ days
 */

import type { PrimaryAgentName } from "@dalam/shared-types"; // eslint-disable-line @typescript-eslint/no-unused-vars

export interface AgentDna {
  id: string;
  parentId: string | null;
  name: string;
  description: string;
  specialization: string;
  triggerPattern: string;
  permissions: string[];
  confidence: number;
  sessionCount: number;
  createdAt: number;
  lastUsedAt: number;
  archived: boolean;
}

const MAX_AGENTS = 15; // eslint-disable-line @typescript-eslint/no-unused-vars
const REPRODUCTION_THRESHOLD = 12;
const MATURITY_SESSIONS = 5;
const ARCHIVE_DAYS = 7;
const AGENT_DNA_KEY = "dalam.agentDna.v1";

/**
 * Load all agent DNA from storage.
 */
export function loadAgentDna(): AgentDna[] {
  try {
    const raw = localStorage.getItem(AGENT_DNA_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return [];
}

/**
 * Save agent DNA to storage.
 */
export function saveAgentDna(agents: AgentDna[]): void {
  localStorage.setItem(AGENT_DNA_KEY, JSON.stringify(agents));
}

/**
 * Check if an agent is mature enough to reproduce.
 */
export function isMature(agent: AgentDna): boolean {
  return agent.sessionCount >= MATURITY_SESSIONS && agent.confidence >= 0.5;
}

/**
 * Get current population count.
 */
export function getPopulation(agents: AgentDna[]): number {
  return agents.filter(a => !a.archived).length;
}

/**
 * Can this agent reproduce?
 */
export function canReproduce(agents: AgentDna[], parentId: string): boolean {
  if (getPopulation(agents) >= REPRODUCTION_THRESHOLD) return false;
  const parent = agents.find(a => a.id === parentId);
  if (!parent || parent.archived) return false;
  return isMature(parent);
}

/**
 * Reproduce: create a specialized sub-agent from a parent.
 */
export function reproduce(
  agents: AgentDna[],
  parentId: string,
  specialization: string,
  triggerPattern: string
): { agents: AgentDna[]; child: AgentDna | null } {
  if (!canReproduce(agents, parentId)) {
    return { agents, child: null };
  }

  const parent = agents.find(a => a.id === parentId)!;
  const child: AgentDna = {
    id: `agent-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    parentId,
    name: `${parent.name}-${specialization.toLowerCase().replace(/\s+/g, "-")}`,
    description: `Specialized for: ${specialization}`,
    specialization,
    triggerPattern,
    permissions: parent.permissions,
    confidence: 0.3,
    sessionCount: 0,
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    archived: false,
  };

  const newAgents = [...agents, child];
  saveAgentDna(newAgents);
  return { agents: newAgents, child };
}

/**
 * Auto-archive agents that haven't been used recently.
 */
export function autoArchive(agents: AgentDna[]): AgentDna[] {
  const now = Date.now();
  const threshold = ARCHIVE_DAYS * 24 * 60 * 60 * 1000;

  const result = agents.map(agent => {
    if (!agent.archived && now - agent.lastUsedAt > threshold && (agent.sessionCount > 0 || agent.parentId !== null)) {
      return { ...agent, archived: true };
    }
    return agent;
  });
  saveAgentDna(result);
  return result;
}

/**
 * Self-destruct: permanently remove archived agents that are very old.
 */
export function selfDestruct(agents: AgentDna[]): AgentDna[] {
  const now = Date.now();
  const destroyThreshold = 30 * 24 * 60 * 60 * 1000; // 30 days

  const result = agents.filter(agent => {
    if (agent.archived && now - agent.lastUsedAt > destroyThreshold) {
      return false; // Remove
    }
    return true;
  });
  saveAgentDna(result);
  return result;
}

/**
 * Match a prompt to the best agent (including evolved sub-agents).
 */
export function matchAgentForTask(
  agents: AgentDna[],
  prompt: string
): AgentDna | null {
  const lower = prompt.toLowerCase();
  const active = agents.filter(a => !a.archived && isMature(a));

  for (const agent of active) {
    // Try specialization with word-boundary matching (avoids false positives like "code" matching "decode")
    if (agent.specialization) {
      try {
        const escaped = agent.specialization.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (new RegExp(`\\b${escaped}\\b`, "i").test(lower)) return agent;
      } catch {
        // Fallback to includes if regex fails
        if (lower.includes(agent.specialization.toLowerCase())) return agent;
      }
    }
    // Then try trigger pattern regex
    try {
      const regex = new RegExp(agent.triggerPattern, "i");
      if (regex.test(lower)) return agent;
    } catch {
      // Invalid regex — skip
    }
  }
  return null;
}

/**
 * Get agent family tree.
 */
export function getAgentTree(agents: AgentDna[]): Map<string, AgentDna[]> {
  const tree = new Map<string, AgentDna[]>();
  for (const agent of agents) {
    const parentId = agent.parentId || "root";
    const children = tree.get(parentId) || [];
    children.push(agent);
    tree.set(parentId, children);
  }
  return tree;
}
