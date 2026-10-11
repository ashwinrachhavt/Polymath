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

const url = process.env.DATABASE_URL;

if (!url) {
  throw new Error(
    "DATABASE_URL is not set. Copy .env.example to .env and paste the Neon connection string.",
  );
}

export const db = drizzle(neon(url));
