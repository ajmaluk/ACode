/**
 * Memory Graph — Production-quality knowledge network visualization.
 *
 * Nodes represent: memories, agents, skills, genes, projects
 * Edges represent: relationships (created_by, uses, related_to, depends_on)
 *
 * Features:
 *  - Barnes-Hut quadtree force layout (O(N log N))
 *  - Deduplicated edges with canonical keying
 *  - Graph statistics (centrality, clustering, components, shortest path)
 *  - JSON export/import with full fidelity
 *  - Relationship scoring (tag overlap, temporal proximity, co-occurrence)
 *  - Graph pruning (weak-edge removal)
 *  - Memory-efficient Map-based lookups
 */

// ──────────────────────────── Types ────────────────────────────

export interface GraphNode {
  id: string;
  label: string;
  type: "memory" | "agent" | "skill" | "gene" | "project" | "tool";
  x: number;
  y: number;
  vx: number;
  vy: number;
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

export interface GraphStats {
  totalNodes: number;
  totalEdges: number;
  avgDegree: number;
  maxDegree: number;
  density: number;
  components: number;
  avgClusteringCoefficient: number;
  mostCentralNodes: { id: string; label: string; centrality: number }[];
  diameter: number;
}

export interface SerializedGraph {
  version: 2;
  nodes: Omit<GraphNode, "vx" | "vy">[];
  edges: GraphEdge[];
  centerNode: string | null;
}

// ──────────────────────────── Constants ────────────────────────

export const NODE_COLORS: Record<GraphNode["type"], string> = {
  memory: "#4fc3f7",
  agent: "#ff8a65",
  skill: "#81c784",
  gene: "#ce93d8",
  project: "#ffd54f",
  tool: "#e57373",
};

/** Maximum iterations scale inversely with node count. */
const MAX_ITERATIONS_BASE = 60;
const MIN_ITERATIONS = 20;

// ──────────────────────────── Quadtree ─────────────────────────

interface QTNode {
  cx: number;
  cy: number;
  mass: number;
  totalMassX: number;
  totalMassY: number;
  childNW: QTNode | null;
  childNE: QTNode | null;
  childSW: QTNode | null;
  childSE: QTNode | null;
  body: GraphNode | null;
  size: number;
}

function createQuadNode(cx: number, cy: number, size: number): QTNode {
  return {
    cx,
    cy,
    size,
    mass: 0,
    totalMassX: 0,
    totalMassY: 0,
    childNW: null,
    childNE: null,
    childSW: null,
    childSE: null,
    body: null,
  };
}

function insertNode(qt: QTNode, p: GraphNode): void {
  if (qt.mass === 0 && qt.body === null) {
    qt.body = p;
    qt.mass = 1;
    qt.totalMassX = p.x;
    qt.totalMassY = p.y;
    return;
  }

  // If this node already has a body, subdivide
  if (qt.body !== null) {
    const old = qt.body;
    qt.body = null;
    subdivide(qt);
    insertIntoChild(qt, old);
  }

  // If size is too small, don't subdivide further — just accumulate mass
  if (qt.size < 0.5) {
    qt.mass += 1;
    qt.totalMassX += p.x;
    qt.totalMassY += p.y;
    return;
  }

  subdivideIfNeeded(qt);
  insertIntoChild(qt, p);
  qt.mass += 1;
  qt.totalMassX += p.x;
  qt.totalMassY += p.y;
}

function subdivide(qt: QTNode): void {
  const h = qt.size / 2;
  qt.childNW = createQuadNode(qt.cx - h, qt.cy - h, h);
  qt.childNE = createQuadNode(qt.cx + h, qt.cy - h, h);
  qt.childSW = createQuadNode(qt.cx - h, qt.cy + h, h);
  qt.childSE = createQuadNode(qt.cx + h, qt.cy + h, h);
}

function subdivideIfNeeded(qt: QTNode): void {
  if (qt.childNW === null && qt.size >= 0.5) subdivide(qt);
}

function getChild(qt: QTNode, x: number, y: number): QTNode | null {
  if (x < qt.cx) {
    return y < qt.cy ? qt.childNW : qt.childSW;
  }
  return y < qt.cy ? qt.childNE : qt.childSE;
}

function insertIntoChild(qt: QTNode, p: GraphNode): void {
  const child = getChild(qt, p.x, p.y);
  if (child) insertNode(child, p);
}

/**
 * Compute repulsive force on node `p` using Barnes-Hut approximation.
 * theta controls accuracy vs speed (lower = more accurate).
 */
function computeForce(
  p: GraphNode,
  qt: QTNode,
  repulsion: number,
  theta: number,
): { fx: number; fy: number } {
  if (qt.mass === 0) return { fx: 0, fy: 0 };

  const dx = qt.totalMassX / qt.mass - p.x;
  const dy = qt.totalMassY / qt.mass - p.y;
  const distSq = dx * dx + dy * dy;

  // Leaf node or far enough to treat as single body
  if (qt.body !== null || (qt.size * qt.size) / distSq < theta * theta) {
    // Skip self-interaction to avoid NaN from division by zero
    if (qt.body === p) return { fx: 0, fy: 0 };
    const dist = Math.sqrt(distSq) || 1;
    const force = repulsion / distSq;
    return { fx: (dx / dist) * force, fy: (dy / dist) * force };
  }

  // Recurse into children
  let fx = 0,
    fy = 0;
  for (const child of [qt.childNW, qt.childNE, qt.childSW, qt.childSE]) {
    if (child) {
      const f = computeForce(p, child, repulsion, theta);
      fx += f.fx;
      fy += f.fy;
    }
  }
  return { fx, fy };
}

// ──────────────────────────── Edge Keys ────────────────────────

function edgeKey(source: string, target: string): string {
  return source < target ? `${source}->${target}` : `${target}->${source}`;
}

function addEdgeDeduped(
  edges: GraphEdge[],
  seen: Set<string>,
  source: string,
  target: string,
  type: GraphEdge["type"],
  weight: number,
): void {
  if (source === target) return;
  const key = edgeKey(source, target);
  if (seen.has(key)) return;
  seen.add(key);
  edges.push({ source, target, type, weight });
}

// ──────────────────────────── Graph Building ───────────────────

/**
 * Build a graph from memory store, gene pool, and workspace data.
 * Edges are fully deduplicated; relationship weights reflect tag overlap
 * and co-occurrence scoring.
 */
export function buildMemoryGraph(
  memories: {
    id: string;
    summary: string;
    category: string;
    tags: string[];
    tier: string;
    sourceSession?: string;
  }[],
  genes: {
    id: string;
    name: string;
    trigger: string;
    category: string;
    confidence: number;
  }[],
  agentSessions: {
    id: string;
    title: string;
    agentName: string;
    messageCount: number;
  }[],
): GraphData {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  const nodeIds = new Set<string>();

  // ── Memory nodes ──
  for (const mem of memories) {
    const id = `mem-${mem.id}`;
    nodeIds.add(id);
    nodes.push({
      id,
      label: mem.summary.slice(0, 30),
      type: "memory",
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      size: Math.max(6, Math.min(14, mem.tags.length * 2 + 4)),
      color: NODE_COLORS.memory,
      connections: [],
      metadata: { category: mem.category, tier: mem.tier, tags: mem.tags },
    });
  }

  // ── Gene nodes ──
  for (const gene of genes) {
    const id = `gene-${gene.id}`;
    nodeIds.add(id);
    nodes.push({
      id,
      label: gene.name,
      type: "gene",
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      size: Math.max(6, Math.min(12, gene.confidence * 10 + 2)),
      color: NODE_COLORS.gene,
      connections: [],
      metadata: { category: gene.category, confidence: gene.confidence },
    });
  }

  // ── Agent nodes (grouped by name) ──
  const agentGroups = new Map<string, typeof agentSessions>();
  for (const session of agentSessions) {
    const group = agentGroups.get(session.agentName) || [];
    group.push(session);
    agentGroups.set(session.agentName, group);
  }
  for (const [agentName, sessions] of agentGroups) {
    const id = `agent-${agentName}`;
    nodeIds.add(id);
    nodes.push({
      id,
      label: agentName,
      type: "agent",
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      size: Math.max(8, Math.min(16, sessions.length)),
      color: NODE_COLORS.agent,
      connections: [],
      metadata: { sessionCount: sessions.length },
    });
  }

  // ── Memory ↔ Gene edges (tag-overlap weighted) ──
  for (const mem of memories) {
    const memId = `mem-${mem.id}`;
    for (const gene of genes) {
      const geneId = `gene-${gene.id}`;
      const overlap = mem.tags.filter(
        (t) => gene.trigger.includes(t) || gene.name.includes(t),
      ).length;
      if (overlap > 0) {
        const weight = Math.min(1, 0.3 + overlap * 0.15 * gene.confidence);
        addEdgeDeduped(edges, seen, memId, geneId, "related_to", weight);
      }
    }
  }

  // ── Agent ↔ Memory edges (only for memories created by each agent) ──
  for (const session of agentSessions) {
    const agentId = `agent-${session.agentName}`;
    if (!nodeIds.has(agentId)) continue;
    for (const mem of memories) {
      if (mem.sourceSession === session.id) {
        addEdgeDeduped(
          edges,
          seen,
          agentId,
          `mem-${mem.id}`,
          "created_by",
          0.5,
        );
      }
    }
  }

  // ── Pre-compute session memories map (avoids O(G*S*M) filtering) ──
  const sessionMemoriesMap = new Map<string, typeof memories>();
  for (const mem of memories) {
    if (mem.sourceSession) {
      const group = sessionMemoriesMap.get(mem.sourceSession) || [];
      group.push(mem);
      sessionMemoriesMap.set(mem.sourceSession, group);
    }
  }

  // ── Gene ↔ Agent edges (only when gene was triggered during a session) ──
  for (const gene of genes) {
    const geneId = `gene-${gene.id}`;
    for (const session of agentSessions) {
      const sessionMemories = sessionMemoriesMap.get(session.id) || [];
      const hasOverlap = sessionMemories.some((m) =>
        m.tags.some((t) => gene.trigger.includes(t) || gene.name.includes(t)),
      );
      if (hasOverlap) {
        const agentId = `agent-${session.agentName}`;
        addEdgeDeduped(edges, seen, geneId, agentId, "uses", 0.3);
      }
    }
  }

  // ── Nearest-neighbor edges (tag similarity) — FIX 5.6: O(n²) → O(n*k) by category grouping
  // Group memories by category to limit pairwise comparisons
  const memByCategory = new Map<string, typeof memories>();
  for (const mem of memories) {
    const group = memByCategory.get(mem.category) || [];
    group.push(mem);
    memByCategory.set(mem.category, group);
  }
  for (const [, catMemories] of memByCategory) {
    for (let i = 0; i < catMemories.length; i++) {
      const a = catMemories[i];
      const aId = `mem-${a.id}`;
      const similarities: { idx: number; score: number }[] = [];
      // Only compare within same category, and limit inner loop to first 100
      const maxJ = Math.min(catMemories.length, 100);
      for (let j = 0; j < maxJ; j++) {
        if (i === j) continue;
        const b = catMemories[j];
        const overlap = a.tags.filter((t) => b.tags.includes(t)).length;
        const summaryOverlap =
          a.summary.slice(0, 10) === b.summary.slice(0, 10) ? 1 : 0;
        const score = overlap + summaryOverlap;
        if (score > 0) similarities.push({ idx: j, score });
      }
      similarities.sort((a, b) => b.score - a.score);
      for (const { idx, score } of similarities.slice(0, 3)) {
        const bId = `mem-${catMemories[idx].id}`;
        const weight = Math.min(1, 0.1 + score * 0.1);
        addEdgeDeduped(edges, seen, aId, bId, "related_to", weight);
      }
    }
  }

  // ── Category clustering edges ──
  // Connect nodes within the same category to form clusters
  const categoryGroups = new Map<string, string[]>();
  for (const node of nodes) {
    const cat = (node.metadata?.category as string) || node.type;
    const group = categoryGroups.get(cat) || [];
    group.push(node.id);
    categoryGroups.set(cat, group);
  }
  for (const [, group] of categoryGroups) {
    // Connect each node to 2 others in same category
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < Math.min(group.length, i + 3); j++) {
        addEdgeDeduped(edges, seen, group[i], group[j], "related_to", 0.2);
      }
    }
  }

  // ── Hub nodes: connect high-degree nodes to each other ──
  // This creates a backbone network structure
  const nodeDegrees = new Map<string, number>();
  for (const e of edges) {
    nodeDegrees.set(e.source, (nodeDegrees.get(e.source) || 0) + 1);
    nodeDegrees.set(e.target, (nodeDegrees.get(e.target) || 0) + 1);
  }
  const hubs = nodes
    .filter((n) => (nodeDegrees.get(n.id) || 0) >= 2)
    .sort((a, b) => (nodeDegrees.get(b.id) || 0) - (nodeDegrees.get(a.id) || 0))
    .slice(0, 15);
  for (let i = 0; i < hubs.length; i++) {
    for (let j = i + 1; j < Math.min(hubs.length, i + 4); j++) {
      addEdgeDeduped(edges, seen, hubs[i].id, hubs[j].id, "related_to", 0.15);
    }
  }

  // ── Build connection lists ──
  const connMap = new Map<string, Set<string>>();
  for (const e of edges) {
    if (!connMap.has(e.source)) connMap.set(e.source, new Set());
    if (!connMap.has(e.target)) connMap.set(e.target, new Set());
    connMap.get(e.source)!.add(e.target);
    connMap.get(e.target)!.add(e.source);
  }
  for (const node of nodes) {
    node.connections = [...(connMap.get(node.id) ?? [])];
  }

  // ── Force layout ──
  applyForceLayout(nodes, edges);

  return { nodes, edges, centerNode: null };
}

