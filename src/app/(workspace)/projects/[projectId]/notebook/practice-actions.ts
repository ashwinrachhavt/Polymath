"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { z } from "zod";
import { projectDocumentIds } from "@/domains/knowledge/projects";
import { CHALLENGE_FORMATS } from "@/domains/learning/challenge-content";
import {
  ChallengeError,
  prepareChallenge,
  showChallengeHint,
  startChallenge,
  submitChallengeAttempt,
} from "@/domains/learning/challenges";
import { actionError } from "@/lib/action-error";
import { getAuthContext } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";

function revalidate(projectId: string) {
  revalidatePath("/projects/" + projectId + "/notebook");
  revalidatePath("/projects/" + projectId + "/notebook/practice");
}

const startSchema = z.object({
  projectId: z.uuid(),
  documentIds: z.array(z.uuid()).min(1).max(8),
  format: z.enum(CHALLENGE_FORMATS),
  idempotencyKey: z.uuid(),
});

/** Accepts the request and returns at once; the exercise is written after the response. */
export async function startPracticeAction(input: z.input<typeof startSchema>) {
  const parsed = startSchema.safeParse(input);
  if (!parsed.success) return { ok: false as const, error: "A source must finish reading first." };
  const auth = await getAuthContext();
  requireRole(auth, "member");
  try {
    const notebookSources = await projectDocumentIds(auth, parsed.data.projectId);
    if (!notebookSources || parsed.data.documentIds.some((id) => !notebookSources.includes(id))) {
      return { ok: false as const, error: "Choose sources that belong to this notebook." };
    }
    const { challengeId, created } = await startChallenge(auth, {
      notebookId: parsed.data.projectId,
      documentIds: parsed.data.documentIds,
      format: parsed.data.format,
      idempotencyKey: parsed.data.idempotencyKey,
    });
    if (created) after(() => prepareChallenge(auth, challengeId));
    revalidate(parsed.data.projectId);
    return { ok: true as const, challengeId };
  } catch (error) {
    if (error instanceof ChallengeError) return { ok: false as const, error: error.message };
    return { ok: false as const, error: actionError(error, "Could not start the exercise.") };
  }
}

const hintSchema = z.object({ projectId: z.uuid(), challengeId: z.uuid() });

export async function showPracticeHintAction(input: z.input<typeof hintSchema>) {
  const parsed = hintSchema.safeParse(input);
  if (!parsed.success) return { ok: false as const, error: "That exercise is not available." };
  const auth = await getAuthContext();
  requireRole(auth, "member");
  try {
    await showChallengeHint(auth, { notebookId: parsed.data.projectId, challengeId: parsed.data.challengeId });
    revalidate(parsed.data.projectId);
    return { ok: true as const };
  } catch (error) {
    if (error instanceof ChallengeError) return { ok: false as const, error: error.message };
    return { ok: false as const, error: actionError(error, "Could not show a hint.") };
  }
}

const answerSchema = z.object({
  projectId: z.uuid(),
  challengeId: z.uuid(),
  submitKey: z.uuid(),
  answer: z.string().max(5000),
  dontKnow: z.boolean(),
});

export async function submitPracticeAnswerAction(input: z.input<typeof answerSchema>) {
  const parsed = answerSchema.safeParse(input);
  if (!parsed.success) return { ok: false as const, error: "Write an answer first." };
  const auth = await getAuthContext();
  requireRole(auth, "member");
  try {
    await submitChallengeAttempt(auth, {
      notebookId: parsed.data.projectId,
      challengeId: parsed.data.challengeId,
      submitKey: parsed.data.submitKey,
      answer: parsed.data.answer,
      dontKnow: parsed.data.dontKnow,
    });
    revalidate(parsed.data.projectId);
    return { ok: true as const };
  } catch (error) {
    if (error instanceof ChallengeError) return { ok: false as const, error: error.message };
    return { ok: false as const, error: actionError(error, "Could not check this answer.") };
  }
}
