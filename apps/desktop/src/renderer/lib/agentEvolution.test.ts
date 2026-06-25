import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock localStorage
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => { store[key] = value; },
    removeItem: (key: string) => { delete store[key]; },
    clear: () => { store = {}; },
  };
})();
vi.stubGlobal("localStorage", localStorageMock);

import {
  loadAgentDna,
  saveAgentDna,
  isMature,
  getPopulation,
  canReproduce,
  reproduce,
  autoArchive,
  selfDestruct,
  matchAgentForTask,
  getAgentTree,
  type AgentDna,
} from "./agentEvolution";

function makeAgent(overrides: Partial<AgentDna> = {}): AgentDna {
  return {
    id: "agent-1",
    parentId: null,
    name: "build",
    description: "Build agent",
    specialization: "general",
    triggerPattern: "build|compile|run",
    permissions: ["bash", "edit"],
    confidence: 0.7,
    sessionCount: 10,
    createdAt: Date.now() - 30 * 24 * 60 * 60 * 1000,
    lastUsedAt: Date.now(),
    archived: false,
    ...overrides,
  };
}

describe("agentEvolution", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  describe("DNA persistence", () => {
    it("loads empty DNA from storage", () => {
      const dna = loadAgentDna();
      expect(dna).toHaveLength(0);
    });

    it("saves and loads DNA", () => {
      const agents = [makeAgent()];
      saveAgentDna(agents);
      const loaded = loadAgentDna();
      expect(loaded).toHaveLength(1);
    });
  });

  describe("Maturity", () => {
    it("agent is mature with enough sessions", () => {
      const agent = makeAgent({ sessionCount: 5, confidence: 0.5 });
      expect(isMature(agent)).toBe(true);
    });

    it("agent is not mature with few sessions", () => {
      const agent = makeAgent({ sessionCount: 2, confidence: 0.5 });
      expect(isMature(agent)).toBe(false);
    });

    it("agent is not mature with low confidence", () => {
      const agent = makeAgent({ sessionCount: 10, confidence: 0.3 });
      expect(isMature(agent)).toBe(false);
    });
  });

  describe("Population", () => {
    it("counts active agents", () => {
      const agents = [
        makeAgent({ id: "1", archived: false }),
        makeAgent({ id: "2", archived: true }),
      ];
      expect(getPopulation(agents)).toBe(1);
    });
  });

  describe("Reproduction", () => {
    it("can reproduce when population is low", () => {
      const agents = [makeAgent({ sessionCount: 10, confidence: 0.5 })];
      expect(canReproduce(agents, "agent-1")).toBe(true);
    });

    it("cannot reproduce when population is high", () => {
      const agents = Array.from({ length: 12 }, (_, i) => makeAgent({ id: `a${i}` }));
      expect(canReproduce(agents, "agent-1")).toBe(false);
    });

    it("cannot reproduce if parent is immature", () => {
      const agents = [makeAgent({ sessionCount: 2 })];
      expect(canReproduce(agents, "agent-1")).toBe(false);
    });

    it("creates child agent", () => {
      const agents = [makeAgent({ sessionCount: 10, confidence: 0.6 })];
      const result = reproduce(agents, "agent-1", "refactoring", "refactor.*");
      expect(result.child).not.toBeNull();
      expect(result.agents).toHaveLength(2);
      expect(result.child!.parentId).toBe("agent-1");
    });

    it("returns null if cannot reproduce", () => {
      const agents = Array.from({ length: 13 }, (_, i) => makeAgent({ id: `a${i}` }));
      const result = reproduce(agents, "agent-1", "test", "test");
      expect(result.child).toBeNull();
      expect(result.agents).toHaveLength(13);
    });
  });

  describe("Auto-archive", () => {
    it("archives old agents", () => {
      const agents = [
        makeAgent({ id: "1", lastUsedAt: Date.now() - 8 * 24 * 60 * 60 * 1000, sessionCount: 1 }),
      ];
      const archived = autoArchive(agents);
      expect(archived[0].archived).toBe(true);
    });

    it("keeps recent agents", () => {
      const agents = [
        makeAgent({ id: "1", lastUsedAt: Date.now() }),
      ];
      const archived = autoArchive(agents);
      expect(archived[0].archived).toBe(false);
    });
  });

  describe("Self-destruct", () => {
    it("removes very old archived agents", () => {
      const agents = [
        makeAgent({ id: "1", archived: true, lastUsedAt: Date.now() - 31 * 24 * 60 * 60 * 1000 }),
      ];
      const result = selfDestruct(agents);
      expect(result).toHaveLength(0);
    });

    it("keeps recent archived agents", () => {
      const agents = [
        makeAgent({ id: "1", archived: true, lastUsedAt: Date.now() - 10 * 24 * 60 * 60 * 1000 }),
      ];
      const result = selfDestruct(agents);
      expect(result).toHaveLength(1);
    });
  });

  describe("Matching", () => {
    it("matches agent by trigger pattern", () => {
      const agents = [
        makeAgent({ triggerPattern: "build|compile" }),
      ];
      const match = matchAgentForTask(agents, "build the project");
      expect(match?.id).toBe("agent-1");
    });

    it("returns null when no match", () => {
      const agents = [
        makeAgent({ triggerPattern: "xyzzy" }),
      ];
      const match = matchAgentForTask(agents, "hello world");
      expect(match).toBeNull();
    });

    it("ignores archived agents", () => {
      const agents = [
        makeAgent({ triggerPattern: "build", archived: true }),
      ];
      const match = matchAgentForTask(agents, "build the project");
      expect(match).toBeNull();
    });
  });

  describe("Agent Tree", () => {
    it("builds tree from agents", () => {
      const agents = [
        makeAgent({ id: "parent", parentId: null }),
        makeAgent({ id: "child1", parentId: "parent" }),
        makeAgent({ id: "child2", parentId: "parent" }),
      ];
      const tree = getAgentTree(agents);
      expect(tree.get("root")?.length).toBe(1);
      expect(tree.get("parent")?.length).toBe(2);
    });
  });
});
