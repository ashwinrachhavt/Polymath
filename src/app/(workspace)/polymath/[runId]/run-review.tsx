"use client";

import { useState, useTransition } from "react";
import { ThumbsDown, ThumbsUp, X } from "lucide-react";
import { cn } from "cn";
import { OutputRating } from "@/components/feedback/output-rating";
import { rateOutputAction } from "@/components/feedback/rate-output-action";
import type { RunCritique } from "@/domains/agents/run-reviews";
import type { Rating } from "@/domains/feedback/ratings";
import { dismissRunCritiqueAction } from "./review-actions";

/*
 * The run's review block (ASH-304), under a finished run's transcript.
 *
 * Two signals, side by side but independent:
 * - the agent's self-critique proposal: three optional fields, dismissable,
 *   never auto-injected anywhere; an empty critique renders nothing at all.
 * - the operator's verdict, stored as a `run` rating (domains/feedback):
 *   thumbs-down is a 0, saved at once with no question in the way, and may be
 *   followed by optional reason chips and a line; thumbs-up opens the 1-5
 *   faces so the verdict says how good it was. The same thumb again clears.
 */

const REASONS = ["Wrong", "Incomplete", "Wrong target", "Messy", "Overscoped", "Other"] as const;

export function RunReview({
  runId,
  critique,
  initialRating,
}: {
  runId: string;
  critique: RunCritique | null;
  initialRating: Rating | null;
}) {
  const [rating, setRating] = useState<Rating | null>(initialRating);
  const [grading, setGrading] = useState(false);
  const [whyOpen, setWhyOpen] = useState(false);
  const [reasons, setReasons] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const [critiqueDismissed, setCritiqueDismissed] = useState(Boolean(critique?.dismissedAt));
  const [error, setError] = useState(false);
  const [pending, startTransition] = useTransition();

  const down = rating?.score === 0;
  const graded = rating !== null && rating.score >= 1;
  const critiqueVisible =
    critique && !critiqueDismissed && (critique.gotWrong || critique.wasThin || critique.wouldDoDifferently);

  /** Saves the run verdict; onDone runs only once the server has confirmed it. */
  function save(score: 0 | null, comment: string | null, onDone?: () => void) {
    setError(false);
    startTransition(async () => {
      try {
        const result = await rateOutputAction({ output: { surface: "run", id: runId }, score, comment });
        if (!result.ok) {
          setError(true);
          return;
        }
        setRating(result.rating);
        onDone?.();
      } catch {
        setError(true);
      }
    });
  }

  function thumbDown() {
    if (down) {
      setWhyOpen(false);
      save(null, null);
      return;
    }
    setGrading(false);
    // An explicit null comment drops the note a previous grade carried.
    save(0, null, () => setWhyOpen(true));
  }

  function thumbUp() {
    setWhyOpen(false);
    if (graded && !grading) {
      save(null, null);
      return;
    }
    // Leaving a thumbs-down clears it first, so its reasons do not ride along on the grade.
    if (down) save(null, null, () => setGrading(true));
    else setGrading(true);
  }

  function saveWhy() {
    const text = [reasons.join(", "), note.trim()].filter(Boolean).join(": ");
    setWhyOpen(false);
    if (text) save(0, text);
  }

  function dismissCritique() {
    setCritiqueDismissed(true);
    startTransition(async () => {
      try {
        await dismissRunCritiqueAction({ runId, idempotencyKey: `run-critique-dismiss-${runId}` });
      } catch {
        setCritiqueDismissed(false);
      }
    });
  }

  const thumb =
    "text-muted-foreground hover:bg-muted hover:text-foreground flex size-7 items-center justify-center rounded-md outline-none transition-colors focus-visible:ring-ring focus-visible:ring-2";

  return (
    <section aria-label="Run review" className="mx-auto flex w-full max-w-[var(--page-width)] flex-col gap-3">
      {critiqueVisible ? (
        <div className="border-border rounded-md border px-3 py-2.5">
          <div className="flex items-baseline justify-between gap-2">
            <h2 className="text-muted-foreground text-data font-medium">What the agent noted about this run</h2>
            <button
              type="button"
              aria-label="Dismiss the self-critique"
              title="Dismiss"
              onClick={dismissCritique}
              className="text-muted-foreground hover:bg-muted hover:text-foreground flex size-6 items-center justify-center rounded-md outline-none focus-visible:ring-ring focus-visible:ring-2"
            >
              <X aria-hidden className="size-3.5" />
            </button>
          </div>
          <dl className="mt-1.5 flex flex-col gap-1.5 text-body-dense leading-relaxed">
            {critique.gotWrong ? (
              <div>
                <dt className="text-muted-foreground inline">Got wrong: </dt>
                <dd className="inline">{critique.gotWrong}</dd>
              </div>
            ) : null}
            {critique.wasThin ? (
              <div>
                <dt className="text-muted-foreground inline">Was thin: </dt>
                <dd className="inline">{critique.wasThin}</dd>
              </div>
            ) : null}
            {critique.wouldDoDifferently ? (
              <div>
                <dt className="text-muted-foreground inline">Would do differently: </dt>
                <dd className="inline">{critique.wouldDoDifferently}</dd>
              </div>
            ) : null}
          </dl>
        </div>
      ) : null}

      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-1">
          <span className="text-muted-foreground mr-1 text-label">How was this run?</span>
          <button
            type="button"
            aria-label="Run was good"
            aria-pressed={graded || grading}
            title="Run was good"
            disabled={pending}
            onClick={thumbUp}
            className={cn(thumb, (graded || grading) && "text-foreground bg-muted")}
          >
            <ThumbsUp aria-hidden className="size-3.5" />
          </button>
          <button
            type="button"
            aria-label="Run was not good"
            aria-pressed={down}
            title="Run was not good"
            disabled={pending}
            onClick={thumbDown}
            className={cn(thumb, down && "text-foreground bg-muted")}
          >
            <ThumbsDown aria-hidden className="size-3.5" />
          </button>
          {graded || grading ? (
            <OutputRating
              key={grading ? "grading" : "graded"}
              output={{ surface: "run", id: runId }}
              initial={graded ? rating : null}
              startOpen={grading}
              label="How good was this run?"
              onChange={(next) => {
                setRating(next);
                setGrading(false);
              }}
            />
          ) : null}
          {error ? (
            <span className="text-destructive ml-1.5 text-data" role="alert">
              Feedback was not saved.
            </span>
          ) : null}
        </div>

        {whyOpen && down ? (
          <div className="border-border flex flex-col gap-2 rounded-md border px-3 py-2.5">
            <fieldset>
              <legend className="text-muted-foreground text-label">Marked not good. What went wrong? Optional.</legend>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {REASONS.map((reason) => (
                  <button
                    key={reason}
                    type="button"
                    aria-pressed={reasons.includes(reason)}
                    onClick={() =>
                      setReasons((current) =>
                        current.includes(reason) ? current.filter((r) => r !== reason) : [...current, reason],
                      )
                    }
                    className={cn(
                      "border-border text-muted-foreground rounded-full border px-2.5 py-1 text-label outline-none focus-visible:ring-ring focus-visible:ring-2",
                      reasons.includes(reason) && "border-foreground/30 bg-muted text-foreground",
                    )}
                  >
                    {reason}
                  </button>
                ))}
              </div>
            </fieldset>
            <input
              type="text"
              value={note}
              maxLength={280}
              onChange={(event) => setNote(event.target.value)}
              placeholder="One line, optional"
              aria-label="A note about this run"
              className="border-border bg-transparent placeholder:text-muted-foreground/70 rounded-md border px-2.5 py-1.5 text-body-dense outline-none focus-visible:ring-ring focus-visible:ring-2"
            />
            <div className="text-muted-foreground flex items-center gap-4 text-body-dense">
              <button
                type="button"
                disabled={pending}
                onClick={saveWhy}
                className="text-foreground font-medium underline underline-offset-2 outline-none focus-visible:ring-ring focus-visible:ring-2"
              >
                Save
              </button>
              <button
                type="button"
                onClick={() => setWhyOpen(false)}
                className="underline underline-offset-2 outline-none focus-visible:ring-ring focus-visible:ring-2"
              >
                Not now
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}
