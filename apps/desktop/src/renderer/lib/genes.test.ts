import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock localStorage for test environment
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => { store[key] = value; },
    removeItem: (key: string) => { delete store[key]; },
    clear: () => { store = {}; },
    get length() { return Object.keys(store).length; },
    key: (index: number) => Object.keys(store)[index] ?? null,
  };
})();
vi.stubGlobal("localStorage", localStorageMock);

import {
  loadGenePool,
  saveGenePool,
  addGene,
  removeGene,
  expressGenes,
  reflectOnSession,
  solidifyGene,
  evolveGenes,
  formatGenesForPrompt,
  createGeneId,
  getGeneSuccessRate,
  type Gene,
  type GenePool,
} from "./genes";
import type { ChatMessage } from "@acode/shared-types";

function makeMsg(role: "user" | "assistant", content: string): ChatMessage {
  return { id: `m-${Math.random()}`, role, content, timestamp: Date.now() };
}

function makeGene(overrides: Partial<Gene> = {}): Gene {
  return {
    id: createGeneId(),
    name: "test-gene",
    description: "Test gene",
    trigger: "test",
    action: "do something",
    category: "pattern",
    confidence: 0.5,
    activationCount: 0,
    successCount: 0,
    createdAt: Date.now(),
    lastActivatedAt: 0,
    source: "session",
    tags: ["test"],
    ...overrides,
  };
}

