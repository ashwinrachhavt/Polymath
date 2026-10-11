"use client";

import { useState } from "react";
import { MessageSquare, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Screen, Panel, Field, Status, Empty, Unavailable } from "@/components/workspace/ui";
import { useWorkspace } from "@/components/workspace/workspace-provider";
import { ArtifactLink } from "./artifact-controls";
import { useAlfredPreview } from "./preview-state";

export default function Chat({ initialId }: { initialId?: string }) {
  const { state, addArtifact, updateArtifact, notify } = useWorkspace();
  const preview = useAlfredPreview();
  const [dossierId, setDossierId] = useState(initialId || "dossier-axiom");
  const [question, setQuestion] = useState("");
  const [citations, setCitations] = useState(true);
  const [budget, setBudget] = useState("0.50");
  const contextRecords = state.artifacts;
  const contextRecord = contextRecords.find((item) => item.id === dossierId);
  const isDossier = contextRecord?.kind === "dossier";
  const pins = isDossier ? preview.state.pins[dossierId] || [] : contextRecord ? [{ id: contextRecord.id, title: contextRecord.title, body: contextRecord.body, version: contextRecord.version, at: contextRecord.updatedAt }] : [];
  const drafts = state.artifacts.filter((item) => item.tags.includes("Chat question"));
  return <Screen title="Ask Alfred" description="Prepare a source-grounded question with an explicit context and budget. There is no connected model or fabricated assistant response."><div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_340px]"><Panel title="Grounded conversation"><div className="mb-5 flex flex-wrap gap-2"><Status>Alfred</Status><Status>Model unconfigured</Status><Status>Tools disabled</Status></div><Empty title="No connected conversation" description="Save your question locally while the agent runtime is unconfigured. No message is sent and no run or response is simulated." /><form className="mt-6 space-y-4" onSubmit={(e) => { e.preventDefault(); const artifact = addArtifact(`Question: ${question.slice(0, 100)}`, "note", `Prepared question (not sent):\n${question}\n\nCitations required: ${citations ? "Yes" : "No"}\nBudget cap: $${budget}\n\nPinned context:\n${pins.map((pin) => `${pin.title} v${pin.version}\n${pin.body}`).join("\n\n") || "No pinned context."}`); if (artifact) { updateArtifact(artifact.id, { tags: ["Chat question"], links: [...new Set([dossierId, ...pins.map((pin) => pin.id)])].filter((id) => state.artifacts.some((item) => item.id === id)) }); setQuestion(""); notify("Question saved locally, not sent to Alfred."); } }}><Field label="Your question"><Textarea rows={5} value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="What do these sources support? What is still uncertain?" /></Field><div className="flex flex-wrap gap-2"><Button type="submit" variant="outline" disabled={!question.trim()}><Save aria-hidden />Save question locally</Button><Button disabled><MessageSquare aria-hidden />Send (not connected)</Button></div></form></Panel><Panel title="Captured context"><div className="space-y-4"><Field label="Context record"><select className="panel h-9 rounded-md px-3" value={dossierId} onChange={(e) => setDossierId(e.target.value)}>{contextRecords.map((item) => <option key={item.id} value={item.id}>{item.title} ({item.kind})</option>)}</select></Field><Field label="Maximum cost"><select className="panel h-9 rounded-md px-3" value={budget} onChange={(e) => setBudget(e.target.value)}>{["0.25", "0.50", "1.00", "2.00"].map((value) => <option key={value} value={value}>${value}</option>)}</select></Field><label className="flex min-h-8 items-center gap-2 text-[13px]"><input type="checkbox" checked={citations} onChange={(e) => setCitations(e.target.checked)} />Require source citations</label><div className="space-y-2">{pins.length ? pins.map((pin) => <div key={pin.id} className="border-b border-border py-2 text-[13px]"><p>{pin.title}</p><span className="readout text-xs text-muted-foreground">{isDossier ? "Pinned" : "Current context"} v{pin.version}</span></div>) : <p className="text-[13px] text-muted-foreground">No pinned source versions. Pin evidence in Dossiers first.</p>}</div><Unavailable feature="Agent runtime">No model, tools, checkpoint branching, streaming events or spend reservation is connected.</Unavailable></div></Panel></div><Panel title="Saved questions">{drafts.length ? drafts.map((item) => <div key={item.id} className="border-b border-border py-3 last:border-0"><ArtifactLink record={item} /></div>) : <Empty title="No saved questions" description="Write a question and preserve it as a canonical note before sending is available." />}</Panel></Screen>;
}
