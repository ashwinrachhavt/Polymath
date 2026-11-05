"use client";

import { RELATION_EDGE_LABELS } from "@/domains/knowledge/relation-vocabulary";
import "@xyflow/react/dist/style.css";
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import type { GraphEdge, GraphNode } from "@/domains/knowledge/relations";
import { combineCardsAction, linkCardsAction } from "./actions";

type CardData = { title: string; kind: string; excerpt: string | null; [key: string]: unknown };
type CardNode = Node<CardData, "card">;

/* The crucible: cards picked for connect/mix. Ephemeral client state (spec:
 * no persistence — the selection dies with the page, like Alfred's did). */
type CrucibleState = { ids: string[]; title: string; open: boolean };

const noCrucible = { ids: new Set<string>(), toggle: () => {} };
const CrucibleContext = createContext<{ ids: ReadonlySet<string>; toggle: (id: string) => void }>(noCrucible);

function CardNodeView({ id, data, selected }: NodeProps<CardNode>) {
  const crucible = useContext(CrucibleContext);
  const inCrucible = crucible.ids.has(id);
  return (
    <div
      className={`w-52 rounded-lg border bg-card px-3 py-2 text-left shadow-none transition-colors ${
        inCrucible ? "border-signal" : selected ? "border-foreground" : "border-border hover:border-muted-foreground"
      }`}
    >
      <Handle type="target" position={Position.Left} className="!size-2 !border-border !bg-muted-foreground" />
      <div className="flex items-center justify-between gap-2">
        <span className="text-data text-muted-foreground">{data.kind}</span>
        <span className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => crucible.toggle(id)}
            aria-pressed={inCrucible}
            aria-label={`${inCrucible ? "Remove" : "Add"} ${data.title} ${inCrucible ? "from" : "to"} the crucible`}
            className={`nodrag size-5 rounded-sm border text-xs leading-none ${
              inCrucible
                ? "border-transparent bg-signal text-signal-ink"
                : "border-border bg-background text-muted-foreground hover:border-foreground hover:text-foreground"
            }`}
          >
            {inCrucible ? "✓" : "+"}
          </button>
          <a
            href={`/polymath/notes?id=${id}`}
            className="nodrag text-data text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          >
            Open
          </a>
        </span>
      </div>
      <p className="mt-0.5 line-clamp-2 text-body-dense font-medium leading-snug">{data.title}</p>
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
  for (const e of edges) {
    near.get(e.source)?.push(e.target);
    near.get(e.target)?.push(e.source);
  }
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
      for (const next of near.get(id) ?? [])
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
    }
    // A linked group starts a fresh row when it would straddle one.
    if (group.length > 1 && group.length <= cols && (slot % cols) + group.length > cols) slot += cols - (slot % cols);
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
    style: suggested
      ? { stroke: "var(--muted-foreground)", strokeDasharray: "5 4", strokeWidth: 1 }
      : { stroke: e.linkType === "contradicts" ? "var(--destructive)" : "var(--foreground)", strokeWidth: 1.5 },
    markerEnd: suggested
      ? undefined
      : {
          type: MarkerType.ArrowClosed,
          color: e.linkType === "contradicts" ? "var(--destructive)" : "var(--foreground)",
        },
  };
}

/* A mixed card lands just below-right of its parents' centroid: close enough
 * to read as their child, not covering any of them. */
function mixPosition(nodes: CardNode[], sourceIds: string[]): { x: number; y: number } {
  const src = nodes.filter((n) => sourceIds.includes(n.id));
  if (!src.length) return { x: 120, y: 120 };
  const x = src.reduce((sum, n) => sum + n.position.x, 0) / src.length + 60;
  const y = src.reduce((sum, n) => sum + n.position.y, 0) / src.length + 60;
  return { x, y };
}

