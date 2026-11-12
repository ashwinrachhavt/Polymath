"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  answerExplainItTurn,
  ExplainItError,
  MAX_EXPLAIN_SOURCES,
  startExplainItSession,
} from "@/domains/learning/explain-it";
import { projectDocumentIds } from "@/domains/knowledge/projects";
import { actionError } from "@/lib/action-error";
import { getAuthContext } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";

const startSchema = z.object({
  projectId: z.uuid(),
  documentIds: z.array(z.uuid()).min(1).max(8),
  idempotencyKey: z.uuid(),
});

export async function startNotebookExplainItAction(input: z.input<typeof startSchema>) {
  const parsed = startSchema.safeParse(input);
  if (!parsed.success) return { ok: false as const, error: `Choose one to ${MAX_EXPLAIN_SOURCES} ready sources.` };
  const auth = await getAuthContext();
  requireRole(auth, "member");
  try {
    const notebookSources = await projectDocumentIds(auth, parsed.data.projectId);
    if (!notebookSources || parsed.data.documentIds.some((id) => !notebookSources.includes(id))) {
      return { ok: false as const, error: "Choose sources that belong to this notebook." };
    }
    const result = await startExplainItSession(auth, {
      notebookId: parsed.data.projectId,
      documentIds: parsed.data.documentIds,
      idempotencyKey: parsed.data.idempotencyKey,
    });
    revalidatePath("/projects/" + parsed.data.projectId + "/notebook");
    return {
      ok: true as const,
      sessionId: result.sessionId,
      summary: "Started Explain It. Open it in Results.",
    };
  } catch (error) {
    if (error instanceof ExplainItError) return { ok: false as const, error: error.message };
    return { ok: false as const, error: actionError(error, "Could not start Explain It.") };
  }
}

const answerSchema = z.object({
  projectId: z.uuid(),
  sessionId: z.uuid(),
  turnId: z.uuid(),
  answer: z.string().trim().min(1).max(5000),
});

export async function answerNotebookExplainItAction(input: z.input<typeof answerSchema>) {
  const parsed = answerSchema.safeParse(input);
  if (!parsed.success) return { ok: false as const, error: "Write an answer before continuing." };
  const auth = await getAuthContext();
  requireRole(auth, "member");
  try {
    const notebookSources = await projectDocumentIds(auth, parsed.data.projectId);
    if (!notebookSources) return { ok: false as const, error: "That Notebook is unavailable." };
    const result = await answerExplainItTurn(auth, {
      notebookId: parsed.data.projectId,
      sessionId: parsed.data.sessionId,
      turnId: parsed.data.turnId,
      answer: parsed.data.answer,
    });
    revalidatePath("/projects/" + parsed.data.projectId + "/notebook");
    revalidatePath("/projects/" + parsed.data.projectId + "/notebook/explain");
    return { ok: true as const, status: result.status };
  } catch (error) {
    if (error instanceof ExplainItError) return { ok: false as const, error: error.message };
    return { ok: false as const, error: actionError(error, "Could not assess this explanation.") };
  }
}
