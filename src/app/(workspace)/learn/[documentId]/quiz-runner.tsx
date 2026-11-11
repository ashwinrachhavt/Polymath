"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Panel } from "@/components/workspace/ui";
import { CoachMark } from "@/components/shell/coach-mark";
import { ArtifactFeedback } from "@/app/(workspace)/artifacts/[artifactId]/artifact-feedback";
import type { ArtifactRating } from "@/domains/knowledge/artifact-feedback";
import type { QuizForSitting } from "@/domains/learning/queries";
import type { QuizPassage } from "@/domains/learning/quiz-passages";
import { completeQuizAttemptAction, type StoneAnnouncement } from "../actions";

/*
 * The quiz runner's client island (the reviews-queue mechanics, scaled to a
 * sitting): one question at a time, answers recorded locally, and one
 * completion call that mints an idempotency key per sitting - a retried
 * finish replays the key and reads the recorded attempt instead of earning
 * a second stone.
 *
 * Read first: when the quiz has passages and the learner has not turned it
 * off, the sitting walks each passage and then that passage's questions;
 * questions with no passage come last. Only questions are steps that count,
 * and every question is asked once in either order.
 *
 * Instant feedback is graded locally against the question's answerValue.
 * The server re-grades on completion, so showing the answer client-side is
 * a UX choice, not a scoring trust. Choices are shuffled per sitting with a
 * Fisher-Yates over values; grading compares values, so the shuffle cannot
 * corrupt a score. The shuffle keys on the hydrated flag (server render and
 * first client render agree on the stored order, so hydration never
 * disagrees with itself) and on the sitting counter (a retake reshuffles).
 * The shuffle is keyed by question id, so the reading order cannot move it.
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

const READ_FIRST_KEY = "axiom.quiz.read-first";
const READ_FIRST_LABEL = "Read the passage before each question";

/** The stored preference, on unless this browser turned it off. Storage can throw (blocked site data). */
function storedReadFirst(): boolean {
  try {
    return window.localStorage.getItem(READ_FIRST_KEY) !== "off";
  } catch {
    return true;
  }
}

function storeReadFirst(on: boolean) {
  try {
    window.localStorage.setItem(READ_FIRST_KEY, on ? "on" : "off");
  } catch {
    // The choice still holds for this sitting; it just is not remembered.
  }
}

/** One screen of a sitting. `number` counts passages or questions, never both. */
type Step =
  | { kind: "passage"; passage: QuizPassage; number: number }
  | { kind: "question"; questionIndex: number; number: number; passageStep: number | null };

function sittingSteps(quiz: QuizForSitting, readFirst: boolean): Step[] {
  const indexById = new Map(quiz.questions.map((q, i) => [q.id, i]));
  const asked = new Set<number>();
  const steps: Step[] = [];
  const ask = (questionIndex: number, passageStep: number | null) => {
    asked.add(questionIndex);
    steps.push({ kind: "question", questionIndex, number: asked.size, passageStep });
  };
  if (readFirst) {
    quiz.passages.forEach((passage, n) => {
      const passageStep = steps.length;
      steps.push({ kind: "passage", passage, number: n + 1 });
      for (const id of passage.questionIds) {
        const index = indexById.get(id);
        if (index !== undefined && !asked.has(index)) ask(index, passageStep);
      }
    });
  }
  quiz.questions.forEach((_, index) => {
    if (!asked.has(index)) ask(index, null);
  });
  return steps;
}

type SittingAnswer = { questionId: string; selectedValue: string | null; dontKnow: boolean };

type SittingResult = {
  attemptId: string;
  correctCount: number;
  totalCount: number;
  stoneEarned: boolean;
  emeraldEarned: boolean;
  replayed: boolean;
  announcement: StoneAnnouncement | null;
};

/**
 * One sitting of a quiz: its answers, shuffle, and completion are all state
 * that resets by remounting with a fresh key - React's documented reset, so
 * a retake needs no manual field-by-field unwind.
 */
