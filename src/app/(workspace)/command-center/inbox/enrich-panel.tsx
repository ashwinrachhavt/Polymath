"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useOptimistic, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { WorkStatus, useWorkPoll, type WorkState } from "@/components/work-status";
import { ENRICH_PENDING_LABEL, type CaptureEnrichment } from "@/domains/capture/enrich-state";
import { captureEnrichStatusAction, enrichCaptureAction } from "./actions";

/*
 * Enrich for a link capture: nothing is fetched until the person clicks.
 * The click queues the run and its render brings the pending state; the pane
 * then polls the stored state (a read, no revalidation) and, once the run
 * settles, refreshes once to bring the summary or the failure with its Retry.
 */

const GIVE_UP_MS = 3 * 60_000;
const GIVE_UP_LABEL = "Still working on the summary in the background. Reopen this capture later to see it.";

async function readEnrichStatus(ids: string[]): Promise<Record<string, WorkState>> {
  const [captureId] = ids;
  const status = await captureEnrichStatusAction({ captureId });
  if (!status.ok) throw new Error(status.error);
  return { [captureId]: status.state };
}

const REQUESTED: CaptureEnrichment = { status: "pending", requestedAt: "", failures: 0 };

export function EnrichPanel({
  captureId,
  enrichment,
  canRequest,
}: {
  captureId: string;
  enrichment: CaptureEnrichment | null;
  /** False once the capture is filed or archived: a stored summary still shows, but no new request starts. */
  canRequest: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [view, markRequested] = useOptimistic<CaptureEnrichment | null, void>(enrichment, () => REQUESTED);

  const pollIds = useMemo(() => (enrichment?.status === "pending" ? [captureId] : []), [enrichment?.status, captureId]);
  const { states } = useWorkPoll({
    ids: pollIds,
    read: readEnrichStatus,
    giveUpMs: GIVE_UP_MS,
    giveUpLabel: GIVE_UP_LABEL,
  });
  const polled = states[captureId];
  const settled = polled?.phase === "done" || polled?.phase === "failed";
  // The run finished in the background: one refresh brings what it stored.
  useEffect(() => {
    if (settled) router.refresh();
  }, [settled, router]);

  function requestEnrich() {
    setError(null);
    startTransition(async () => {
      markRequested();
      const result = await enrichCaptureAction({ captureId });
      if (!result.ok) setError(result.error);
    });
  }

  if (view?.status === "done") {
    return (
      <section aria-label="Summary of the page" className="mt-6 max-w-[70ch] border-border border-t pt-6">
        <h3 className="text-body-dense font-medium">Summary</h3>
        <p className="mt-1.5 text-body-dense leading-relaxed">{view.summary}</p>
        <h3 className="mt-4 text-body-dense font-medium">Key points</h3>
        <ul className="mt-1.5 list-disc space-y-1 pl-5 text-body-dense">
          {view.keyPoints.map((point, index) => (
            <li key={index}>{point}</li>
          ))}
        </ul>
        {view.suggestedNotebookId && view.suggestedNotebookTitle ? (
          <p className="mt-4 text-body-dense text-muted-foreground">
            Fits the notebook{" "}
            <Link
              href={`/projects/${encodeURIComponent(view.suggestedNotebookId)}`}
              className="font-medium text-[color:var(--link)] underline-offset-4 hover:underline"
            >
              {view.suggestedNotebookTitle}
            </Link>
          </p>
        ) : null}
      </section>
    );
  }

  if (!canRequest) return null;

  return (
    <section aria-label="Enrich this link" className="mt-6 max-w-[70ch] border-border border-t pt-6">
      {view?.status === "pending" ? (
        <>
          <WorkStatus state={polled ?? { phase: "working", label: ENRICH_PENDING_LABEL }} />
          {polled?.label === GIVE_UP_LABEL ? (
            <Button className="mt-2" size="sm" variant="outline" disabled={pending} onClick={requestEnrich}>
              Try again
            </Button>
          ) : null}
        </>
      ) : view?.status === "failed" ? (
        <>
          <WorkStatus state={{ phase: "failed", label: view.error }} />
          <Button className="mt-2" size="sm" variant="outline" disabled={pending} onClick={requestEnrich}>
            Retry
          </Button>
        </>
      ) : (
        <>
          <p className="text-body-dense text-muted-foreground">
            Fetch the page and add a summary, key points and a notebook it fits.
          </p>
          <Button className="mt-2" size="sm" variant="outline" disabled={pending} onClick={requestEnrich}>
            Enrich
          </Button>
        </>
      )}
      {error ? <WorkStatus state={{ phase: "failed", label: error }} className="mt-2" /> : null}
    </section>
  );
}
