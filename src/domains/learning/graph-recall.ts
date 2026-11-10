import { and, eq } from "drizzle-orm";
import { recordAudit } from "@/domains/audit/record";
import type { AuthContext } from "@/domains/identity/resolve";
import { db } from "@/lib/db";
import { withTransaction } from "@/lib/db-transaction";
import { listCardGraph } from "@/domains/knowledge/relations";
import { RELATION_TYPES, type RelationType } from "@/domains/knowledge/relation-vocabulary";
import { graphRecallAttempts } from "./schema";

export class GraphRecallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GraphRecallError";
  }
}

export async function submitGraphRecall(
  auth: AuthContext,
  input: {
    notebookId: string;
    documentIds: string[];
    sourceArtifactId: string;
    targetArtifactId: string;
    submittedRelation: Exclude<RelationType, "source">;
    requestKey: string;
  },
): Promise<{ correct: boolean; expectedRelation: Exclude<RelationType, "source"> }> {
  if (input.sourceArtifactId === input.targetArtifactId || !RELATION_TYPES.includes(input.submittedRelation)) {
    throw new GraphRecallError("Choose two distinct ideas and a supported relationship.");
  }
  const graph = await listCardGraph(auth, { documentIds: input.documentIds });
  const edge = graph.edges.find(
    (item) => item.source === input.sourceArtifactId && item.target === input.targetArtifactId,
  );
  const verifiedRelations: Exclude<RelationType, "source">[] = RELATION_TYPES.filter(
    (relation): relation is Exclude<RelationType, "source"> => relation !== "source",
  );
  if (!edge || !verifiedRelations.includes(edge.linkType as Exclude<RelationType, "source">)) {
    throw new GraphRecallError("That relationship is not available as a verified link in this Notebook.");
  }
  const expectedRelation = edge.linkType as Exclude<RelationType, "source">;

  const [prior] = await db
    .select({
      sourceArtifactId: graphRecallAttempts.sourceArtifactId,
      targetArtifactId: graphRecallAttempts.targetArtifactId,
      submittedRelation: graphRecallAttempts.submittedRelation,
      expectedRelation: graphRecallAttempts.expectedRelation,
      isCorrect: graphRecallAttempts.isCorrect,
    })
    .from(graphRecallAttempts)
    .where(
      and(
        eq(graphRecallAttempts.workspaceId, auth.workspaceId),
        eq(graphRecallAttempts.userId, auth.userId),
        eq(graphRecallAttempts.requestKey, input.requestKey),
      ),
    )
    .limit(1);
  if (prior) {
    if (
      prior.sourceArtifactId !== input.sourceArtifactId ||
      prior.targetArtifactId !== input.targetArtifactId ||
      prior.submittedRelation !== input.submittedRelation
    ) {
      throw new GraphRecallError("This recall attempt key belongs to another answer.");
    }
    return { correct: prior.isCorrect, expectedRelation: prior.expectedRelation as Exclude<RelationType, "source"> };
  }

  const correct = input.submittedRelation === expectedRelation;
  await withTransaction(async (tx) => {
    await tx.insert(graphRecallAttempts).values({
      workspaceId: auth.workspaceId,
      notebookId: input.notebookId,
      userId: auth.userId,
      sourceArtifactId: input.sourceArtifactId,
      targetArtifactId: input.targetArtifactId,
      expectedRelation,
      submittedRelation: input.submittedRelation,
      isCorrect: correct,
      requestKey: input.requestKey,
      createdAt: new Date(),
    });
    await recordAudit(
      auth,
      {
        action: "learning.graph_recall_attempted",
        subjectType: "graph_recall_attempt",
        subjectId: input.sourceArtifactId,
        summary: correct ? "Recalled a verified idea relationship" : "Practiced a verified idea relationship",
        metadata: { relation: expectedRelation, correct },
      },
      tx,
    );
  });
  return { correct, expectedRelation };
}
