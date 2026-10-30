"use client";

import { Save } from "lucide-react";
import { Screen, Panel, Empty, Unavailable } from "@/components/workspace/ui";
import { useWorkspace } from "@/components/workspace/workspace-provider";
import { ArtifactLink } from "./artifact-controls";

/*
 * Dictionary: senses of a concept, annotated and saved as vocabulary zettels.
 * Definitions come from a live lookup, and no dictionary or AI lookup is
 * connected, so there is nothing to browse. The screen says so and names the
 * action that fills it; it never ships fabricated sample entries. Senses the
 * owner saved are real artifacts and stay.
 */
export default function Dictionary() {
  const { state } = useWorkspace();
  const saved = state.artifacts.filter((item) => item.tags.includes("Vocabulary"));
  return <Screen title="Dictionary" description="Saved senses become canonical vocabulary zettels."><div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]"><Panel title="Concept lookup"><Empty title="Lookup not connected" description="A live dictionary and AI explanation source answers here once connected. Until then there is nothing to browse, and no sample entries stand in for it." /><div className="mt-4"><Unavailable feature="Live dictionary and AI explanation">No external definition, encyclopedia, translation, pronunciation audio or AI explanation has been fetched.</Unavailable></div></Panel><Panel title="Saved vocabulary" actions={<Save aria-hidden className="size-4 text-muted-foreground" />}>{saved.length ? saved.map((item) => <div key={item.id} className="border-b border-border py-3 last:border-0"><ArtifactLink record={item} /></div>) : <Empty title="No saved senses" description="No saved senses yet." />}</Panel></div></Screen>;
}
