import Link from "next/link";
import { Suspense } from "react";
import { connection } from "next/server";
import type { Metadata } from "next";
import { getAuthContext } from "@/lib/auth";
import { getLearnLibrary } from "@/domains/learning/queries";
import { getFlashcardDueQueue } from "@/domains/learning/flashcards";
import { getUpNext } from "@/domains/learning/up-next";
import { UpNextCard } from "@/app/(workspace)/polymath/up-next-card";
import { Skeleton } from "@/components/ui/skeleton";

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
  // Home's Up next card leads, so both pages agree on where Continue goes;
  // the lists below are everything behind it.
  const [upNext, library, dueCards] = await Promise.all([
    getUpNext(auth),
    getLearnLibrary(auth),
    getFlashcardDueQueue(auth, 40),
  ]);
  const quizzes = library.filter((item) => item.quizId);

  return (
    <main className="page-content mx-auto w-full max-w-4xl">
      <header className="mb-6">
        <h1 className="text-2xl font-medium">Learn</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Continue a quiz or review flashcards due across your Notebooks.
        </p>
      </header>
      <div className="mb-4">
        <UpNextCard upNext={upNext} />
      </div>
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
                <Link
                  href={"/projects/" + item.notebookId + "/notebook/flashcards?deck=" + item.deckId}
                  className="font-medium underline-offset-4 hover:underline"
                >
                  {item.notebookTitle}: {item.deckTitle}
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
            No quizzes ready yet. Create one from selected sources inside a Notebook.
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
      <p className="mt-4 text-sm text-muted-foreground">
        Create quizzes and flashcards from pinned sources in a{" "}
        <Link href="/projects" className="underline underline-offset-4">
          Notebook
        </Link>
        .
      </p>
    </main>
  );
}
