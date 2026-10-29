"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { generateZettelsAction } from "./zettel-actions";

/*
 * The inbox's second bulk verb: "Generate zettels". It sits beside the
 * selection toolbar's Archive and Restore, in the same secondary register, and
 * is the only control on the screen that starts a model pass.
 *
 * The row count decides whether it can act at all; an unconfigured provider
 * disables it with the reason in its title rather than failing on the click.
 * The button queues and returns - proposals are made by the outbox - so the
 * answer is "N captures queued" plus a link into the review queue, never a
 * spinner held open on a model call.
 */

export function GenerateZettelsButton({
  sources,
  providerReady,
  providerReason,
}: {
  /** Open captures carrying text. Zero disables the control. */
  sources: number;
  providerReady: boolean;
  /** Safe sentence naming what turns generation on; shown when it is off. */
  providerReason: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [outcome, setOutcome] = useState<{ message: string; failed: boolean } | null>(null);

  const disabled = pending || sources === 0 || !providerReady;
  const reason = !providerReady
    ? providerReason
    : sources === 0
      ? "No open capture has text to read."
      : undefined;

  function run() {
    setOutcome(null);
    startTransition(async () => {
      // One key per click: a double-submit replays the first request instead of
      // queueing a second pass over the same captures.
      const result = await generateZettelsAction({ idempotencyKey: crypto.randomUUID() });
      if (!result.ok) {
        setOutcome({ message: result.message, failed: true });
        return;
      }
      const queued = `${result.queued} capture${result.queued === 1 ? "" : "s"} queued for zettel proposals`;
      const review = result.awaitingReview
        ? ` ${result.awaitingReview} zettel${result.awaitingReview === 1 ? "" : "s"} awaiting review.`
        : " They appear in the review queue as they are read.";
      setOutcome({
        message: result.replayed ? `${queued}. This request was already sent.${review}` : `${queued}.${review}`,
        failed: false,
      });
      router.refresh();
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={disabled}
        title={reason}
        aria-describedby={outcome ? "zettel-generation-outcome" : undefined}
        onClick={run}
      >
        {pending ? "Queueing…" : "Generate zettels"}
      </Button>
      {!providerReady ? <span className="text-xs text-muted-foreground">{providerReason}</span> : null}
      {outcome ? (
        <p
          id="zettel-generation-outcome"
          role={outcome.failed ? "alert" : "status"}
          className={
            outcome.failed
              ? "w-full text-[13px] text-destructive"
              : "w-full text-[13px] text-muted-foreground"
          }
        >
          {outcome.message}{" "}
          {!outcome.failed ? (
            <Link href="/polymath/knowledge/zettels" className="font-medium text-foreground underline underline-offset-4">
              Review zettels
            </Link>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}
