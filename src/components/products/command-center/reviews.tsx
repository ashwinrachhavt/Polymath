"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import dynamic from "next/dynamic";

const ActionComposer = dynamic(() => import("./action-composer"), { loading: () => <p role="status" className="text-xs">Loading action fields…</p> });
import { Textarea } from "@/components/ui/textarea";
import { Empty, Field, Panel, Screen, Status, Unavailable } from "@/components/workspace/ui";
import { useWorkspace } from "@/components/workspace/workspace-provider";
import type { Review } from "@/components/workspace/types";
import { Check, Select } from "./controls";
import { canDecideReview } from "./review-gate";

function ReviewEditor({ review }: { review: Review }) {
  const { state, getSnapshot, updateReview, addArtifact, updateArtifact, notify } = useWorkspace();
  const [payload, setPayload] = useState(review.payload);
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [sensitive, setSensitive] = useState(false);
  const dirty = payload !== review.payload;
  const pending = review.status === "Pending";
  function decide(status: "Approved locally" | "Rejected") {
    const current = getSnapshot().reviews.find((record) => record.id === review.id);
    if (!canDecideReview(current, review, { payload, reason, decision: status, confirmed, sensitiveConfirmed: sensitive })) { notify("Review changed or confirmation is incomplete. Inspect the current payload again."); return; }
    const receipt = addArtifact(`Local review receipt: ${review.title}`, "note", `Decision: ${status}\nReview: ${review.id}\nExact revision: ${review.revision}\nRisk: ${review.risk}\nReason: ${reason.trim()}\nAccount: Not connected\nExternal attempt: None\n\nExact payload:\n${review.payload}\n\nThis receipt records a browser-preview decision only. It does not authorize any provider write.`);
    if (receipt) updateArtifact(receipt.id, { links: [review.id], tags: ["Local review receipt"] });
    const result = updateReview(review.id, { status });
    if (!result.ok || !result.persisted) return;
    notify(status === "Approved locally" ? "Exact revision approved locally. Nothing sent, scheduled or queued externally." : "Exact revision rejected locally. No external action performed.");
  }
  return <Panel title={review.title} description="No account or provider is connected. Approval is a local rehearsal, not external authorization." actions={<Status>{review.status}</Status>}><div className="mb-4 flex flex-wrap gap-2"><Status>{review.kind}</Status><Status>{review.risk}</Status><span className="readout text-xs">Revision {review.revision}</span></div><form className="grid gap-3" onSubmit={(e) => { e.preventDefault(); const current = getSnapshot().reviews.find((record) => record.id === review.id); if (current?.revision !== review.revision || current?.payload !== review.payload) { notify("Current review changed. Reopen it before saving."); return; } const result = updateReview(review.id, { payload }); if (!result.ok || !result.persisted) return; notify("Payload revision saved. Prior local approval and confirmation are invalidated."); }}><Field label="Exact proposed payload"><Textarea className="min-h-56 font-mono text-xs" value={payload} maxLength={100000} onChange={(e) => { setPayload(e.target.value); setConfirmed(false); setSensitive(false); }}/></Field><Button type="submit" variant="outline" disabled={!dirty || !payload.trim()}>Save new payload revision</Button></form><p className="mt-3 text-xs text-muted-foreground">{dirty ? "Unsaved payload edits block all decisions. Save a new revision first." : "This is the exact current saved payload. Editing creates a new pending revision."}</p>{pending && <div className="mt-5 grid gap-3 border-t border-border pt-4"><Field label="Review reason (required)"><Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={2000}/></Field><Check label={`I inspected the exact payload for revision ${review.revision}; this is a local-only decision.`} checked={confirmed} onChange={setConfirmed} disabled={dirty}/>{review.risk === "Sensitive write" && <Check label="I explicitly confirm this sensitive local review rehearsal; no external execution is permitted." checked={sensitive} onChange={setSensitive} disabled={dirty}/>}<div className="flex flex-wrap gap-2"><Button disabled={dirty || !confirmed || !reason.trim() || (review.risk === "Sensitive write" && !sensitive)} onClick={() => decide("Approved locally")}>Approve locally (no sending)</Button><Button variant="outline" disabled={dirty || !reason.trim()} onClick={() => decide("Rejected")}>Reject locally</Button></div></div>}<details className="mt-4 text-[13px]"><summary className="cursor-pointer">Local decision receipts</summary>{state.artifacts.filter((artifact) => artifact.links.includes(review.id) && artifact.tags.includes("Local review receipt")).map((artifact) => <pre key={artifact.id} className="mt-3 overflow-x-auto whitespace-pre-wrap break-words font-mono text-xs">{artifact.body}</pre>)}{!state.artifacts.some((artifact) => artifact.links.includes(review.id)) && <p className="mt-2 text-xs text-muted-foreground">No local decision receipt.</p>}</details></Panel>;
}
export default function Reviews() {
  const { state } = useWorkspace();
  const [filter, setFilter] = useState("Pending");
  const [creating, setCreating] = useState(false);
  const reviews = state.reviews.filter((review) => filter === "All" || review.status === filter);
  return <Screen title="Reviews" description="Inspect exact payloads, risk and revisions before deciding. All approvals here are local-only; no email, calendar event or other external effect can execute." actions={<Button onClick={() => setCreating(!creating)}>{creating ? "Close proposal" : "New local proposal"}</Button>}><Unavailable feature="External execution and reconciliation">Provider account identity, attachment manifests, expiry, dedupe and attempts require authenticated domain commands. Local decisions cannot create an execution attempt.</Unavailable>{creating && <ActionComposer onCreated={() => { setCreating(false); setFilter("Pending"); }}/>}<Field label="Review status"><Select className="max-w-xs" value={filter} onChange={(e) => setFilter(e.target.value)}>{["Pending", "Approved locally", "Rejected", "All"].map((value) => <option key={value}>{value}</option>)}</Select></Field>{reviews.map((review) => <ReviewEditor key={`${review.id}-${review.revision}-${review.status}`} review={review}/>)}{!reviews.length && <Empty title="No reviews in this view" description="Change the filter or prepare a local proposal."/>}</Screen>;
}
