"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { CoinsEarned } from "@/components/stones/coins-earned";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { WorkStatus } from "@/components/work-status";
import type { MockSessionView } from "@/domains/learning/mission-mock";
import type { MissionView } from "@/domains/learning/missions";
import { answerMockQuestionAction } from "./mock-actions";

/*
 * The unaided sitting. Nothing about the answer is revealed until it is
 * submitted: the next question's text is not on the page and there is no
 * hint control. One question at a time, in the order the plan was made.
 * An uncertain verdict reads "Needs your own check", never a pass.
 */

const VERDICT_COPY: Record<string, string> = {
  correct: "Correct with no help",
  partial: "Partly right",
  incorrect: "Not right yet",
  uncertain: "Needs your own check",
};

export function MockInterviewSession({ mission, session }: { mission: MissionView; session: MockSessionView }) {
  const router = useRouter();
  const [answer, setAnswer] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [coinsEarned, setCoinsEarned] = useState(0);

  if (session.status === "preparing") {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        {session.error ?? "Writing your questions from your sources. This page updates when it is ready."}
      </p>
    );
  }
  const current = session.questions.find((question) => question.answer === null);
  const answered = session.questions.filter((question) => question.answer !== null);

  function submit() {
    if (!current || !answer.trim() || pending) return;
    setError(null);
    startTransition(async () => {
      const result = await answerMockQuestionAction({
        missionId: mission.id,
        sessionId: session.id,
        questionId: current.id,
        answer,
      }).catch(() => ({ ok: false as const, error: "The request did not reach Polymath. Try again." }));
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setAnswer("");
      setCoinsEarned(result.coinsEarned);
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-3">
      {answered.length > 0 ? (
        <ol className="flex flex-col gap-2">
          {answered.map((question) => (
            <li key={question.id} className="rounded-lg border border-border p-3">
              <p className="text-xs text-muted-foreground">
                Question {question.ordinal + 1} · {question.conceptName}
              </p>
              <p className="mt-1 font-medium">{question.prompt}</p>
              <p className="mt-2 whitespace-pre-wrap text-sm">{question.answer}</p>
              <p className="mt-2 text-sm font-medium">{VERDICT_COPY[question.grade ?? "uncertain"]}</p>
              {question.feedback ? <p className="mt-1 text-sm text-muted-foreground">{question.feedback}</p> : null}
              {question.evidence.length > 0 ? (
                <ul className="mt-2 flex flex-col gap-1">
                  {question.evidence.map((quote, index) => (
                    <li key={index} className="border-l-2 border-border pl-3 text-xs text-muted-foreground">
                      “{quote.quote}” <span className="block">{quote.source.title}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
        </ol>
      ) : null}
      {current ? (
        <div className="rounded-lg border border-border p-3">
          <p className="text-xs text-muted-foreground">
            Question {current.ordinal + 1} of {session.questions.length} · {current.conceptName}
          </p>
          <p className="mt-1 font-medium">{current.prompt}</p>
          <Textarea
            value={answer}
            onChange={(event) => setAnswer(event.target.value)}
            rows={4}
            placeholder="Answer from memory. Nothing is revealed until you submit."
            aria-label="Your answer"
            className="mt-2"
            disabled={pending}
          />
          {error ? <WorkStatus state={{ phase: "failed", label: error }} /> : null}
          <Button className="mt-2" disabled={pending || !answer.trim()} onClick={submit}>
            {pending ? "Checking…" : "Submit answer"}
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <p role="status" className="text-sm text-muted-foreground">
            Every question is answered. Your report is shown below.
          </p>
          {coinsEarned > 0 ? <CoinsEarned coins={coinsEarned} /> : null}
        </div>
      )}
    </div>
  );
}
