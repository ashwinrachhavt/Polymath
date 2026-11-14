import { and, asc, count, eq, sql } from "drizzle-orm";
import type { AuthContext } from "@/domains/identity/resolve";
import { db } from "@/lib/db";
import { coinLedger, stoneOwnership, stones } from "./schema";
import { earnedToday } from "./coins";
import { levelFor, type LevelProgress } from "./levels";

export type CollectionStone = Omit<typeof stones.$inferSelect, "position"> & { ownedAt: Date | null };

export type CoinStanding = { balance: number; level: LevelProgress };

/** Balance and level in one read: the balance is every ledger row, the level's XP only the earnings. */
export async function getCoinStanding(auth: AuthContext): Promise<CoinStanding> {
  const [row] = await db
    .select({
      balance: sql<number>`coalesce(sum(${coinLedger.amount}), 0)::int`,
      earned: sql<number>`coalesce(sum(${coinLedger.amount}) filter (where ${coinLedger.amount} > 0), 0)::int`,
    })
    .from(coinLedger)
    .where(and(eq(coinLedger.workspaceId, auth.workspaceId), eq(coinLedger.userId, auth.userId)));
  return { balance: row?.balance ?? 0, level: levelFor(row?.earned ?? 0) };
}

/** The whole catalog in wall order, each stone marked with when this person bought it, plus their standing and today's earnings. */
export async function getStoneCollection(auth: AuthContext): Promise<{
  stones: CollectionStone[];
  balance: number;
  level: LevelProgress;
  earnedToday: Awaited<ReturnType<typeof earnedToday>>;
}> {
  const [rows, standing, today] = await Promise.all([
    db
      .select({
        slug: stones.slug,
        name: stones.name,
        family: stones.family,
        formula: stones.formula,
        color: stones.color,
        hardness: stones.hardness,
        origin: stones.origin,
        fact: stones.fact,
        lore: stones.lore,
        tier: stones.tier,
        price: stones.price,
        ownedAt: stoneOwnership.acquiredAt,
      })
      .from(stones)
      .leftJoin(
        stoneOwnership,
        and(
          eq(stoneOwnership.stoneSlug, stones.slug),
          eq(stoneOwnership.workspaceId, auth.workspaceId),
          eq(stoneOwnership.userId, auth.userId),
        ),
      )
      .orderBy(asc(stones.position)),
    getCoinStanding(auth),
    earnedToday(db, auth),
  ]);
  return { stones: rows, balance: standing.balance, level: standing.level, earnedToday: today };
}

/** The quiet summary Learn shows in its header: balance and how much of the set is owned. */
export async function getStoneProgress(auth: AuthContext): Promise<CoinStanding & { owned: number; total: number }> {
  const [standing, [owned], [total]] = await Promise.all([
    getCoinStanding(auth),
    db
      .select({ n: count() })
      .from(stoneOwnership)
      .where(and(eq(stoneOwnership.workspaceId, auth.workspaceId), eq(stoneOwnership.userId, auth.userId))),
    db.select({ n: count() }).from(stones),
  ]);
  return { ...standing, owned: owned?.n ?? 0, total: total?.n ?? 0 };
}
