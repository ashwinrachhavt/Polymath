"use client";

import { RELATION_EDGE_LABELS } from "@/domains/knowledge/relation-vocabulary";
import "@xyflow/react/dist/style.css";
import { Background, Controls, Handle, MarkerType, Position, ReactFlow, useEdgesState, useNodesState, type Connection, type Edge, type Node, type NodeProps } from "@xyflow/react";
import { useRouter } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import type { GraphEdge, GraphNode } from "@/domains/knowledge/relations";
import { combineCardsAction, linkCardsAction } from "./actions";

type CardData = { title: string; kind: string; excerpt: string | null; [key: string]: unknown };
type CardNode = Node<CardData, "card">;

function CardNodeView({ id, data, selected }: NodeProps<CardNode>) {
  return (
    <div className={`w-52 rounded-lg border bg-card px-3 py-2 text-left shadow-none transition-colors ${selected ? "border-foreground" : "border-border hover:border-muted-foreground"}`}>
      <Handle type="target" position={Position.Left} className="!size-2 !border-border !bg-muted-foreground" />
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{data.kind}</span>
        <a href={`/alfred/notebook?id=${id}`} className="nodrag text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">Open</a>
      </div>
      <p className="mt-0.5 line-clamp-2 text-[13px] font-medium leading-snug">{data.title}</p>
      {data.excerpt && <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{data.excerpt}</p>}
      <Handle type="source" position={Position.Right} className="!size-2 !border-border !bg-muted-foreground" />
    </div>
  );
}

const nodeTypes = { card: CardNodeView };

/* Connected cards sit side by side: walk each component breadth-first so a
 * linked pair lands in one row and its edge runs straight across. */
function layout(nodes: GraphNode[], edges: GraphEdge[]): CardNode[] {
  const near = new Map<string, string[]>(nodes.map((n) => [n.id, []]));
  for (const e of edges) { near.get(e.source)?.push(e.target); near.get(e.target)?.push(e.source); }
  const seen = new Set<string>();
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const cols = 5;
  const placed: CardNode[] = [];
  let slot = 0;
  for (const n of [...nodes].sort((a, b) => (near.get(b.id)?.length ?? 0) - (near.get(a.id)?.length ?? 0))) {
    if (seen.has(n.id)) continue;
    const group: GraphNode[] = [];
    const queue = [n.id];
    seen.add(n.id);
    while (queue.length) {
      const id = queue.shift()!;
      group.push(byId.get(id)!);
      for (const next of near.get(id) ?? []) if (!seen.has(next)) { seen.add(next); queue.push(next); }
    }
    // A linked group starts a fresh row when it would straddle one.
    if (group.length > 1 && group.length <= cols && slot % cols + group.length > cols) slot += cols - (slot % cols);
    for (const g of group) {
      placed.push({
        id: g.id,
        type: "card" as const,
        position: { x: (slot % cols) * 300, y: Math.floor(slot / cols) * 170 },
        data: { title: g.title, kind: g.kind, excerpt: g.excerpt },
      });
      slot += 1;
    }
  }
  return placed;
}



function toEdge(e: GraphEdge): Edge {
  const suggested = e.linkType === "semantic";
  const typed = RELATION_EDGE_LABELS[e.linkType];
  return {
    id: e.id,
    source: e.source,
    target: e.target,
    animated: false,
    label: suggested && e.score != null ? `${Math.round(e.score * 100)}%` : typed,
    labelStyle: { fontSize: 10, fill: "var(--muted-foreground)" },
    labelBgStyle: { fill: "var(--background)" },
    style: suggested ? { stroke: "var(--muted-foreground)", strokeDasharray: "5 4", strokeWidth: 1 } : { stroke: e.linkType === "contradicts" ? "var(--destructive)" : "var(--foreground)", strokeWidth: 1.5 },
    markerEnd: suggested ? undefined : { type: MarkerType.ArrowClosed, color: e.linkType === "contradicts" ? "var(--destructive)" : "var(--foreground)" },
  };
}

export function GraphCanvas({ nodes: initialNodes, edges: initialEdges }: { nodes: GraphNode[]; edges: GraphEdge[] }) {
  const router = useRouter();
  const [nodes, , onNodesChange] = useNodesState<CardNode>(useMemo(() => layout(initialNodes, initialEdges), [initialNodes, initialEdges]));
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(useMemo(() => initialEdges.map(toEdge), [initialEdges]));
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const selected = nodes.filter((n) => n.selected);

  const onConnect = useCallback(async (c: Connection) => {
    if (!c.source || !c.target || c.source === c.target) return;
    setError("");
    const tempId = `tmp-${c.source}-${c.target}`;
    setEdges((es) => [...es.filter((e) => !(e.source === c.source && e.target === c.target && e.style?.strokeDasharray)), toEdge({ id: tempId, source: c.source!, target: c.target!, linkType: "related", score: null })]);
    const result = await linkCardsAction({ artifactId: c.source, targetId: c.target });
    if (!result.ok) {
      setEdges((es) => es.filter((e) => e.id !== tempId));
      setError(result.error);
    } else {
      router.refresh();
    }
  }, [router, setEdges]);

  const combine = async () => {
    setBusy(true);
    setError("");
    const result = await combineCardsAction({ sourceIds: selected.map((n) => n.id), title: title || undefined, idempotencyKey: crypto.randomUUID() });
    setBusy(false);
    if (!result.ok) return setError(result.error);
    router.push(`/alfred/notebook?id=${result.id}`);
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex min-h-9 flex-wrap items-center gap-2 text-[13px]">
        {selected.length >= 2 ? (
          <>
            <span className="text-muted-foreground">{selected.length} selected</span>
            <input
              aria-label="Title for the combined zettel"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !busy) void combine(); }}
              placeholder={selected.map((n) => n.data.title).join(" + ").slice(0, 60)}
              className="h-8 w-72 max-w-full rounded-md border border-border bg-background px-2 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <Button size="sm" onClick={() => void combine()} disabled={busy}>{busy ? "Combining" : "Combine into new zettel"}</Button>
          </>
        ) : (
          <span className="text-muted-foreground">Shift-click or drag a box to select cards. Solid lines are links with their meaning; dashed lines are suggestions.</span>
        )}
        {error && <span role="alert" className="text-destructive">{error}</span>}
      </div>
      <div className="h-[70vh] min-h-96 overflow-hidden rounded-xl border border-border">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          fitView
          fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
          minZoom={0.2}
          selectionOnDrag
          panOnDrag={[1, 2]}
          multiSelectionKeyCode="Shift"
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={24} />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
    </div>
  );
}