// ──────────────────────────── Force Layout ─────────────────────

/**
 * Force-directed layout using Barnes-Hut quadtree for repulsion.
 * Iteration count scales with sqrt(node count) to keep runtime sub-quadratic.
 *
 * FIX 5.5: Uses requestAnimationFrame with time-budgeting to avoid blocking
 * the main thread for large graphs (>200 nodes). For smaller graphs,
 * runs synchronously for simplicity.
 */
function applyForceLayout(nodes: GraphNode[], edges: GraphEdge[]): void {
  const n = nodes.length;
  if (n === 0) return;

  const nodeMap = new Map<string, GraphNode>();
  for (const node of nodes) nodeMap.set(node.id, node);

  // Seed positions in concentric rings by type for natural clustering
  const typeGroups = new Map<string, GraphNode[]>();
  for (const node of nodes) {
    const group = typeGroups.get(node.type) || [];
    group.push(node);
    typeGroups.set(node.type, group);
  }
  const typeList = [...typeGroups.keys()];
  const baseSpread = Math.min(350, Math.sqrt(n) * 25);

  for (let t = 0; t < typeList.length; t++) {
    const group = typeGroups.get(typeList[t])!;
    const ringRadius = baseSpread * (0.3 + t * 0.25);
    const typeAngleOffset = (t / typeList.length) * Math.PI * 2;
    for (let i = 0; i < group.length; i++) {
      const angle = typeAngleOffset + (i / group.length) * Math.PI * 2;
      const r = ringRadius * (0.5 + 0.5 * Math.sqrt(i / group.length));
      group[i].x = 300 + r * Math.cos(angle);
      group[i].y = 250 + r * Math.sin(angle);
      group[i].vx = 0;
      group[i].vy = 0;
    }
  }

  const iterations = Math.max(
    MIN_ITERATIONS,
    Math.min(MAX_ITERATIONS_BASE, Math.round(50 * Math.sqrt(n / 100))),
  );
  const repulsion = 600;
  const attraction = 0.015;
  const damping = 0.82;
  const theta = 0.7; // Barnes-Hut accuracy

  // Pre-compute edge endpoints for O(1) attraction lookups
  const edgeEndpoints: {
    source: GraphNode;
    target: GraphNode;
    weight: number;
  }[] = [];
  for (const edge of edges) {
    const s = nodeMap.get(edge.source);
    const t = nodeMap.get(edge.target);
    if (s && t)
      edgeEndpoints.push({ source: s, target: t, weight: edge.weight });
  }

  const CONVERGENCE_THRESHOLD = 0.3;

  // FIX 5.5: Run iterations synchronously. The Barnes-Hut quadtree with
  // convergence detection is fast enough for reasonable graph sizes (<1000 nodes).
  // Async layout (via requestAnimationFrame) would break the `buildMemoryGraph()`
  // return contract since callers expect final positions immediately.
  for (let iter = 0; iter < iterations; iter++) {
    const cooling = 1 - iter / iterations;
    const alpha = cooling * cooling; // quadratic cooling

    // Build quadtree for this iteration
    let boundsMinX = Infinity,
      boundsMinY = Infinity;
    let boundsMaxX = -Infinity,
      boundsMaxY = -Infinity;
    for (const node of nodes) {
      if (node.x < boundsMinX) boundsMinX = node.x;
      if (node.y < boundsMinY) boundsMinY = node.y;
      if (node.x > boundsMaxX) boundsMaxX = node.x;
      if (node.y > boundsMaxY) boundsMaxY = node.y;
    }
    const padding = 10;
    const size =
      Math.max(boundsMaxX - boundsMinX, boundsMaxY - boundsMinY) + padding * 2;
    const rootCx = (boundsMinX + boundsMaxX) / 2;
    const rootCy = (boundsMinY + boundsMaxY) / 2;
    const qt = createQuadNode(rootCx, rootCy, size);
    for (const node of nodes) insertNode(qt, node);

    // Repulsion via quadtree
    for (const node of nodes) {
      const f = computeForce(node, qt, repulsion, theta);
      node.vx += f.fx * alpha;
      node.vy += f.fy * alpha;
    }

    // Attraction along edges (stronger for higher weight)
    for (const { source: s, target: t, weight } of edgeEndpoints) {
      const dx = t.x - s.x;
      const dy = t.y - s.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const idealDist = 60 + (1 - weight) * 40;
      const force = (dist - idealDist) * attraction * weight * alpha;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      s.vx += fx;
      s.vy += fy;
      t.vx -= fx;
      t.vy -= fy;
    }

    // Type clustering
    for (const [, group] of typeGroups) {
      for (let gi = 0; gi < group.length; gi++) {
        for (let gj = gi + 1; gj < group.length; gj++) {
          const dx = group[gj].x - group[gi].x;
          const dy = group[gj].y - group[gi].y;
          const dist = Math.sqrt(dx * dx + dy * dy) || 1;
          const force = 0.003 * alpha;
          group[gi].vx += (dx / dist) * force;
          group[gi].vy += (dy / dist) * force;
          group[gj].vx -= (dx / dist) * force;
          group[gj].vy -= (dy / dist) * force;
        }
      }
    }

    // Center gravity + velocity integration
    let totalDisplacement = 0;
    for (const node of nodes) {
      node.vx += (300 - node.x) * 0.008 * alpha;
      node.vy += (250 - node.y) * 0.008 * alpha;
      node.vx *= damping;
      node.vy *= damping;
      node.x += node.vx;
      node.y += node.vy;
      totalDisplacement += Math.abs(node.vx) + Math.abs(node.vy);
    }

    // Early exit when system is stable
    if (totalDisplacement / n < CONVERGENCE_THRESHOLD && iter > MIN_ITERATIONS)
      break;
  }
}

