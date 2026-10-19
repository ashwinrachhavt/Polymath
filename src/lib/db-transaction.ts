import { db } from "./db";

/*
 * Use the same Postgres pool for reads and transactions. The pool has multiple
 * connections so concurrent claims still exercise their advisory locks.
 * Never hold a transaction across a provider call: reserve, commit, call, settle.
 */

export type TxDrizzle = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function withTransaction<T>(
  fn: (tx: TxDrizzle) => Promise<T>,
): Promise<T> {
  return db.transaction(fn);
}
