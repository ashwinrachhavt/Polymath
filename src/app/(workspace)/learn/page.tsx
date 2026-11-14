import Link from "next/link";
import { Suspense } from "react";
import { connection } from "next/server";
import type { Metadata } from "next";
import { getAuthContext } from "@/lib/auth";
import { listUnfinishedGenerationJobs } from "@/domains/jobs/queries";
import { LEARNING_JOB_KIND_PREFIX } from "@/domains/learning/job-names";
import { getLearnLibrary } from "@/domains/learning/queries";
import { getConceptOverview } from "@/domains/learning/concept-overview";
import { listMissions } from "@/domains/learning/missions";
import { getFlashcardDueQueue } from "@/domains/learning/flashcards";
import { deckReviewHref } from "@/domains/learning/review-href";
import { getStoneProgress } from "@/domains/stones/queries";
import { CoinGlyph, formatCoins } from "@/components/stones/coin";
import { Skeleton } from "@/components/ui/skeleton";
import { ConceptOverviewSection } from "./concept-overview";
import { MissionList } from "./missions/mission-list";
import { LearnJobs } from "./learn-jobs";
import { MakeLearningButton } from "./make-learning-dialog";

export const metadata: Metadata = { title: "Learn · Polymath" };

// The queue reads per-request data, so it streams behind a skeleton instead of
// blocking the whole navigation (cacheComponents: blocking-prerender-dynamic).
export default function LearnPage() {
  return (
    <Suspense
      fallback={
        <div
          role="status"
          aria-label="Loading Learn"
          className="page-content mx-auto flex w-full max-w-4xl flex-col gap-4"
        >
          <Skeleton className="h-8 w-40" />
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-28 w-full" />
        </div>
      }
    >
      <LearnSurface />
    </Suspense>
  );
}

async function LearnSurface() {
  await connection();
  const auth = await getAuthContext();
  const [library, dueCards, jobs, overview, missions, stones] = await Promise.all([
    getLearnLibrary(auth),
    getFlashcardDueQueue(auth, 40),
    listUnfinishedGenerationJobs(auth, { kindPrefix: LEARNING_JOB_KIND_PREFIX }),
    getConceptOverview(auth),
    listMissions(auth),
    getStoneProgress(auth),
  ]);
  const quizzes = library.filter((item) => item.quizId);

  return (
    <main className="page-content mx-auto w-full max-w-4xl">
      <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h1 className="min-w-0 text-2xl font-medium">Learn</h1>
        <div className="flex items-center gap-4">
          <Link
            href="/learn/stones"
            className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
            aria-label={`${stones.balance} coins, ${stones.owned} of ${stones.total} stones collected`}
          >
            <CoinGlyph />
            <span className="tabular-nums text-foreground">{formatCoins(stones.balance)}</span>
            <span className="tabular-nums">
              · {stones.owned}/{stones.total} stones
            </span>
          </Link>
          <MakeLearningButton />
        </div>
      </header>
      <LearnJobs initialJobs={jobs} kindPrefix={LEARNING_JOB_KIND_PREFIX} />
      <MissionList missions={missions} />
      <ConceptOverviewSection overview={overview} />
      <section aria-labelledby="due-flashcards-title" className="panel rounded-xl p-4">
        <h2 id="due-flashcards-title" className="font-medium">
          Flashcards due
        </h2>
        {dueCards.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">No flashcards are due right now.</p>
        ) : (
          <ul className="mt-3 divide-y divide-border">
            {dueCards.map((item) => (
              <li key={item.flashcardId} className="py-3 first:pt-0 last:pb-0">
                <Link href={deckReviewHref(item)} className="font-medium underline-offset-4 hover:underline">
                  {item.notebookTitle ? `${item.notebookTitle}: ${item.deckTitle}` : item.deckTitle}
                </Link>
                <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{item.prompt}</p>
              </li>
            ))}
          </ul>
        )}
      </section>
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
            {quizzes.map((item) => (
              <li key={item.quizId} className="flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
                <div className="min-w-0">
                  <p className="truncate font-medium">{item.title}</p>
                  <p className="text-xs text-muted-foreground">
                    {item.bestCorrect === null
                      ? "Not started"
                      : "Best score " + item.bestCorrect + "/" + item.questionCount}
                  </p>
                </div>
                <Link href={"/learn/" + item.documentId} className="shrink-0 text-sm underline underline-offset-4">
                  Continue
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
