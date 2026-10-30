"use client";

import { useState, useTransition } from "react";
import { ThumbsDown, ThumbsUp, X } from "lucide-react";
import { cn } from "cn";
import { dismissRunCritiqueAction, setRunFeedbackAction } from "./review-actions";

/*
 * The run's review block (ASH-304), under a finished run's transcript.
 *
 * Two signals, side by side but independent:
 * - the agent's self-critique proposal: three optional fields, dismissable,
 *   never auto-injected anywhere; an empty critique renders nothing at all.
 * - the operator's verdict: thumbs-up in one tap; thumbs-down opens a
 *   skippable one-turn prompt (reasons + an optional line); the same verdict
 *   again clears back to neutral.
 */

const REASONS: { slug: string; label: string }[] = [
  { slug: "wrong", label: "Wrong" },
  { slug: "incomplete", label: "Incomplete" },
  { slug: "wrong-target", label: "Wrong target" },
  { slug: "messy", label: "Messy" },
  { slug: "overscoped", label: "Overscoped" },
  { slug: "other", label: "Other" },
];

export type RunReviewInitial = {
  critique: {
    gotWrong: string | null;
    wasThin: string | null;
    wouldDoDifferently: string | null;
    dismissedAt: Date | null;
  } | null;
  feedback: { verdict: "up" | "down" | null; reasons: string[]; note: string | null } | null;
};

export function RunReview({ runId, initial }: { runId: string; initial: RunReviewInitial }) {
  const [verdict, setVerdict] = useState<"up" | "down" | null>(initial.feedback?.verdict ?? null);
  const [reasons, setReasons] = useState<string[]>(initial.feedback?.reasons ?? []);
  const [note, setNote] = useState(initial.feedback?.note ?? "");
  const [promptOpen, setPromptOpen] = useState(false);
  const [critiqueDismissed, setCritiqueDismissed] = useState(Boolean(initial.critique?.dismissedAt));
  const [error, setError] = useState(false);
  const [pending, startTransition] = useTransition();

  const critique = initial.critique;
  const critiqueVisible =
    critique && !critiqueDismissed && (critique.gotWrong || critique.wasThin || critique.wouldDoDifferently);

  function send(next: "up" | "down" | "clear", nextReasons: string[], nextNote: string) {
    setError(false);
    startTransition(async () => {
      try {
        const result = await setRunFeedbackAction({
          runId,
          verdict: next,
          reasons: next === "down" ? nextReasons : undefined,
          note: next === "down" && nextNote.trim() ? nextNote.trim() : undefined,
          idempotencyKey: `run-feedback-${runId}-${next}-${nextReasons.join(",")}-${nextNote.trim()}`,
        });
        if (!result.ok) {
          setError(true);
          return;
        }
        setVerdict(result.verdict);
        if (next !== "down") setPromptOpen(false);
      } catch {
        setError(true);
      }
    });
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

  return (
    <section aria-label="Run review" className="mx-auto flex w-full max-w-[var(--page-width)] flex-col gap-3">
      {critiqueVisible ? (
        <div className="border-border rounded-md border px-3 py-2.5">
          <div className="flex items-baseline justify-between gap-2">
            <h2 className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
              What the agent noted about this run
            </h2>
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
          <dl className="mt-1.5 flex flex-col gap-1.5 text-[13px] leading-relaxed">
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
          <span className="text-muted-foreground mr-1 text-[12px]">How was this run?</span>
          <button
            type="button"
            aria-label="Run was good"
            aria-pressed={verdict === "up"}
            title="Run was good"
            disabled={pending}
            onClick={() => send(verdict === "up" ? "clear" : "up", [], "")}
            className={cn(
              "text-muted-foreground hover:bg-muted hover:text-foreground flex size-7 items-center justify-center rounded-md outline-none transition-colors focus-visible:ring-ring focus-visible:ring-2",
              verdict === "up" && "text-foreground bg-muted",
            )}
          >
            <ThumbsUp aria-hidden className="size-3.5" />
          </button>
          <button
            type="button"
            aria-label="Run was not good"
            aria-pressed={verdict === "down"}
            title="Run was not good"
            disabled={pending}
            onClick={() => {
              if (verdict === "down" && !promptOpen) {
                send("clear", [], "");
                return;
              }
              setPromptOpen(true);
            }}
            className={cn(
              "text-muted-foreground hover:bg-muted hover:text-foreground flex size-7 items-center justify-center rounded-md outline-none transition-colors focus-visible:ring-ring focus-visible:ring-2",
              verdict === "down" && "text-foreground bg-muted",
            )}
          >
            <ThumbsDown aria-hidden className="size-3.5" />
          </button>
          {error ? (
            <span className="text-destructive ml-1.5 text-[11px]" role="alert">
              Feedback was not saved.
            </span>
          ) : null}
        </div>

        {promptOpen && verdict !== "up" ? (
          <div className="border-border flex flex-col gap-2 rounded-md border px-3 py-2.5">
            <fieldset>
              <legend className="text-muted-foreground text-[12px]">What went wrong? Pick any, or skip.</legend>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {REASONS.map(({ slug, label }) => (
                  <button
                    key={slug}
                    type="button"
                    aria-pressed={reasons.includes(slug)}
                    onClick={() =>
                      setReasons((current) =>
                        current.includes(slug) ? current.filter((r) => r !== slug) : [...current, slug],
                      )
                    }
                    className={cn(
                      "border-border text-muted-foreground rounded-full border px-2.5 py-1 text-[12px] outline-none focus-visible:ring-ring focus-visible:ring-2",
                      reasons.includes(slug) && "border-foreground/30 bg-muted text-foreground",
                    )}
                  >
                    {label}
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
              className="border-border bg-transparent placeholder:text-muted-foreground/70 rounded-md border px-2.5 py-1.5 text-[13px] outline-none focus-visible:ring-ring focus-visible:ring-2"
            />
            <div className="text-muted-foreground flex items-center gap-4 text-[13px]">
              <button
                type="button"
                disabled={pending}
                onClick={() => send("down", reasons, note)}
                className="text-foreground font-medium underline underline-offset-2 outline-none focus-visible:ring-ring focus-visible:ring-2"
              >
                Save
              </button>
              <button
                type="button"
                disabled={pending}
                onClick={() => send("down", [], "")}
                className="underline underline-offset-2 outline-none focus-visible:ring-ring focus-visible:ring-2"
              >
                Skip, just mark it not good
              </button>
              <button
                type="button"
                disabled={pending}
                onClick={() => setPromptOpen(false)}
                className="ml-auto outline-none focus-visible:ring-ring focus-visible:ring-2"
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
