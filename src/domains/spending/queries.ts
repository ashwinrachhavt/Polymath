import { and, count, desc, eq, gte, ilike, or, sql } from "drizzle-orm";
import type { AuthContext } from "@/domains/identity/resolve";
import { db } from "@/lib/db";
import { escapeLike } from "@/lib/list-params";
import {
  modelRateCards,
  spendingPolicies,
  spendingReservations,
  spendSettlements,
} from "./schema";

/*
 * Read queries for the spending surface. Sums are derived from the ledger in
 * SQL, never cached: a stored balance is a balance that drifts. The daily
 * boundary is midnight in the workspace's timezone, the same rule the
 * reserve path enforces in commands.ts, and the arithmetic stays in
 * Postgres `numeric` - money is never a JS float.
 */

/** numeric columns come back from drizzle as strings; keep them strings. */
type Money = string;

export type SpendingOverview = {
  policy: typeof spendingPolicies.$inferSelect | null;
  /** Reserved today and not yet settled or released - budget still claimed. */
  openReservedToday: Money;
  /** Settled today - actual spend against the daily ceiling. */
  settledToday: Money;
  settledThisMonth: Money;
  /** Daily ceiling minus everything claimed against it today; null without a daily ceiling. */
  remainingToday: Money | null;
  openReservations: Array<typeof spendingReservations.$inferSelect>;
  recentSettlements: Array<typeof spendSettlements.$inferSelect>;
  rateCards: Array<typeof modelRateCards.$inferSelect>;
};

export async function getSpendingOverview(auth: AuthContext): Promise<SpendingOverview> {
  const [policy] = await db
    .select()
    .from(spendingPolicies)
    .where(eq(spendingPolicies.workspaceId, auth.workspaceId))
    .limit(1);

  // NULLIF keeps "no daily ceiling" a null remaining rather than a number.
  const totals = db.execute(sql`
    with budget_context as (
      select coalesce(
        (select timezone from user_preferences where workspace_id = ${auth.workspaceId} limit 1),
        'UTC') as tz
    ),
    bounds as (
      select
        timezone(tz, date_trunc('day', timezone(tz, now()))) as day_start,
        timezone(tz, date_trunc('month', timezone(tz, now()))) as month_start
      from budget_context
    ),
    claimed_today as (
      select coalesce(sum(r.reserved_usd), 0) as total
      from spending_reservations r, bounds b
      where r.workspace_id = ${auth.workspaceId} and r.status in ('reserved', 'settled')
        and r.created_at >= b.day_start
    )
    select
      coalesce((select sum(r.reserved_usd) from spending_reservations r, bounds b
        where r.workspace_id = ${auth.workspaceId} and r.status = 'reserved'
          and r.created_at >= b.day_start), 0)::text as open_reserved_today,
      coalesce((select sum(s.amount_usd) from spend_settlements s, bounds b
        where s.workspace_id = ${auth.workspaceId}
          and s.created_at >= b.day_start), 0)::text as settled_today,
      coalesce((select sum(s.amount_usd) from spend_settlements s, bounds b
        where s.workspace_id = ${auth.workspaceId}
          and s.created_at >= b.month_start), 0)::text as settled_this_month,
      (${policy?.dailyCeilingUsd ?? null}::numeric - (select total from claimed_today))::text as remaining_today
  `);

  const [openReservations, recentSettlements, rateCards, totalsRows] = await Promise.all([
    db
      .select()
      .from(spendingReservations)
      .where(and(eq(spendingReservations.workspaceId, auth.workspaceId), eq(spendingReservations.status, "reserved")))
      .orderBy(desc(spendingReservations.createdAt))
      .limit(50),
    db
      .select()
      .from(spendSettlements)
      .where(eq(spendSettlements.workspaceId, auth.workspaceId))
      .orderBy(desc(spendSettlements.createdAt))
      .limit(30),
    db
      .select()
      .from(modelRateCards)
      .where(eq(modelRateCards.workspaceId, auth.workspaceId))
      .orderBy(desc(modelRateCards.effectiveFrom))
      .limit(100),
    totals,
  ]);

  const row = (totalsRows as unknown as Array<Record<string, string | null>>)[0] ?? {};
  return {
    policy: policy ?? null,
    openReservedToday: row.open_reserved_today ?? "0",
    settledToday: row.settled_today ?? "0",
    settledThisMonth: row.settled_this_month ?? "0",
    remainingToday: row.remaining_today ?? null,
    openReservations,
    recentSettlements,
    rateCards,
  };
}

export const SETTLEMENT_RANGES = { "7d": 7, "30d": 30, "90d": 90 } as const;
export type SettlementRange = keyof typeof SETTLEMENT_RANGES;

/** The settlement ledger, one page at a time, newest first. Total honours the filters. */
export async function pageSettlements(
  auth: AuthContext,
  input: { query?: string; range?: SettlementRange; limit: number; offset: number },
) {
  const filters = [eq(spendSettlements.workspaceId, auth.workspaceId)];
  if (input.query?.trim()) filters.push(ilike(spendSettlements.model, `%${escapeLike(input.query.trim())}%`));
  if (input.range) {
    filters.push(gte(spendSettlements.createdAt, new Date(Date.now() - SETTLEMENT_RANGES[input.range] * 86_400_000)));
  }
  const where = and(...filters);
  const [items, [totalRow]] = await Promise.all([
    db.select().from(spendSettlements).where(where).orderBy(desc(spendSettlements.createdAt), desc(spendSettlements.id)).limit(input.limit).offset(input.offset),
    db.select({ total: count() }).from(spendSettlements).where(where),
  ]);
  return { items, total: totalRow?.total ?? 0 };
}

export async function pageRateCards(auth: AuthContext, input: { query?: string; limit: number; offset: number }) {
  const filters = [eq(modelRateCards.workspaceId, auth.workspaceId)];
  if (input.query?.trim()) {
    const like = `%${escapeLike(input.query.trim())}%`;
    filters.push(or(ilike(modelRateCards.model, like), ilike(modelRateCards.provider, like))!);
  }
  const where = and(...filters);
  const [items, [totalRow]] = await Promise.all([
    db.select().from(modelRateCards).where(where).orderBy(desc(modelRateCards.effectiveFrom), desc(modelRateCards.id)).limit(input.limit).offset(input.offset),
    db.select({ total: count() }).from(modelRateCards).where(where),
  ]);
  return { items, total: totalRow?.total ?? 0 };
}
