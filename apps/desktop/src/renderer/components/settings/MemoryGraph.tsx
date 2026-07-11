import { useRef, useEffect, useState, useCallback, useMemo } from "react";
import {
  buildMemoryGraph,
  hitTest,
  NODE_COLORS,
  type GraphNode,
  type GraphData,
} from "@/lib/memoryGraph";
import { useSkillsMcp, useChat, useWorkspace } from "@/store/useAppStore";
import { loadGenePool } from "@/lib/genes";
import { isDatabaseReady } from "@/lib/database";
import { BUNDLED_SKILLS } from "@/lib/skills";

export function MemoryGraph() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [graphData, setGraphData] = useState<GraphData | null>(null);
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [hoveredNode, setHoveredNode] = useState<GraphNode | null>(null);
  const [canvasSize, setCanvasSize] = useState({ width: 800, height: 500 });
  const [isDragging, setIsDragging] = useState(false);
  const [isDark, setIsDark] = useState(() =>
    document.documentElement.classList.contains("dark"),
  );

  // Refs for animation loop state (avoids tearing down RAF on hover/select)
  const panOffsetRef = useRef({ x: 0, y: 0 });
  const zoomRef = useRef(1);
  const dragStartRef = useRef({ x: 0, y: 0 });
  const panStartRef = useRef({ x: 0, y: 0 });
  const hoveredNodeRef = useRef<GraphNode | null>(null);
  const selectedNodeRef = useRef<GraphNode | null>(null);
  const animFrameRef = useRef<number>(0);
  const timeRef = useRef(0);

  // Sync hover/select to refs for animation loop
  useEffect(() => {
    hoveredNodeRef.current = hoveredNode;
  }, [hoveredNode]);
  useEffect(() => {
    selectedNodeRef.current = selectedNode;
  }, [selectedNode]);

  // Track theme changes
  useEffect(() => {
    const check = () =>
      setIsDark(document.documentElement.classList.contains("dark"));
    check();
    const observer = new MutationObserver(check);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => observer.disconnect();
  }, []);

  // Responsive canvas sizing
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width > 0 && height > 0) {
          setCanvasSize({
            width: Math.floor(width),
            height: Math.floor(height),
          });
        }
      }
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  // Pre-compute dot grid canvas (avoids O(N²) per-frame rendering)
  const gridPattern = useMemo(() => {
    const patternCanvas = document.createElement("canvas");
    const spacing = 40;
    patternCanvas.width = spacing;
    patternCanvas.height = spacing;
    const pctx = patternCanvas.getContext("2d");
    if (pctx) {
      pctx.fillStyle = isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.06)";
      pctx.beginPath();
      pctx.arc(spacing / 2, spacing / 2, 1, 0, 2 * Math.PI);
      pctx.fill();
    }
    return patternCanvas;
  }, [isDark]);

  // Build graph from live data (separated from resize rescaling)
  useEffect(() => {
    let cancelled = false;
    const build = async () => {
      const { mcpServers } = useSkillsMcp.getState();
      const { chatSessions, sessionMessages } = useChat.getState();
      const genePool = await loadGenePool();
      const { activeWorkspaceId, workspaces } = useWorkspace.getState();
      const ws = workspaces.find((w) => w.id === activeWorkspaceId);

      const memories: {
        id: string;
        summary: string;
        category: string;
        tags: string[];
        tier: string;
      }[] = [];
      if (ws && isDatabaseReady()) {
        try {
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
        } catch (e) {
          if (import.meta.env.DEV) console.warn("[MemoryGraph] Memory store not available:", e);
        }
      }

      for (const session of chatSessions.slice(0, 30)) {
        const msgs = sessionMessages[session.id] || [];
        memories.push({
          id: `session-${session.id}`,
          summary: session.title || "Untitled session",
          category: "session",
          tags: [session.mode, session.agentName],
          tier: "medium",
        });
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

      for (const m of mcpServers) {
        memories.push({
          id: `mcp-${m.name}`,
          summary: m.name,
          category: "skill",
          tags: (m.tools?.length ? m.tools.map((t) => t.name) : undefined) || [
            m.transport,
          ],
          tier: m.enabled ? "high" : "low",
        });
      }

      for (const skill of BUNDLED_SKILLS) {
        memories.push({
          id: `skill-${skill.name}`,
          summary: skill.name,
          category: "skill",
          tags: ["bundled", skill.name],
          tier: "medium",
        });
      }

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
        chatSessions.slice(0, 30).map((s) => ({
          id: s.id,
          title: s.title,
          agentName: s.agentName,
          messageCount: s.messageCount,
        })),
      );

      setGraphData(data);
    };
    void build();
    return () => {
      cancelled = true;
    };
  }, []); // Only build once on mount

  // Compute rescale transform for fitting graph to canvas (pure, no setState)
  const rescaleTransform = useMemo(() => {
    if (!graphData || graphData.nodes.length < 3)
      return { scale: 1, offsetX: 0, offsetY: 0 };
    let minX = Infinity,
      maxX = -Infinity,
      minY = Infinity,
      maxY = -Infinity;
    for (const n of graphData.nodes) {
      if (n.x < minX) minX = n.x;
      if (n.x > maxX) maxX = n.x;
      if (n.y < minY) minY = n.y;
      if (n.y > maxY) maxY = n.y;
    }
    const rangeX = Math.max(maxX - minX, 200);
    const rangeY = Math.max(maxY - minY, 200);
    const padding = 80;
    const scaleX = (canvasSize.width - padding * 2) / rangeX;
    const scaleY = (canvasSize.height - padding * 2) / rangeY;
    const scale = Math.min(scaleX, scaleY, 3);
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    return {
      scale,
      offsetX: canvasSize.width / 2 - centerX * scale,
      offsetY: canvasSize.height / 2 - centerY * scale,
    };
  }, [graphData, canvasSize]);

  // Render loop (stable — only restarts on graphData/isDark/canvasSize changes)
  useEffect(() => {
    if (!graphData) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let running = true;

    const renderFrame = (timestamp: number) => {
      if (!running) return;
      timeRef.current = timestamp * 0.001;

      const dpr = window.devicePixelRatio || 1;
      canvas.width = canvasSize.width * dpr;
      canvas.height = canvasSize.height * dpr;
      ctx.scale(dpr, dpr);

      const w = canvasSize.width;
      const h = canvasSize.height;
      const pan = panOffsetRef.current;
      const zoom = zoomRef.current;
      const t = timeRef.current;
      const hovered = hoveredNodeRef.current;
      const selected = selectedNodeRef.current;

      ctx.clearRect(0, 0, w, h);

      ctx.save();
      ctx.translate(pan.x, pan.y);
      ctx.scale(zoom, zoom);
      // Apply rescale transform to fit graph to canvas
      ctx.translate(rescaleTransform.offsetX, rescaleTransform.offsetY);
      ctx.scale(rescaleTransform.scale, rescaleTransform.scale);

      // Background dot grid (tiled from pre-rendered pattern)
      if (gridPattern.width > 0) {
        const pattern = ctx.createPattern(gridPattern, "repeat");
        if (pattern) {
          ctx.fillStyle = pattern;
          ctx.fillRect(
            -pan.x / zoom - 100,
            -pan.y / zoom - 100,
            w / zoom + 200,
            h / zoom + 200,
          );
        }
      }

      // Pre-compute node map
      const nodeMap = new Map<string, GraphNode>();
      for (const n of graphData.nodes) nodeMap.set(n.id, n);

      // Draw curved edges
      for (const edge of graphData.edges) {
        const source = nodeMap.get(edge.source);
        const target = nodeMap.get(edge.target);
        if (!source || !target) continue;

        const isHighlighted =
          selected &&
          (edge.source === selected.id || edge.target === selected.id);
        const isDimmed = selected && !isHighlighted;

        const midX = (source.x + target.x) / 2;
        const midY = (source.y + target.y) / 2;
        const dx = target.x - source.x;
        const dy = target.y - source.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const curveAmount = Math.min(dist * 0.15, 30);
        const nx = -dy / dist;
        const ny = dx / dist;
        const ctrlX = midX + nx * curveAmount;
        const ctrlY = midY + ny * curveAmount;

        const alpha = isDimmed ? "15" : isHighlighted ? "bb" : "44";
        const grad = ctx.createLinearGradient(
          source.x,
          source.y,
          target.x,
          target.y,
        );
        grad.addColorStop(0, source.color + alpha);
        grad.addColorStop(1, target.color + alpha);
        ctx.strokeStyle = grad;
        ctx.lineWidth = isDimmed
          ? 0.3
          : isHighlighted
            ? Math.max(1.5, edge.weight * 3)
            : Math.max(0.5, edge.weight * 1.5);
        ctx.lineCap = "round";

        ctx.beginPath();
        ctx.moveTo(source.x, source.y);
        ctx.quadraticCurveTo(ctrlX, ctrlY, target.x, target.y);
        ctx.stroke();

        // Animated pulse on highlighted edges
        if (isHighlighted && !isDimmed) {
          const pulseT = (t * 1.5) % 1;
          const pulseX = source.x + dx * pulseT;
          const pulseY = source.y + dy * pulseT;
          const pulseSize = 2 + Math.sin(pulseT * Math.PI) * 2;
          ctx.beginPath();
          ctx.arc(pulseX, pulseY, pulseSize, 0, 2 * Math.PI);
          ctx.fillStyle = source.color + "88";
          ctx.fill();
        }
      }

      // Draw nodes
      for (const node of graphData.nodes) {
        const isHovered = hovered?.id === node.id;
        const isSelected = selected?.id === node.id;
        const isConnected = selected?.connections?.includes(node.id) ?? false;
        const baseSize = Math.max(4, Math.min(16, node.size));
        const dimmed = selected && !isSelected && !isConnected;
        const size = isHovered || isSelected ? baseSize * 1.4 : baseSize;

        // Outer glow for high-connection nodes
        if (node.connections.length >= 3 && !dimmed) {
          const glowSize = size + 8 + Math.sin(t * 2 + node.x * 0.01) * 2;
          ctx.beginPath();
          ctx.arc(node.x, node.y, glowSize, 0, 2 * Math.PI);
          ctx.fillStyle = node.color + "10";
          ctx.fill();
        }

        // Glow for selected/hovered
        if (isSelected || isHovered) {
          ctx.beginPath();
          ctx.arc(node.x, node.y, size + 6, 0, 2 * Math.PI);
          ctx.fillStyle = node.color + "20";
          ctx.fill();
        }

        // Node with radial gradient
        const nodeGrad = ctx.createRadialGradient(
          node.x - size * 0.3,
          node.y - size * 0.3,
          0,
          node.x,
          node.y,
          size,
        );
        const baseColor = dimmed ? node.color + "40" : node.color;
        nodeGrad.addColorStop(
          0,
          dimmed ? node.color + "30" : node.color + "ee",
        );
        nodeGrad.addColorStop(1, baseColor);
        ctx.beginPath();
        ctx.arc(node.x, node.y, size, 0, 2 * Math.PI);
        ctx.fillStyle = nodeGrad;
        ctx.fill();

        if (isSelected) {
          ctx.strokeStyle = isDark ? "#fff" : "#333";
          ctx.lineWidth = 2.5;
          ctx.stroke();
        } else if (isHovered) {
          ctx.strokeStyle = isDark
            ? "rgba(255,255,255,0.5)"
            : "rgba(0,0,0,0.3)";
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }

        // Label
        if (size > 3 || zoom > 0.8) {
          const labelColor = dimmed
            ? isDark
              ? "rgba(255,255,255,0.3)"
              : "rgba(0,0,0,0.3)"
            : isDark
              ? "rgba(255,255,255,0.85)"
              : "rgba(0,0,0,0.8)";
          const outlineColor = dimmed
            ? "transparent"
            : isDark
              ? "rgba(0,0,0,0.6)"
              : "rgba(255,255,255,0.9)";
          const fontSize = Math.max(9, Math.min(12, 10 / zoom));
          ctx.font = `500 ${fontSize}px -apple-system, BlinkMacSystemFont, sans-serif`;
          ctx.textAlign = "center";
          const labelY = node.y + size + fontSize + 2;
          if (!dimmed) {
            ctx.strokeStyle = outlineColor;
            ctx.lineWidth = 3;
            ctx.lineJoin = "round";
            ctx.strokeText(node.label.slice(0, 22), node.x, labelY);
          }
          ctx.fillStyle = labelColor;
          ctx.fillText(node.label.slice(0, 22), node.x, labelY);
        }
      }

      ctx.restore();
      animFrameRef.current = requestAnimationFrame(renderFrame);
    };

    animFrameRef.current = requestAnimationFrame(renderFrame);
    return () => {
      running = false;
      cancelAnimationFrame(animFrameRef.current);
    };
  }, [graphData, canvasSize, isDark, gridPattern, rescaleTransform]);

  // Convert screen coords to graph coords
  const screenToGraph = useCallback((clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const pan = panOffsetRef.current;
    const zoom = zoomRef.current;
    return {
      x: (clientX - rect.left - pan.x) / zoom,
      y: (clientY - rect.top - pan.y) / zoom,
    };
  }, []);

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (isDragging) {
        const dx = e.clientX - dragStartRef.current.x;
        const dy = e.clientY - dragStartRef.current.y;
        panOffsetRef.current = {
          x: panStartRef.current.x + dx,
          y: panStartRef.current.y + dy,
        };
        return;
      }
      if (!graphData) return;
      const { x, y } = screenToGraph(e.clientX, e.clientY);
      setHoveredNode(hitTest(graphData.nodes, x, y));
    },
    [graphData, isDragging, screenToGraph],
  );

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (!graphData) return;
      const { x, y } = screenToGraph(e.clientX, e.clientY);
      setSelectedNode(hitTest(graphData.nodes, x, y));
    },
    [graphData, screenToGraph],
  );

  const handleDoubleClick = useCallback(() => {
    panOffsetRef.current = { x: 0, y: 0 };
    zoomRef.current = 1;
    setSelectedNode(null);
  }, []);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (e.button === 1 || e.button === 0) {
        const { x, y } = screenToGraph(e.clientX, e.clientY);
        const node = graphData ? hitTest(graphData.nodes, x, y) : null;
        if (node && e.button === 0) return;
        e.preventDefault();
        setIsDragging(true);
        dragStartRef.current = { x: e.clientX, y: e.clientY };
        panStartRef.current = { ...panOffsetRef.current };
      }
    },
    [graphData, screenToGraph],
  );

  const handleMouseUp = useCallback(() => setIsDragging(false), []);

  const handleWheel = useCallback((e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;
      const oldZoom = zoomRef.current;
      const newZoom = Math.max(
        0.2,
        Math.min(5, oldZoom * (e.deltaY > 0 ? 0.9 : 1.1)),
      );
      const pan = panOffsetRef.current;
      zoomRef.current = newZoom;
      panOffsetRef.current = {
        x: mouseX - (mouseX - pan.x) * (newZoom / oldZoom),
        y: mouseY - (mouseY - pan.y) * (newZoom / oldZoom),
      };
    } else {
      const pan = panOffsetRef.current;
      panOffsetRef.current = { x: pan.x - e.deltaX, y: pan.y - e.deltaY };
    }
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSelectedNode(null);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const handleReset = useCallback(() => {
    panOffsetRef.current = { x: 0, y: 0 };
    zoomRef.current = 1;
    setSelectedNode(null);
  }, []);

  const legend = Object.entries(NODE_COLORS);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4 text-[10px] text-dalam-text-muted">
          {legend.map(([type, color]) => (
            <div key={type} className="flex items-center gap-1">
              <span
                className="w-2.5 h-2.5 rounded-full"
                style={{ backgroundColor: color }}
              />
              <span>{type}</span>
            </div>
          ))}
        </div>
        <div className="flex items-center gap-2 text-[10px] text-dalam-text-muted">
          {graphData && (
            <span>
              {graphData.nodes.length} nodes · {graphData.edges.length} edges
            </span>
          )}
          <button
            onClick={handleReset}
            className="px-2 py-0.5 rounded bg-dalam-bg-tertiary hover:bg-dalam-bg-hover transition-colors"
          >
            Reset
          </button>
          <span className="opacity-50">
            Scroll to pan · Ctrl+scroll to zoom · Double-click to reset
          </span>
        </div>
      </div>

      <div
        ref={containerRef}
        className="relative bg-dalam-bg-primary border border-dalam-border-primary rounded-xl overflow-hidden"
        style={{ height: "500px" }}
      >
        <canvas
          ref={canvasRef}
          width={canvasSize.width}
          height={canvasSize.height}
          className={`w-full h-full ${isDragging ? "cursor-grabbing" : "cursor-grab"}`}
          style={{ width: canvasSize.width, height: canvasSize.height }}
          onMouseMove={handleMouseMove}
          onClick={handleClick}
          onDoubleClick={handleDoubleClick}
          onMouseDown={handleMouseDown}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
          onWheel={handleWheel}
        />

        {graphData && graphData.nodes.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="text-center">
              <p className="text-sm text-dalam-text-muted">
                No data to visualize
              </p>
              <p className="text-xs text-dalam-text-muted/60 mt-1">
                Start a chat session to populate the graph
              </p>
            </div>
          </div>
        )}

        {(selectedNode || hoveredNode) &&
          (() => {
            const node = selectedNode || hoveredNode;
            if (!node) return null;
            return (
              <div className="absolute top-3 right-3 bg-dalam-bg-secondary/95 backdrop-blur-sm border border-dalam-border-primary rounded-lg p-3 shadow-xl min-w-[200px] max-w-[280px]">
                <div className="flex items-center gap-2 mb-2">
                  <span
                    className="w-3 h-3 rounded-full flex-shrink-0"
                    style={{ backgroundColor: node.color }}
                  />
                  <div className="text-xs font-semibold text-dalam-text-primary truncate">
                    {node.label}
                  </div>
                </div>
                <div className="space-y-1 text-[10px] text-dalam-text-muted">
                  <div className="flex justify-between">
                    <span>Type</span>
                    <span className="text-dalam-text-secondary">
                      {node.type}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span>Connections</span>
                    <span className="text-dalam-text-secondary">
                      {node.connections.length}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span>Size</span>
                    <span className="text-dalam-text-secondary">
                      {node.size.toFixed(1)}
                    </span>
                  </div>
                  {node.metadata && Object.keys(node.metadata).length > 0 && (
                    <div className="mt-2 pt-2 border-t border-dalam-border-primary/50 space-y-1">
                      {Object.entries(node.metadata)
                        .slice(0, 5)
                        .map(([k, v]) => (
                          <div key={k} className="flex justify-between gap-2">
                            <span className="truncate">{k}</span>
                            <span className="text-dalam-text-secondary truncate max-w-[120px]">
                              {String(v)}
                            </span>
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
