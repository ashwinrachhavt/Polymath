import Link from "next/link";
import { Suspense } from "react";
import { connection } from "next/server";
import type { Metadata } from "next";
import { getAuthContext } from "@/lib/auth";
import { listUnfinishedGenerationJobs } from "@/domains/jobs/queries";
import { LEARNING_JOB_KIND_PREFIX } from "@/domains/learning/job-names";
import { listFlashcardStacks, listQuizHistory } from "@/domains/learning/history";
import { getConceptOverview } from "@/domains/learning/concept-overview";
import { listMissions } from "@/domains/learning/missions";
import { getStoneProgress } from "@/domains/stones/queries";
import { CoinGlyph, formatCoins } from "@/components/stones/coin";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ConceptOverviewSection } from "./concept-overview";
import { MissionList } from "./missions/mission-list";
import { LearnJobs } from "./learn-jobs";
import { MakeLearningButton } from "./make-learning-dialog";
import { FlashcardStacks, QuizHistory } from "./stacks";

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
  const [stacks, quizzes, jobs, overview, missions, stones] = await Promise.all([
    listFlashcardStacks(auth),
    listQuizHistory(auth),
    listUnfinishedGenerationJobs(auth, { kindPrefix: LEARNING_JOB_KIND_PREFIX }),
    getConceptOverview(auth),
    listMissions(auth),
    getStoneProgress(auth),
  ]);

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
      <Tabs defaultValue="stacks" className="mt-4">
        <TabsList>
          <TabsTrigger value="stacks">Stacks</TabsTrigger>
          <TabsTrigger value="concepts">Concepts</TabsTrigger>
        </TabsList>
        <TabsContent value="stacks">
          <FlashcardStacks stacks={stacks} />
          <QuizHistory quizzes={quizzes} />
        </TabsContent>
        <TabsContent value="concepts">
          <ConceptOverviewSection overview={overview} />
        </TabsContent>
      </Tabs>
    </main>
  );
}
