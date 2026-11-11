"use server";

import { revalidatePath, updateTag } from "next/cache";
import { z } from "zod";
import { ConflictError, StaleWriteError } from "@/domains/capture/commands";
import { checkCaptureSource, documentForCapture } from "@/domains/capture/document-source";
import { searchCaptures } from "@/domains/capture/queries";
import { FlashcardError, generateFlashcardDeck } from "@/domains/learning/flashcards";
import {
  GENERATION_COPY,
  generateQuiz,
  loadCurrentQuizSources,
  QuizGenerationError,
} from "@/domains/learning/generate-quiz";
import {
  type GenerationOutcome,
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
  { ok: true; href: string; notice: string | null } | { ok: false; error: string; failedSourceId?: string };

type Resolved = { ok: true; documentIds: string[] } | { ok: false; error: string; failedSourceId?: string };

const PICKER_LIMIT = 25;
const MAX_RAW_SOURCES = 50;

const findSchema = z.object({ query: z.string().max(200) });

export async function findLearningSourcesAction(
  input: z.input<typeof findSchema>,
): Promise<
  { ok: true; documents: LearningSourceOption[]; captures: LearningSourceOption[] } | { ok: false; error: string }
> {
  const parsed = findSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Search with a shorter phrase." };
  try {
    const auth = await authorize();
    const query = parsed.data.query;
    const [documents, captures] = await Promise.all([
      searchLearningDocuments(auth, { query, limit: PICKER_LIMIT }),
      searchCaptures(auth, { filter: "unprocessed", query, limit: PICKER_LIMIT, offset: 0 }),
    ]);
    return {
      ok: true,
      documents: documents.map((doc) => ({ type: "document", ...doc })),
      // A capture with no words yet (a voice note before its transcript) cannot be filed.
      captures: captures.items
        .filter((row) => row.hasText)
        .map((row) => ({
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
  // The source limit counts distinct documents after resolution; this only bounds the request.
  sources: z.array(sourceSchema).min(1).max(MAX_RAW_SOURCES),
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
  try {
    const auth = await authorize();
    const resolved = await resolveDocumentIds(auth, sources);
    if (!resolved.ok) return resolved;
    const documentIds = resolved.documentIds;

    if (kind === "flashcards") {
      const deck = await generateFlashcardDeck(auth, { documentIds, cardCount: count, idempotencyKey });
      revalidatePath("/learn");
      return {
        ok: true,
        href: `/learn/decks/${deck.deckId}`,
        notice: shortfallNotice("flashcards", {
          made: deck.cardCount,
          requested: deck.requested,
          stoppedBy: deck.stoppedBy,
        }),
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
      notice: shortfallNotice("questions", {
        made: quiz.questionCount,
        requested: quiz.requested,
        stoppedBy: quiz.stoppedBy,
      }),
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

/** What to tell the learner about a deck or quiz that came out short of its request; null when it did not. */
function shortfallNotice(
  noun: string,
  run: { made: number; requested: number; stoppedBy: GenerationOutcome | "in_progress" },
): string | null {
  if (run.stoppedBy === "in_progress") return `Still making ${noun}: ${run.made} so far.`;
  if (run.made >= run.requested) return null;
  if (run.stoppedBy === "batch_failed") {
    return `Made ${run.made} of ${run.requested} ${noun} before a batch failed. Make them again for more.`;
  }
  return `Made ${run.made} of ${run.requested} ${noun}; the sources support no more.`;
}

/**
 * Each source's library document, in the order picked, without repeats: a
 * capture already filed as a picked document counts once. Filing takes a
 * capture out of the inbox for good, so every source is checked first, read
 * only, and no capture is filed unless the whole request can go ahead. A
 * capture that cannot be a source stops the request and names itself, so
 * the dialog can point at it.
 */
async function resolveDocumentIds(auth: AuthContext, sources: LearningSourceRef[]): Promise<Resolved> {
  const checked: Array<{ source: LearningSourceRef; documentId: string | null }> = [];
  for (const source of sources) {
    if (source.type === "document") {
      checked.push({ source, documentId: source.id });
      continue;
    }
    const outcome = await asSourceRefusal(source, () =>
      checkCaptureSource(auth, { captureId: source.id, expectedVersion: source.version }),
    );
    if (!outcome.ok) return outcome;
    checked.push({ source, documentId: outcome.value.documentId });
  }

  const inLibrary = [...new Set(checked.flatMap(({ documentId }) => (documentId ? [documentId] : [])))];
  const distinct = inLibrary.length + checked.filter(({ documentId }) => documentId === null).length;
  if (distinct > MAX_LEARNING_SOURCES) {
    const over = distinct - MAX_LEARNING_SOURCES;
    return {
      ok: false,
      error: `One request reads up to ${MAX_LEARNING_SOURCES} sources, and these are ${distinct}. Remove ${over} and try again.`,
    };
  }
  // Throws QuizGenerationError for a document outside the workspace or still being read.
  if (inLibrary.length > 0) await loadCurrentQuizSources(auth, inLibrary);

  const documentIds: string[] = [];
  let filedCapture = false;
  try {
    for (const { source, documentId: known } of checked) {
      let documentId = known;
      if (documentId === null && source.type === "capture") {
        const filed = await asSourceRefusal(source, () =>
          documentForCapture(auth, { captureId: source.id, expectedVersion: source.version }),
        );
        if (!filed.ok) return filed;
        documentId = filed.value;
        filedCapture = true;
      }
      if (documentId && !documentIds.includes(documentId)) documentIds.push(documentId);
    }
  } finally {
    if (filedCapture) {
      updateTag(capturesTag(auth));
      revalidatePath("/command-center/inbox");
    }
  }
  return { ok: true, documentIds };
}

/** A capture's refusal (stale, converted, no text) as copy naming that capture; other errors still throw. */
async function asSourceRefusal<T>(
  source: LearningSourceRef,
  run: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: string; failedSourceId: string }> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    if (error instanceof ConflictError || error instanceof StaleWriteError) {
      return { ok: false, error: error.message, failedSourceId: source.id };
    }
    throw error;
  }
}

async function authorize() {
  const auth = await getAuthContext();
  requireRole(auth, "member");
  return auth;
}
