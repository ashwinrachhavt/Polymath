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

export const db = drizzle(postgres(url, { max: 5 }));
