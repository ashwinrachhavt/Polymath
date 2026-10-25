"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/workspace/ui";
import type { VerifiedReadingSummary } from "@/domains/knowledge/reading-summary";
import { acceptReadingSummaryAction, summarizeReadingAction } from "./summary-actions";

/*
 * The summarize flow on the reader (ASH-292): one click runs the
 * summarizer, the result stays a proposal - the owner reads it, then
 * accepts (a linked note plus zettel proposals for the verified claims)
 * or discards it. Nothing is written before Accept; the accept key is
 * minted once per produced summary so a double-click folds.
 */
export function SummaryPanel({ documentId, canSummarize }: { documentId: string; canSummarize: boolean }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [summary, setSummary] = useState<VerifiedReadingSummary | null>(null);
  const [saved, setSaved] = useState<{ noteId: string; proposals: number } | null>(null);

  if (!canSummarize) return null;

  function summarize() {
    setPending(true);
    setError("");
    void summarizeReadingAction(documentId)
      .then((r) => (r.ok ? setSummary(r.summary) : setError(r.error)))
      .catch(() => setError("Could not summarize this document."))
      .finally(() => setPending(false));
  }

  function accept() {
    if (!summary) return;
    setPending(true);
    setError("");
    void acceptReadingSummaryAction({
      documentId,
      summary,
      idempotencyKey: `reading-summary:${documentId}:${summary.keyClaims.map((c) => `${c.start}-${c.end}`).join(",")}`,
    })
      .then((r) => (r.ok ? setSaved({ noteId: r.noteId, proposals: r.proposals }) : setError(r.error)))
      .catch(() => setError("Could not save this summary."))
      .finally(() => setPending(false));
  }

  if (saved) {
    return (
      <Panel title="Summary saved">
        <p className="text-[13px]">
          Saved as a note linked to this document, with {saved.proposals} zettel {saved.proposals === 1 ? "proposal" : "proposals"} waiting in the usual queue.
        </p>
      </Panel>
    );
  }

  if (!summary) {
    return (
      <div>
        <Button variant="outline" size="sm" disabled={pending} onClick={summarize}>
          {pending ? "Summarizing…" : "Summarize this reading"}
        </Button>
        {error && <p role="alert" className="mt-2 text-[13px] text-destructive">{error}</p>}
      </div>
    );
  }

  return (
    <Panel
      title="Reading summary"
      description="A proposal, not a saved note. Claims are kept only when their supporting passage verifies against the text."
      actions={
        <div className="flex gap-2">
          <Button size="sm" disabled={pending} onClick={accept}>{pending ? "Saving…" : "Accept"}</Button>
          <Button size="sm" variant="outline" disabled={pending} onClick={() => setSummary(null)}>Discard</Button>
        </div>
      }
    >
      {summary.summary && <p className="text-[13px]">{summary.summary}</p>}
      {summary.keyClaims.length > 0 && (
        <div className="mt-3">
          <p className="text-[13px] font-medium">Key claims</p>
          <ul className="mt-1 space-y-1 text-[13px] text-muted-foreground">
            {summary.keyClaims.map((c) => <li key={`${c.start}-${c.end}`}>{c.claim}</li>)}
          </ul>
        </div>
      )}
      {summary.openQuestions.length > 0 && (
        <div className="mt-3">
          <p className="text-[13px] font-medium">Open questions</p>
          <ul className="mt-1 space-y-1 text-[13px] text-muted-foreground">
            {summary.openQuestions.map((q) => <li key={q}>{q}</li>)}
          </ul>
        </div>
      )}
      {summary.droppedClaims > 0 && (
        <p className="mt-3 text-xs text-muted-foreground">
          {summary.droppedClaims} offered {summary.droppedClaims === 1 ? "claim" : "claims"} dropped: no verbatim supporting passage in the text.
        </p>
      )}
      {error && <p role="alert" className="mt-2 text-[13px] text-destructive">{error}</p>}
    </Panel>
  );
}