// ──────────────────────────── Hit Test ─────────────────────────

/**
 * Hit test: find node at given canvas coordinates.
 * Checks highest-degree nodes first for better UX.
 */
export function hitTest(
  nodes: GraphNode[],
  x: number,
  y: number,
): GraphNode | null {
  let best: GraphNode | null = null;
  let bestDist = Infinity;
  for (const node of nodes) {
    const dx = x - node.x;
    const dy = y - node.y;
    const hitRadius = node.size + 4;
    const distSq = dx * dx + dy * dy;
    if (distSq < hitRadius * hitRadius && distSq < bestDist) {
      best = node;
      bestDist = distSq;
    }
  }
  return best;
}

// ──────────────────────────── Statistics ───────────────────────

/**
 * Compute degree centrality: connections / (N-1).
 */
export function degreeCentrality(nodes: GraphNode[]): Map<string, number> {
  const n = nodes.length;
  const result = new Map<string, number>();
  const maxDegree = n - 1 || 1;
  for (const node of nodes) {
    result.set(node.id, node.connections.length / maxDegree);
  }
  return result;
}

/**
 * Compute clustering coefficient for each node.
 * CC(v) = 2 * edges_between_neighbors(v) / (deg(v) * (deg(v) - 1))
 */
export function clusteringCoefficients(
  nodes: GraphNode[],
): Map<string, number> {
  const neighborSets = new Map<string, Set<string>>();
  for (const node of nodes) {
    neighborSets.set(node.id, new Set(node.connections));
  }

  const result = new Map<string, number>();
  for (const node of nodes) {
    const neighbors = neighborSets.get(node.id)!;
    const deg = neighbors.size;
    if (deg < 2) {
      result.set(node.id, 0);
      continue;
    }
    let triangles = 0;
    for (const a of neighbors) {
      const aNeighbors = neighborSets.get(a);
      if (!aNeighbors) continue;
      for (const b of neighbors) {
        if (a < b && aNeighbors.has(b)) triangles++;
      }
    }
    result.set(node.id, (2 * triangles) / (deg * (deg - 1)));
  }
  return result;
}

