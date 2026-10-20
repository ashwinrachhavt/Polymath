import { Suspense } from "react";
import { connection } from "next/server";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { getAuthContext } from "@/lib/auth";
import { db } from "@/lib/db";
import { documents } from "@/domains/knowledge/schema";
import { listDecks } from "@/domains/learning/commands";
import { dueItems, proposedItems, type LearningItemView } from "@/domains/learning/queries";
import LearningSurface from "./learning-surface";

export const metadata = { title: "Learning · Polymath" };

/*
 * /alfred/learning: the NotebookLM-style study surface (S4). Decks, the
 * approval queue for generated questions, and the due queue.
 *
 * The per-deck queues are fetched in parallel, bounded to the decks shown. A
 * workspace with many decks would need pagination; at the product's size one
 * page of decks is the whole set.
 */

const MAX_DECKS = 20;

export async function LearningData() {
  await connection();
  if (!process.env.DATABASE_URL?.trim()) {
    return (
      <>
        <PageHeader title="Learning" purpose="Approved questions come back on a schedule." />
        <EmptyState title="No database configured" description="Set DATABASE_URL to read and review decks." />
      </>
    );
  }
  const auth = await getAuthContext();
  const decks = (await listDecks(auth)).slice(0, MAX_DECKS);

  const [dueLists, proposedLists, docs] = await Promise.all([
    Promise.all(decks.map((deck) => dueItems(auth, { deckId: deck.id, limit: 20 }))),
    Promise.all(decks.map((deck) => proposedItems(auth, { deckId: deck.id, limit: 50 }))),
    db
      .select({ id: documents.id, title: documents.title })
      .from(documents)
      .where(and(eq(documents.workspaceId, auth.workspaceId), isNull(documents.archivedAt), sql`${documents.fileId} is not null`))
      .orderBy(desc(documents.createdAt))
      .limit(100),
  ]);

  const dueByDeck: Record<string, LearningItemView[]> = {};
  const proposedByDeck: Record<string, LearningItemView[]> = {};
  decks.forEach((deck, i) => {
    dueByDeck[deck.id] = dueLists[i];
    proposedByDeck[deck.id] = proposedLists[i];
  });

  return <LearningSurface initialDecks={decks} dueByDeck={dueByDeck} proposedByDeck={proposedByDeck} documents={docs} />;
}

export default function LearningPage() {
  return (
    <Suspense fallback={<Skeleton className="m-6 h-64 w-full" />}>
      <LearningData />
    </Suspense>
  );
}
