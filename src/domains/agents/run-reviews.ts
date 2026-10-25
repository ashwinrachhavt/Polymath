import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { AuthContext } from "@/domains/identity/resolve";
import { requireRole } from "@/lib/auth/guards";
import { db } from "@/lib/db";
import { withTransaction } from "@/lib/db-transaction";
import { recordAudit } from "@/domains/audit/record";
import { withReceipt } from "@/domains/audit/receipt";
import { agentRuns, FEEDBACK_REASONS, runReviews } from "./schema";

/*
 * Run-level reviews (ASH-304). Two rows can hang off a finished run: the
 * agent's self-critique proposal (written by the critique pass in critique.ts)
 * and the operator's verdict. Both are iteration input for instructions,
 * skills, and run policies - they are consumed by nothing automatically.
 *
 * One feedback row per run, enforced by a partial unique index; setting,
 * switching and clearing all update that one row, so the index can never be
 * raced into a second row. Every mutation writes its audit row in the same
 * transaction - the row is the state, the audit is the history.
 */

export const FEEDBACK_REASON_SLUGS: readonly string[] = FEEDBACK_REASONS;

const feedbackInput = z.object({
  runId: z.string().uuid(),
  verdict: z.enum(["up", "down", "clear"]),
  reasons: z.array(z.enum(FEEDBACK_REASONS)).max(FEEDBACK_REASONS.length).max(6).optional(),
  note: z.string().max(280).optional(),
  idempotencyKey: z.string().max(200).optional(),
});

export type RunReview = {
  kind: "critique" | "user_feedback";
  verdict: "up" | "down" | null;
  reasons: string[];
  note: string | null;
  gotWrong: string | null;
  wasThin: string | null;
  wouldDoDifferently: string | null;
  dismissedAt: Date | null;
};

/** The run's reviews for the detail page: at most one critique, one feedback. */
export async function getRunReviews(
  workspaceId: string,
  runId: string,
): Promise<{ critique: RunReview | null; feedback: RunReview | null }> {
  const rows = await db
    .select({
      kind: runReviews.kind,
      verdict: runReviews.verdict,
      reasons: runReviews.reasons,
      note: runReviews.note,
      gotWrong: runReviews.gotWrong,
      wasThin: runReviews.wasThin,
      wouldDoDifferently: runReviews.wouldDoDifferently,
      dismissedAt: runReviews.dismissedAt,
    })
    .from(runReviews)
    .where(and(eq(runReviews.workspaceId, workspaceId), eq(runReviews.runId, runId)))
    .orderBy(asc(runReviews.createdAt));
  let critique: RunReview | null = null;
  let feedback: RunReview | null = null;
  for (const row of rows) {
    const review: RunReview = { ...row, verdict: (row.verdict as "up" | "down" | null) ?? null };
    if (row.kind === "critique") critique = review;
    else feedback = review;
  }
  return { critique, feedback };
}

/**
 * The operator's run-level verdict. Thumbs-up is one tap; thumbs-down may
 * carry reasons and a one-line note; the same verdict again clears back to
 * neutral (verdict null, reasons emptied), matching the per-message toggle.
 * Reasons and note are only meaningful with a down verdict - an up verdict or
 * a clear drops them rather than keeping stale rationale on the row.
 */
export async function setRunFeedback(
  auth: AuthContext,
  input: z.infer<typeof feedbackInput>,
): Promise<{ ok: boolean; verdict: "up" | "down" | null }> {
  requireRole(auth, "member");
  const parsed = feedbackInput.parse(input);
  const reasons = parsed.verdict === "down" ? [...new Set(parsed.reasons ?? [])] : [];
  const note = parsed.verdict === "down" ? (parsed.note?.trim() || null) : null;
  const verdict = parsed.verdict === "clear" ? null : parsed.verdict;

  const { value } = await withTransaction(async (tx) => {
    return withReceipt(tx, auth, parsed.idempotencyKey, { op: "setRunFeedback", ...parsed }, async () => {
      // The run must belong to this workspace; a foreign run id answers as
      // not-found, the same answer getRun gives the page.
      const [run] = await tx
        .select({ id: agentRuns.id, profileRevisionId: agentRuns.profileRevisionId, model: agentRuns.model })
        .from(agentRuns)
        .where(and(eq(agentRuns.id, parsed.runId), eq(agentRuns.workspaceId, auth.workspaceId)))
        .limit(1);
      if (!run) return { ok: false as const, verdict: null };

      await tx
        .insert(runReviews)
        .values({
          workspaceId: auth.workspaceId,
          runId: run.id,
          kind: "user_feedback",
          verdict,
          reasons,
          note,
          profileRevisionId: run.profileRevisionId,
          model: run.model,
          createdBy: auth.userId,
          updatedBy: auth.userId,
        })
        .onConflictDoUpdate({
          target: [runReviews.workspaceId, runReviews.runId],
          targetWhere: sql`kind = 'user_feedback'`,
          set: { verdict, reasons, note, updatedBy: auth.userId, updatedAt: new Date(), version: sql`${runReviews.version} + 1` },
        });

      await recordAudit(
        auth,
        {
          action: verdict ? `run.feedback.${verdict}` : "run.feedback.cleared",
          subjectType: "run",
          subjectId: run.id,
          summary: verdict
            ? `Marked the run ${verdict === "up" ? "good" : "not good"}${reasons.length ? ` (${reasons.join(", ")})` : ""}`
            : "Cleared the run verdict",
        },
        tx,
      );
      return { ok: true as const, verdict };
    });
  });
  return value;
}

/** Dismiss the critique proposal. Stored, just no longer rendered. */
export async function dismissRunCritique(
  auth: AuthContext,
  input: { runId: string; idempotencyKey?: string },
): Promise<{ ok: boolean }> {
  requireRole(auth, "member");
  const runId = z.string().uuid().parse(input.runId);
  const { value } = await withTransaction(async (tx) => {
    return withReceipt(tx, auth, input.idempotencyKey, { op: "dismissRunCritique", runId }, async () => {
      const updated = await tx
        .update(runReviews)
        .set({ dismissedAt: new Date(), updatedBy: auth.userId, updatedAt: new Date(), version: sql`${runReviews.version} + 1` })
        .where(
          and(
            eq(runReviews.workspaceId, auth.workspaceId),
            eq(runReviews.runId, runId),
            eq(runReviews.kind, "critique"),
            sql`${runReviews.dismissedAt} is null`,
          ),
        )
        .returning({ id: runReviews.id });
      if (updated.length === 0) return { ok: false as const };
      await recordAudit(
        auth,
        { action: "run.critique.dismissed", subjectType: "run", subjectId: runId, summary: "Dismissed the run's self-critique" },
        tx,
      );
      return { ok: true as const };
    });
  });
  return value;
}
