"use client";

import { useState } from "react";
import Link from "next/link";
import { FileText, ListChecks, BookOpen, CalendarRange, Network, Layers3, GraduationCap, Headphones, Video, Image, Presentation, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Screen, Panel, Field, Empty, Status, Unavailable } from "@/components/workspace/ui";
import { useWorkspace } from "@/components/workspace/workspace-provider";
import { ArtifactLink } from "./artifact-controls";
import { useAlfredPreview } from "./preview-state";
import PromptTemplates from "./prompt-templates";

const types = [
  { id: "briefing", label: "Briefing", description: "A concise synthesis with source-backed findings.", icon: FileText },
  { id: "faq", label: "FAQ", description: "Questions and answers, grounded in the dossier.", icon: ListChecks },
  { id: "study_guide", label: "Study guide", description: "Concepts, explanations and practice prompts.", icon: BookOpen },
  { id: "timeline", label: "Timeline", description: "Events ordered by date with evidence references.", icon: CalendarRange },
  { id: "mind_map", label: "Mind map", description: "A structured map of connected concepts.", icon: Network },
  { id: "flashcards", label: "Flashcards", description: "Question and answer pairs for recall.", icon: Layers3 },
  { id: "quiz", label: "Quiz", description: "Questions, choices and sourced explanations.", icon: GraduationCap },
  { id: "audio_overview", label: "Audio overview", description: "A script and narration derived from your sources.", icon: Headphones },
  { id: "video_overview", label: "Video overview", description: "A visual overview with grounded narration.", icon: Video },
  { id: "infographic", label: "Infographic", description: "A visual summary of supported findings.", icon: Image },
  { id: "slide_deck", label: "Slide deck", description: "An outline and slides tied to source evidence.", icon: Presentation },
];
export default function Studio({ initialId }: { initialId?: string }) {
  const { state, addArtifact, updateArtifact, notify } = useWorkspace();
  const preview = useAlfredPreview();
  const [dossierId, setDossierId] = useState(initialId || "dossier-axiom");
  const [type, setType] = useState("briefing");
  const [instructions, setInstructions] = useState("");
  const [selectedPins, setSelectedPins] = useState<string[] | null>(null);
  const dossiers = state.artifacts.filter((item) => item.kind === "dossier");
  const dossier = dossiers.find((item) => item.id === dossierId);
  const pins = preview.state.pins[dossierId] || [];
  const enabled = selectedPins === null ? pins : pins.filter((item) => selectedPins.includes(item.id));
  const selected = types.find((item) => item.id === type) || types[0];
  const briefs = state.artifacts.filter((item) => item.tags.includes("Studio brief") && item.links.includes(dossierId));
  return <Screen title="Studio" description="Prepare grounded generation requests across all eleven donor artifact types. Saved briefs are your instructions, not generated output."><div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]"><Panel title="Choose an artifact type"><div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{types.map(({ id, label, description, icon: Icon }) => <button type="button" key={id} onClick={() => setType(id)} aria-pressed={type === id} className="panel rounded-lg p-4 text-left hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring aria-pressed:bg-muted"><div className="flex items-center gap-2 text-[13px] font-medium"><Icon aria-hidden className="size-4 text-muted-foreground" />{label}</div><p className="mt-2 text-xs leading-relaxed text-muted-foreground">{description}</p></button>)}</div></Panel><Panel title="Generation brief" description={selected.description}><div className="space-y-4"><Field label="Dossier"><select className="panel h-9 rounded-md px-3" value={dossierId} onChange={(e) => { setDossierId(e.target.value); setSelectedPins(null); }}>{dossiers.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></Field><div><h3 className="mb-2 text-[13px] font-medium">Pinned sources to include</h3>{pins.length ? pins.map((item) => <label key={item.id} className="flex min-h-9 items-center gap-2 text-[13px]"><input type="checkbox" checked={enabled.some((pin) => pin.id === item.id)} onChange={(e) => setSelectedPins(e.target.checked ? [...enabled.map((pin) => pin.id), item.id] : enabled.filter((pin) => pin.id !== item.id).map((pin) => pin.id))} /><span>{item.title} <span className="readout text-xs text-muted-foreground">v{item.version}</span></span></label>) : <Empty title="Pin evidence first" description="A link is not a source-version snapshot." action={<Button asChild variant="outline"><Link href={`/apps/alfred/dossiers?id=${dossierId}`}>Open dossier sources</Link></Button>} />}</div><Field label="Instructions and audience"><Textarea rows={5} value={instructions} onChange={(e) => setInstructions(e.target.value)} placeholder="Who is this for? What question should it answer?" /></Field><Status>{selected.label}</Status><Button className="w-full" disabled={!dossier || !enabled.length} variant="outline" onClick={() => { const artifact = addArtifact(`${selected.label} brief: ${dossier?.title}`, "note", `Artifact type: ${selected.id}\nStatus: Prepared locally; not generated\n\nInstructions:\n${instructions}\n\nPinned evidence snapshots:\n${enabled.map((pin) => `${pin.title} (${pin.id}) v${pin.version}\n${pin.body}`).join("\n\n")}`); if (artifact) { updateArtifact(artifact.id, { tags: ["Studio brief", selected.label], links: [dossierId, ...enabled.map((pin) => pin.id)] }); notify("Studio brief saved locally. No generation was started."); } }}><Save aria-hidden />Save generation brief</Button><Button className="w-full" disabled>Generate (not connected)</Button></div></Panel></div><Unavailable feature="Artifact generation">Model generation, text-to-speech, video, image rendering and slide export are not connected. No queued, running or completed artifact is fabricated.</Unavailable><Panel title="Prepared briefs">{briefs.length ? briefs.map((item) => <div key={item.id} className="border-b border-border py-3 last:border-0"><ArtifactLink record={item} /></div>) : <Empty title="No prepared briefs" description="Choose a type and pin dossier evidence, then save your instructions to a canonical note." />}</Panel><PromptTemplates /></Screen>;
}
