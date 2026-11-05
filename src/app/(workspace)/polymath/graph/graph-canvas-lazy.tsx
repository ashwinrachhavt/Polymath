"use client";

import dynamic from "next/dynamic";
import { Skeleton } from "@/components/ui/skeleton";
import type { GraphEdge, GraphNode } from "@/domains/knowledge/relations";

/*
 * Client bridge between the graph page's server render and the xyflow canvas:
 * the page (a server component) cannot host a next/dynamic with ssr:false
 * itself, and the flow library (~100 KB) has no business in the route's
 * first-load JS. The skeleton matches the Suspense fallback the page already
 * renders, so a slow canvas load swaps one placeholder for another, not for
 * layout.
 */

const GraphCanvas = dynamic(() => import("./graph-canvas").then((m) => m.GraphCanvas), {
  ssr: false,
  loading: () => <Skeleton className="h-[70vh] min-h-96 rounded-xl" />,
});

export function GraphCanvasLazy({ nodes, edges }: { nodes: GraphNode[]; edges: GraphEdge[] }) {
  return <GraphCanvas nodes={nodes} edges={edges} />;
}
