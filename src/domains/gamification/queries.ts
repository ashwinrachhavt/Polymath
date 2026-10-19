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
  ledger: Array<typeof rewardLedger.$inferSelect & { definitionKey: string; definitionLabel: string; definitionKind: string; definitionThreshold: number }>;
  /** Sum of ledger points - the score is a derivation, not a record. */
  totalPoints: number;
  /** Distinct workspace-local days with at least one ledger entry. */
  activeDays: number;
  /** Stones earned, shards claimed, and the explicit-claim remainder. */
  shards: { stones: number; claimed: number; claimable: number };
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
        definitionKind: rewardDefinitions.kind,
        definitionThreshold: rewardDefinitions.threshold,
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
  const shardRows = await db.execute(sql`
    select
      count(*) filter (where d.key <> 'shard')::int as stones,
      count(*) filter (where d.key = 'shard')::int as claimed
    from reward_ledger l
    join reward_definitions d on d.id = l.reward_definition_id
    where l.workspace_id = ${auth.workspaceId}
  `);
  const shardRow = (shardRows as unknown as Array<{ stones: number; claimed: number }>)[0] ?? { stones: 0, claimed: 0 };
  const claimable = Math.max(0, Math.floor(shardRow.stones / 5) - shardRow.claimed);
  return {
    definitions,
    ledger,
    totalPoints: row.total_points,
    activeDays: row.active_days,
    shards: { stones: shardRow.stones, claimed: shardRow.claimed, claimable },
  };
}

/*
 * The "Stone earned" announcement (ASH-135 s7): the newest real earning is
 * surfaced once as a coach mark keyed by the ledger row id. Shard claims and
 * adjustments are not earnings, and a stale row (a first visit months later)
 * announces nothing - the toast answers "what just happened", not history.
 */
export const ANNOUNCEMENT_WINDOW_MS = 72 * 60 * 60 * 1000;

export function pickRewardAnnouncement(
  ledger: RewardsOverview["ledger"],
  now: Date,
): (RewardsOverview["ledger"][number] & { milestone: boolean }) | null {
  const entry = ledger.find(
    (row) => row.points > 0 && row.reason !== "adjustment" && now.getTime() - row.createdAt.getTime() <= ANNOUNCEMENT_WINDOW_MS,
  );
  if (!entry) return null;
  return { ...entry, milestone: entry.definitionKind === "badge" || entry.definitionThreshold > 1 };
}
