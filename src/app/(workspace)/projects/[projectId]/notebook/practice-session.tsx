"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import type { ChallengeAttemptView, ChallengeView } from "@/domains/learning/challenges";
import { showPracticeHintAction, submitPracticeAnswerAction } from "./practice-actions";
import { randomId } from "@/lib/random-id";

/*
 * One practice exercise: one prompt, one answer box, one button. Nothing about
 * the answer is on the page until the learner commits one; the server sends
 * the full answer only with the first stored attempt. Every earlier try stays
 * listed below, read from what was stored.
 */

export const PRACTICE_NAMES: Record<ChallengeView["format"], string> = {
  predict: "Predict what happens",
  bug_hunt: "Find the bug",
};

const GRADE_WORDS = {
  correct: "Right",
  partial: "Partly right",
  incorrect: "Not yet",
  uncertain: "Could not check this one",
} as const;

function gradeWord(attempt: ChallengeAttemptView): string {
  return attempt.grade ? GRADE_WORDS[attempt.grade] : "Skipped";
}

/** How much help the try had, in the learner's words. */
function helpNote(attempt: ChallengeAttemptView): string {
  if (attempt.independent) return "On your own";
  if (attempt.hintsUsed > 0) return attempt.hintsUsed === 1 ? "With 1 hint" : `With ${attempt.hintsUsed} hints`;
  if (attempt.ordinal > 0) return "After seeing the answer";
  return "";
}

/** Re-reads the page while the exercise is still being written. */
export function useRefreshWhile(waiting: boolean) {
  const router = useRouter();
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => router.refresh(), 2500);
    return () => clearInterval(timer);
  }, [waiting, router]);
}

function Passage({ evidence }: { evidence: ChallengeAttemptView["evidence"] }) {
  if (evidence.length === 0) return null;
  return (
    <ul className="mt-3 space-y-2">
      {evidence.map((item, index) => (
        <li key={index} className="border-l-2 border-border pl-3 text-sm text-muted-foreground">
          <blockquote>{item.quote}</blockquote>
          <p className="mt-1 text-xs">{item.source.title}</p>
        </li>
      ))}
    </ul>
  );
}

