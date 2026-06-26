import { describe, it, expect } from "vitest";
import { buildMemoryGraph, hitTest } from "./memoryGraph";

describe("memoryGraph", () => {
  describe("buildMemoryGraph", () => {
    it("builds graph from memories", () => {
      const memories = [
        { id: "1", summary: "Test memory", category: "project", tags: ["test"], tier: "medium" },
      ];
      const graph = buildMemoryGraph(memories, [], []);
      expect(graph.nodes.length).toBeGreaterThan(0);
      expect(graph.nodes[0].type).toBe("memory");
    });

    it("builds graph from genes", () => {
      const genes = [
        { id: "g1", name: "test-gene", trigger: "test", category: "pattern", confidence: 0.5 },
      ];
      const graph = buildMemoryGraph([], genes, []);
      expect(graph.nodes.length).toBe(1);
      expect(graph.nodes[0].type).toBe("gene");
    });

    it("builds graph from agent sessions", () => {
      const sessions = [
        { id: "s1", title: "Session 1", agentName: "build", messageCount: 5 },
      ];
      const graph = buildMemoryGraph([], [], sessions);
      expect(graph.nodes.length).toBe(1);
      expect(graph.nodes[0].type).toBe("agent");
    });

    it("creates edges between related nodes", () => {
      const memories = [
        { id: "1", summary: "Test", category: "project", tags: ["test"], tier: "medium" },
      ];
      const genes = [
        { id: "g1", name: "test-gene", trigger: "test", category: "pattern", confidence: 0.5 },
      ];
      const graph = buildMemoryGraph(memories, genes, []);
      expect(graph.edges.length).toBeGreaterThan(0);
    });

    it("handles empty input", () => {
      const graph = buildMemoryGraph([], [], []);
      expect(graph.nodes).toHaveLength(0);
      expect(graph.edges).toHaveLength(0);
    });

    it("limits node size based on tier", () => {
      const memories = [
        { id: "1", summary: "Test", category: "project", tags: ["a", "b", "c"], tier: "high" },
        { id: "2", summary: "Test", category: "project", tags: [], tier: "low" },
      ];
      const graph = buildMemoryGraph(memories, [], []);
      expect(graph.nodes[0].size).toBeGreaterThan(graph.nodes[1].size);
    });
  });

  describe("hitTest", () => {
    it("finds node at coordinates", () => {
      const nodes = [
        { id: "1", label: "Test", type: "memory" as const, x: 100, y: 100, vx: 0, vy: 0, size: 10, color: "#fff", connections: [] },
      ];
      const result = hitTest(nodes, 100, 100);
      expect(result?.id).toBe("1");
    });

    it("returns null when no node at coordinates", () => {
      const nodes = [
        { id: "1", label: "Test", type: "memory" as const, x: 100, y: 100, vx: 0, vy: 0, size: 10, color: "#fff", connections: [] },
      ];
      const result = hitTest(nodes, 500, 500);
      expect(result).toBeNull();
    });
  });
});