export function GraphCanvas({ nodes: initialNodes, edges: initialEdges }: { nodes: GraphNode[]; edges: GraphEdge[] }) {
  const router = useRouter();
  const [nodes, setNodes, onNodesChange] = useNodesState<CardNode>(
    useMemo(() => layout(initialNodes, initialEdges), [initialNodes, initialEdges]),
  );
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(useMemo(() => initialEdges.map(toEdge), [initialEdges]));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [crucible, setCrucible] = useState<CrucibleState>({ ids: [], title: "", open: false });
  const crucibleIds = useMemo(() => new Set(crucible.ids), [crucible.ids]);
  // Open the panel on the first add so the user sees where the card went;
  // later adds and removals keep whatever openness the user chose.
  const toggleCrucible = useCallback((id: string) => {
    setCrucible((c) => {
      const adding = !c.ids.includes(id);
      return {
        ...c,
        ids: adding ? [...c.ids, id] : c.ids.filter((x) => x !== id),
        open: adding && c.ids.length === 0 ? true : c.open,
      };
    });
  }, []);
  const crucibleValue = useMemo(() => ({ ids: crucibleIds, toggle: toggleCrucible }), [crucibleIds, toggleCrucible]);

  /* One pair tie, optimistic temp edge with rollback; the drag handler and the
   * crucible panel both go through here. Returns false (and leaves the error)
   * so batch callers can decide what a partial failure means. */
  const linkPair = useCallback(
    async (source: string, target: string): Promise<boolean> => {
      const tempId = `tmp-${source}-${target}`;
      setEdges((es) => [
        ...es.filter((e) => !(e.source === source && e.target === target && e.style?.strokeDasharray)),
        toEdge({ id: tempId, source, target, linkType: "related", score: null }),
      ]);
      const result = await linkCardsAction({ artifactId: source, targetId: target });
      if (!result.ok) {
        setEdges((es) => es.filter((e) => e.id !== tempId));
        setError(result.error);
        return false;
      }
      return true;
    },
    [setEdges],
  );

  const onConnect = useCallback(
    async (c: Connection) => {
      if (!c.source || !c.target || c.source === c.target) return;
      setError("");
      if (await linkPair(c.source, c.target)) router.refresh();
    },
    [linkPair, router],
  );

  /* Alfred's CONNECT: every unique pair in the crucible, pairwise. Failed
   * pairs roll back their own temp edge; successful ones stay as the visible
   * edge for the session (the real row exists behind them). */
  const connectCrucible = async () => {
    if (crucible.ids.length < 2) return;
    setBusy(true);
    setError("");
    const pairs: [string, string][] = [];
    for (let i = 0; i < crucible.ids.length; i++)
      for (let j = i + 1; j < crucible.ids.length; j++) pairs.push([crucible.ids[i], crucible.ids[j]]);
    const results = await Promise.all(pairs.map(([a, b]) => linkPair(a, b)));
    setBusy(false);
    if (results.every(Boolean)) router.refresh();
  };

  /* Alfred's MIX: synthesize the crucible into a new card and keep playing —
   * the synthesis lands on the canvas as a selected node, crucible cleared,
   * no redirect. Data in hand + the action's id are enough to draw it; the
   * server revalidation already happened inside the action. */
  const mix = async () => {
    if (crucible.ids.length < 2) return;
    setBusy(true);
    setError("");
    const result = await combineCardsAction({
      sourceIds: crucible.ids,
      title: crucible.title || undefined,
      idempotencyKey: crypto.randomUUID(),
    });
    if (!result.ok) {
      setBusy(false);
      return setError(result.error);
    }
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const sources = crucible.ids.map((id) => byId.get(id)).filter((n) => n != null);
    const mixedTitle = crucible.title || sources.map((n) => n.data.title).join(" + ");
    setNodes((ns) => [
      ...ns.map((n) => ({ ...n, selected: false })),
      {
        id: result.id,
        type: "card" as const,
        position: mixPosition(ns, crucible.ids),
        data: { title: mixedTitle, kind: "zettel", excerpt: null },
        selected: true,
      },
    ]);
    // synthesizeZettel wrote one `source` edge per parent; draw them now so
    // the session already looks like the data.
    setEdges((es) => [
      ...es,
      ...crucible.ids.map((parentId) =>
        toEdge({
          id: `tmp-${result.id}-source-${parentId}`,
          source: result.id,
          target: parentId,
          linkType: "source",
          score: null,
        }),
      ),
    ]);
    setBusy(false);
    setCrucible({ ids: [], title: "", open: false });
  };

  const crucibleCards = crucible.ids.map((id) => nodes.find((n) => n.id === id)).filter((n) => n != null);
  const placeholder = crucibleCards
    .map((n) => n.data.title)
    .join(" + ")
    .slice(0, 60);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex min-h-9 flex-wrap items-center gap-2 text-body-dense">
        <span className="text-muted-foreground">
          Use the + on a card to put it in the crucible, drag between two cards to tie them. Solid lines are links with
          their meaning; dashed lines are suggestions.
        </span>
        {error && (
          <span role="alert" className="text-destructive">
            {error}
          </span>
        )}
      </div>
      <div className="relative h-[70vh] min-h-96 overflow-hidden rounded-xl border border-border">
        {crucible.ids.length > 0 && (
          <div className="absolute right-3 top-3 z-10 w-72">
            <button
              type="button"
              onClick={() => setCrucible((c) => ({ ...c, open: !c.open }))}
              aria-expanded={crucible.open}
              className="flex w-full items-center justify-between gap-2 rounded-lg border border-border bg-card px-3 py-1.5 text-body-dense shadow-sm hover:border-muted-foreground"
            >
              <span>Crucible · {crucible.ids.length} selected</span>
              <span aria-hidden className="text-muted-foreground">
                {crucible.open ? "▾" : "▸"}
              </span>
            </button>
            {crucible.open && (
              <div className="mt-2 rounded-lg border border-border bg-card p-3 shadow-lg">
                <ul className="max-h-40 space-y-1 overflow-y-auto text-body-dense">
                  {crucibleCards.map((n) => (
                    <li key={n.id}>
                      <button
                        type="button"
                        onClick={() => toggleCrucible(n.id)}
                        aria-label={`Remove ${n.data.title} from the crucible`}
                        className="line-clamp-1 w-full text-left text-muted-foreground hover:text-foreground"
                      >
                        {n.data.title}
                      </button>
                    </li>
                  ))}
                </ul>
                <input
                  aria-label="New idea title"
                  value={crucible.title}
                  onChange={(e) => setCrucible((c) => ({ ...c, title: e.target.value }))}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !busy && crucible.ids.length >= 2) void mix();
                  }}
                  placeholder={placeholder}
                  className="mt-2 h-8 w-full rounded-md border border-border bg-background px-2 text-body-dense outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
                <div className="mt-2 flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void connectCrucible()}
                    disabled={busy || crucible.ids.length < 2}
                  >
                    Connect
                  </Button>
                  <Button size="sm" onClick={() => void mix()} disabled={busy || crucible.ids.length < 2}>
                    {busy ? "Mixing" : "Mix"}
                  </Button>
                </div>
                {crucible.ids.length < 2 && (
                  <p className="mt-2 text-xs text-muted-foreground">Add at least two cards to connect or mix.</p>
                )}
              </div>
            )}
          </div>
        )}
        <CrucibleContext.Provider value={crucibleValue}>
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
        </CrucibleContext.Provider>
      </div>
    </div>
  );
}
