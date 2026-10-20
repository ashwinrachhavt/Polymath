"use client";

import dynamic from "next/dynamic";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle, DialogDescription, DialogTrigger } from "@/components/ui/dialog";
import { Screen, Panel, Empty } from "@/components/workspace/ui";
import { useWorkspace } from "@/components/workspace/workspace-provider";
import { ArtifactList, NewArtifact, RecordLinks } from "./artifact-controls";

const CanvasEditor = dynamic(() => import("./canvas-editor"), { ssr: false, loading: () => <p role="status" className="p-5 text-[13px] text-muted-foreground">Loading Excalidraw drawing tools…</p> });
export default function Canvas({ initialId }: { initialId?: string }) {
  const { state, updateArtifact, notify } = useWorkspace();
  const [id, setId] = useState(initialId || "");
  const [reload, setReload] = useState(0);
  const records = state.artifacts.filter((item) => item.kind === "canvas");
  const record = records.find((item) => item.id === id) || (!id ? records[0] : undefined);
  const versions = state.artifactVersions.filter((item) => item.artifactId === record?.id).sort((a, b) => b.version - a.version);
  return <Screen title="Canvas" description="Real Excalidraw drawings stored as canonical canvas artifacts. Explicit local checkpoints, linked notes and system-design templates; no AI, collaboration or external sharing." actions={<NewArtifact kind="canvas" label="New canvas" onCreated={(record) => setId(record.id)} />}><div className="grid gap-6 xl:grid-cols-[230px_minmax(0,1fr)]"><Panel title="Canvases"><ArtifactList records={records} selectedId={record?.id} onSelect={setId} /></Panel>{record ? <div className="space-y-6"><Panel title={record.title} actions={<Dialog><DialogTrigger asChild><Button variant="outline">History ({versions.length})</Button></DialogTrigger><DialogContent><DialogTitle>Canvas checkpoints</DialogTitle><DialogDescription>Restoring creates a new local revision and reloads the drawing. Unsaved canvas changes will be replaced.</DialogDescription><div className="max-h-72 space-y-3 overflow-y-auto">{versions.map((version) => <div key={version.id} className="flex items-center justify-between gap-2 text-[13px]"><span>{version.title} <span className="readout">v{version.version}</span></span><Button size="sm" variant="outline" onClick={() => { if (!window.confirm("Replace the working canvas with this checkpoint? Unsaved drawing changes will be lost.")) return; const restored = updateArtifact(record.id, { title: version.title, body: version.body }); if (!restored.ok || !restored.persisted) return; setReload((value) => value + 1); notify("Canvas checkpoint restored as a new local revision."); }}>Restore</Button></div>)}</div></DialogContent></Dialog>}><CanvasEditor key={`${record.id}-${reload}`} record={record} /></Panel><Panel title="Linked notes and evidence"><RecordLinks record={record} /></Panel></div> : <Empty title="Create a canvas" description="Start a local Excalidraw board. Draw freely or add a system-design or evidence-map template." />}</div></Screen>;
}