export function PracticeSession({ projectId, challenge }: { projectId: string; challenge: ChallengeView }) {
  const [answer, setAnswer] = useState("");
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  // A resend of the same answer replays its key; a changed answer gets a new one.
  const submit = useRef<{ signature: string; key: string } | null>(null);
  useRefreshWhile(challenge.status === "preparing");

  if (challenge.status !== "ready" || !challenge.prompt) {
    return (
      <section className="mx-auto w-full max-w-3xl rounded-xl border border-border p-5">
        <p role="status" className="text-sm leading-relaxed">
          {challenge.status === "preparing"
            ? "Getting this exercise ready. You can leave this page; it will be waiting in your notebook."
            : challenge.error}
        </p>
      </section>
    );
  }

  const { prompt, attempts, reveal } = challenge;
  const latest = attempts.at(-1);
  const answering = !latest || retrying;

  function commit(dontKnow: boolean) {
    if (!dontKnow && !answer.trim()) return;
    setError(null);
    const signature = JSON.stringify([dontKnow, answer]);
    if (submit.current?.signature !== signature) submit.current = { signature, key: randomId() };
    const submitKey = submit.current.key;
    startTransition(async () => {
      const result = await submitPracticeAnswerAction({
        projectId,
        challengeId: challenge.id,
        submitKey,
        answer: dontKnow ? "" : answer,
        dontKnow,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      submit.current = null;
      setAnswer("");
      setRetrying(false);
    });
  }

  function showHint() {
    setError(null);
    startTransition(async () => {
      const result = await showPracticeHintAction({ projectId, challengeId: challenge.id });
      if (!result.ok) setError(result.error);
    });
  }

  return (
    <section className="mx-auto w-full max-w-3xl">
      <p className="mb-4 text-sm text-muted-foreground">From: {challenge.title}</p>

      <div className="rounded-xl border border-border p-5">
        {prompt.situation ? <p className="whitespace-pre-wrap leading-relaxed">{prompt.situation}</p> : null}
        {prompt.artifact ? (
          <ol
            aria-label={prompt.artifact.kind === "log" ? "Log" : "Code"}
            className="overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs leading-relaxed"
          >
            {prompt.artifact.lines.map((line, index) => (
              <li key={index} className="flex gap-3 whitespace-pre">
                <span className="w-6 shrink-0 select-none text-right text-muted-foreground">{index + 1}</span>
                <span>{line}</span>
              </li>
            ))}
          </ol>
        ) : null}
        <h2 className="mt-4 font-medium leading-relaxed">{prompt.question}</h2>

        {answering ? (
          <form
            className="mt-4"
            onSubmit={(event) => {
              event.preventDefault();
              commit(false);
            }}
          >
            {challenge.hints.length > 0 ? (
              <div className="mb-3 rounded-md bg-muted p-3 text-sm">
                <ol className="list-decimal space-y-1 pl-5">
                  {challenge.hints.map((hint, index) => (
                    <li key={index}>{hint}</li>
                  ))}
                </ol>
                <p className="mt-2 text-xs text-muted-foreground">
                  You used a hint, so this try will not count as done on your own.
                </p>
              </div>
            ) : null}
            <label htmlFor="practice-answer" className="sr-only">
              Your answer
            </label>
            <textarea
              id="practice-answer"
              value={answer}
              onChange={(event) => setAnswer(event.target.value)}
              maxLength={5000}
              rows={challenge.format === "bug_hunt" ? 7 : 5}
              placeholder={
                challenge.format === "bug_hunt"
                  ? "Name the line and the rule it breaks. Paste a fix if you like."
                  : "Say what happens, and why."
              }
              className={`w-full resize-y rounded-md border border-border bg-background p-3 text-sm leading-relaxed outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                challenge.format === "bug_hunt" ? "font-mono" : ""
              }`}
            />
            <div className="mt-3 flex flex-wrap items-center gap-4">
              <Button type="submit" disabled={pending || !answer.trim()}>
                {pending ? "Checking…" : "Check my answer"}
              </Button>
              {challenge.hintsLeft > 0 ? (
                <button
                  type="button"
                  disabled={pending}
                  onClick={showHint}
                  className="text-sm text-muted-foreground underline-offset-4 hover:underline"
                >
                  Show a hint
                </button>
              ) : null}
              <button
                type="button"
                disabled={pending}
                onClick={() => commit(true)}
                className="text-sm text-muted-foreground underline-offset-4 hover:underline"
              >
                I don&apos;t know
              </button>
            </div>
          </form>
        ) : null}
      </div>

      {error ? (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {error}
        </p>
      ) : null}

      {latest && reveal && !retrying ? (
        <div aria-label="Feedback" role="status" className="mt-4 rounded-xl border border-border p-5">
          <p className="font-medium">{gradeWord(latest)}</p>
          <p className="mt-1 text-sm leading-relaxed">{latest.feedback}</p>
          <h3 className="mt-4 text-xs text-muted-foreground">A full answer</h3>
          <p className="mt-1 text-sm leading-relaxed">{reveal.answer}</p>
          <h3 className="mt-4 text-xs text-muted-foreground">The rule</h3>
          <p className="mt-1 text-sm leading-relaxed">{reveal.rule}</p>
          <Passage evidence={latest.evidence.length > 0 ? latest.evidence : reveal.evidence} />
          <Button variant="outline" className="mt-4" onClick={() => setRetrying(true)}>
            Try again
          </Button>
        </div>
      ) : null}

      {attempts.length > 0 ? (
        <div className="mt-6">
          <h2 className="text-sm font-medium">Your tries</h2>
          <ol className="mt-2 space-y-2">
            {attempts.map((attempt) => (
              <li key={attempt.id} className="rounded-lg border border-border p-3 text-sm">
                <p>
                  <span className="font-medium">
                    Try {attempt.ordinal + 1}: {gradeWord(attempt)}
                  </span>
                  {helpNote(attempt) ? <span className="text-muted-foreground"> · {helpNote(attempt)}</span> : null}
                </p>
                {attempt.failedStep ? (
                  <p className="mt-1 text-xs text-muted-foreground">What was off: {attempt.failedStep}</p>
                ) : null}
                {attempt.dontKnow ? null : (
                  <p
                    className={`mt-2 whitespace-pre-wrap leading-relaxed ${challenge.format === "bug_hunt" ? "font-mono text-xs" : ""}`}
                  >
                    {attempt.answer}
                  </p>
                )}
              </li>
            ))}
          </ol>
        </div>
      ) : null}
    </section>
  );
}
