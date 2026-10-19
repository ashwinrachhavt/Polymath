import { desc, eq, sql } from "drizzle-orm";
import type { AuthContext } from "@/domains/identity/resolve";
import { db } from "@/lib/db";
import { rewardDefinitions, rewardLedger } from "./schema";

/*
 * Read queries for the rewards surface (ASH-137 A10). Totals are derived
 * from the append-only ledger in SQL at render, never from a stored balance:
 * user_progress is a rebuildable cache, and this surface does not trust it.
 */

export type RewardsOverview = {
  definitions: Array<typeof rewardDefinitions.$inferSelect>;
  ledger: Array<typeof rewardLedger.$inferSelect & { definitionKey: string; definitionLabel: string }>;
  /** Sum of ledger points - the score is a derivation, not a record. */
  totalPoints: number;
  /** Distinct workspace-local days with at least one ledger entry. */
  activeDays: number;
};

export async function getRewardsOverview(auth: AuthContext): Promise<RewardsOverview> {
  const [definitions, ledger, totals] = await Promise.all([
    db
      .select()
      .from(rewardDefinitions)
      .where(eq(rewardDefinitions.workspaceId, auth.workspaceId))
      .orderBy(rewardDefinitions.key)
      .limit(100),
    db
      .select({
        id: rewardLedger.id,
        workspaceId: rewardLedger.workspaceId,
        rewardDefinitionId: rewardLedger.rewardDefinitionId,
        userId: rewardLedger.userId,
        reason: rewardLedger.reason,
        subjectType: rewardLedger.subjectType,
        subjectId: rewardLedger.subjectId,
        points: rewardLedger.points,
        idempotencyKey: rewardLedger.idempotencyKey,
        createdAt: rewardLedger.createdAt,
        definitionKey: rewardDefinitions.key,
        definitionLabel: rewardDefinitions.label,
      })
      .from(rewardLedger)
      .innerJoin(rewardDefinitions, eq(rewardDefinitions.id, rewardLedger.rewardDefinitionId))
      .where(eq(rewardLedger.workspaceId, auth.workspaceId))
      .orderBy(desc(rewardLedger.createdAt))
      .limit(50),
    db.execute(sql`
      select
        coalesce(sum(points), 0)::int as total_points,
        count(distinct created_at::date)::int as active_days
      from reward_ledger
      where workspace_id = ${auth.workspaceId}
    `),
  ]);

  const row = (totals as unknown as Array<{ total_points: number; active_days: number }>)[0] ?? {
    total_points: 0,
    active_days: 0,
  };
  return { definitions, ledger, totalPoints: row.total_points, activeDays: row.active_days };
}
