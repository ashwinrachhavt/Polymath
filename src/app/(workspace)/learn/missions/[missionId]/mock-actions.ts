"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { answerMockQuestion, MockError, startMockSession } from "@/domains/learning/mission-mock";
import { actionError } from "@/lib/action-error";
import { getAuthContext } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";

/*
 * The mock interview's mutations. Starting returns at once with the session
 * id while the questions are written; answering stores the words before it
 * grades, so a failure never loses what was written.
 */

const startSchema = z.object({ missionId: z.uuid(), requestKey: z.uuid() });

export async function startMockAction(
  input: z.input<typeof startSchema>,
): Promise<{ ok: true; sessionId: string } | { ok: false; error: string }> {
  const parsed = startSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "That Mission is not available." };
  try {
    const auth = await getAuthContext();
    requireRole(auth, "member");
    const { sessionId } = await startMockSession(auth, parsed.data);
    revalidatePath(`/learn/missions/${parsed.data.missionId}`);
    return { ok: true, sessionId };
  } catch (error) {
    if (error instanceof MockError) return { ok: false, error: error.message };
    return { ok: false, error: actionError(error, "Could not start the mock interview.") };
  }
}

const answerSchema = z.object({
  sessionId: z.uuid(),
  questionId: z.uuid(),
  answer: z.string().trim().min(1).max(5000),
  missionId: z.uuid(),
});

export async function answerMockQuestionAction(
  input: z.input<typeof answerSchema>,
): Promise<
  { ok: true; status: "asking" | "complete"; grade: string; coinsEarned: number } | { ok: false; error: string }
> {
  const parsed = answerSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Write an answer before submitting." };
  try {
    const auth = await getAuthContext();
    requireRole(auth, "member");
    const result = await answerMockQuestion(auth, {
      sessionId: parsed.data.sessionId,
      questionId: parsed.data.questionId,
      answer: parsed.data.answer,
    });
    revalidatePath(`/learn/missions/${parsed.data.missionId}`);
    return { ok: true, ...result };
  } catch (error) {
    if (error instanceof MockError) return { ok: false, error: error.message };
    return { ok: false, error: actionError(error, "Could not record this answer.") };
  }
}
