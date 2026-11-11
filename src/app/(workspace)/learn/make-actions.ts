"use server";

import { revalidatePath, updateTag } from "next/cache";
import { z } from "zod";
import { ConflictError, StaleWriteError } from "@/domains/capture/commands";
import { documentForCapture } from "@/domains/capture/document-source";
import { searchCaptures } from "@/domains/capture/queries";
import { FlashcardError, generateFlashcardDeck } from "@/domains/learning/flashcards";
import { GENERATION_COPY, generateQuiz, QuizGenerationError } from "@/domains/learning/generate-quiz";
import {
  describeGenerationOutcome,
  MAX_ITEM_COUNT,
  MAX_LEARNING_SOURCES,
  MIN_ITEM_COUNT,
} from "@/domains/learning/item-count";
import { searchLearningDocuments } from "@/domains/learning/queries";
import { actionError } from "@/lib/action-error";
import { getAuthContext, type AuthContext } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";
import { capturesTag } from "@/lib/cache-tags";

/*
 * Flashcards or a quiz from any sources, with no Notebook in between. A
 * source is a library document or an inbox capture; a capture is filed to
 * the library first (documentForCapture), because learning reads documents.
 * Both verbs return typed unions with authored copy: nothing thrown reaches
 * the client.
 */

/** A source the learner picked. A capture carries the version they saw, since picking it may file it. */
export type LearningSourceRef = { type: "document"; id: string } | { type: "capture"; id: string; version: number };

/** One row of the source picker. */
export type LearningSourceOption =
  | { type: "document"; id: string; title: string; ready: boolean }
  | { type: "capture"; id: string; version: number; title: string };

export type MakeLearningResult =
  { ok: true; href: string; summary: string } | { ok: false; error: string; failedSourceId?: string };

const PICKER_LIMIT = 25;

const findSchema = z.object({ query: z.string().max(200) });

export async function findLearningSourcesAction(
  input: z.input<typeof findSchema>,
): Promise<
  { ok: true; documents: LearningSourceOption[]; captures: LearningSourceOption[] } | { ok: false; error: string }
> {
  const parsed = findSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Search with a shorter phrase." };
  const auth = await authorize();
  try {
    const query = parsed.data.query;
    const [documents, captures] = await Promise.all([
      searchLearningDocuments(auth, { query, limit: PICKER_LIMIT }),
      searchCaptures(auth, { filter: "unprocessed", query, limit: PICKER_LIMIT, offset: 0 }),
    ]);
    return {
      ok: true,
      documents: documents.map((doc) => ({ type: "document", ...doc })),
      captures: captures.items.map((row) => ({
        type: "capture",
        id: row.id,
        version: row.version,
        title: row.title?.trim() || row.preview?.trim().split("\n")[0] || row.url || "Untitled capture",
      })),
    };
  } catch (error) {
    return { ok: false, error: actionError(error, "Could not load your sources.") };
  }
}

const sourceSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("document"), id: z.uuid() }),
  z.object({ type: z.literal("capture"), id: z.uuid(), version: z.number().int().min(0) }),
]);

const makeSchema = z.object({
  kind: z.enum(["flashcards", "quiz"]),
  sources: z.array(sourceSchema).min(1).max(MAX_LEARNING_SOURCES),
  count: z.number().int().min(MIN_ITEM_COUNT).max(MAX_ITEM_COUNT).optional(),
  idempotencyKey: z.uuid(),
});

export async function makeFlashcardsOrQuizAction(input: z.input<typeof makeSchema>): Promise<MakeLearningResult> {
  const parsed = makeSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: `Choose one to ${MAX_LEARNING_SOURCES} sources, and ${MIN_ITEM_COUNT} to ${MAX_ITEM_COUNT} items or leave the count blank.`,
    };
  }
  const { kind, sources, count, idempotencyKey } = parsed.data;
  const auth = await authorize();
  try {
    const resolved = await resolveDocumentIds(auth, sources);
    if (!resolved.ok) return resolved;
    const documentIds = resolved.documentIds;

    if (kind === "flashcards") {
      const deck = await generateFlashcardDeck(auth, { documentIds, cardCount: count, idempotencyKey });
      revalidatePath("/learn");
      return {
        ok: true,
        href: `/learn/decks/${deck.deckId}`,
        summary: describeGenerationOutcome(
          { one: "flashcard", many: "flashcards" },
          { made: deck.cardCount, requested: deck.requested, stoppedBy: deck.stoppedBy },
        ),
      };
    }
    const quiz = await generateQuiz(auth, {
      documentId: documentIds[0],
      documentIds,
      questionCount: count,
      idempotencyKey,
    });
    revalidatePath("/learn");
    return {
      ok: true,
      href: `/learn/quizzes/${quiz.quizId}`,
      summary: describeGenerationOutcome(
        { one: "question", many: "questions" },
        { made: quiz.questionCount, requested: quiz.requested, stoppedBy: quiz.stoppedBy },
      ),
    };
  } catch (error) {
    if (error instanceof FlashcardError) return { ok: false, error: error.message };
    if (error instanceof QuizGenerationError) return { ok: false, error: GENERATION_COPY[error.code] };
    return {
      ok: false,
      error: actionError(error, kind === "quiz" ? "Could not make a quiz." : "Could not make flashcards."),
    };
  }
}

/**
 * Each source's library document, in the order picked, without repeats: a
 * capture already filed as a picked document counts once. A capture that
 * cannot be filed stops the request and names itself, so the dialog can
 * point at it.
 */
async function resolveDocumentIds(
  auth: AuthContext,
  sources: LearningSourceRef[],
): Promise<{ ok: true; documentIds: string[] } | { ok: false; error: string; failedSourceId: string }> {
  const documentIds: string[] = [];
  let filedCapture = false;
  try {
    for (const source of sources) {
      let documentId = source.id;
      if (source.type === "capture") {
        try {
          documentId = await documentForCapture(auth, { captureId: source.id, expectedVersion: source.version });
          filedCapture = true;
        } catch (error) {
          if (error instanceof ConflictError || error instanceof StaleWriteError) {
            return { ok: false, error: error.message, failedSourceId: source.id };
          }
          throw error;
        }
      }
      if (!documentIds.includes(documentId)) documentIds.push(documentId);
    }
  } finally {
    if (filedCapture) {
      updateTag(capturesTag(auth));
      revalidatePath("/command-center/inbox");
    }
  }
  return { ok: true, documentIds };
}

async function authorize() {
  const auth = await getAuthContext();
  requireRole(auth, "member");
  return auth;
}
