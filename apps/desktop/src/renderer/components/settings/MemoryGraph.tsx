import { useRef, useEffect, useState, useCallback } from "react";
import { buildMemoryGraph, hitTest, type GraphNode, type GraphData } from "@/lib/memoryGraph";
import { useSkillsMcp, useChat } from "@/store/useAppStore";
import { loadGenePool } from "@/lib/genes";

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
  const [graphData, setGraphData] = useState<GraphData | null>(null);
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [hoveredNode, setHoveredNode] = useState<GraphNode | null>(null);
  const animFrameRef = useRef<number>(0);

  // Build graph from live data
  useEffect(() => {
    const { mcpServers } = useSkillsMcp.getState();
    const { chatSessions, sessionMessages } = useChat.getState();
    const genePool = loadGenePool();

    // Collect memories from session messages
    const memories: { id: string; summary: string; category: string; tags: string[]; tier: string }[] = [];
    for (const session of chatSessions.slice(0, 20)) {
      const msgs = sessionMessages[session.id] || [];
      const toolResults = msgs.filter(m => m.content.startsWith("[TOOL RESULT:"));
      if (toolResults.length > 0) {
        memories.push({
          id: session.id,
          summary: session.title,
          category: session.agentName,
          tags: [session.mode, session.agentName],
          tier: "medium",
        });
      }
    }

    // Add skill nodes
    const skillNodes = mcpServers.filter(m => m.tools && m.tools.length > 0).map((m, i) => ({
      id: `skill-${i}`,
      summary: m.name,
      category: m.transport,
      tags: m.tools?.map(t => t.name) || [],
      tier: "medium",
    }));

    const data = buildMemoryGraph(
      [...memories, ...skillNodes],
      genePool.genes,
      chatSessions.slice(0, 20).map(s => ({
        id: s.id,
        title: s.title,
        agentName: s.agentName,
        messageCount: s.messageCount,
      }))
    );

    setGraphData(data);
  }, []);

  // Render loop
  useEffect(() => {
    if (!graphData) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const render = () => {
      const w = canvas.width;
      const h = canvas.height;
      ctx.clearRect(0, 0, w, h);

      // Draw edges
      ctx.strokeStyle = "rgba(100, 100, 120, 0.3)";
      ctx.lineWidth = 0.5;
      for (const edge of graphData.edges) {
        const source = graphData.nodes.find(n => n.id === edge.source);
        const target = graphData.nodes.find(n => n.id === edge.target);
        if (!source || !target) continue;
        ctx.beginPath();
        ctx.moveTo(source.x, source.y);
        ctx.lineTo(target.x, target.y);
        ctx.stroke();
      }

      // Draw nodes
      for (const node of graphData.nodes) {
        const isHovered = hoveredNode?.id === node.id;
        const isSelected = selectedNode?.id === node.id;
        const size = isHovered || isSelected ? node.size * 1.3 : node.size;

        ctx.beginPath();
        ctx.arc(node.x, node.y, size, 0, 2 * Math.PI);
        ctx.fillStyle = node.color;
        ctx.fill();

        if (isSelected) {
          ctx.strokeStyle = "#fff";
          ctx.lineWidth = 2;
          ctx.stroke();
        }

        // Label
        if (size > 6) {
          ctx.fillStyle = "rgba(255,255,255,0.8)";
          ctx.font = "9px sans-serif";
          ctx.textAlign = "center";
          ctx.fillText(node.label, node.x, node.y + size + 10);
        }
      }
    };

    render();
    return () => cancelAnimationFrame(animFrameRef.current);
  }, [graphData, hoveredNode, selectedNode]);

  // Mouse interaction
  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas || !graphData) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const node = hitTest(graphData.nodes, x, y);
    setHoveredNode(node);
  }, [graphData]);

  const handleClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas || !graphData) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const node = hitTest(graphData.nodes, x, y);
    setSelectedNode(node);
  }, [graphData]);

  // Legend
  const legend = Object.entries(NODE_COLORS);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-4 text-[10px] text-acode-text-muted">
        {legend.map(([type, color]) => (
          <div key={type} className="flex items-center gap-1">
            <span className="w-3 h-3 rounded-full" style={{ backgroundColor: color }} />
            <span>{type}</span>
          </div>
        ))}
      </div>

      <div className="relative bg-acode-bg-primary border border-acode-border-primary rounded-xl overflow-hidden">
        <canvas
          ref={canvasRef}
          width={620}
          height={500}
          className="w-full cursor-crosshair"
          onMouseMove={handleMouseMove}
          onClick={handleClick}
        />

        {/* Node detail panel */}
        {(selectedNode || hoveredNode) && (
          <div className="absolute top-2 right-2 bg-acode-bg-secondary border border-acode-border-primary rounded-lg p-3 shadow-lg min-w-[180px]">
            <div className="text-xs font-medium text-acode-text-primary mb-1">
              {selectedNode?.label || hoveredNode?.label}
            </div>
            <div className="text-[10px] text-acode-text-muted">
              Type: {selectedNode?.type || hoveredNode?.type}
            </div>
            {(selectedNode?.metadata || hoveredNode?.metadata) && (
              <div className="text-[10px] text-acode-text-muted mt-1 space-y-0.5">
                {Object.entries(selectedNode?.metadata || hoveredNode?.metadata || {}).map(([k, v]) => (
                  <div key={k}>{k}: {String(v)}</div>
                ))}
              </div>
            )}
            <div className="text-[10px] text-acode-text-muted mt-1">
              Connections: {selectedNode?.connections.length || hoveredNode?.connections.length || 0}
            </div>
          </div>
        )}
      </div>

      {graphData && (
        <div className="text-[10px] text-acode-text-muted text-center">
          {graphData.nodes.length} nodes · {graphData.edges.length} connections
        </div>
      )}
    </div>
  );
}
