import { and, desc, eq, sql } from "drizzle-orm";
import type { AuthContext } from "@/domains/identity/resolve";
import { db } from "@/lib/db";
import { flashcardDecks, quizzes } from "./schema";

export type LearningGalleryItem = {
  recordType: "quiz" | "flashcard_deck";
  id: string;
  title: string;
  kind: "quiz" | "flashcards";
  status: "generated" | "failed";
  origin: "run";
  createdAt: Date;
  updatedAt: Date;
  preview: string;
  notebookId: string | null;
  documentId: string | null;
};

export async function listLearningGalleryArtifacts(
  auth: AuthContext,
  input: { kind?: string; status?: string; query?: string; limit?: number; offset?: number } = {},
): Promise<LearningGalleryItem[]> {
  const limit = input.limit ?? 100;
  const offset = input.offset ?? 0;
  const query = input.query?.trim().replace(/[%_]/g, "\\$&");
  const includeQuizzes = !input.kind || input.kind === "quiz";
  const includeFlashcards = !input.kind || input.kind === "flashcards";
  const quizStatuses =
    input.status === "failed"
      ? ["failed"]
      : input.status === "generated"
        ? ["ready"]
        : input.status
          ? []
          : ["ready", "failed"];

  const [quizRows, deckRows] = await Promise.all([
    !includeQuizzes || quizStatuses.length === 0
      ? Promise.resolve([])
      : db
          .select({
            id: quizzes.id,
            title: quizzes.title,
            status: quizzes.status,
            notebookId: quizzes.notebookId,
            documentId: quizzes.documentId,
            createdAt: quizzes.createdAt,
            updatedAt: quizzes.updatedAt,
            preview: sql<string>`coalesce((select qq.prompt from quiz_questions qq where qq.quiz_id = ${quizzes.id} order by qq.ordinal limit 1), '')`,
          })
          .from(quizzes)
          .where(
            and(
              eq(quizzes.workspaceId, auth.workspaceId),
              sql`${quizzes.status} in (${sql.join(
                quizStatuses.map((status) => sql`${status}`),
                sql`, `,
              )})`,
              query
                ? sql`(${quizzes.title} ilike ${`%${query}%`} or exists (select 1 from quiz_questions qq where qq.quiz_id = ${quizzes.id} and qq.prompt ilike ${`%${query}%`}))`
                : sql`true`,
            ),
          )
          .orderBy(desc(quizzes.updatedAt), desc(quizzes.id))
          .limit(limit + offset),
    !includeFlashcards || (input.status !== undefined && input.status !== "" && input.status !== "generated")
      ? Promise.resolve([])
      : db
          .select({
            id: flashcardDecks.id,
            title: flashcardDecks.title,
            notebookId: flashcardDecks.notebookId,
            createdAt: flashcardDecks.createdAt,
            updatedAt: flashcardDecks.updatedAt,
            preview: sql<string>`coalesce((select fc.prompt from flashcards fc where fc.deck_id = ${flashcardDecks.id} order by fc.ordinal limit 1), '')`,
          })
          .from(flashcardDecks)
          .where(
            and(
              eq(flashcardDecks.workspaceId, auth.workspaceId),
              query
                ? sql`(${flashcardDecks.title} ilike ${`%${query}%`} or exists (select 1 from flashcards fc where fc.deck_id = ${flashcardDecks.id} and (fc.prompt ilike ${`%${query}%`} or fc.answer ilike ${`%${query}%`})))`
                : sql`true`,
            ),
          )
          .orderBy(desc(flashcardDecks.updatedAt), desc(flashcardDecks.id))
          .limit(limit + offset),
  ]);

  const items: LearningGalleryItem[] = [
    ...quizRows.map((row) => ({
      recordType: "quiz" as const,
      id: row.id,
      title: row.title,
      kind: "quiz" as const,
      status: row.status === "ready" ? ("generated" as const) : ("failed" as const),
      origin: "run" as const,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      preview: row.preview,
      notebookId: row.notebookId,
      documentId: row.documentId,
    })),
    ...deckRows.map((row) => ({
      recordType: "flashcard_deck" as const,
      id: row.id,
      title: row.title,
      kind: "flashcards" as const,
      status: "generated" as const,
      origin: "run" as const,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      preview: row.preview,
      notebookId: row.notebookId,
      documentId: null,
    })),
  ];
  items.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime() || b.id.localeCompare(a.id));
  return items.slice(offset, offset + limit);
}
