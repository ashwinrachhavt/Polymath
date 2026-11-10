import { and, eq, sql } from "drizzle-orm";
import { recordAudit } from "@/domains/audit/record";
import type { AuthContext } from "@/domains/identity/resolve";
import { quizzes, flashcardDecks, learningArtifactFeedback } from "@/domains/learning/schema";
import { db } from "@/lib/db";
import { withTransaction, type TxDrizzle } from "@/lib/db-transaction";
import { artifacts } from "./schema";

export type ArtifactRating = "helpful" | "not_helpful";
export type LearningArtifactFeedbackTarget =
  { kind: "artifact"; id: string } | { kind: "quiz"; id: string } | { kind: "flashcard_deck"; id: string };

function targetColumn(target: LearningArtifactFeedbackTarget) {
  switch (target.kind) {
    case "artifact":
      return learningArtifactFeedback.artifactId;
    case "quiz":
      return learningArtifactFeedback.quizId;
    case "flashcard_deck":
      return learningArtifactFeedback.flashcardDeckId;
  }
}

async function assertTargetInWorkspace(
  tx: TxDrizzle,
  auth: AuthContext,
  target: LearningArtifactFeedbackTarget,
): Promise<void> {
  const [row] =
    target.kind === "artifact"
      ? await tx
          .select({ id: artifacts.id })
          .from(artifacts)
          .where(and(eq(artifacts.id, target.id), eq(artifacts.workspaceId, auth.workspaceId)))
          .limit(1)
      : target.kind === "quiz"
        ? await tx
            .select({ id: quizzes.id })
            .from(quizzes)
            .where(
              and(eq(quizzes.id, target.id), eq(quizzes.workspaceId, auth.workspaceId), eq(quizzes.status, "ready")),
            )
            .limit(1)
        : await tx
            .select({ id: flashcardDecks.id })
            .from(flashcardDecks)
            .where(and(eq(flashcardDecks.id, target.id), eq(flashcardDecks.workspaceId, auth.workspaceId)))
            .limit(1);
  if (!row) throw new Error("Learning artifact not found in workspace");
}

export async function getArtifactFeedback(
  auth: AuthContext,
  target: LearningArtifactFeedbackTarget,
): Promise<ArtifactRating | null> {
  const [row] = await db
    .select({ rating: learningArtifactFeedback.rating })
    .from(learningArtifactFeedback)
    .where(
      and(
        eq(learningArtifactFeedback.workspaceId, auth.workspaceId),
        eq(targetColumn(target), target.id),
        eq(learningArtifactFeedback.userId, auth.userId),
      ),
    )
    .limit(1);
  return row?.rating ?? null;
}

async function saveFeedback(
  tx: TxDrizzle,
  auth: AuthContext,
  target: LearningArtifactFeedbackTarget,
  rating: ArtifactRating,
): Promise<void> {
  const values = {
    workspaceId: auth.workspaceId,
    artifactId: target.kind === "artifact" ? target.id : null,
    quizId: target.kind === "quiz" ? target.id : null,
    flashcardDeckId: target.kind === "flashcard_deck" ? target.id : null,
    userId: auth.userId,
    rating,
    createdBy: auth.userId,
    updatedBy: auth.userId,
  };
  const update = { rating, updatedBy: auth.userId, updatedAt: new Date() };
  if (target.kind === "artifact") {
    await tx
      .insert(learningArtifactFeedback)
      .values(values)
      .onConflictDoUpdate({
        target: [
          learningArtifactFeedback.workspaceId,
          learningArtifactFeedback.artifactId,
          learningArtifactFeedback.userId,
        ],
        targetWhere: sql`${learningArtifactFeedback.artifactId} is not null`,
        set: update,
      });
  } else if (target.kind === "quiz") {
    await tx
      .insert(learningArtifactFeedback)
      .values(values)
      .onConflictDoUpdate({
        target: [
          learningArtifactFeedback.workspaceId,
          learningArtifactFeedback.quizId,
          learningArtifactFeedback.userId,
        ],
        targetWhere: sql`${learningArtifactFeedback.quizId} is not null`,
        set: update,
      });
  } else {
    await tx
      .insert(learningArtifactFeedback)
      .values(values)
      .onConflictDoUpdate({
        target: [
          learningArtifactFeedback.workspaceId,
          learningArtifactFeedback.flashcardDeckId,
          learningArtifactFeedback.userId,
        ],
        targetWhere: sql`${learningArtifactFeedback.flashcardDeckId} is not null`,
        set: update,
      });
  }
}

export async function rateArtifact(
  auth: AuthContext,
  input: { target: LearningArtifactFeedbackTarget; rating: ArtifactRating },
) {
  return withTransaction(async (tx) => {
    await assertTargetInWorkspace(tx, auth, input.target);
    const [existing] = await tx
      .select({ rating: learningArtifactFeedback.rating })
      .from(learningArtifactFeedback)
      .where(
        and(
          eq(learningArtifactFeedback.workspaceId, auth.workspaceId),
          eq(targetColumn(input.target), input.target.id),
          eq(learningArtifactFeedback.userId, auth.userId),
        ),
      )
      .limit(1);
    if (existing?.rating === input.rating) return { changed: false, rating: input.rating };

    await saveFeedback(tx, auth, input.target, input.rating);
    await recordAudit(
      auth,
      {
        action: "learning.artifact_feedback_recorded",
        subjectType: input.target.kind,
        subjectId: input.target.id,
        summary: `Marked a ${input.target.kind.replace("_", " ")} ${input.rating === "helpful" ? "helpful" : "not helpful"}`,
        metadata: { targetKind: input.target.kind, rating: input.rating },
      },
      tx,
    );
    return { changed: true, rating: input.rating };
  });
}
