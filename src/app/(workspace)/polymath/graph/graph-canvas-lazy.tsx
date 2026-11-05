"use client";

import dynamic from "next/dynamic";
import type { GraphEdge, GraphNode } from "@/domains/knowledge/relations";

/* The alchemy canvas mounts client-only (pattern: canvas.tsx:11): @xyflow is
 * heavy and interactive — keep it out of the route's initial bundle. */
const GraphCanvas = dynamic(() => import("./graph-canvas").then((m) => m.GraphCanvas), {
  ssr: false,
  loading: () => (
    <p role="status" className="p-5 text-body-dense text-muted-foreground">
      Loading the alchemy canvas…
    </p>
  ),
});

export function GraphCanvasLazy({ nodes, edges }: { nodes: GraphNode[]; edges: GraphEdge[] }) {
  return <GraphCanvas nodes={nodes} edges={edges} />;
}
