import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { AuthContext } from "@/domains/identity/resolve";
import { requireRole } from "@/lib/auth/guards";
import { db } from "@/lib/db";
import { withTransaction } from "@/lib/db-transaction";
import { recordAudit } from "@/domains/audit/record";
import { withReceipt } from "@/domains/audit/receipt";
import { runReviews } from "./schema";

/*
 * Run-level reviews (ASH-304): the agent's self-critique proposal, written by
 * the critique pass (critique.ts). It is iteration input for instructions,
 * skills, and run policies - consumed by nothing automatically. The
 * operator's own verdict on a run is a `run` rating in llm_feedback.
 *
 * Every mutation writes its audit row in the same transaction - the row is
 * the state, the audit is the history.
 */

export type RunCritique = {
  gotWrong: string | null;
  wasThin: string | null;
  wouldDoDifferently: string | null;
  dismissedAt: Date | null;
};

/** The run's critique for the detail page, or null when the agent wrote none. */
export async function getRunCritique(workspaceId: string, runId: string): Promise<RunCritique | null> {
  const [row] = await db
    .select({
      gotWrong: runReviews.gotWrong,
      wasThin: runReviews.wasThin,
      wouldDoDifferently: runReviews.wouldDoDifferently,
      dismissedAt: runReviews.dismissedAt,
    })
    .from(runReviews)
    .where(and(eq(runReviews.workspaceId, workspaceId), eq(runReviews.runId, runId), eq(runReviews.kind, "critique")))
    .limit(1);
  return row ?? null;
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
        .set({
          dismissedAt: new Date(),
          updatedBy: auth.userId,
          updatedAt: new Date(),
          version: sql`${runReviews.version} + 1`,
        })
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
        {
          action: "run.critique.dismissed",
          subjectType: "run",
          subjectId: runId,
          summary: "Dismissed the run's self-critique",
        },
        tx,
      );
      return { ok: true as const };
    });
  });
  return value;
}
