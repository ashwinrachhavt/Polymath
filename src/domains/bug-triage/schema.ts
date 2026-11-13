import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { BugSignal } from "./signal";

/*
 * One row per bug fingerprint. The row is both the dedupe record (a unique
 * fingerprint) and the bug agent's queue (rows with no issue yet). Not
 * workspace-owned: a Sentry alert names no workspace, and the payload holds
 * only scrubbed, structured fields - no user, no workspace, no content.
 */
export const bugSignals = pgTable(
  "bug_signals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fingerprint: text("fingerprint").notNull().unique(),
    /** The latest scrubbed sighting. */
    signal: jsonb("signal").$type<BugSignal>().notNull(),
    occurrences: integer("occurrences").notNull().default(1),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    /** Set once the GitHub issue exists; the row then only counts sightings. */
    issueNumber: integer("issue_number"),
    filedAt: timestamp("filed_at", { withTimezone: true }),
    /** A filing attempt in flight; a worker that dies leaves it to expire. */
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    /** Earliest next attempt after a failure. */
    retryAt: timestamp("retry_at", { withTimezone: true }),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
  },
  (t) => [
    index("bug_signals_unfiled_idx")
      .on(t.firstSeenAt)
      .where(sql`issue_number is null`),
    index("bug_signals_filed_at_idx").on(t.filedAt),
    check("bug_signals_filed_together", sql`(issue_number is null) = (filed_at is null)`),
  ],
);