export function QuizRunner({ quiz, rating }: { quiz: QuizForSitting; rating: ArtifactRating | null }) {
  const [sitting, setSitting] = useState(0);
  return <Sitting key={sitting} quiz={quiz} rating={rating} onRetake={() => setSitting((s) => s + 1)} />;
}

function Sitting({
  quiz,
  rating,
  onRetake,
}: {
  quiz: QuizForSitting;
  rating: ArtifactRating | null;
  onRetake: () => void;
}) {
  const hydrated = useHydrated();
  const shuffled = useMemo(
    () => new Map(quiz.questions.map((q) => [q.id, hydrated ? fisherYates(q.choices) : q.choices])),
    [quiz, hydrated],
  );

  const stored = useSyncExternalStore(
    () => () => {},
    storedReadFirst,
    () => true,
  );
  // Set by the toggle, and pinned at the first answer so the order cannot
  // change under a sitting in progress.
  const [readFirstChoice, setReadFirstChoice] = useState<boolean | null>(null);
  const hasPassages = quiz.passages.length > 0;
  const readFirst = (readFirstChoice ?? stored) && hasPassages;
  const steps = useMemo(() => sittingSteps(quiz, readFirst), [quiz, readFirst]);
  const [stepIndex, setStepIndex] = useState(0);
  // The passage step a learner went back to from an unanswered question.
  const [rereading, setRereading] = useState<number | null>(null);
  const [answers, setAnswers] = useState<SittingAnswer[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [dontKnow, setDontKnow] = useState(false);
  const [result, setResult] = useState<SittingResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  // One key per sitting: a double-finish replays it; a retake mints a fresh
  // one. Never rendered, so server and client need not agree on the value.
  const sittingKey = useRef(crypto.randomUUID());

  const step = steps[rereading ?? stepIndex];
  const questionStep = steps[stepIndex];
  // Read only on a question step; a passage step never renders it.
  const question = quiz.questions[questionStep.kind === "question" ? questionStep.questionIndex : 0];
  const answered = dontKnow || selected !== null;
  // The last step is always a question: every passage is followed by its own.
  const isLast = stepIndex === steps.length - 1;
  const correctChoice = question.choices.find((c) => c.value === question.answerValue) ?? null;

  const record = (chosen: SittingAnswer) => {
    setReadFirstChoice(readFirst);
    setAnswers((prev) => [...prev, chosen]);
  };

  const changeReadFirst = (on: boolean) => {
    if (answers.length > 0) return;
    setReadFirstChoice(on);
    storeReadFirst(on);
    setStepIndex(0);
    setRereading(null);
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
          emeraldEarned: response.result.emeraldEarned,
          replayed: response.result.replayed,
          announcement: response.announcement,
        });
      });
    } else {
      setStepIndex(stepIndex + 1);
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
          <p className="text-body-dense">
            {result.emeraldEarned
              ? "Every answer right: an emerald, plus +10 stones."
              : result.stoneEarned
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
              <li key={q.id} className="flex flex-col gap-0.5 rounded-md px-2 py-1.5 text-body-dense odd:bg-muted/40">
                <span className="flex items-start gap-2">
                  <span
                    aria-hidden
                    className={correct ? "text-(--tone-teal)" : gap ? "text-muted-foreground" : "text-destructive"}
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

        <ArtifactFeedback target={{ kind: "quiz", id: quiz.id }} rating={rating} />
        <div className="mt-4 flex gap-2">
          <Button type="button" size="sm" variant="outline" onClick={retake}>
            Retake
          </Button>
          <Button type="button" size="sm" variant="outline" asChild>
            <Link href="/learn">Back to Learn</Link>
          </Button>
        </div>
        {error ? (
          <p role="alert" className="mt-2 text-body-dense text-destructive">
            {error}
          </p>
        ) : null}
      </Panel>
    );
  }

  const readFirstToggle = hasPassages ? (
    <div className="mb-2 flex items-center justify-end gap-2 text-xs text-muted-foreground">
      <span aria-hidden>{READ_FIRST_LABEL}</span>
      <Switch
        checked={readFirst}
        disabled={answers.length > 0}
        aria-label={READ_FIRST_LABEL}
        onCheckedChange={changeReadFirst}
      />
    </div>
  ) : null;

  if (step.kind === "passage") {
    return (
      <div>
        {readFirstToggle}
        <PassageScreen
          key={step.passage.id}
          quizTitle={quiz.title}
          passage={step.passage}
          number={step.number}
          total={quiz.passages.length}
          onContinue={() => (rereading === null ? setStepIndex(stepIndex + 1) : setRereading(null))}
        />
      </div>
    );
  }

  const passageStep = step.passageStep;
  return (
    <div>
      {readFirstToggle}
      <Panel
        title={quiz.title}
        description={`Question ${step.number} of ${quiz.questions.length}`}
        actions={
          passageStep !== null && !answered ? (
            <Button type="button" size="sm" variant="ghost" onClick={() => setRereading(passageStep)}>
              Re-read the passage
            </Button>
          ) : null
        }
      >
        <p className="text-body font-medium">{question.prompt}</p>

        <div role="group" aria-label="Answer choices" className="mt-3 flex flex-col gap-2">
          {(shuffled.get(question.id) ?? question.choices).map((choice) => {
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
                  "flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-left text-body-dense transition-colors " +
                  (answered && isAnswer
                    ? "border-(--tone-teal-wash)/60 bg-(--tone-teal-wash)/10"
                    : answered && isChosen
                      ? "border-destructive/60 bg-destructive/5"
                      : answered
                        ? "border-border text-muted-foreground"
                        : "border-border hover:border-foreground/30 hover:bg-muted")
                }
              >
                <span>{choice.label}</span>
                {mark ? (
                  <span aria-hidden className={isAnswer ? "text-(--tone-teal)" : "text-destructive"}>
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
                "flex w-full items-center justify-between gap-3 rounded-md border border-dashed px-3 py-2 text-left text-body-dense transition-colors " +
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
              <p className="text-body-dense">
                Kept as an honest gap. The correct answer is:{" "}
                <span className="font-medium">{correctChoice?.label}</span>
              </p>
            ) : selected === question.answerValue ? (
              <p className="text-body-dense font-medium">Correct!</p>
            ) : (
              <p className="text-body-dense">
                Incorrect. The correct answer is: <span className="font-medium">{correctChoice?.label}</span>
              </p>
            )}
            <p className="mt-2 text-body-dense leading-relaxed text-muted-foreground">{question.explanation}</p>
            {question.evidence.quote ? (
              <p className="mt-2 border-l-2 border-border pl-3 text-xs italic leading-relaxed text-muted-foreground">
                From {question.evidence.source?.title ?? "the document"}: {question.evidence.quote}
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
          <p role="alert" className="mt-3 text-body-dense text-destructive">
            {error}
          </p>
        ) : null}
      </Panel>
    </div>
  );
}

/** A passage on its own screen. Focus moves to its heading so a screen reader starts reading here. */
function PassageScreen({
  quizTitle,
  passage,
  number,
  total,
  onContinue,
}: {
  quizTitle: string;
  passage: QuizPassage;
  number: number;
  total: number;
  onContinue: () => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);
  return (
    <Panel title={quizTitle} description={`Passage ${number} of ${total}`}>
      <h3
        ref={heading}
        tabIndex={-1}
        className="text-xs font-medium tracking-wide text-muted-foreground uppercase outline-none"
      >
        {passage.sourceTitle}
      </h3>
      <p className="mt-2 max-w-[var(--measure-prose)] font-[family-name:var(--font-reading)] text-ui leading-relaxed whitespace-pre-wrap">
        {passage.body}
      </p>
      <div className="mt-4">
        <Button type="button" onClick={onContinue}>
          Continue
        </Button>
      </div>
    </Panel>
  );
}
