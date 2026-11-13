import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { coinLedger, stoneOwnership, stones } from "@/domains/stones/schema";
import { loadCatalog } from "../../scripts/stones/catalog";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * The coin ledger and the stone shop against a real database: awards are
 * idempotent per event and clipped by the daily ceiling, a purchase debits
 * and grants together or not at all, and concurrent purchases cannot spend
 * the same coins twice. The catalog table must equal catalog.json.
 */

const handle = makeTestDb({ max: 6 });
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
let coins: typeof import("@/domains/stones/coins");
let queries: typeof import("@/domains/stones/queries");
let tx: typeof import("@/lib/db-transaction");

beforeAll(async () => {
  if (!handle) return;
  ({ db } = handle);
  coins = await import("@/domains/stones/coins");
  queries = await import("@/domains/stones/queries");
  tx = await import("@/lib/db-transaction");
});
afterAll(async () => {
  await handle?.client.end();
});

let seq = 0;
async function person() {
  const s = await seedWorkspace(db, `stones-${Date.now()}-${(seq += 1)}`);
  return ownerAuth(s.userId, s.workspaceId);
}

type Auth = Awaited<ReturnType<typeof person>>;
type Completion = Parameters<typeof import("@/domains/stones/coins").awardCoins>[2];

const award = (auth: Auth, completion: Completion) => tx.withTransaction((t) => coins.awardCoins(t, auth, completion));

/** Test fixture: an opening balance, written the way the legacy conversion writes it. */
async function grant(auth: Auth, amount: number) {
  await db.insert(coinLedger).values({
    workspaceId: auth.workspaceId,
    userId: auth.userId,
    amount,
    reason: "legacy_rewards",
    idempotencyKey: `fixture-${crypto.randomUUID()}`,
  });
}

const ledgerOf = (auth: Auth) =>
  db
    .select()
    .from(coinLedger)
    .where(and(eq(coinLedger.workspaceId, auth.workspaceId), eq(coinLedger.userId, auth.userId)));

suite("coin awards", () => {
  it("pays a completion once: replaying the same event writes nothing", async () => {
    const auth = await person();
    const taskId = crypto.randomUUID();
    expect(await award(auth, { kind: "task", taskId })).toBe(5);
    expect(await award(auth, { kind: "task", taskId })).toBe(0);
    expect(await ledgerOf(auth)).toHaveLength(1);
  });

  it("pays the same quiz once a day, and a different quiz again", async () => {
    const auth = await person();
    const quizId = crypto.randomUUID();
    const sitting = { kind: "quiz" as const, quizId, correct: 4, total: 4 };
    expect(await award(auth, { ...sitting, attemptId: crypto.randomUUID() })).toBe(50);
    expect(await award(auth, { ...sitting, attemptId: crypto.randomUUID() })).toBe(0);
    expect(await award(auth, { ...sitting, quizId: crypto.randomUUID(), attemptId: crypto.randomUUID() })).toBe(50);
  });

  it("stops paying a kind of work at its daily ceiling, paying only what is left", async () => {
    const auth = await person();
    const paid: number[] = [];
    for (let i = 0; i < 31; i += 1)
      paid.push(await award(auth, { kind: "flashcard", flashcardId: crypto.randomUUID() }));
    expect(paid.reduce((sum, n) => sum + n, 0)).toBe(60);
    expect(paid.at(-1)).toBe(0);

    await db.insert(coinLedger).values({
      workspaceId: auth.workspaceId,
      userId: auth.userId,
      amount: 185,
      reason: "quiz_completed",
      idempotencyKey: `fixture-${crypto.randomUUID()}`,
    });
    const clipped = await award(auth, {
      kind: "quiz",
      quizId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      correct: 3,
      total: 3,
    });
    expect(clipped).toBe(15);
  });

  it("racing awards for the same event pay once", async () => {
    const auth = await person();
    const taskId = crypto.randomUUID();
    const results = await Promise.all(Array.from({ length: 4 }, () => award(auth, { kind: "task", taskId })));
    expect(results.sort()).toEqual([0, 0, 0, 5]);
  });

  it("keeps each person's coins their own", async () => {
    const one = await person();
    const two = await person();
    await award(one, { kind: "task", taskId: crypto.randomUUID() });
    expect(await coins.coinBalance(db as never, one)).toBe(5);
    expect(await coins.coinBalance(db as never, two)).toBe(0);
  });
});

