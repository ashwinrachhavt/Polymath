"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { reviewCardAction } from "../actions";

/*
 * One card at a time. Review is retrieval, not recognition: the answer stays
 * hidden until the owner acknowledges they attempted the recall - the gate is
 * the acknowledgment, not the click alone. Typing the attempt is optional
 * (self-graded mental recall is the design); when typed it is stored on the
 * review row as response_text. Grading posts the attempt and the server hands
 * back the next due card on refresh; a wrong answer returns within the
 * sitting (the scheduler queues it RETRY_MINUTES out, and it surfaces as
 * soon as the queue ahead of it drains).
 */

export function ReviewCard({
  card,
  dueCount,
}: {
  card: {
    id: string;
    prompt: string;
    answer: string;
    sourceTitle: string;
    sourceId: string | null;
    sourceArchived: boolean;
    version: number;
  };
  dueCount: number;
}) {
  const router = useRouter();
  const [attempted, setAttempted] = useState(false);
  const [responseText, setResponseText] = useState("");
  const [revealed, setRevealed] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const errorId = useId();
  const answerRef = useRef<HTMLParagraphElement>(null);
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
        responseText: responseText.trim() || undefined,
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
          <p
            ref={answerRef}
            tabIndex={-1}
            className="border-border border-l-2 pl-3 text-[13px] leading-relaxed text-muted-foreground outline-none"
          >
            {card.answer}
          </p>
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
        <div className="flex flex-col gap-3">
          <textarea
            aria-label="Your attempt (optional)"
            placeholder="Your attempt (optional)"
            value={responseText}
            onChange={(event) => setResponseText(event.target.value)}
            maxLength={4000}
            rows={3}
            className="border-input bg-background placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 w-full rounded-md border px-3 py-2 text-[13px] outline-none focus-visible:ring-3"
          />
          <label className="flex items-center gap-2 text-[13px]">
            <input
              type="checkbox"
              checked={attempted}
              onChange={(event) => setAttempted(event.target.checked)}
              className="accent-foreground size-4"
            />
            I attempted to recall this
          </label>
          <div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!attempted}
              onClick={() => {
                shownAt.current = Date.now();
                setRevealed(true);
                // The reveal unmounts this button; move focus to the answer
                // instead of dropping it to <body>.
                requestAnimationFrame(() => answerRef.current?.focus());
              }}
            >
              Show answer
            </Button>
          </div>
        </div>
      )}
      {card.sourceId && !card.sourceArchived ? (
        <Link href={`/alfred/notes?id=${card.sourceId}`} className="text-xs text-muted-foreground underline-offset-2 hover:underline">
          from {card.sourceTitle}
        </Link>
      ) : (
        <p className="text-xs text-muted-foreground">
          from {card.sourceTitle} ({card.sourceId ? "source archived" : "source deleted"})
        </p>
      )}
      {error && (
        <p id={errorId} role="alert" className="text-destructive text-xs">
          {error}
        </p>
      )}
    </div>
  );
}
