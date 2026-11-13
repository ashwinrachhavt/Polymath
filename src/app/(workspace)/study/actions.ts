"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { FlashcardError, rateFlashcard } from "@/domains/learning/flashcards";
import {
  answerStudyQuestion,
  getStudyOutlook,
  StudyError,
  type StudyAnswerResult,
  type StudyOutlook,
} from "@/domains/learning/study";
import { actionError } from "@/lib/action-error";
import { getAuthContext } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";

/* Study's mutations: each is member-only and returns a typed union, never a throw. */

type Result<T> = ({ ok: true } & T) | { ok: false; error: string };

const rateSchema = z.object({
  flashcardId: z.uuid(),
  rating: z.enum(["again", "hard", "good", "easy"]),
});

export async function rateStudyCardAction(input: z.input<typeof rateSchema>): Promise<Result<unknown>> {
  const parsed = rateSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Choose a valid rating." };
  const auth = await getAuthContext();
  requireRole(auth, "member");
  try {
    await rateFlashcard(auth, parsed.data);
    return { ok: true };
  } catch (error) {
    if (error instanceof FlashcardError) return { ok: false, error: error.message };
    return { ok: false, error: actionError(error, "Could not save that rating.") };
  }
}

const answerSchema = z.object({ questionId: z.uuid(), selectedValue: z.string().min(1).max(200).nullable() });

export async function answerStudyQuestionAction(
  input: z.input<typeof answerSchema>,
): Promise<Result<{ answer: Omit<StudyAnswerResult, "dueAt"> }>> {
  const parsed = answerSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Choose one of the answers." };
  const auth = await getAuthContext();
  requireRole(auth, "member");
  try {
    const { dueAt: _dueAt, ...answer } = await answerStudyQuestion(auth, parsed.data);
    return { ok: true, answer };
  } catch (error) {
    if (error instanceof StudyError) return { ok: false, error: error.message };
    return { ok: false, error: actionError(error, "Could not save that answer.") };
  }
}

/** The end of a session: what is still due, what comes back tomorrow, and the nearest mission date. */
export async function finishStudyAction(): Promise<Result<{ outlook: StudyOutlook }>> {
  const auth = await getAuthContext();
  requireRole(auth, "member");
  try {
    const outlook = await getStudyOutlook(auth);
    revalidatePath("/today");
    revalidatePath("/learn");
    return { ok: true, outlook };
  } catch (error) {
    return { ok: false, error: actionError(error, "Could not load what is due next.") };
  }
}
