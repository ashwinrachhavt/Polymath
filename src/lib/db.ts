import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

/*
 * postgres-js over TCP, the same driver db-transaction.ts uses. The neon-http
 * driver was tried here and rejected for two reasons: it speaks Neon's HTTPS
 * proxy protocol, which a plain local Postgres does not (a clone could not
 * develop against localhost), and unioning the two drizzle driver types breaks
 * overload resolution on `.returning({fields})` at every call site. Neon
 * accepts standard TCP through its pooled connection string, so one driver
 * serves both.
 *
 * An empty string is accepted here so a clone with no .env still *builds* —
 * `next build` evaluates route modules, and a throw at import time failed CI.
 * The missing URL is surfaced at first query instead, where it is an actual
 * runtime error rather than a build one.
 */

const url = process.env.DATABASE_URL ?? "";

/*
 * prepare: false keeps the client safe behind Neon's transaction-mode pooler
 * (PgBouncer), which cannot route named prepared statements to the same
 * backend. It costs a per-execute parse on a local direct connection and is
 * imperceptible at this scale; the pooled endpoint is the default Vercel+Neon
 * posture, so the default must tolerate it. Documented in .env.example.
 *
 * The timeouts are the pool's guardrails, not its tuning: with max: 5, one
 * leaked transaction or hung statement removes a slot from a pool every
 * interactive route shares, and nothing else surfaces the loss. postgres-js
 * drivers the session with SET on each connect — statement_timeout bounds a
 * wedged query, idle_in_transaction_session_timeout releases a backend whose
 * holder is stuck between provider calls (an idle-in-transaction connection
 * is never returned to the pool, on Neon's pooler or locally). The 60s
 * allowance is sized for the app's external-call-in-transaction patterns;
 * per-connection knobs (idle_timeout, max_lifetime, connect_timeout) recycle
 * sockets and bound connect attempts so a network wedge cannot consume slots
 * indefinitely.
 */
export const db = drizzle(
  postgres(url, {
    max: 5,
    prepare: false,
    idle_timeout: 30,
    connect_timeout: 10,
    max_lifetime: 3600,
    connection: {
      statement_timeout: 30_000,
      idle_in_transaction_session_timeout: 60_000,
    },
  }),
);