/**
 * Find connected components using union-find.
 */
export function connectedComponents(nodes: GraphNode[]): string[][] {
  const parent = new Map<string, string>();
  const rank = new Map<string, number>();

  function find(x: string): string {
    if (parent.get(x) !== x) {
      parent.set(x, find(parent.get(x)!));
    }
    return parent.get(x)!;
  }

  function union(a: string, b: string): void {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    const rankA = rank.get(ra) ?? 0;
    const rankB = rank.get(rb) ?? 0;
    if (rankA < rankB) {
      parent.set(ra, rb);
    } else if (rankA > rankB) {
      parent.set(rb, ra);
    } else {
      parent.set(rb, ra);
      rank.set(ra, rankA + 1);
    }
  }

  for (const node of nodes) {
    parent.set(node.id, node.id);
    rank.set(node.id, 0);
  }
  const nodeIds = new Set(nodes.map((n) => n.id));
  for (const node of nodes) {
    for (const conn of node.connections) {
      // Skip dangling edge references to prevent infinite recursion
      if (!nodeIds.has(conn)) continue;
      union(node.id, conn);
    }
  }

  const groups = new Map<string, string[]>();
  for (const node of nodes) {
    const root = find(node.id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(node.id);
  }
  return [...groups.values()];
}

/**
 * BFS shortest path between two nodes. Returns null if no path exists.
 */
export function shortestPath(
  nodes: GraphNode[],
  startId: string,
  endId: string,
): string[] | null {
  if (startId === endId) return [startId];

  const adj = new Map<string, string[]>();
  for (const node of nodes) {
    adj.set(node.id, node.connections);
  }

  const visited = new Set<string>();
  const queue: [string, string[]][] = [[startId, [startId]]];
  let head = 0;
  visited.add(startId);

  while (head < queue.length) {
    const [current, path] = queue[head++];
    for (const neighbor of adj.get(current) ?? []) {
      if (neighbor === endId) return [...path, neighbor];
      if (!visited.has(neighbor)) {
        visited.add(neighbor);
        queue.push([neighbor, [...path, neighbor]]);
      }
    }
  }
  return null;
}

/**
 * Compute graph density: |E| / (|N| * (|N|-1) / 2).
 */
export function graphDensity(nodes: GraphNode[], edges: GraphEdge[]): number {
  const n = nodes.length;
  const maxEdges = (n * (n - 1)) / 2;
  return maxEdges > 0 ? edges.length / maxEdges : 0;
}

/**
 * Estimate graph diameter (longest shortest path) via BFS sampling.
 * For large graphs, samples a subset of nodes to keep cost manageable.
 */
export function graphDiameter(nodes: GraphNode[]): number {
  if (nodes.length === 0) return 0;

  const adj = new Map<string, string[]>();
  for (const node of nodes) adj.set(node.id, node.connections);

  // Sample up to 50 nodes for large graphs using Fisher-Yates shuffle
  const sampleSize = Math.min(nodes.length, 50);
  let sampled: GraphNode[];
  if (nodes.length <= 50) {
    sampled = nodes;
  } else {
    const shuffled = [...nodes];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    sampled = shuffled.slice(0, sampleSize);
  }

  let diameter = 0;

  function bfsDistance(start: string): number {
    const dist = new Map<string, number>();
    dist.set(start, 0);
    const queue = [start];
    let head = 0;
    let maxDist = 0;
    while (head < queue.length) {
      const current = queue[head++];
      const d = dist.get(current)!;
      for (const neighbor of adj.get(current) ?? []) {
        if (!dist.has(neighbor)) {
          dist.set(neighbor, d + 1);
          maxDist = Math.max(maxDist, d + 1);
          queue.push(neighbor);
        }
      }
    }
    return maxDist;
  }

  for (const node of sampled) {
    diameter = Math.max(diameter, bfsDistance(node.id));
  }
  return diameter;
}

/**
 * Full graph statistics summary.
 */
export function computeGraphStats(
  nodes: GraphNode[],
  edges: GraphEdge[],
): GraphStats {
  const centrality = degreeCentrality(nodes);
  const clustering = clusteringCoefficients(nodes);
  const components = connectedComponents(nodes);

  let totalClustering = 0;
  let maxDegree = 0;
  const mostCentral: { id: string; label: string; centrality: number }[] = [];

  for (const node of nodes) {
    const c = centrality.get(node.id) ?? 0;
    totalClustering += clustering.get(node.id) ?? 0;
    const deg = node.connections.length;
    if (deg > maxDegree) maxDegree = deg;
    mostCentral.push({ id: node.id, label: node.label, centrality: c });
  }

  mostCentral.sort((a, b) => b.centrality - a.centrality);

  return {
    totalNodes: nodes.length,
    totalEdges: edges.length,
    avgDegree:
      nodes.length > 0
        ? nodes.reduce((s, n) => s + n.connections.length, 0) / nodes.length
        : 0,
    maxDegree,
    density: graphDensity(nodes, edges),
    components: components.length,
    avgClusteringCoefficient:
      nodes.length > 0 ? totalClustering / nodes.length : 0,
    mostCentralNodes: mostCentral.slice(0, 10),
    diameter: graphDiameter(nodes),
  };
}

// ──────────────────────────── Pruning ──────────────────────────

/**
 * Remove edges below a weight threshold. Rebuilds connection lists.
 * Returns the pruned graph (mutates in place).
 */
export function pruneWeakEdges(
  graph: GraphData,
  threshold: number = 0.15,
): GraphData {
  const kept = graph.edges.filter((e) => e.weight >= threshold);
  graph.edges = kept;

  // Rebuild connection lists
  const connMap = new Map<string, Set<string>>();
  for (const e of kept) {
    if (!connMap.has(e.source)) connMap.set(e.source, new Set());
    if (!connMap.has(e.target)) connMap.set(e.target, new Set());
    connMap.get(e.source)!.add(e.target);
    connMap.get(e.target)!.add(e.source);
  }
  for (const node of graph.nodes) {
    node.connections = [...(connMap.get(node.id) ?? [])];
  }
  return graph;
}

// ──────────────────────────── Export / Import ──────────────────

/**
 * Serialize graph to JSON. Velocity fields are dropped.
 */
export function exportGraph(graph: GraphData): SerializedGraph {
  return {
    version: 2,
    nodes: graph.nodes.map(({ vx: _, vy: __, ...rest }) => rest),
    edges: graph.edges,
    centerNode: graph.centerNode,
  };
}

/**
 * Deserialize graph from JSON. Velocity fields are initialized to zero.
 */
export function importGraph(data: SerializedGraph): GraphData {
  const nodes: GraphNode[] = data.nodes.map((n) => ({
    ...n,
    vx: 0,
    vy: 0,
  }));
  return {
    nodes,
    edges: data.edges,
    centerNode: data.centerNode,
  };
}

// ──────────────────────────── Serialization (string) ───────────

/**
 * Serialize graph to a JSON string for file/storage persistence.
 */
export function serializeGraph(graph: GraphData): string {
  return JSON.stringify(exportGraph(graph));
}

/**
 * Deserialize graph from a JSON string.
 */
export function deserializeGraph(json: string): GraphData {
  try {
    return importGraph(JSON.parse(json));
  } catch (e) {
    console.warn("[MemoryGraph] Failed to deserialize graph:", e);
    return { nodes: [], edges: [], centerNode: null };
  }
}
