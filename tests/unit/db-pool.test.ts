import { beforeAll, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const execute = vi.fn(async (_statement?: unknown) => ({ rows: [] }));
  const transaction = vi.fn(async (fn: (tx: object) => Promise<unknown>) => fn({ marker: "transaction", execute }));
  return { transaction, execute, pools: [] as unknown[], adapters: 0 };
});
vi.mock("postgres", () => ({
  default: (...args: unknown[]) => {
    mocks.pools.push(args);
    return {};
  },
}));
vi.mock("drizzle-orm/postgres-js", () => ({
  drizzle: () => {
    mocks.adapters++;
    return { transaction: mocks.transaction };
  },
}));

let withTransaction: typeof import("@/lib/db-transaction").withTransaction;
beforeAll(async () => {
  ({ withTransaction } = await import("@/lib/db-transaction"));
});

describe("shared Postgres pool", () => {
  it("constructs one multi-connection pool for reads and transactions", async () => {
    const work = vi.fn(async (tx: object) => tx);
    expect(await withTransaction(work)).toEqual(expect.objectContaining({ marker: "transaction" }));
    // db.transaction receives withTransaction's guardrail wrapper, not work
    // itself; test 2 pins that work still runs inside it with the tx.
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    // prepare:false keeps the pool safe behind Neon's transaction-mode
    // pooler. The per-connection knobs are client-side only — never startup
    // parameters, which transaction-mode poolers reject.
    expect(mocks.pools).toEqual([
      [expect.any(String), { max: 5, prepare: false, idle_timeout: 30, connect_timeout: 10, max_lifetime: 3600 }],
    ]);
    expect(mocks.adapters).toBe(1);
  });
  it("applies the timeout guardrails as session-local config on every transaction", async () => {
    const work = vi.fn(async (tx: object) => tx);
    await withTransaction(work);
    // One round trip per transaction, set_config with is_local so the
    // config reverts at commit and cannot leak through the pooled session.
    expect(mocks.execute).toHaveBeenCalledTimes(1);
    const statement = JSON.stringify(mocks.execute.mock.calls[0]?.[0]);
    expect(statement).toContain("statement_timeout");
    expect(statement).toContain("idle_in_transaction_session_timeout");
    expect(statement).toContain("true");
    expect(work).toHaveBeenCalledWith(expect.objectContaining({ marker: "transaction" }));
  });
  it("propagates callback rejection rather than swallowing a rollback", async () => {
    const error = new Error("rollback");
    await expect(
      withTransaction(async () => {
        throw error;
      }),
    ).rejects.toBe(error);
  });
});
