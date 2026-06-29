import { useRef, useEffect, useState, useCallback } from "react";
import { buildMemoryGraph, hitTest, type GraphNode, type GraphData } from "@/lib/memoryGraph";
import { useSkillsMcp, useChat, useWorkspace } from "@/store/useAppStore";
import { loadGenePool } from "@/lib/genes";
import { getDb } from "@/lib/database";

const NODE_COLORS: Record<string, string> = {
  memory: "#4fc3f7",
  agent: "#ff8a65",
  skill: "#81c784",
  gene: "#ce93d8",
  project: "#ffd54f",
  tool: "#e57373",
};

export function MemoryGraph() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [graphData, setGraphData] = useState<GraphData | null>(null);
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [hoveredNode, setHoveredNode] = useState<GraphNode | null>(null);
  const [canvasSize, setCanvasSize] = useState({ width: 800, height: 500 });
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [panStart, setPanStart] = useState({ x: 0, y: 0 });

  // Responsive canvas sizing
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width > 0 && height > 0) {
          setCanvasSize({ width: Math.floor(width), height: Math.floor(height) });
        }
      }
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  // Build graph from live data
  useEffect(() => {
    let cancelled = false;
    const build = async () => {
      const { mcpServers } = useSkillsMcp.getState();
      const { chatSessions, sessionMessages } = useChat.getState();
      const genePool = loadGenePool();
      const { activeWorkspaceId, workspaces } = useWorkspace.getState();
      const ws = workspaces.find(w => w.id === activeWorkspaceId);

      // Collect memories from SQLite if available
      const memories: { id: string; summary: string; category: string; tags: string[]; tier: string }[] = [];
      try {
        if (ws && getDb()) {
          const { getAllMemories } = await import("@/lib/memoryStore");
          const dbMemories = await getAllMemories();
          for (const m of dbMemories) {
            memories.push({
              id: m.id,
              summary: m.summary,
              category: m.category,
              tags: m.tags,
              tier: m.tier,
            });
          }
        }
      } catch { /* memory store not initialized */ }

      // Collect memories from session messages (fallback + supplement)
      for (const session of chatSessions.slice(0, 30)) {
        const msgs = sessionMessages[session.id] || [];
        memories.push({
          id: `session-${session.id}`,
          summary: session.title || "Untitled session",
          category: "session",
          tags: [session.mode, session.agentName],
          tier: "medium",
        });
        // Extract file change memories
        for (const msg of msgs) {
          if (msg.fileChanges) {
            for (const fc of msg.fileChanges) {
              memories.push({
                id: `change-${fc.path}-${msg.id}`,
                summary: `${fc.action}: ${fc.path.split("/").pop()}`,
                category: "reference",
                tags: [fc.action],
                tier: "low",
              });
            }
          }
        }
      }

      // Add MCP server / tool nodes to memories
      for (const m of mcpServers) {
        memories.push({
          id: `mcp-${m.name}`,
          summary: m.name,
          category: "skill",
          tags: m.tools?.map(t => t.name) || [m.transport],
          tier: m.enabled ? "high" : "low",
        });
      }

      // Add built-in skills as nodes
      const { BUNDLED_SKILLS } = await import("@/lib/skills");
      for (const skill of BUNDLED_SKILLS) {
        memories.push({
          id: `skill-${skill.name}`,
          summary: skill.name,
          category: "skill",
          tags: ["bundled", skill.name],
          tier: "medium",
        });
      }

      // Add built-in agents as memories for richer graph
      const { ALL_AGENTS } = await import("@/lib/agents");
      for (const agent of ALL_AGENTS) {
        if (agent.mode === "subagent") {
          memories.push({
            id: `agentdef-${agent.name}`,
            summary: agent.name,
            category: "agent",
            tags: [agent.category, "subagent"],
            tier: "high",
          });
        }
      }

      if (cancelled) return;

      const data = buildMemoryGraph(
        memories.slice(0, 200),
        genePool.genes,
        chatSessions.slice(0, 30).map(s => ({
          id: s.id,
          title: s.title,
          agentName: s.agentName,
          messageCount: s.messageCount,
        }))
      );

      // Scale node positions to fit the canvas with minimum spread
      if (data.nodes.length > 0) {
        // If only 1-2 nodes, spread them out manually
        if (data.nodes.length === 1) {
          data.nodes[0].x = canvasSize.width / 2;
          data.nodes[0].y = canvasSize.height / 2;
        } else if (data.nodes.length === 2) {
          data.nodes[0].x = canvasSize.width * 0.35;
          data.nodes[0].y = canvasSize.height / 2;
          data.nodes[1].x = canvasSize.width * 0.65;
          data.nodes[1].y = canvasSize.height / 2;
        } else {
          let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
          for (const n of data.nodes) {
            if (n.x < minX) minX = n.x;
            if (n.x > maxX) maxX = n.x;
            if (n.y < minY) minY = n.y;
            if (n.y > maxY) maxY = n.y;
          }
          const rangeX = maxX - minX;
          const rangeY = maxY - minY;
          // Ensure minimum spread so nodes aren't all on top of each other
          const minSpread = 200;
          const effectiveRangeX = Math.max(rangeX, minSpread);
          const effectiveRangeY = Math.max(rangeY, minSpread);
          const padding = 80;
          const scaleX = (canvasSize.width - padding * 2) / effectiveRangeX;
          const scaleY = (canvasSize.height - padding * 2) / effectiveRangeY;
          const scale = Math.min(scaleX, scaleY, 3);
          // Center the graph
          const actualCenterX = (minX + maxX) / 2;
          const actualCenterY = (minY + maxY) / 2;
          const targetCenterX = canvasSize.width / 2;
          const targetCenterY = canvasSize.height / 2;
          for (const n of data.nodes) {
            n.x = (n.x - actualCenterX) * scale + targetCenterX;
            n.y = (n.y - actualCenterY) * scale + targetCenterY;
          }
        }
      }

      setGraphData(data);
    };
    build();
    return () => { cancelled = true; };
  }, [canvasSize]);

  // Render loop with pan and zoom
  useEffect(() => {
    if (!graphData) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Set actual pixel dimensions for crisp rendering
    const dpr = window.devicePixelRatio || 1;
    canvas.width = canvasSize.width * dpr;
    canvas.height = canvasSize.height * dpr;
    ctx.scale(dpr, dpr);

    const render = () => {
      const w = canvasSize.width;
      const h = canvasSize.height;
      ctx.clearRect(0, 0, w, h);

      ctx.save();
      ctx.translate(panOffset.x, panOffset.y);
      ctx.scale(zoom, zoom);

      // Pre-compute node map for O(1) edge lookups
      const nodeMap = new Map<string, GraphNode>();
      for (const n of graphData.nodes) nodeMap.set(n.id, n);

      // Draw edges with gradient
      for (const edge of graphData.edges) {
        const source = nodeMap.get(edge.source);
        const target = nodeMap.get(edge.target);
        if (!source || !target) continue;

        const grad = ctx.createLinearGradient(source.x, source.y, target.x, target.y);
        grad.addColorStop(0, source.color + "80");
        grad.addColorStop(1, target.color + "80");
        ctx.strokeStyle = grad;
        ctx.lineWidth = Math.max(0.5, edge.weight * 2);
        ctx.beginPath();
        ctx.moveTo(source.x, source.y);
        ctx.lineTo(target.x, target.y);
        ctx.stroke();
      }

      // Draw nodes
      for (const node of graphData.nodes) {
        const isHovered = hoveredNode?.id === node.id;
        const isSelected = selectedNode?.id === node.id;
        const baseSize = Math.max(4, Math.min(16, node.size));
        const size = isHovered || isSelected ? baseSize * 1.4 : baseSize;

        // Glow for selected/hovered
        if (isSelected || isHovered) {
          ctx.beginPath();
          ctx.arc(node.x, node.y, size + 4, 0, 2 * Math.PI);
          ctx.fillStyle = node.color + "30";
          ctx.fill();
        }

        // Node circle
        ctx.beginPath();
        ctx.arc(node.x, node.y, size, 0, 2 * Math.PI);
        ctx.fillStyle = node.color;
        ctx.fill();

        if (isSelected) {
          ctx.strokeStyle = "#fff";
          ctx.lineWidth = 2;
          ctx.stroke();
        }

        // Label (show for nodes with enough connections or when zoomed in)
        if (size > 4 || zoom > 1.2) {
          ctx.fillStyle = "rgba(255,255,255,0.75)";
          ctx.font = `${Math.max(8, 9 / zoom)}px -apple-system, sans-serif`;
          ctx.textAlign = "center";
          ctx.fillText(node.label.slice(0, 20), node.x, node.y + size + 12 / zoom);
        }
      }

      ctx.restore();
    };

    render();
  }, [graphData, hoveredNode, selectedNode, panOffset, zoom, canvasSize]);

  // Convert screen coords to graph coords
  const screenToGraph = useCallback((clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const x = (clientX - rect.left - panOffset.x) / zoom;
    const y = (clientY - rect.top - panOffset.y) / zoom;
    return { x, y };
  }, [panOffset, zoom]);

  // Mouse interaction — hover
  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (isDragging) {
      const dx = e.clientX - dragStart.x;
      const dy = e.clientY - dragStart.y;
      setPanOffset({ x: panStart.x + dx, y: panStart.y + dy });
      return;
    }
    if (!graphData) return;
    const { x, y } = screenToGraph(e.clientX, e.clientY);
    const node = hitTest(graphData.nodes, x, y);
    setHoveredNode(node);
  }, [graphData, isDragging, dragStart, panStart, screenToGraph]);

  // Mouse — click to select
  const handleClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!graphData) return;
    const { x, y } = screenToGraph(e.clientX, e.clientY);
    const node = hitTest(graphData.nodes, x, y);
    setSelectedNode(node);
  }, [graphData, screenToGraph]);

  // Mouse — drag to pan
  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (e.button === 1 || (e.button === 0 && e.altKey)) {
      // Middle click or Alt+click = pan
      e.preventDefault();
      setIsDragging(true);
      setDragStart({ x: e.clientX, y: e.clientY });
      setPanStart(panOffset);
    }
  }, [panOffset]);

  const handleMouseUp = useCallback(() => {
    setIsDragging(false);
  }, []);

  // Scroll to zoom
  const handleWheel = useCallback((e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    setZoom(z => Math.max(0.2, Math.min(5, z * delta)));
  }, []);

  // Reset view
  const handleReset = useCallback(() => {
    setPanOffset({ x: 0, y: 0 });
    setZoom(1);
    setSelectedNode(null);
  }, []);

  const legend = Object.entries(NODE_COLORS);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4 text-[10px] text-dalam-text-muted">
          {legend.map(([type, color]) => (
            <div key={type} className="flex items-center gap-1">
              <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: color }} />
              <span>{type}</span>
            </div>
          ))}
        </div>
        <div className="flex items-center gap-2 text-[10px] text-dalam-text-muted">
          {graphData && (
            <span>{graphData.nodes.length} nodes · {graphData.edges.length} edges</span>
          )}
          <button onClick={handleReset} className="px-2 py-0.5 rounded bg-dalam-bg-tertiary hover:bg-dalam-bg-hover transition-colors">
            Reset
          </button>
          <span className="opacity-50">Scroll to zoom · Alt+drag to pan</span>
        </div>
      </div>

      <div ref={containerRef} className="relative bg-dalam-bg-primary border border-dalam-border-primary rounded-xl overflow-hidden" style={{ height: "500px" }}>
        <canvas
          ref={canvasRef}
          width={canvasSize.width}
          height={canvasSize.height}
          className="w-full h-full cursor-crosshair"
          style={{ width: canvasSize.width, height: canvasSize.height }}
          onMouseMove={handleMouseMove}
          onClick={handleClick}
          onMouseDown={handleMouseDown}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
          onWheel={handleWheel}
        />

        {/* Empty state */}
        {graphData && graphData.nodes.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="text-center">
              <p className="text-sm text-dalam-text-muted">No data to visualize</p>
              <p className="text-xs text-dalam-text-muted/60 mt-1">Start a chat session to populate the graph</p>
            </div>
          </div>
        )}

        {/* Node detail panel */}
        {(selectedNode || hoveredNode) && (() => {
          const node = selectedNode || hoveredNode;
          if (!node) return null;
          return (
            <div className="absolute top-3 right-3 bg-dalam-bg-secondary/95 backdrop-blur-sm border border-dalam-border-primary rounded-lg p-3 shadow-xl min-w-[200px] max-w-[280px]">
              <div className="flex items-center gap-2 mb-2">
                <span className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: node.color }} />
                <div className="text-xs font-semibold text-dalam-text-primary truncate">{node.label}</div>
              </div>
              <div className="space-y-1 text-[10px] text-dalam-text-muted">
                <div className="flex justify-between">
                  <span>Type</span>
                  <span className="text-dalam-text-secondary">{node.type}</span>
                </div>
                <div className="flex justify-between">
                  <span>Connections</span>
                  <span className="text-dalam-text-secondary">{node.connections.length}</span>
                </div>
                <div className="flex justify-between">
                  <span>Size</span>
                  <span className="text-dalam-text-secondary">{node.size.toFixed(1)}</span>
                </div>
                {node.metadata && Object.keys(node.metadata).length > 0 && (
                  <div className="mt-2 pt-2 border-t border-dalam-border-primary/50 space-y-1">
                    {Object.entries(node.metadata).slice(0, 5).map(([k, v]) => (
                      <div key={k} className="flex justify-between gap-2">
                        <span className="truncate">{k}</span>
                        <span className="text-dalam-text-secondary truncate max-w-[120px]">{String(v)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          );
        })()}
      </div>
    </div>
  );
}
