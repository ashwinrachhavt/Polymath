import { and, asc, count, eq } from "drizzle-orm";
import type { AuthContext } from "@/domains/identity/resolve";
import { db } from "@/lib/db";
import { coinBalance } from "./coins";
import { stoneOwnership, stones } from "./schema";

export type CollectionStone = Omit<typeof stones.$inferSelect, "position"> & { ownedAt: Date | null };

/** The whole catalog in wall order, each stone marked with when this person bought it, and their balance. */
export async function getStoneCollection(auth: AuthContext): Promise<{ stones: CollectionStone[]; balance: number }> {
  const [rows, balance] = await Promise.all([
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
    coinBalance(db, auth),
  ]);
  return { stones: rows, balance };
}

/** The quiet summary Learn shows in its header: balance and how much of the set is owned. */
export async function getStoneProgress(auth: AuthContext): Promise<{ balance: number; owned: number; total: number }> {
  const [balance, [owned], [total]] = await Promise.all([
    coinBalance(db, auth),
    db
      .select({ n: count() })
      .from(stoneOwnership)
      .where(and(eq(stoneOwnership.workspaceId, auth.workspaceId), eq(stoneOwnership.userId, auth.userId))),
    db.select({ n: count() }).from(stones),
  ]);
  return { balance, owned: owned?.n ?? 0, total: total?.n ?? 0 };
}
