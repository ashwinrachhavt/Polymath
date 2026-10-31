import { sql } from "drizzle-orm";
import { db } from "./db";

/*
 * Use the same Postgres pool for reads and transactions. The pool has multiple
 * connections so concurrent claims still exercise their advisory locks.
 * Never hold a transaction across a provider call: reserve, commit, call, settle.
 */

export type TxDrizzle = Parameters<Parameters<typeof db.transaction>[0]>[0];

/*
 * The pool's guardrails ride every transaction as session-local config.
 * They cannot be driver connection options: postgres-js sends those as
 * startup parameters, which transaction-mode poolers (Neon's PgBouncer)
 * reject before the connection opens. set_config with is_local reverts at
 * commit/rollback, so nothing leaks through a pooled server session — and
 * the guardrails cannot outlive the transaction they bound.
 *
 * statement_timeout (30s) bounds a wedged statement; the
 * idle-in-transaction timeout (60s) releases a backend whose holder died
 * mid-transaction, the failure class that otherwise holds one of the pool's
 * five slots until process restart. The 60s allowance is sized for the
 * app's external-call-in-transaction patterns; it is a backstop, not a
 * license for them. Bare-pool reads (no transaction) are not covered —
 * they cannot leak a backend the way a leaked transaction can.
 */
const TX_GUARDRAILS =
  "SELECT set_config('statement_timeout', '30s', true), set_config('idle_in_transaction_session_timeout', '60s', true)";

export async function withTransaction<T>(
  fn: (tx: TxDrizzle) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql.raw(TX_GUARDRAILS));
    return fn(tx);
  });
}
