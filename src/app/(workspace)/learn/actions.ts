"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { completeQuizAttempt, QuizAttemptError, type CompleteQuizAttemptResult } from "@/domains/learning/commands";
import { FlashcardError, getFlashcardDeck, rateFlashcard } from "@/domains/learning/flashcards";
import { kickGenerationJob } from "@/domains/jobs/kick";
import type { GenerationJobView } from "@/domains/jobs/state";
import { GENERATION_COPY, QuizGenerationError } from "@/domains/learning/generate-quiz";
import { acceptLearningJob } from "@/domains/learning/generation-jobs";
import { learningJobSubject } from "@/domains/learning/job-names";
import type { SubmittedAnswer } from "@/domains/learning/schema";
import { actionError } from "@/lib/action-error";
import { getAuthContext } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";

/*
 * The Learn surface's mutations. Each is member-only, returns a typed
 * union (no throw crosses to the client), and maps the domain's typed
 * error codes onto authored copy - the code that reaches the screen is a
 * sentence, never a class name or a driver message. The copy map lives in
 * the domain next to the codes, so the verb and the failed row's stored
 * reason are the same sentences.
 */

const ATTEMPT_COPY: Record<QuizAttemptError["code"], string> = {
  quiz_not_found: "That quiz is not in this workspace.",
  quiz_not_ready: "This quiz is not ready to be taken.",
  invalid_answers: "This sitting does not match the quiz - start it again.",
  attempt_conflict: "This sitting was already recorded.",
};

const generateSchema = z.object({ documentId: z.uuid(), idempotencyKey: z.uuid() });

/** Accepts a quiz for one document to be made in the background; `job` is the wait, not the quiz. */
export async function generateQuizAction(
  input: z.input<typeof generateSchema>,
): Promise<{ ok: true; job: GenerationJobView } | { ok: false; error: string }> {
  const parsed = generateSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: GENERATION_COPY.document_not_found };
  const { documentId, idempotencyKey } = parsed.data;
  try {
    const auth = await getAuthContext();
    requireRole(auth, "member");
    const { job, created } = await acceptLearningJob(auth, {
      kind: "quiz",
      documentIds: [documentId],
      subject: learningJobSubject.document(documentId),
      idempotencyKey,
    });
    if (created) kickGenerationJob({ jobId: job.id, attempt: job.attempt });
    return { ok: true, job };
  } catch (error) {
    if (error instanceof QuizGenerationError) return { ok: false, error: GENERATION_COPY[error.code] };
    return { ok: false, error: actionError(error, "Could not generate a quiz for this document.") };
  }
}

export async function completeQuizAttemptAction(input: {
  quizId: string;
  answers: SubmittedAnswer[];
  idempotencyKey: string;
}): Promise<{ ok: true; result: CompleteQuizAttemptResult } | { ok: false; error: string }> {
  const auth = await getAuthContext();
  requireRole(auth, "member");
  try {
    const result = await completeQuizAttempt(auth, input);
    revalidatePath("/learn");
    return { ok: true, result };
  } catch (error) {
    if (error instanceof QuizAttemptError) return { ok: false, error: ATTEMPT_COPY[error.code] };
    return { ok: false, error: actionError(error, "Could not record this sitting.") };
  }
}

const rateSchema = z.object({
  deckId: z.uuid(),
  flashcardId: z.uuid(),
  rating: z.enum(["again", "hard", "good", "easy"]),
});

/** Rate a card in a deck made outside a Notebook; a Notebook deck is rated through its Notebook. */
export async function rateDeckFlashcardAction(
  input: z.input<typeof rateSchema>,
): Promise<{ ok: true; dueAt: string; coinsEarned: number } | { ok: false; error: string }> {
  const parsed = rateSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Choose a valid flashcard rating." };
  const auth = await getAuthContext();
  requireRole(auth, "member");
  try {
    const deck = await getFlashcardDeck(auth, parsed.data.deckId);
    if (!deck || deck.notebookId !== null || !deck.cards.some((card) => card.id === parsed.data.flashcardId)) {
      return { ok: false, error: "That flashcard is not in this deck." };
    }
    const result = await rateFlashcard(auth, parsed.data);
    return { ok: true, dueAt: result.dueAt.toISOString(), coinsEarned: result.coinsEarned };
  } catch (error) {
    if (error instanceof FlashcardError) return { ok: false, error: error.message };
    return { ok: false, error: actionError(error, "Could not save this flashcard rating.") };
  }
}
