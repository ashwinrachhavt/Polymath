"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import type { StudyItem, StudyOutlook } from "@/domains/learning/study";
import type { StudyAnswerResult } from "@/domains/learning/study";
import { answerStudyQuestionAction, finishStudyAction, rateStudyCardAction } from "./actions";

type Rating = "again" | "hard" | "good" | "easy";
const RATINGS: { value: Rating; label: string }[] = [
  { value: "again", label: "Again" },
  { value: "hard", label: "Hard" },
  { value: "good", label: "Good" },
  { value: "easy", label: "Easy" },
];

type Answer = Omit<StudyAnswerResult, "dueAt">;

/**
 * One item at a time, no choices to make before starting. A card is recalled,
 * revealed and rated; a question is answered and graded on the server. The
 * session ends on what is due tomorrow.
 */
export function StudySession({
  items,
  minutes,
  mission,
}: {
  items: StudyItem[];
  minutes: number;
  mission: StudyOutlook["mission"];
}) {
  const [index, setIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [recalled, setRecalled] = useState(0);
  const [missed, setMissed] = useState(0);
  const [outlook, setOutlook] = useState<StudyOutlook | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const item = items[index];

  function next(wasRecalled: boolean) {
    if (wasRecalled) setRecalled((n) => n + 1);
    else setMissed((n) => n + 1);
    setRevealed(false);
    setAnswer(null);
    setPicked(null);
    setIndex(index + 1);
    if (index + 1 < items.length) return;
    startTransition(async () => {
      const result = await finishStudyAction();
      if (result.ok) setOutlook(result.outlook);
      else setError(result.error);
    });
  }

  function rateCard(card: Extract<StudyItem, { kind: "flashcard" }>, rating: Rating) {
    setError(null);
    startTransition(async () => {
      const result = await rateStudyCardAction({ flashcardId: card.id, rating });
      if (!result.ok) return setError(result.error);
      next(rating !== "again");
    });
  }

  function answerQuestion(question: Extract<StudyItem, { kind: "quiz_question" }>, selectedValue: string | null) {
    setError(null);
    setPicked(selectedValue);
    startTransition(async () => {
      const result = await answerStudyQuestionAction({ questionId: question.id, selectedValue });
      if (!result.ok) {
        setPicked(null);
        return setError(result.error);
      }
      setAnswer(result.answer);
    });
  }

  if (!item)
    return (
      <Summary
        reviewed={items.length}
        recalled={recalled}
        missed={missed}
        outlook={outlook}
        mission={mission}
        error={error}
      />
    );

  return (
    <section aria-label="Study session" className="page-content mx-auto flex w-full max-w-2xl flex-col gap-5">
      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <div
          role="progressbar"
          aria-label="Session progress"
          aria-valuemin={0}
          aria-valuemax={items.length}
          aria-valuenow={index}
          className="h-1 flex-1 overflow-hidden rounded-full bg-muted"
        >
          <div className="h-full bg-primary transition-[width]" style={{ width: `${(index / items.length) * 100}%` }} />
        </div>
        <span>
          {index + 1} of {items.length} · about {minutes} min
        </span>
      </div>

      <article className="rounded-2xl border border-border p-6">
        <p className="mb-3 text-xs text-muted-foreground">{item.source}</p>
        <h1 className="text-lg font-medium leading-relaxed">{item.prompt}</h1>

        {item.kind === "flashcard" ? (
          revealed ? (
            <div className="mt-5 border-t border-border pt-4">
              <p className="leading-relaxed">{item.answer}</p>
              <blockquote className="mt-4 border-l-2 border-border pl-3 text-sm text-muted-foreground">
                {item.quote}
              </blockquote>
              <div className="mt-5 grid grid-cols-4 gap-2">
                {RATINGS.map((rating) => (
                  <Button
                    key={rating.value}
                    variant="outline"
                    disabled={pending}
                    onClick={() => rateCard(item, rating.value)}
                  >
                    {rating.label}
                  </Button>
                ))}
              </div>
            </div>
          ) : (
            <Button className="mt-5" onClick={() => setRevealed(true)}>
              Show answer
            </Button>
          )
        ) : (
          <div className="mt-5 flex flex-col gap-2">
            {item.choices.map((choice) => {
              const isRight = answer?.answerValue === choice.value;
              const isWrongPick = answer && picked === choice.value && !isRight;
              return (
                <Button
                  key={choice.value}
                  variant="outline"
                  disabled={pending || answer !== null}
                  aria-pressed={picked === choice.value}
                  onClick={() => answerQuestion(item, choice.value)}
                  className={`h-auto justify-start whitespace-normal px-3 py-2 text-left ${
                    isRight
                      ? "border-primary bg-primary/10 disabled:opacity-100"
                      : isWrongPick
                        ? "border-destructive bg-destructive/10 disabled:opacity-100"
                        : ""
                  }`}
                >
                  {choice.label}
                </Button>
              );
            })}
            {answer ? (
              <div className="mt-3 border-t border-border pt-4">
                <p className="font-medium">{answer.correct ? "Right." : "Not quite. It comes back soon."}</p>
                <p className="mt-2 text-sm leading-relaxed">{answer.explanation}</p>
                <blockquote className="mt-3 border-l-2 border-border pl-3 text-sm text-muted-foreground">
                  {answer.quote}
                </blockquote>
                <Button className="mt-4" onClick={() => next(answer.correct)}>
                  Next
                </Button>
              </div>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                className="self-start"
                disabled={pending}
                onClick={() => answerQuestion(item, null)}
              >
                I don&apos;t know
              </Button>
            )}
          </div>
        )}
      </article>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function Summary({
  reviewed,
  recalled,
  missed,
  outlook,
  mission,
  error,
}: {
  reviewed: number;
  recalled: number;
  missed: number;
  outlook: StudyOutlook | null;
  mission: StudyOutlook["mission"];
  error: string | null;
}) {
  const nearest = outlook?.mission ?? mission;
  return (
    <section aria-label="Session summary" className="page-content mx-auto flex w-full max-w-2xl flex-col gap-4 py-10">
      <h1 className="text-xl font-medium">Done for now</h1>
      <p className="text-sm text-muted-foreground">
        {reviewed} reviewed · {recalled} recalled
        {missed > 0 ? ` · ${missed} coming back soon` : ""}
      </p>
      <div className="rounded-2xl border border-border p-5">
        {outlook ? (
          <>
            <p className="text-sm text-muted-foreground">Tomorrow</p>
            <p className="text-lg font-medium">
              {outlook.tomorrow} {outlook.tomorrow === 1 ? "item" : "items"} due
            </p>
            {outlook.dueNow > 0 ? (
              <p className="mt-1 text-sm text-muted-foreground">
                {outlook.dueNow} more are due today if you want them.
              </p>
            ) : null}
          </>
        ) : error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : (
          <p role="status" className="text-sm text-muted-foreground">
            Working out what is due tomorrow…
          </p>
        )}
        {nearest ? (
          <p className="mt-3 text-sm">
            {nearest.title}:{" "}
            {nearest.daysLeft === 0 ? "today" : `${nearest.daysLeft} ${nearest.daysLeft === 1 ? "day" : "days"} left`}
          </p>
        ) : null}
      </div>
      <div className="flex gap-2">
        <Button asChild>
          <Link href="/today">Back to Today</Link>
        </Button>
        {outlook && outlook.dueNow > 0 ? (
          <Button asChild variant="outline">
            <Link href="/study" prefetch={false}>
              Keep going
            </Link>
          </Button>
        ) : null}
      </div>
    </section>
  );
}
