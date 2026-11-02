"use client";

import Link from "next/link";
import { useMemo, useRef, useState, useSyncExternalStore, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/workspace/ui";
import { CoachMark } from "@/components/shell/coach-mark";
import type { QuizForSitting } from "@/domains/learning/queries";
import { completeQuizAttemptAction, type StoneAnnouncement } from "../actions";

/*
 * The quiz runner's client island (the reviews-queue mechanics, scaled to a
 * sitting): one question at a time, answers recorded locally, and one
 * completion call that mints an idempotency key per sitting - a retried
 * finish replays the key and reads the recorded attempt instead of earning
 * a second stone.
 *
 * Instant feedback is graded locally against the question's answerValue.
 * The server re-grades on completion, so showing the answer client-side is
 * a UX choice, not a scoring trust. Choices are shuffled per sitting with a
 * Fisher-Yates over values; grading compares values, so the shuffle cannot
 * corrupt a score. The shuffle keys on the hydrated flag (server render and
 * first client render agree on the stored order, so hydration never
 * disagrees with itself) and on the sitting counter (a retake reshuffles).
 */

/** True only after hydration; React's documented two-pass read for values that must not render on the server. */
const useHydrated = () =>
  useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );

function fisherYates<T>(items: T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

type SittingAnswer = { questionId: string; selectedValue: string | null; dontKnow: boolean };

type SittingResult = {
  attemptId: string;
  correctCount: number;
  totalCount: number;
  stoneEarned: boolean;
  replayed: boolean;
  announcement: StoneAnnouncement | null;
};

/**
 * One sitting of a quiz: its answers, shuffle, and completion are all state
 * that resets by remounting with a fresh key - React's documented reset, so
 * a retake needs no manual field-by-field unwind.
 */
export function QuizRunner({ quiz }: { quiz: QuizForSitting }) {
  const [sitting, setSitting] = useState(0);
  return <Sitting key={sitting} quiz={quiz} onRetake={() => setSitting((s) => s + 1)} />;
}

function Sitting({ quiz, onRetake }: { quiz: QuizForSitting; onRetake: () => void }) {
  const hydrated = useHydrated();
  const shuffled = useMemo(
    () => quiz.questions.map((q) => (hydrated ? fisherYates(q.choices) : q.choices)),
    [quiz, hydrated],
  );

  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<SittingAnswer[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [dontKnow, setDontKnow] = useState(false);
  const [result, setResult] = useState<SittingResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  // One key per sitting: a double-finish replays it; a retake mints a fresh
  // one. Never rendered, so server and client need not agree on the value.
  const sittingKey = useRef(crypto.randomUUID());

  const question = quiz.questions[index];
  const answered = dontKnow || selected !== null;
  const isLast = index === quiz.questions.length - 1;
  const correctChoice = question.choices.find((c) => c.value === question.answerValue) ?? null;

  const record = (chosen: SittingAnswer) => {
    setAnswers((prev) => [...prev, chosen]);
  };

  const choose = (value: string) => {
    if (answered) return;
    setSelected(value);
    record({ questionId: question.id, selectedValue: value, dontKnow: false });
  };

  const giveUp = () => {
    if (answered) return;
    setDontKnow(true);
    record({ questionId: question.id, selectedValue: null, dontKnow: true });
  };

  const advance = () => {
    setSelected(null);
    setDontKnow(false);
    if (isLast) {
      startTransition(async () => {
        const response = await completeQuizAttemptAction({
          quizId: quiz.id,
          answers,
          idempotencyKey: sittingKey.current,
        });
        if (!response.ok) {
          setError(response.error);
          return;
        }
        setError(null);
        setResult({
          attemptId: response.result.attemptId,
          correctCount: response.result.correctCount,
          totalCount: response.result.totalCount,
          stoneEarned: response.result.stoneEarned,
          replayed: response.result.replayed,
          announcement: response.announcement,
        });
      });
    } else {
      setIndex(index + 1);
    }
  };

  const retake = () => {
    // Remounts this component with a fresh key: state, shuffle, and the
    // idempotency key all reset together.
    onRetake();
  };

  if (result) {
    return (
      <Panel title="Sitting complete">
        <p className="readout text-2xl">
          {result.correctCount} of {result.totalCount}
        </p>
        <div className="relative mt-2">
          <p className="text-[13px]">
            {result.stoneEarned
              ? "+10 stones for finishing this quiz."
              : result.replayed
                ? "This sitting was already recorded - the stone it earned was not awarded twice."
                : "No stone for this sitting."}
          </p>
          {result.announcement ? (
            <CoachMark
              id={`stone-${result.announcement.id}`}
              title={result.announcement.milestone ? "Milestone reached" : "Stone earned"}
              actionLabel="Keep learning"
            >
              {result.announcement.label} · +{result.announcement.points} pts ·{" "}
              {result.announcement.reason.replaceAll("_", " ")}. The collection lives on the rewards page.
            </CoachMark>
          ) : null}
        </div>

        <ul className="mt-4 flex flex-col gap-2">
          {quiz.questions.map((q) => {
            const answer = answers.find((a) => a.questionId === q.id);
            const correct = !!answer && !answer.dontKnow && answer.selectedValue === q.answerValue;
            const gap = !!answer?.dontKnow;
            return (
              <li key={q.id} className="flex flex-col gap-0.5 rounded-md px-2 py-1.5 text-[13px] odd:bg-muted/40">
                <span className="flex items-start gap-2">
                  <span
                    aria-hidden
                    className={
                      correct ? "text-teal-600 dark:text-teal-400" : gap ? "text-muted-foreground" : "text-destructive"
                    }
                  >
                    {correct ? "✓" : gap ? "·" : "✗"}
                  </span>
                  <span className="min-w-0 flex-1">{q.prompt}</span>
                  {gap ? <span className="shrink-0 text-xs text-muted-foreground">I didn&apos;t know</span> : null}
                </span>
              </li>
            );
          })}
        </ul>

        <div className="mt-4 flex gap-2">
          <Button type="button" size="sm" variant="outline" onClick={retake}>
            Retake
          </Button>
          <Button type="button" size="sm" variant="outline" asChild>
            <Link href="/learn">Back to Learn</Link>
          </Button>
        </div>
        {error ? (
          <p role="alert" className="mt-2 text-[13px] text-destructive">
            {error}
          </p>
        ) : null}
      </Panel>
    );
  }

  return (
    <Panel title={quiz.title} description={`Question ${index + 1} of ${quiz.questions.length}`}>
      <p className="text-[15px] font-medium">{question.prompt}</p>

      <div role="group" aria-label="Answer choices" className="mt-3 flex flex-col gap-2">
        {(shuffled[index] ?? question.choices).map((choice) => {
          const isAnswer = question.answerValue === choice.value;
          const isChosen = selected === choice.value;
          const mark = answered ? (isAnswer ? "✓" : isChosen ? "✗" : "") : "";
          return (
            <button
              key={choice.value}
              type="button"
              disabled={answered}
              onClick={() => choose(choice.value)}
              className={
                "flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-left text-[13px] transition-colors " +
                (answered && isAnswer
                  ? "border-teal-600/60 bg-teal-50 dark:border-teal-400/40 dark:bg-teal-950/30"
                  : answered && isChosen
                    ? "border-destructive/60 bg-destructive/5"
                    : answered
                      ? "border-border text-muted-foreground"
                      : "border-border hover:border-foreground/30 hover:bg-muted")
              }
            >
              <span>{choice.label}</span>
              {mark ? (
                <span aria-hidden className={isAnswer ? "text-teal-600 dark:text-teal-400" : "text-destructive"}>
                  {mark}
                </span>
              ) : null}
            </button>
          );
        })}

        <div className="mt-1 border-t border-dashed border-border pt-3">
          <button
            type="button"
            disabled={answered}
            onClick={giveUp}
            className={
              "flex w-full items-center justify-between gap-3 rounded-md border border-dashed px-3 py-2 text-left text-[13px] transition-colors " +
              (answered && dontKnow
                ? "border-border bg-muted/60 text-foreground"
                : answered
                  ? "border-border text-muted-foreground"
                  : "border-border text-muted-foreground hover:border-foreground/30 hover:text-foreground")
            }
          >
            <span>I don&apos;t know</span>
            {dontKnow ? (
              <span aria-hidden className="text-muted-foreground">
                ·
              </span>
            ) : null}
          </button>
        </div>
      </div>

      {answered ? (
        <div className="mt-4 rounded-md border border-border bg-muted/40 p-3" role="status">
          {dontKnow ? (
            <p className="text-[13px]">
              Kept as an honest gap. The correct answer is: <span className="font-medium">{correctChoice?.label}</span>
            </p>
          ) : selected === question.answerValue ? (
            <p className="text-[13px] font-medium">Correct!</p>
          ) : (
            <p className="text-[13px]">
              Incorrect. The correct answer is: <span className="font-medium">{correctChoice?.label}</span>
            </p>
          )}
          <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground">{question.explanation}</p>
          {question.evidence.quote ? (
            <p className="mt-2 border-l-2 border-border pl-3 text-xs italic leading-relaxed text-muted-foreground">
              From the document: {question.evidence.quote}
            </p>
          ) : null}
          <div className="mt-3">
            <Button type="button" size="sm" disabled={pending} onClick={advance}>
              {isLast ? (pending ? "Recording…" : "Finish") : "Next question"}
            </Button>
          </div>
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="mt-3 text-[13px] text-destructive">
          {error}
        </p>
      ) : null}
    </Panel>
  );
}
