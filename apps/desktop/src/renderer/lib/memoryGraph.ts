/**
 * Memory Graph — Neuron-style knowledge network visualization.
 *
 * Nodes represent: memories, agents, skills, genes, projects
 * Edges represent: relationships (created_by, uses, related_to, depends_on)
 *
 * Designed for lightweight canvas rendering (no GPU, no heavy libs).
 */

export interface GraphNode {
  id: string;
  label: string;
  type: "memory" | "agent" | "skill" | "gene" | "project" | "tool";
  x: number;
  y: number;
  size: number;
  color: string;
  connections: string[];
  metadata?: Record<string, unknown>;
}

export interface GraphEdge {
  source: string;
  target: string;
  type: "created_by" | "uses" | "related_to" | "depends_on" | "evolved_from";
  weight: number;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  centerNode: string | null;
}

const NODE_COLORS: Record<GraphNode["type"], string> = {
  memory: "#4fc3f7",
  agent: "#ff8a65",
  skill: "#81c784",
  gene: "#ce93d8",
  project: "#ffd54f",
  tool: "#e57373",
};

/**
 * Build a graph from memory store, gene pool, and workspace data.
 */
export function buildMemoryGraph(
  memories: { id: string; summary: string; category: string; tags: string[]; tier: string }[],
  genes: { id: string; name: string; trigger: string; category: string; confidence: number }[],
  agentSessions: { id: string; title: string; agentName: string; messageCount: number }[]
): GraphData {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  // Add memory nodes
  for (const mem of memories) {
    nodes.push({
      id: `mem-${mem.id}`,
      label: mem.summary.slice(0, 30),
      type: "memory",
      x: 0, y: 0,
      size: Math.max(6, Math.min(14, mem.tags.length * 2 + 4)),
      color: NODE_COLORS.memory,
      connections: [],
      metadata: { category: mem.category, tier: mem.tier, tags: mem.tags },
    });
  }

  // Add gene nodes
  for (const gene of genes) {
    nodes.push({
      id: `gene-${gene.id}`,
      label: gene.name,
      type: "gene",
      x: 0, y: 0,
      size: Math.max(6, Math.min(12, gene.confidence * 10 + 2)),
      color: NODE_COLORS.gene,
      connections: [],
      metadata: { category: gene.category, confidence: gene.confidence },
    });
  }

  // Add agent session nodes (grouped by agent name)
  const agentGroups = new Map<string, typeof agentSessions>();
  for (const session of agentSessions) {
    const group = agentGroups.get(session.agentName) || [];
    group.push(session);
    agentGroups.set(session.agentName, group);
  }
  for (const [agentName, sessions] of agentGroups) {
    nodes.push({
      id: `agent-${agentName}`,
      label: agentName,
      type: "agent",
      x: 0, y: 0,
      size: Math.max(8, Math.min(16, sessions.length)),
      color: NODE_COLORS.agent,
      connections: [],
      metadata: { sessionCount: sessions.length },
    });
  }

  // Connect memories to genes by shared tags
  for (const mem of memories) {
    for (const gene of genes) {
      if (mem.tags.some(t => gene.trigger.includes(t) || gene.name.includes(t))) {
        edges.push({ source: `mem-${mem.id}`, target: `gene-${gene.id}`, type: "related_to", weight: 0.6 });
      }
    }
  }

  // Connect agents to their sessions
  for (const session of agentSessions) {
    const agentId = `agent-${session.agentName}`;
    if (nodes.find(n => n.id === agentId)) {
      // Connect agent to memories created in its sessions
      for (const mem of memories) {
        edges.push({ source: agentId, target: `mem-${mem.id}`, type: "created_by", weight: 0.3 });
      }
    }
  }

  // Connect genes to agents by category
  for (const gene of genes) {
    for (const [agentName] of agentGroups) {
      edges.push({ source: `gene-${gene.id}`, target: `agent-${agentName}`, type: "uses", weight: 0.2 });
    }
  }

  // Force-directed layout (simple)
  applyForceLayout(nodes, edges);

  return { nodes, edges, centerNode: null };
}

/**
 * Simple force-directed layout without physics simulation.
 * Uses iterative relaxation to spread nodes.
 */
function applyForceLayout(nodes: GraphNode[], edges: GraphEdge[]): void {
  const n = nodes.length;
  if (n === 0) return;

  // Build lookup map for O(1) edge lookups
  const nodeMap = new Map<string, GraphNode>();
  for (const node of nodes) nodeMap.set(node.id, node);

  // Initialize in a circle
  for (let i = 0; i < n; i++) {
    const angle = (2 * Math.PI * i) / n;
    const radius = Math.min(200, n * 5);
    nodes[i].x = 300 + radius * Math.cos(angle);
    nodes[i].y = 250 + radius * Math.sin(angle);
  }

  // Simple repulsion + attraction
  for (let iter = 0; iter < 50; iter++) {
    // Repulsion between all nodes
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const dx = nodes[j].x - nodes[i].x;
        const dy = nodes[j].y - nodes[i].y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const force = 800 / (dist * dist);
        nodes[i].x -= (dx / dist) * force;
        nodes[i].y -= (dy / dist) * force;
        nodes[j].x += (dx / dist) * force;
        nodes[j].y += (dy / dist) * force;
      }
    }

    // Attraction along edges (O(1) lookup via map)
    for (const edge of edges) {
      const source = nodeMap.get(edge.source);
      const target = nodeMap.get(edge.target);
      if (!source || !target) continue;
      const dx = target.x - source.x;
      const dy = target.y - source.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const force = (dist - 80) * 0.01 * edge.weight;
      source.x += (dx / dist) * force;
      source.y += (dy / dist) * force;
      target.x -= (dx / dist) * force;
      target.y -= (dy / dist) * force;
    }

    // Center gravity
    for (const node of nodes) {
      node.x += (300 - node.x) * 0.01;
      node.y += (250 - node.y) * 0.01;
    }
  }
}

/**
 * Hit test: find node at given canvas coordinates.
 */
export function hitTest(nodes: GraphNode[], x: number, y: number): GraphNode | null {
  for (const node of nodes) {
    const dx = x - node.x;
    const dy = y - node.y;
    if (dx * dx + dy * dy < node.size * node.size) {
      return node;
    }
  }
  return null;
}
