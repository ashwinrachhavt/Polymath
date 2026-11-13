import { connection } from "next/server";
import { getAuthContext } from "@/lib/auth";
import { ratingOf } from "@/domains/feedback/ratings";
import { notFound } from "next/navigation";
import { FlashcardSession } from "../flashcard-session";
import { getNotebookFlashcardDeckAction } from "../flashcard-actions";

export const metadata = { title: "Flashcards · Polymath" };

export default async function NotebookFlashcardsPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await connection();
  const { projectId } = await params;
  const query = await searchParams;
  const deckId = typeof query.deck === "string" ? query.deck : "";
  if (!deckId) notFound();
  const result = await getNotebookFlashcardDeckAction({ projectId, deckId });
  if (!result.ok) notFound();
  const auth = await getAuthContext();
  const rating = await ratingOf(auth, { surface: "flashcards", id: deckId });
  return (
    <div className="page-content">
      <div className="mb-5">
        <a
          href={"/projects/" + projectId + "/notebook"}
          className="text-sm text-muted-foreground underline-offset-4 hover:underline"
        >
          Back to Notebook
        </a>
        <h1 className="mt-2 text-xl font-medium">Flashcards</h1>
      </div>
      <FlashcardSession
        projectId={projectId}
        deckId={deckId}
        title={result.deck.title}
        initialCards={result.deck.cards}
        rating={rating}
      />
    </div>
  );
}
