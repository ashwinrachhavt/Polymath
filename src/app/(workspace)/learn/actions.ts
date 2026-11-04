"use server";

import { revalidatePath } from "next/cache";
import { completeQuizAttempt, QuizAttemptError, type CompleteQuizAttemptResult } from "@/domains/learning/commands";
import { generateQuiz, GENERATION_COPY, QuizGenerationError } from "@/domains/learning/generate-quiz";
import type { SubmittedAnswer } from "@/domains/learning/schema";
import { getRewardsOverview, pickRewardAnnouncement } from "@/domains/gamification/queries";
import { actionError } from "@/lib/action-error";
import { getAuthContext } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";

/*
 * The Learn surface's two mutations. Both are member-only, both return typed
 * unions (no throw crosses to the client), and both map the domain's typed
 * error codes onto authored copy - the code that reaches the screen is a
 * sentence, never a class name or a driver message. The copy map lives in
 * the domain next to the codes, so the verb and the failed row's stored
 * reason are the same sentences. The completion action also computes the
 * "Stone earned" announcement from the fresh ledger, so the runner can
 * surface it with the same coach mark the collection uses.
 */

const ATTEMPT_COPY: Record<QuizAttemptError["code"], string> = {
  quiz_not_found: "That quiz is not in this workspace.",
  quiz_not_ready: "This quiz is not ready to be taken.",
  invalid_answers: "This sitting does not match the quiz - start it again.",
  attempt_conflict: "This sitting was already recorded.",
};

export type StoneAnnouncement = {
  id: string;
  label: string;
  points: number;
  reason: string;
  milestone: boolean;
};

export async function generateQuizAction(
  documentId: string,
): Promise<{ ok: true; quizId: string } | { ok: false; error: string }> {
  const auth = await getAuthContext();
  requireRole(auth, "member");
  try {
    const result = await generateQuiz(auth, { documentId });
    revalidatePath("/learn");
    revalidatePath(`/learn/${documentId}`);
    return { ok: true, quizId: result.quizId };
  } catch (error) {
    if (error instanceof QuizGenerationError) return { ok: false, error: GENERATION_COPY[error.code] };
    return { ok: false, error: actionError(error, "Could not generate a quiz for this document.") };
  }
}

export async function completeQuizAttemptAction(input: {
  quizId: string;
  answers: SubmittedAnswer[];
  idempotencyKey: string;
}): Promise<
  { ok: true; result: CompleteQuizAttemptResult; announcement: StoneAnnouncement | null } | { ok: false; error: string }
> {
  const auth = await getAuthContext();
  requireRole(auth, "member");
  try {
    const result = await completeQuizAttempt(auth, input);
    // The announcement is the ledger's own newest-earning rule, run against
    // the row this sitting just wrote - the same rule the collection page
    // renders, and the same coach-mark id, so either surface shows it once.
    const overview = await getRewardsOverview(auth);
    const picked = pickRewardAnnouncement(overview.ledger, new Date());
    const announcement: StoneAnnouncement | null = picked
      ? {
          id: picked.id,
          label: picked.definitionLabel,
          points: picked.points,
          reason: picked.reason,
          milestone: picked.milestone,
        }
      : null;
    revalidatePath("/learn");
    return { ok: true, result, announcement };
  } catch (error) {
    if (error instanceof QuizAttemptError) return { ok: false, error: ATTEMPT_COPY[error.code] };
    return { ok: false, error: actionError(error, "Could not record this sitting.") };
  }
}
