"use client";

import { Select } from "@/components/ui/select";

import { useState } from "react";
import { Screen, Panel, Empty, Status, Field, SearchField } from "@/components/workspace/ui";
import { useWorkspace } from "@/components/workspace/workspace-provider";
import { ArtifactLink, RecordLinks } from "./artifact-controls";

export default function Graph({ initialId }: { initialId?: string }) {
  const { state } = useWorkspace();
  const [id, setId] = useState(initialId || "note-axiom");
  const [kind, setKind] = useState("all");
  const [query, setQuery] = useState("");
  const nodes = state.artifacts.filter((item) => (kind === "all" || item.kind === kind) && item.title.toLowerCase().includes(query.toLowerCase())).slice(0, 40);
  const points = nodes.map((item, index) => ({ item, x: 350 + Math.cos(index / Math.max(nodes.length, 1) * Math.PI * 2) * 245, y: 235 + Math.sin(index / Math.max(nodes.length, 1) * Math.PI * 2) * 165 }));
  const edges = points.flatMap((point) => point.item.links.map((target) => ({ from: point, to: points.find((node) => node.item.id === target) })).filter((edge) => edge.to));
  const selected = state.artifacts.find((item) => item.id === id);
  return <Screen title="Knowledge graph" description="Explicit canonical artifact links. This is not an AI-inferred semantic map. The list is a keyboard-accessible equivalent of the graph."><div className="flex flex-wrap items-end gap-4"><SearchField value={query} onChange={setQuery} placeholder="Find graph nodes" /><Field label="Artifact kind"><Select value={kind} onChange={(e) => setKind(e.target.value)}><option value="all">All artifacts</option>{["source", "document", "note", "zettel", "dossier", "canvas"].map((kind) => <option key={kind} value={kind}>{kind}</option>)}</Select></Field><Status>{nodes.length} visible nodes</Status><Status>{edges.length} visible links</Status></div><div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_320px]"><Panel title="Connections" description="Up to 40 matching nodes; filter to inspect a smaller neighborhood.">{nodes.length ? <><svg viewBox="0 0 700 470" className="w-full max-h-[32rem] text-muted-foreground" role="img" aria-label={`Graph showing ${nodes.length} artifacts and ${edges.length} explicit links. Select nodes using the list below.`}>{edges.map((edge) => edge.to && <line key={`${edge.from.item.id}-${edge.to.item.id}`} x1={edge.from.x} y1={edge.from.y} x2={edge.to.x} y2={edge.to.y} stroke="currentColor" strokeWidth={edge.from.item.id === id || edge.to.item.id === id ? 1.8 : 0.6} opacity={0.55} />)}{points.map((point) => <g key={point.item.id} onClick={() => setId(point.item.id)} className="cursor-pointer"><circle cx={point.x} cy={point.y} r={point.item.id === id ? 10 : 7} className={point.item.id === id ? "fill-primary" : "fill-foreground"} /><text x={point.x} y={point.y + 23} textAnchor="middle" fill="currentColor" fontSize="10">{point.item.title.slice(0, 29)}</text></g>)}</svg><div className="grid gap-1 border-t border-border pt-3 sm:grid-cols-2">{nodes.map((item) => <button type="button" aria-pressed={item.id === id} key={item.id} onClick={() => setId(item.id)} className="flex min-h-8 items-center justify-between gap-2 rounded-md px-2 text-left text-xs hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring aria-pressed:bg-muted"><span>{item.title}</span><span className="text-muted-foreground">{item.kind}</span></button>)}</div></> : <Empty title="No nodes match" description="Clear the search or select another artifact kind." />}</Panel>{selected ? <Panel title="Selected artifact"><ArtifactLink record={selected} /><div className="my-3"><Status>{selected.kind}</Status></div><RecordLinks record={selected} /></Panel> : <Empty title="Select a node" description="Inspect incoming and outgoing record links." />}</div></Screen>;
}
