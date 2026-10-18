import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";

/*
 * Neon's HTTP driver, not a TCP pool. Every query is one fetch, which is what
 * a serverless request wants; there is no connection to leak between
 * invocations. Swap to `neon-serverless` the day a transaction spans code
 * that awaits a provider call.
 *
 * Nothing imports this yet, so a clone with no DATABASE_URL still builds —
 * the throw below only fires when a domain actually reaches for the database.
 */

/*
 * An empty string is accepted here so a clone with no .env still *builds* —
 * `next build` evaluates route modules, and a throw at import time failed CI.
 * The missing URL is surfaced at first query instead, where it is an actual
 * runtime error rather than a build one.
 */
const url = process.env.DATABASE_URL ?? "";

export const db = drizzle(neon(url));
