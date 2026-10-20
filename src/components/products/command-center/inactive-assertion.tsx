"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Field, Status } from "@/components/workspace/ui";
import { useWorkspace } from "@/components/workspace/workspace-provider";
import type { Artifact } from "@/components/workspace/types";
import { Check, Inspector } from "./controls";

export default function InactiveAssertion({ artifact, noun }: { artifact: Artifact; noun: string }) {
  const { state, getSnapshot, updateArtifact, addArtifact, notify } = useWorkspace();
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const archived = artifact.tags.includes("Archived preparation");
  function recordDecision(decision: string) {
    const current = getSnapshot().artifacts.find((record) => record.id === artifact.id);
    if (!current || current.version !== artifact.version || current.body !== artifact.body || !reason.trim() || !confirmed) { notify("Inspect the current exact wording and confirm with a reason before reviewing locally."); return; }
    const receipt = addArtifact(`Local ${noun} wording review`, "note", `Preparation: ${artifact.id}\nExact checkpoint: ${artifact.version}\nDecision: ${decision}\nReason: ${reason.trim()}\n\nExact wording:\n${artifact.body}\n\nInactive preview review only. No retrieval activation, verified profile fact or external-write authority is granted.`);
    if (receipt) updateArtifact(receipt.id, { links: [artifact.id], tags: ["Inactive wording receipt"] });
    const result = updateArtifact(artifact.id, { tags: [...artifact.tags.filter((tag) => !tag.startsWith("Local wording:")), `Local wording:${decision}`] });
    if (!result.ok) return;
    notify(`${noun} wording ${decision.toLowerCase()} locally. It remains inactive.`);
  }
  return <article className="border-b border-border py-3"><div className="flex flex-wrap justify-between gap-2"><Inspector title={artifact.title} description={`${noun} wording preparation, not an active runtime record. Local review never verifies facts or activates retrieval.`} trigger={<Button variant="ghost" className="px-0">{artifact.title}</Button>}><p className="readout text-xs">Exact local checkpoint v{artifact.version}</p><p className="max-h-64 overflow-y-auto whitespace-pre-wrap text-[13px]">{artifact.body}</p>{!archived && <><form className="grid gap-3" onSubmit={(e) => { e.preventDefault(); const current = getSnapshot().artifacts.find((record) => record.id === artifact.id); if (current?.version !== artifact.version) { notify("Preparation changed. Reopen the current checkpoint."); return; } const data = new FormData(e.currentTarget); const result = updateArtifact(artifact.id, { title: String(data.get("title")).trim(), body: String(data.get("body")), tags: artifact.tags.filter((tag) => !tag.startsWith("Local wording:")) }); if (!result.ok) return; setConfirmed(false); setReason(""); notify("New inactive wording checkpoint saved. Local review must be repeated."); }}><Field label="Preparation title"><Input required name="title" defaultValue={artifact.title} maxLength={200}/></Field><Field label="Exact wording and provenance"><Textarea name="body" required defaultValue={artifact.body} maxLength={15000}/></Field><Button type="submit" variant="outline">Save new wording checkpoint</Button></form><Field label="Local wording review reason"><Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={2000}/></Field><Check label={`I inspected exact checkpoint ${artifact.version}; this stays inactive.`} checked={confirmed} onChange={setConfirmed}/><div className="flex flex-wrap gap-2"><Button disabled={!confirmed || !reason.trim()} onClick={() => recordDecision("Accepted")}>Accept wording locally</Button><Button variant="outline" disabled={!confirmed || !reason.trim()} onClick={() => recordDecision("Rejected")}>Reject wording locally</Button></div></>}<Button variant="outline" onClick={() => updateArtifact(artifact.id, { tags: archived ? artifact.tags.filter((tag) => tag !== "Archived preparation") : [...artifact.tags, "Archived preparation"] })}>{archived ? "Restore preparation" : "Archive preparation"}</Button><details><summary className="cursor-pointer text-[13px]">Exact checkpoint history</summary>{state.artifactVersions.filter((version) => version.artifactId === artifact.id).sort((a, b) => b.version - a.version).map((version) => <details key={version.id} className="mt-2 text-xs"><summary className="cursor-pointer">Checkpoint {version.version}</summary><p className="mt-2 whitespace-pre-wrap">{version.body}</p></details>)}</details></Inspector><Status>{archived ? "Archived preparation" : "Inactive"} / v{artifact.version}</Status></div><p className="mt-2 whitespace-pre-wrap text-[13px]">{artifact.body}</p>{artifact.tags.find((tag) => tag.startsWith("Local wording:")) && <p className="mt-2 text-xs text-muted-foreground">{artifact.tags.find((tag) => tag.startsWith("Local wording:"))?.replace("Local wording:", "Wording reviewed locally: ")} (not activated)</p>}</article>;
}
