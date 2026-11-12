import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { mutable, primaryId, tenantId } from "../../db/columns";
import { users } from "../identity/tables";

/*
 * Agent memory, in one table, deliberately.
 *
 * The hierarchy this backs (Anthropic, "The components of agent memory",
 * Nov 2026): transcripts -> notes -> injected index. Transcripts are not a new
 * store: they are `run_events` / `messages`, which the agent already writes.
 * What the agent lacked was the middle layer — a few salient observations with
 * provenance — and the small layer injected into every session.
 *
 * Notes are per workspace AND per person: memory belongs to the owner whose
 * runs produced it, and the injected index only ever reads the note rows of
 * the run's own user. The run id in source_id is provenance, never authority.
 *
 * `key` is the normalized-body digest. It makes "write the same observation
 * twice" a no-op instead of a duplicate, which is what lets the nightly pass
 * run again without growing the store.
 */

export const memoryNoteStatus = ["unconfirmed", "confirmed", "corrected"] as const;
export type MemoryNoteStatus = (typeof memoryNoteStatus)[number];

export const memoryNotes = pgTable(
  "memory_notes",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** One short observation. The cap is enforced by the migration's check too. */
    body: text("body").notNull(),
    status: text("status").$type<MemoryNoteStatus>().notNull().default("unconfirmed"),
    /** Normalized-body digest: equal observations collide, which is the dedupe. */
    key: text("key").notNull(),
    /** What the note was drawn from: a run the person had. */
    sourceKind: text("source_kind").notNull().default("run"),
    sourceId: uuid("source_id"),
    /** The transcript words the note is grounded in. Kept so a later pass can check it. */
    sourceQuote: text("source_quote"),
    /** Set when a correction replaced the body, so the previous wording is not lost. */
    previousBody: text("previous_body"),
    ...mutable,
  },
  (t) => [
    unique("memory_notes_owner_key").on(t.workspaceId, t.userId, t.key),
    index("memory_notes_owner_status_idx").on(t.workspaceId, t.userId, t.status, t.updatedAt),
    check("memory_notes_body_check", sql`char_length(btrim(body)) between 1 and 400`),
  ],
);

/*
 * One row per person per workspace: the watermark that makes dreaming
 * idempotent. A pass reads transcripts newer than `checked_through`; a second
 * run with no new transcripts returns without calling a model and changes
 * nothing. The summary is the last pass's own report, shown to the owner.
 */
export const memoryDreams = pgTable(
  "memory_dreams",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** The newest transcript creation time the last pass consumed. */
    checkedThrough: timestamp("checked_through", { withTimezone: true }),
    lastSummary: jsonb("last_summary").notNull().default({}),
    ...mutable,
  },
  (t) => [unique("memory_dreams_owner_key").on(t.workspaceId, t.userId)],
);
