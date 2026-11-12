"use server";

import { z } from "zod";
import { projectDocumentIds } from "@/domains/knowledge/projects";
import { kickGenerationJob } from "@/domains/jobs/kick";
import type { GenerationJobView } from "@/domains/jobs/state";
import { GENERATION_COPY, QuizGenerationError } from "@/domains/learning/generate-quiz";
import { acceptLearningJob } from "@/domains/learning/generation-jobs";
import { learningJobSubject } from "@/domains/learning/job-names";
import { MAX_ITEM_COUNT, MAX_LEARNING_SOURCES, MIN_ITEM_COUNT } from "@/domains/learning/item-count";
import { actionError } from "@/lib/action-error";
import { getAuthContext } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";

const inputSchema = z.object({
  projectId: z.uuid(),
  kind: z.enum(["quiz", "flashcards"]),
  documentIds: z.array(z.uuid()).min(1).max(MAX_LEARNING_SOURCES),
  count: z.number().int().min(MIN_ITEM_COUNT).max(MAX_ITEM_COUNT).optional(),
  idempotencyKey: z.uuid(),
});

/**
 * Accepts a quiz or a flashcard deck for this Notebook to be made in the
 * background. `job` is the wait, not the result: the result shows in the
 * Notebook's Results once the job is ready.
 */
export async function makeNotebookLearningAction(
  input: z.input<typeof inputSchema>,
): Promise<{ ok: true; job: GenerationJobView } | { ok: false; error: string }> {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: `Choose one to ${MAX_LEARNING_SOURCES} ready sources and ${MIN_ITEM_COUNT} to ${MAX_ITEM_COUNT} items.`,
    };
  }
  const { projectId, kind, documentIds, count, idempotencyKey } = parsed.data;
  try {
    const auth = await getAuthContext();
    requireRole(auth, "member");
    const notebookSources = await projectDocumentIds(auth, projectId);
    if (!notebookSources || documentIds.some((id) => !notebookSources.includes(id))) {
      return { ok: false, error: "Choose sources that belong to this notebook." };
    }
    const { job, created } = await acceptLearningJob(auth, {
      kind,
      documentIds,
      count,
      notebookId: projectId,
      subject: learningJobSubject.notebook(projectId),
      idempotencyKey,
    });
    if (created) kickGenerationJob({ jobId: job.id, attempt: job.attempt });
    return { ok: true, job };
  } catch (error) {
    if (error instanceof QuizGenerationError) return { ok: false, error: GENERATION_COPY[error.code] };
    return {
      ok: false,
      error: actionError(
        error,
        kind === "quiz"
          ? "Could not generate a quiz from these sources."
          : "Could not generate flashcards from these sources.",
      ),
    };
  }
}
