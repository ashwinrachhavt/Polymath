import { beforeAll, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const transaction = vi.fn(async (fn: (tx: object) => Promise<unknown>) => fn({ marker: "transaction" }));
  return { transaction, pools: [] as unknown[], adapters: 0 };
});
vi.mock("postgres", () => ({ default: (...args: unknown[]) => { mocks.pools.push(args); return {}; } }));
vi.mock("drizzle-orm/postgres-js", () => ({ drizzle: () => { mocks.adapters++; return { transaction: mocks.transaction }; } }));

let db: typeof import("@/lib/db").db;
let withTransaction: typeof import("@/lib/db-transaction").withTransaction;
beforeAll(async () => {
  ({ db } = await import("@/lib/db"));
  ({ withTransaction } = await import("@/lib/db-transaction"));
});

describe("shared Postgres pool", () => {
  it("constructs one multi-connection pool for reads and transactions", async () => {
    const work = vi.fn(async (tx: object) => tx);
    expect(await withTransaction(work)).toEqual({ marker: "transaction" });
    expect(db.transaction).toHaveBeenCalledWith(work);
    // prepare:false keeps the pool safe behind Neon's transaction-mode pooler.
    expect(mocks.pools).toEqual([[expect.any(String), { max: 5, prepare: false }]]);
    expect(mocks.adapters).toBe(1);
  });
  it("propagates callback rejection rather than swallowing a rollback", async () => {
    const error = new Error("rollback");
    await expect(withTransaction(async () => { throw error; })).rejects.toBe(error);
  });
});