describe("genes", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  describe("GenePool CRUD", () => {
    it("loads empty pool from localStorage", () => {
      const pool = loadGenePool();
      expect(pool.genes).toHaveLength(0);
      expect(pool.version).toBe(1);
    });

    it("saves and loads pool", () => {
      const pool: GenePool = { genes: [makeGene()], version: 1, lastEvolution: 0, totalActivations: 0 };
      saveGenePool(pool);
      const loaded = loadGenePool();
      expect(loaded.genes).toHaveLength(1);
    });

    it("addGene deduplicates by name", () => {
      let pool: GenePool = { genes: [], version: 1, lastEvolution: 0, totalActivations: 0 };
      pool = addGene(pool, makeGene({ name: "dup" }));
      pool = addGene(pool, makeGene({ name: "dup" }));
      expect(pool.genes).toHaveLength(1);
      expect(pool.genes[0].confidence).toBeGreaterThan(0.5);
    });

    it("addGene deduplicates by trigger", () => {
      let pool: GenePool = { genes: [], version: 1, lastEvolution: 0, totalActivations: 0 };
      pool = addGene(pool, makeGene({ name: "a", trigger: "same" }));
      pool = addGene(pool, makeGene({ name: "b", trigger: "same" }));
      expect(pool.genes).toHaveLength(1);
    });

    it("addGene caps pool at 50", () => {
      let pool: GenePool = { genes: [], version: 1, lastEvolution: 0, totalActivations: 0 };
      for (let i = 0; i < 60; i++) {
        pool = addGene(pool, makeGene({ name: `gene-${i}`, trigger: `trigger-${i}` }));
      }
      expect(pool.genes.length).toBeLessThanOrEqual(50);
    });

    it("removeGene works", () => {
      const gene = makeGene({ id: "test-123" });
      let pool: GenePool = { genes: [gene], version: 1, lastEvolution: 0, totalActivations: 0 };
      pool = removeGene(pool, "test-123");
      expect(pool.genes).toHaveLength(0);
    });
  });

  describe("Gene Expression", () => {
    it("matches genes by prompt content", () => {
      const pool: GenePool = {
        genes: [makeGene({ trigger: "refactor" })],
        version: 1,
        lastEvolution: 0,
        totalActivations: 0,
      };
      const matched = expressGenes(pool, "please refactor this code", []);
      expect(matched).toHaveLength(1);
    });

    it("matches genes by recent messages", () => {
      const pool: GenePool = {
        genes: [makeGene({ trigger: "error" })],
        version: 1,
        lastEvolution: 0,
        totalActivations: 0,
      };
      const msgs = [makeMsg("assistant", "Error occurred in the file")];
      const matched = expressGenes(pool, "something else", msgs);
      expect(matched).toHaveLength(1);
    });

    it("returns empty for no matches", () => {
      const pool: GenePool = {
        genes: [makeGene({ trigger: "xyzzy" })],
        version: 1,
        lastEvolution: 0,
        totalActivations: 0,
      };
      const matched = expressGenes(pool, "hello world", []);
      expect(matched).toHaveLength(0);
    });

    it("handles invalid regex gracefully", () => {
      const pool: GenePool = {
        genes: [makeGene({ trigger: "[invalid" })],
        version: 1,
        lastEvolution: 0,
        totalActivations: 0,
      };
      const matched = expressGenes(pool, "[invalid", []);
      expect(matched).toHaveLength(1);
    });

    it("limits to top 3 matches", () => {
      const pool: GenePool = {
        genes: Array.from({ length: 5 }, (_, i) => makeGene({ name: `g${i}`, trigger: "test", confidence: 0.1 * (i + 1) })),
        version: 1,
        lastEvolution: 0,
        totalActivations: 0,
      };
      const matched = expressGenes(pool, "test", []);
      expect(matched).toHaveLength(3);
    });

    it("returns matches sorted by confidence", () => {
      const pool: GenePool = {
        genes: [
          makeGene({ name: "low", trigger: "test", confidence: 0.1 }),
          makeGene({ name: "high", trigger: "test", confidence: 0.9 }),
          makeGene({ name: "mid", trigger: "test", confidence: 0.5 }),
        ],
        version: 1,
        lastEvolution: 0,
        totalActivations: 0,
      };
      const matched = expressGenes(pool, "test", []);
      expect(matched[0].name).toBe("high");
      expect(matched[1].name).toBe("mid");
      expect(matched[2].name).toBe("low");
    });
  });

  describe("Reflection", () => {
    it("detects tool error patterns", () => {
      const msgs = [
        makeMsg("user", "run something"),
        makeMsg("assistant", "running"),
        makeMsg("user", "[TOOL ERROR: read_file]\nPermission denied"),
        makeMsg("user", "[TOOL ERROR: read_file]\nFile not found"),
        makeMsg("user", "[TOOL ERROR: read_file]\nTimeout"),
      ];
      const result = reflectOnSession(msgs, "test");
      expect(result.patterns.length).toBeGreaterThan(0);
      expect(result.patterns.some(p => p.type === "failure")).toBe(true);
    });

    it("creates recovery genes for repeated errors", () => {
      const msgs = Array.from({ length: 6 }, (_, i) =>
        makeMsg("user", i % 2 === 0 ? `[TOOL ERROR: bash]\nPermission denied` : "ok")
      );
      const result = reflectOnSession(msgs, "test");
      expect(result.suggestedGenes.length).toBeGreaterThan(0);
    });

    it("detects clean sessions", () => {
      const msgs = [
        makeMsg("user", "hello"),
        makeMsg("assistant", "hi"),
        makeMsg("user", "[TOOL RESULT: ls]\nfile1.ts"),
        makeMsg("assistant", "found file1"),
      ];
      const result = reflectOnSession(msgs, "test");
      expect(result.performanceScore).toBe(1);
    });

    it("calculates performance score", () => {
      const msgs = [
        makeMsg("user", "run"),
        makeMsg("user", "[TOOL ERROR: bash]\nfailed"),
        makeMsg("user", "[TOOL RESULT: ls]\nok"),
      ];
      const result = reflectOnSession(msgs, "test");
      expect(result.performanceScore).toBeLessThan(1);
    });

    it("detects file edit patterns", () => {
      const msgs = Array.from({ length: 7 }, (_, i) =>
        makeMsg("user", i % 2 === 0 ? "File edited successfully" : "ok")
      );
      const result = reflectOnSession(msgs, "test");
      expect(result.suggestedGenes.some(g => g.name === "batch-file-operations")).toBe(true);
    });
  });

  describe("Solidification", () => {
    it("validates gene before adding", () => {
      const pool: GenePool = { genes: [], version: 1, lastEvolution: 0, totalActivations: 0 };
      const result = solidifyGene(pool, {
        name: "test",
        description: "test",
        trigger: "valid regex",
        action: "do it",
        category: "pattern",
        confidence: 0.5,
        activationCount: 0,
        successCount: 0,
        source: "session",
        tags: [],
      });
      expect(result.success).toBe(true);
      expect(result.gene).toBeDefined();
    });

    it("rejects invalid regex", () => {
      const pool: GenePool = { genes: [], version: 1, lastEvolution: 0, totalActivations: 0 };
      const result = solidifyGene(pool, {
        name: "test",
        description: "test",
        trigger: "[invalid",
        action: "do it",
        category: "pattern",
        confidence: 0.5,
        activationCount: 0,
        successCount: 0,
        source: "session",
        tags: [],
      });
      expect(result.success).toBe(false);
    });

    it("rejects duplicate names", () => {
      const pool: GenePool = { genes: [makeGene({ name: "dup" })], version: 1, lastEvolution: 0, totalActivations: 0 };
      const result = solidifyGene(pool, {
        name: "dup",
        description: "test",
        trigger: "test",
        action: "do it",
        category: "pattern",
        confidence: 0.5,
        activationCount: 0,
        successCount: 0,
        source: "session",
        tags: [],
      });
      expect(result.success).toBe(false);
    });
  });

  describe("Evolution", () => {
    it("boosts confidence of successful genes", () => {
      const pool: GenePool = {
        genes: [makeGene({ confidence: 0.5, activationCount: 10, successCount: 8 })],
        version: 1,
        lastEvolution: 0,
        totalActivations: 0,
      };
      const evolved = evolveGenes(pool);
      expect(evolved.genes[0].confidence).toBeGreaterThan(0.5);
    });

    it("removes very low confidence unused genes", () => {
      const pool: GenePool = {
        genes: [makeGene({ confidence: 0.05, activationCount: 0, createdAt: Date.now() - 60 * 24 * 60 * 60 * 1000 })],
        version: 1,
        lastEvolution: 0,
        totalActivations: 0,
      };
      const evolved = evolveGenes(pool);
      expect(evolved.genes).toHaveLength(0);
    });
  });

  describe("Utility", () => {
    it("createGeneId produces unique IDs", () => {
      const ids = new Set(Array.from({ length: 100 }, () => createGeneId()));
      expect(ids.size).toBe(100);
    });

    it("getGeneSuccessRate handles zero activations", () => {
      const gene = makeGene({ activationCount: 0, successCount: 0 });
      expect(getGeneSuccessRate(gene)).toBe(0);
    });

    it("getGeneSuccessRate calculates correctly", () => {
      const gene = makeGene({ activationCount: 10, successCount: 7 });
      expect(getGeneSuccessRate(gene)).toBe(0.7);
    });

    it("formatGenesForPrompt returns empty for no genes", () => {
      expect(formatGenesForPrompt([])).toBe("");
    });

    it("formatGenesForPrompt formats genes", () => {
      const result = formatGenesForPrompt([makeGene({ name: "test", trigger: "when X", action: "do Y" })]);
      expect(result).toContain("test");
      expect(result).toContain("when X");
      expect(result).toContain("do Y");
    });
  });
});
