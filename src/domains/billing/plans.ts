import { and, eq, sql } from "drizzle-orm";
import { recordAudit } from "@/domains/audit/record";
import type { AuthContext } from "@/domains/identity/resolve";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth/guards";
import { withTransaction, type TxDrizzle } from "@/lib/db-transaction";
import { workspaceModelKeys, workspacePlans, type Plan } from "./schema";

/*
 * Entitlements. A workspace's plan decides how many calls it may spend on the
 * house keys per week; its own keys are never limited here. The resolver is
 * the only enforcement point (resolver.ts), so changing these numbers or the
 * rules below changes behaviour everywhere at once.
 *
 *   free     the house model, FREE_WEEKLY_AI_CALLS calls a week
 *   pro      the house model, PRO_WEEKLY_AI_CALLS calls a week ($10/month, billed later)
 *   own-key  no house calls: the workspace pays its provider directly
 *
 * `own-key` is not chosen, it follows from keys: saving the first key moves a
 * free workspace to it, removing the last key moves it back. Pro stays pro.
 * There is no billing yet; the owner switches Pro on by hand.
 */

/** One "AI call" is one model request: a chat step, a generation, a grading. Embeddings are exempt. */
export const FREE_WEEKLY_AI_CALLS = 100;
export const PRO_WEEKLY_AI_CALLS = 2_000;

export function weeklyAllowance(plan: Plan): number {
  return plan === "free" ? FREE_WEEKLY_AI_CALLS : plan === "pro" ? PRO_WEEKLY_AI_CALLS : 0;
}

/** The week the allowance counts in: UTC, Monday 00:00 to the next Monday. */
export function currentWeek(now: Date = new Date()): { start: Date; resetsAt: Date } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7));
  const resetsAt = new Date(start);
  resetsAt.setUTCDate(start.getUTCDate() + 7);
  return { start, resetsAt };
}

export async function getPlan(workspaceId: string): Promise<Plan> {
  const [row] = await db
    .select({ plan: workspacePlans.plan })
    .from(workspacePlans)
    .where(eq(workspacePlans.workspaceId, workspaceId))
    .limit(1);
  return (row?.plan as Plan | undefined) ?? "free";
}

/** What a stored plan becomes given whether the workspace holds any key. */
export function settledPlan(plan: Plan, hasKey: boolean): Plan {
  if (plan === "pro") return "pro";
  return hasKey ? "own-key" : "free";
}

/*
 * workspace_plans has two writers (the owner's Pro switch and the plan a key
 * change implies) and no version column, because the plan is derived state:
 * whichever transaction holds this lock re-reads the current plan and the key
 * count before it writes, so neither can overwrite the other from a stale read.
 */
async function lockPlan(tx: TxDrizzle, workspaceId: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`workspace_plan:${workspaceId}`}, 0))`);
}

async function writePlan(tx: TxDrizzle, auth: { workspaceId: string; userId: string | null }, plan: Plan) {
  await tx
    .insert(workspacePlans)
    .values({ workspaceId: auth.workspaceId, plan, updatedBy: auth.userId })
    .onConflictDoUpdate({
      target: workspacePlans.workspaceId,
      set: { plan, updatedBy: auth.userId, updatedAt: new Date() },
    });
}

/**
 * Re-derives the plan after a key was added or removed. Runs inside the key
 * change's own transaction so the key and the plan it implies commit together.
 */
export async function reconcilePlan(
  tx: TxDrizzle,
  auth: { workspaceId: string; userId: string | null },
): Promise<Plan> {
  await lockPlan(tx, auth.workspaceId);
  const [row] = await tx
    .select({ plan: workspacePlans.plan })
    .from(workspacePlans)
    .where(eq(workspacePlans.workspaceId, auth.workspaceId))
    .limit(1);
  const current = (row?.plan as Plan | undefined) ?? "free";
  const [{ count }] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(workspaceModelKeys)
    .where(eq(workspaceModelKeys.workspaceId, auth.workspaceId));
  const next = settledPlan(current, count > 0);
  if (next !== current) await writePlan(tx, auth, next);
  return next;
}

/**
 * The owner's manual switch (no billing yet): Pro on, or back to the default.
 * Until billing exists any workspace owner can do this to their own workspace;
 * the audit row is the record.
 */
export async function setProByOwner(auth: AuthContext, pro: boolean): Promise<Plan> {
  requireRole(auth, "owner");
  return withTransaction(async (tx) => {
    await lockPlan(tx, auth.workspaceId);
    const [{ count }] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(workspaceModelKeys)
      .where(and(eq(workspaceModelKeys.workspaceId, auth.workspaceId)));
    const next = pro ? "pro" : settledPlan("free", count > 0);
    await writePlan(tx, auth, next);
    await recordAudit(
      auth,
      {
        action: "workspace_plan.changed",
        subjectType: "workspace",
        subjectId: auth.workspaceId,
        summary: `Plan set to ${next}`,
        metadata: { plan: next },
      },
      tx,
    );
    return next;
  });
}
