import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { requestReceipts } from "@/domains/audit/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * Gate 2: replaying a mutation must not produce a second external effect.
 * These cases drive the public withReceipt interface against real Postgres,
 * because the guarantee is the (workspace, key) advisory lock plus the unique
 * index — neither of which a mock can show.
 *
 * The "external effect" is the `run` callback's counter. Every case asserts
 * both the returned `replayed` flag and the effect count, so deleting the
 * replay branch fails the suite rather than passing on a hand-built value.
 *
 * Skipped unless TEST_DATABASE_URL points at a database with the migrations
 * applied. The transaction wrapper and the unit under test are imported lazily
 * for the same reason as spending.test.ts: src/lib/db-transaction.ts reads
 * DATABASE_URL at module load, and makeTestDb points it at the scratch DB.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
let receipt: typeof import("@/domains/audit/receipt");
let withTransaction: typeof import("@/lib/db-transaction").withTransaction;

beforeAll(async () => {
  if (!handle) return;
  ({ db } = handle);
  receipt = await import("@/domains/audit/receipt");
  ({ withTransaction } = await import("@/lib/db-transaction"));
});

afterAll(async () => {
  await handle?.client.end();
});

async function workspace(slug: string) {
  const { userId, workspaceId } = await seedWorkspace(db, `${slug}-${Date.now()}`);
  return ownerAuth(userId, workspaceId);
}

async function receiptCount(workspaceId: string) {
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(requestReceipts)
    .where(eq(requestReceipts.workspaceId, workspaceId));
  return count;
}

suite("withReceipt", () => {
  it("same key and request runs the effect once and replays the stored value", async () => {
    const auth = await workspace("receipt-replay");
    const key = crypto.randomUUID();
    const request = { taskId: "t_1", body: "hello" };
    let effects = 0;
    const run = async () => ({ messageId: `msg_${++effects}` });

    const first = await withTransaction((tx) => receipt.withReceipt(tx, auth, key, request, run));
    const again = await withTransaction((tx) => receipt.withReceipt(tx, auth, key, request, run));

    expect(first).toEqual({ value: { messageId: "msg_1" }, replayed: false });
    // Both the flag and the count: a missing replay branch would re-run `run`
    // and hand back msg_2 while still reporting a receipt.
    expect(again.replayed).toBe(true);
    expect(again.value).toEqual({ messageId: "msg_1" });
    expect(effects).toBe(1);
    expect(await receiptCount(auth.workspaceId)).toBe(1);
  });

  it("same key with a different request throws IdempotencyConflictError and runs nothing", async () => {
    const auth = await workspace("receipt-conflict");
    const key = crypto.randomUUID();
    let effects = 0;
    const run = async () => ({ n: ++effects });

    await withTransaction((tx) => receipt.withReceipt(tx, auth, key, { body: "a" }, run));
    await expect(
      withTransaction((tx) => receipt.withReceipt(tx, auth, key, { body: "b" }, run)),
    ).rejects.toBeInstanceOf(receipt.IdempotencyConflictError);
    expect(effects).toBe(1);
  });

  it("no key runs each time and stores no receipt", async () => {
    const auth = await workspace("receipt-nokey");
    let effects = 0;
    const run = async () => ({ n: ++effects });

    const first = await withTransaction((tx) => receipt.withReceipt(tx, auth, undefined, {}, run));
    const again = await withTransaction((tx) => receipt.withReceipt(tx, auth, undefined, {}, run));

    expect(first).toEqual({ value: { n: 1 }, replayed: false });
    expect(again).toEqual({ value: { n: 2 }, replayed: false });
    expect(effects).toBe(2);
    expect(await receiptCount(auth.workspaceId)).toBe(0);
  });

  it("concurrent first attempts with one key run the effect exactly once", async () => {
    const auth = await workspace("receipt-concurrent");
    const key = crypto.randomUUID();
    let effects = 0;
    const run = async () => ({ n: ++effects });

    // Four at once: two contenders can serialize by luck and pass a broken
    // lock, so use more than two. The advisory lock makes the losers wait and
    // replay rather than insert a duplicate key.
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        withTransaction((tx) => receipt.withReceipt(tx, auth, key, { body: "same" }, run)),
      ),
    );

    expect(effects).toBe(1);
    expect(results.filter((r) => r.replayed === false)).toHaveLength(1);
    expect(results.filter((r) => r.replayed === true)).toHaveLength(3);
    expect(new Set(results.map((r) => JSON.stringify(r.value))).size).toBe(1);
    expect(await receiptCount(auth.workspaceId)).toBe(1);
  });

  it("the same key string in another workspace is independent", async () => {
    const one = await workspace("receipt-tenant-one");
    const two = await workspace("receipt-tenant-two");
    // Unique per run: the scratch DB is not truncated between runs, so a fixed
    // literal would accumulate receipts from earlier runs and hide the count.
    const key = `shared-${crypto.randomUUID()}`;
    const effects: string[] = [];
    const run = async (tag: string) => ({ tag: (effects.push(tag), tag) });

    const a = await withTransaction((tx) => receipt.withReceipt(tx, one, key, { tag: "a" }, () => run("a")));
    const b = await withTransaction((tx) => receipt.withReceipt(tx, two, key, { tag: "b" }, () => run("b")));
    const aAgain = await withTransaction((tx) => receipt.withReceipt(tx, one, key, { tag: "a" }, () => run("a")));

    expect(a).toEqual({ value: { tag: "a" }, replayed: false });
    expect(b).toEqual({ value: { tag: "b" }, replayed: false });
    expect(aAgain.replayed).toBe(true);
    expect(effects).toEqual(["a", "b"]);
    expect(
      await db
        .select({ count: sql<number>`count(*)::int` })
        .from(requestReceipts)
        .where(and(eq(requestReceipts.idempotencyKey, key))),
    ).toEqual([{ count: 2 }]);
  });
});
