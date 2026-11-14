import Link from "next/link";
import type { FlashcardStack, QuizHistoryRow } from "@/domains/learning/history";
import { deckReviewHref } from "@/domains/learning/review-href";
import { relativeDay } from "@/lib/relative-day";
import { Button } from "@/components/ui/button";

/*
 * Learn's history: a flashcard stack and a quiz are one row each, to reopen
 * and study again. A stack says how much is due and how far it has been
 * learned; a quiz says how the last sitting and the best one went.
 */

function sourcesLine(sources: string[]): string {
  if (sources.length === 0) return "";
  return sources.length === 1 ? sources[0]! : `${sources[0]} + ${sources.length - 1} more`;
}

function MasteryBar({ stack }: { stack: FlashcardStack }) {
  const pct = (count: number) => (stack.cardCount === 0 ? 0 : Math.round((count / stack.cardCount) * 100));
  return (
    <div
      role="img"
      aria-label={`${stack.rememberedCount} of ${stack.cardCount} cards remembered, ${stack.seenCount} studied`}
      className="relative h-1.5 w-full overflow-hidden rounded-full bg-muted"
    >
      <div className="absolute inset-y-0 left-0 bg-primary/30" style={{ width: `${pct(stack.seenCount)}%` }} />
      <div className="absolute inset-y-0 left-0 bg-primary" style={{ width: `${pct(stack.rememberedCount)}%` }} />
    </div>
  );
}

export function FlashcardStacks({ stacks }: { stacks: FlashcardStack[] }) {
  return (
    <section aria-labelledby="stacks-title" className="panel rounded-xl p-4">
      <h2 id="stacks-title" className="font-medium">
        Flashcards
      </h2>
      {stacks.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">
          No flashcard stacks yet. Use New flashcards or quiz to make one from any sources.
        </p>
      ) : (
        <ul className="mt-3 divide-y divide-border">
          {stacks.map((stack) => (
            <li key={stack.deckId}>
              <Link
                href={deckReviewHref(stack)}
                className="block py-3 first:pt-0 last:pb-0 hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate font-medium">{stack.title}</p>
                    <p className="truncate text-xs text-muted-foreground">{sourcesLine(stack.sources)}</p>
                  </div>
                  {stack.dueCount > 0 ? (
                    <span className="shrink-0 rounded-full border border-border px-2 py-0.5 text-xs tabular-nums">
                      {stack.dueCount} due
                    </span>
                  ) : null}
                </div>
                <div className="mt-2">
                  <MasteryBar stack={stack} />
                </div>
                <p className="mt-1.5 text-xs text-muted-foreground">
                  {stack.cardCount} cards · {stack.rememberedCount} remembered ·{" "}
                  {stack.lastStudiedAt ? `studied ${relativeDay(stack.lastStudiedAt)}` : "not studied yet"}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function QuizHistory({ quizzes }: { quizzes: QuizHistoryRow[] }) {
  return (
    <section aria-labelledby="quiz-title" className="panel mt-4 rounded-xl p-4">
      <h2 id="quiz-title" className="font-medium">
        Quizzes
      </h2>
      {quizzes.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">
          No quizzes ready yet. Use New flashcards or quiz to make one from any sources.
        </p>
      ) : (
        <ul className="mt-3 divide-y divide-border">
          {quizzes.map((quiz) => (
            <li key={quiz.quizId} className="flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
              <div className="min-w-0">
                <p className="truncate font-medium">{quiz.title}</p>
                <p className="text-xs text-muted-foreground tabular-nums">
                  {quiz.latestCorrect === null
                    ? `${quiz.questionCount} questions · not taken yet`
                    : `Latest ${quiz.latestCorrect}/${quiz.questionCount} · best ${quiz.bestCorrect}/${quiz.questionCount} · ${quiz.attempts} ${
                        quiz.attempts === 1 ? "attempt" : "attempts"
                      } · ${relativeDay(quiz.latestAttemptedAt ?? quiz.createdAt)}`}
                </p>
              </div>
              <Button asChild variant="outline" size="sm" className="shrink-0">
                <Link href={`/learn/quizzes/${quiz.quizId}`}>{quiz.latestCorrect === null ? "Take" : "Retake"}</Link>
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
