import { and, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import type { AuthContext } from "@/domains/identity/resolve";
import { getExplainItSession } from "./explain-it";
import { getFlashcardDeck } from "./flashcards";
import type { GenerationOutcome } from "./item-count";
import { getQuizForSitting, type QuizForSitting } from "./queries";
import { explainSessions, flashcardDecks, quizzes } from "./schema";

/*
 * The Notebook's Results: the latest quiz, deck and Explain It session made in
 * one notebook, each with what it needs to open in place. Work counts only
 * while the notebook still holds every source it was pinned to (a removed
 * source's work stays stored, it just stops showing), a failed quiz never
 * shows, and an Explain It session is its learner's alone.
 */

/** How many newest rows to look through for one that passes the source check. */
const LOOK_BACK = 20;

type Held = (pinned: Array<{ documentId: string }>) => boolean;

export type NotebookQuizResult = QuizForSitting & {
  createdAt: Date;
  requested: number | null;
  stoppedBy: GenerationOutcome | null;
};

export type NotebookDeckResult = {
  id: string;
  title: string;
  createdAt: Date;
  /** Every card in the deck. */
  cardCount: number;
  /** The cards due now, in order. */
  cards: NonNullable<Awaited<ReturnType<typeof getFlashcardDeck>>>["cards"];
  requested: number | null;
  stoppedBy: GenerationOutcome | null;
};

export type NotebookExplainResult = NonNullable<Awaited<ReturnType<typeof getExplainItSession>>> & { createdAt: Date };

export type NotebookLearningResults = {
  quiz: NotebookQuizResult | null;
  deck: NotebookDeckResult | null;
  explain: NotebookExplainResult | null;
};

export async function getNotebookLearningResults(
  auth: AuthContext,
  notebookId: string,
  options: { documentIds: string[]; quizId?: string },
): Promise<NotebookLearningResults> {
  const held: Held = (pinned) => pinned.every((pin) => options.documentIds.includes(pin.documentId));
  const [quiz, deck, explain] = await Promise.all([
    latestQuiz(auth, notebookId, held, options.quizId),
    latestDeck(auth, notebookId, held),
    latestExplain(auth, notebookId, held),
  ]);
  return { quiz, deck, explain };
}

async function latestQuiz(
  auth: AuthContext,
  notebookId: string,
  held: Held,
  quizId?: string,
): Promise<NotebookQuizResult | null> {
  const rows = await db
    .select({
      id: quizzes.id,
      documentId: quizzes.documentId,
      sourceManifest: quizzes.sourceManifest,
      createdAt: quizzes.createdAt,
      requested: quizzes.requestedCount,
      stoppedBy: quizzes.stoppedBy,
    })
    .from(quizzes)
    .where(
      and(eq(quizzes.workspaceId, auth.workspaceId), eq(quizzes.notebookId, notebookId), eq(quizzes.status, "ready")),
    )
    .orderBy(desc(quizzes.createdAt))
    .limit(LOOK_BACK);
  const shown = rows.filter((row) =>
    held(row.sourceManifest.length > 0 ? row.sourceManifest : [{ documentId: row.documentId }]),
  );
  // A deep link wins only when it is one of this notebook's own shown quizzes.
  const chosen = shown.find((row) => row.id === quizId) ?? shown[0];
  if (!chosen) return null;
  const full = await getQuizForSitting(auth, chosen.id);
  if (!full) return null;
  return { ...full, createdAt: chosen.createdAt, requested: chosen.requested, stoppedBy: chosen.stoppedBy };
}

async function latestDeck(auth: AuthContext, notebookId: string, held: Held): Promise<NotebookDeckResult | null> {
  const rows = await db
    .select({
      id: flashcardDecks.id,
      sourceManifest: flashcardDecks.sourceManifest,
      createdAt: flashcardDecks.createdAt,
      requested: flashcardDecks.requestedCount,
      stoppedBy: flashcardDecks.stoppedBy,
    })
    .from(flashcardDecks)
    .where(and(eq(flashcardDecks.workspaceId, auth.workspaceId), eq(flashcardDecks.notebookId, notebookId)))
    .orderBy(desc(flashcardDecks.createdAt))
    .limit(LOOK_BACK);
  const chosen = rows.find((row) => held(row.sourceManifest));
  if (!chosen) return null;
  const [all, due] = await Promise.all([getFlashcardDeck(auth, chosen.id), getFlashcardDeck(auth, chosen.id, true)]);
  if (!all || !due) return null;
  return {
    id: all.id,
    title: all.title,
    createdAt: chosen.createdAt,
    cardCount: all.cards.length,
    cards: due.cards,
    requested: chosen.requested,
    stoppedBy: chosen.stoppedBy,
  };
}

async function latestExplain(auth: AuthContext, notebookId: string, held: Held): Promise<NotebookExplainResult | null> {
  const rows = await db
    .select({
      id: explainSessions.id,
      sourceManifest: explainSessions.sourceManifest,
      createdAt: explainSessions.createdAt,
    })
    .from(explainSessions)
    .where(
      and(
        eq(explainSessions.workspaceId, auth.workspaceId),
        eq(explainSessions.notebookId, notebookId),
        eq(explainSessions.userId, auth.userId),
      ),
    )
    .orderBy(desc(explainSessions.createdAt))
    .limit(LOOK_BACK);
  const chosen = rows.find((row) => held(row.sourceManifest));
  if (!chosen) return null;
  const session = await getExplainItSession(auth, notebookId, chosen.id);
  return session ? { ...session, createdAt: chosen.createdAt } : null;
}
