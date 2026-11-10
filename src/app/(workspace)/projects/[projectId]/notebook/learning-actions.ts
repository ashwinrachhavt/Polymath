"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { GENERATION_COPY, generateQuiz, QuizGenerationError } from "@/domains/learning/generate-quiz";
import { projectDocumentIds } from "@/domains/knowledge/projects";
import { actionError } from "@/lib/action-error";
import { getAuthContext } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";

const inputSchema = z.object({
  projectId: z.uuid(),
  documentIds: z.array(z.uuid()).min(1).max(8),
  questionCount: z.number().int().min(5).max(100).optional(),
  idempotencyKey: z.uuid(),
});

export async function generateNotebookQuizAction(input: z.input<typeof inputSchema>) {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false as const, error: "Choose one to eight ready sources and 5 to 100 questions." };

  const auth = await getAuthContext();
  requireRole(auth, "member");
  try {
    const notebookSources = await projectDocumentIds(auth, parsed.data.projectId);
    if (!notebookSources || parsed.data.documentIds.some((id) => !notebookSources.includes(id))) {
      return { ok: false as const, error: "Choose sources that belong to this notebook." };
    }
    const primaryDocumentId = parsed.data.documentIds[0];
    const result = await generateQuiz(auth, {
      notebookId: parsed.data.projectId,
      documentId: primaryDocumentId,
      documentIds: parsed.data.documentIds,
      questionCount: parsed.data.questionCount,
      idempotencyKey: parsed.data.idempotencyKey,
    });
    revalidatePath(`/projects/${parsed.data.projectId}/notebook`);
    revalidatePath("/learn");
    return {
      ok: true as const,
      quizId: result.quizId,
      questionCount: result.questionCount,
      requested: result.requested,
      stoppedBy: result.stoppedBy,
    };
  } catch (error) {
    if (error instanceof QuizGenerationError) return { ok: false as const, error: GENERATION_COPY[error.code] };
    return { ok: false as const, error: actionError(error, "Could not generate a quiz from these sources.") };
  }
}
