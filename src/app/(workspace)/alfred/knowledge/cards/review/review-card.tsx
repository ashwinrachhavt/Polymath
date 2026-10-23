"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { reviewCardAction } from "../actions";

/*
 * One card at a time. The answer stays hidden until attempted - review is
 * retrieval, not recognition. Grading posts the attempt and the server hands
 * back the next due card on refresh; a wrong answer returns within the
 * sitting (the scheduler queues it RETRY_MINUTES out, and it surfaces as
 * soon as the queue ahead of it drains).
 */

export function ReviewCard({
  card,
  dueCount,
}: {
  card: { id: string; prompt: string; answer: string; sourceTitle: string; sourceId: string; version: number };
  dueCount: number;
}) {
  const router = useRouter();
  const [revealed, setRevealed] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const errorId = useId();
  // One key per mounted card: a retried grade replays, it never double-counts.
  const keyRef = useRef(crypto.randomUUID());
  // Set when the answer is revealed (event handlers may read the clock;
  // render may not). The measured duration is time spent on the reveal.
  const shownAt = useRef(0);

  async function grade(outcome: "correct" | "wrong") {
    setPending(true);
    setError(null);
    try {
      await reviewCardAction({
        cardId: card.id,
        expectedVersion: card.version,
        outcome,
        durationMs: Date.now() - shownAt.current,
        idempotencyKey: keyRef.current,
      });
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Something went wrong.");
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-4" aria-describedby={error ? errorId : undefined}>
      <p className="text-xs text-muted-foreground">{dueCount} due</p>
      <p className="text-[15px] font-medium leading-relaxed">{card.prompt}</p>
      {revealed ? (
        <>
          <p className="border-border border-l-2 pl-3 text-[13px] leading-relaxed text-muted-foreground">{card.answer}</p>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" size="sm" disabled={pending} onClick={() => void grade("correct")}>
              Recalled
            </Button>
            <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => void grade("wrong")}>
              Missed
            </Button>
          </div>
        </>
      ) : (
        <div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              shownAt.current = Date.now();
              setRevealed(true);
            }}
          >
            Show answer
          </Button>
        </div>
      )}
      <Link href={`/alfred/notes?id=${card.sourceId}`} className="text-xs text-muted-foreground underline-offset-2 hover:underline">
        from {card.sourceTitle}
      </Link>
      {error && (
        <p id={errorId} role="alert" className="text-destructive text-xs">
          {error}
        </p>
      )}
    </div>
  );
}
