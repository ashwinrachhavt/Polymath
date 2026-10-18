import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

/*
 * The HTTP driver in src/lib/db.ts has no transaction, and money cannot be
 * reserved inside one fetch: the ceiling check and the reservation insert have
 * to commit together, behind a lock. Everything that must be atomic goes
 * through here. Never hold a transaction across a provider call — reserve,
 * commit, call, settle.
 *
 * The pool is larger than one on purpose: a per-workspace advisory lock only
 * holds if two transactions can actually run at once. A single connection
 * serializes every claim, and the lock would never be exercised.
 *
 * ponytail: per-process pool, unshared. Enough at current traffic; move to a
 * pooled Neon endpoint when concurrent transactions outnumber the pool.
 */
/*
 * Same deal as src/lib/db.ts: postgres() tolerates an empty URL at
 * construction, so a clone with no .env still builds. The connection fails at
 * first use, which is where a missing DATABASE_URL is a real error.
 */
const url = process.env.DATABASE_URL ?? "";

const client = postgres(url, { max: 5 });
const db = drizzle(client);

export type TxDrizzle = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function withTransaction<T>(
  fn: (tx: TxDrizzle) => Promise<T>,
): Promise<T> {
  return db.transaction(fn);
}