suite("buying stones", () => {
  it("refuses a purchase the balance cannot cover and writes nothing", async () => {
    const auth = await person();
    await grant(auth, 20);
    await expect(coins.buyStone(auth, "diamond")).rejects.toMatchObject({ code: "insufficient_coins" });
    expect(await ledgerOf(auth)).toHaveLength(1);
    expect(await db.select().from(stoneOwnership).where(eq(stoneOwnership.userId, auth.userId))).toHaveLength(0);
  });

  it("debits the catalog price and grants the stone together; buying it again changes nothing", async () => {
    const auth = await person();
    const [stone] = await db.select().from(stones).where(eq(stones.slug, "rose-quartz"));
    await grant(auth, stone.price + 7);

    const first = await coins.buyStone(auth, "rose-quartz");
    expect(first).toMatchObject({ slug: "rose-quartz", balance: 7, alreadyOwned: false });
    const again = await coins.buyStone(auth, "rose-quartz");
    expect(again).toMatchObject({ balance: 7, alreadyOwned: true });

    const debits = (await ledgerOf(auth)).filter((row) => row.reason === "stone_purchased");
    expect(debits.map((row) => row.amount)).toEqual([-stone.price]);
    const [owned] = await db.select().from(stoneOwnership).where(eq(stoneOwnership.userId, auth.userId));
    expect(owned).toMatchObject({ stoneSlug: "rose-quartz", ledgerEntryId: debits[0].id });

    const collection = await queries.getStoneCollection(auth);
    expect(collection.balance).toBe(7);
    expect(collection.stones.filter((s) => s.ownedAt !== null).map((s) => s.slug)).toEqual(["rose-quartz"]);
  });

  it("concurrent purchases cannot spend the same coins twice", async () => {
    const auth = await person();
    const two = await db.select().from(stones).where(eq(stones.tier, "crystal")).orderBy(asc(stones.price)).limit(2);
    // Enough for either stone, not both.
    await grant(auth, Math.max(two[0].price, two[1].price));
    const results = await Promise.allSettled(two.map((stone) => coins.buyStone(auth, stone.slug)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(await coins.coinBalance(db as never, auth)).toBeGreaterThanOrEqual(0);
    expect(await db.select().from(stoneOwnership).where(eq(stoneOwnership.userId, auth.userId))).toHaveLength(1);
  });

  it("a double click on one stone charges once", async () => {
    const auth = await person();
    const [stone] = await db.select().from(stones).where(eq(stones.slug, "pyrite"));
    await grant(auth, stone.price * 3);
    await Promise.all([coins.buyStone(auth, "pyrite"), coins.buyStone(auth, "pyrite")]);
    expect(await coins.coinBalance(db as never, auth)).toBe(stone.price * 2);
  });

  it("names an unknown stone", async () => {
    const auth = await person();
    await expect(coins.buyStone(auth, "kryptonite")).rejects.toMatchObject({ code: "stone_not_found" });
  });
});

suite("the catalog table", () => {
  it("holds exactly the 200 stones of catalog.json, in order", async () => {
    const rows = await db.select().from(stones).orderBy(asc(stones.position));
    const catalog = loadCatalog();
    expect(rows).toHaveLength(200);
    expect(rows).toEqual(
      catalog.map((entry, index) => ({
        slug: entry.slug,
        name: entry.name,
        family: entry.family,
        formula: entry.formula,
        color: entry.color,
        hardness: entry.hardness,
        origin: entry.origin,
        fact: entry.fact,
        lore: entry.lore,
        tier: entry.tier,
        price: entry.price,
        position: index + 1,
      })),
    );
  });
});
