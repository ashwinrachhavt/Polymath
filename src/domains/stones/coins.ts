import { and, eq, sql } from "drizzle-orm";
import { recordAudit } from "@/domains/audit/record";
import type { AuthContext } from "@/domains/identity/resolve";
import { db } from "@/lib/db";
import { withTransaction, type TxDrizzle } from "@/lib/db-transaction";
import { coinAwardFor, type Completion } from "./awards";
import { coinLedger, stoneOwnership, stones } from "./schema";

/*
 * The coin ledger's only writers. Every change to a person's coins goes
 * through `awardCoins` (inside the transaction that records the completion)
 * or `buyStone`, and both first take the person's coin lock, so a balance
 * check, a daily ceiling and the row written after it cannot interleave with
 * another write for the same person.
 */

async function lockCoins(tx: TxDrizzle, auth: AuthContext): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`coins:${auth.workspaceId}:${auth.userId}`}, 0))`,
  );
}

/** Today, YYYY-MM-DD, in the person's timezone (UTC when they have not set one). */
async function personDay(tx: TxDrizzle, auth: AuthContext): Promise<string> {
  const rows = await tx.execute(sql`
    select to_char(timezone(coalesce(
      (select timezone from user_preferences where workspace_id = ${auth.workspaceId} and user_id = ${auth.userId} limit 1),
      'UTC'), now()), 'YYYY-MM-DD') as day
  `);
  return (rows as unknown as Array<{ day: string }>)[0].day;
}

/** A person's balance: the sum of their ledger rows. */
export async function coinBalance(tx: TxDrizzle | typeof db, auth: AuthContext): Promise<number> {
  const [row] = await tx
    .select({ balance: sql<number>`coalesce(sum(${coinLedger.amount}), 0)::int` })
    .from(coinLedger)
    .where(and(eq(coinLedger.workspaceId, auth.workspaceId), eq(coinLedger.userId, auth.userId)));
  return row?.balance ?? 0;
}

/**
 * Pay coins for a completion, inside the caller's transaction so the coins
 * commit with the completion or not at all. Returns the coins paid: 0 when
 * the completion earns nothing, the event already paid (a replay, or the
 * same quiz, card or mission earlier today), or today's ceiling for this kind
 * of work is spent. Never throws for reward reasons.
 */
export async function awardCoins(tx: TxDrizzle, auth: AuthContext, completion: Completion): Promise<number> {
  await lockCoins(tx, auth);
  const day = await personDay(tx, auth);
  const award = coinAwardFor(completion, day);
  if (!award) return 0;

  const [today] = await tx
    .select({ earned: sql<number>`coalesce(sum(${coinLedger.amount}), 0)::int` })
    .from(coinLedger)
    .where(
      and(
        eq(coinLedger.workspaceId, auth.workspaceId),
        eq(coinLedger.userId, auth.userId),
        eq(coinLedger.reason, award.reason),
        // Any timezone's "today" began less than two days ago; the bound keeps the scan on the index.
        sql`${coinLedger.createdAt} > now() - interval '2 days'`,
        sql`to_char(timezone(coalesce(
          (select timezone from user_preferences where workspace_id = ${auth.workspaceId} and user_id = ${auth.userId} limit 1),
          'UTC'), ${coinLedger.createdAt}), 'YYYY-MM-DD') = ${day}`,
      ),
    );
  const amount = Math.min(award.amount, award.dailyCap - (today?.earned ?? 0));
  if (amount <= 0) return 0;

  const [row] = await tx
    .insert(coinLedger)
    .values({
      workspaceId: auth.workspaceId,
      userId: auth.userId,
      amount,
      reason: award.reason,
      subjectId: award.subjectId,
      idempotencyKey: award.idempotencyKey,
    })
    .onConflictDoNothing({ target: [coinLedger.workspaceId, coinLedger.userId, coinLedger.idempotencyKey] })
    .returning({ id: coinLedger.id });
  return row ? amount : 0;
}

export class StonePurchaseError extends Error {
  constructor(
    readonly code: "stone_not_found" | "insufficient_coins",
    message: string,
  ) {
    super(message);
    this.name = "StonePurchaseError";
  }
}

export type StonePurchase = { slug: string; name: string; price: number; balance: number; alreadyOwned: boolean };

/**
 * Buy one stone: the debit and the ownership row commit together or not at
 * all. Buying a stone already owned changes nothing and reports it, so a
 * double click or a retry never charges twice; a balance short of the price
 * throws `insufficient_coins` and writes nothing.
 */
export async function buyStone(auth: AuthContext, slug: string): Promise<StonePurchase> {
  return withTransaction(async (tx) => {
    await lockCoins(tx, auth);
    const [stone] = await tx
      .select({ slug: stones.slug, name: stones.name, price: stones.price })
      .from(stones)
      .where(eq(stones.slug, slug))
      .limit(1);
    if (!stone) throw new StonePurchaseError("stone_not_found", "There is no such stone.");

    const [owned] = await tx
      .select({ id: stoneOwnership.id })
      .from(stoneOwnership)
      .where(
        and(
          eq(stoneOwnership.workspaceId, auth.workspaceId),
          eq(stoneOwnership.userId, auth.userId),
          eq(stoneOwnership.stoneSlug, stone.slug),
        ),
      )
      .limit(1);
    const balance = await coinBalance(tx, auth);
    if (owned) return { ...stone, balance, alreadyOwned: true };
    if (balance < stone.price) {
      throw new StonePurchaseError(
        "insufficient_coins",
        `${stone.name} costs ${stone.price} coins; you have ${balance}.`,
      );
    }

    const [debit] = await tx
      .insert(coinLedger)
      .values({
        workspaceId: auth.workspaceId,
        userId: auth.userId,
        amount: -stone.price,
        reason: "stone_purchased",
        subjectId: stone.slug,
        idempotencyKey: `purchase:${stone.slug}`,
      })
      .returning({ id: coinLedger.id });
    await tx.insert(stoneOwnership).values({
      workspaceId: auth.workspaceId,
      userId: auth.userId,
      stoneSlug: stone.slug,
      ledgerEntryId: debit.id,
    });
    await recordAudit(
      auth,
      {
        action: "stones.purchased",
        subjectType: "coin_ledger",
        subjectId: debit.id,
        summary: `Bought ${stone.name} for ${stone.price} coins`,
        metadata: { slug: stone.slug, price: stone.price },
      },
      tx,
    );
    return { ...stone, balance: balance - stone.price, alreadyOwned: false };
  });
}
