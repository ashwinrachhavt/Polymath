"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { projectDocumentIds } from "@/domains/knowledge/projects";
import { submitGraphRecall, GraphRecallError } from "@/domains/learning/graph-recall";
import { actionError } from "@/lib/action-error";
import { getAuthContext } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";

const schema = z.object({
  projectId: z.uuid(),
  sourceArtifactId: z.uuid(),
  targetArtifactId: z.uuid(),
  submittedRelation: z.enum([
    "related",
    "explains",
    "supports",
    "contradicts",
    "applies",
    "extends",
    "contrasts",
    "instance_of",
    "part_of",
    "causes",
  ]),
  requestKey: z.uuid(),
});

export async function submitNotebookGraphRecallAction(input: z.input<typeof schema>) {
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { ok: false as const, error: "Choose a relationship between two distinct ideas." };
  const auth = await getAuthContext();
  requireRole(auth, "member");
  try {
    const documentIds = await projectDocumentIds(auth, parsed.data.projectId);
    if (!documentIds) return { ok: false as const, error: "That Notebook is unavailable." };
    const result = await submitGraphRecall(auth, {
      notebookId: parsed.data.projectId,
      documentIds,
      sourceArtifactId: parsed.data.sourceArtifactId,
      targetArtifactId: parsed.data.targetArtifactId,
      submittedRelation: parsed.data.submittedRelation,
      requestKey: parsed.data.requestKey,
    });
    revalidatePath("/projects/" + parsed.data.projectId + "/notebook/graph");
    return { ok: true as const, ...result };
  } catch (error) {
    if (error instanceof GraphRecallError) return { ok: false as const, error: error.message };
    return { ok: false as const, error: actionError(error, "Could not save this relationship recall.") };
  }
}
