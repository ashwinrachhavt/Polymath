import { sql } from "drizzle-orm";
import { index, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { mutable, primaryId, tenantId } from "../../db/columns";
import { tasks } from "../work/schema";

/*
 * A focus session is durable state, not a client-side timer. The authoritative
 * timestamps live here so a refresh, a navigation, or a second tab resumes the
 * same session instead of starting a rival one.
 */

export const focusSessionState = pgEnum("focus_session_state", [
  "running",
  "paused",
  "interrupted",
  "finished",
  "abandoned",
]);

/*
 * Spec §1: how strictly the server holds a live session. Normal behaves as
 * always; timeout caps breaks; deep holds until the planned time is up. The
 * tier is the contract - add a value, never repurpose one.
 */
export const focusStrictness = pgEnum("focus_strictness", ["normal", "timeout", "deep"]);
export type FocusStrictness = (typeof focusStrictness.enumValues)[number];

export const focusSessions = pgTable(
  "focus_sessions",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "set null" }),
    /** What the owner is focusing on, when it is not a task. */
    subject: text("subject"),
    state: focusSessionState("state").notNull().default("running"),
    /** Spec §1 tier for this session; every guarded transition reads it. */
    strictness: focusStrictness("strictness").notNull().default("normal"),
    /** Structural count of pause transitions. The timeout tier's ≤2-pause rule is an invariant, not something to derive from free-text interruption reasons. */
    pauseCount: integer("pause_count").notNull().default(0),
    /** Set when an abandon is requested; the tier's cooldown (server clock) gates the confirm. */
    abandonRequestedAt: timestamp("abandon_requested_at", { withTimezone: true }),
    plannedMinutes: integer("planned_minutes"),
    /** Durable clock: startedAt plus accumulated time is authoritative. Null while only scheduled (ASH-308). */
    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow(),
    /** The slot a capture was dropped on; set until the session starts. */
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
    /** The capture this session was scheduled from; the capture row is never mutated. */
    captureId: uuid("capture_id"),
    lastResumedAt: timestamp("last_resumed_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    /** Seconds accumulated across pauses. */
    accumulatedSeconds: integer("accumulated_seconds").notNull().default(0),
    /** [{ at, reason }] — every pause, interruption, and resume. */
    interruptions: jsonb("interruptions").notNull().default([]),
    outcome: text("outcome"),
    /** The finish record against a linked task: what moved, where to resume. */
    whatChanged: text("what_changed"),
    nextStep: text("next_step"),
    ...mutable,
  },
  (t) => [
    index("focus_sessions_workspace_started_idx").on(t.workspaceId, t.startedAt),
    index("focus_sessions_scheduled_day_idx")
      .on(t.scheduledAt)
      .where(sql`${t.scheduledAt} is not null and ${t.startedAt} is null`),
    index("focus_sessions_capture_idx").on(t.captureId),
    // At most one live session per workspace; two tabs cannot both own the clock.
    uniqueIndex("focus_sessions_active_idx")
      .on(t.workspaceId)
      // A planned row borrows 'paused' but is not live: live means started (ASH-308).
      .where(sql`state in ('running', 'paused') and ${t.startedAt} is not null`),
  ],
);

/*
 * The blocklist the setup screen curates and the browser companion polls
 * (GET /api/v1/focus/blocklist). A pattern is a hostname the extension
 * matches (e.g. "news.ycombinator.com"); `kind` decides the verdict — a
 * matching `allow` wins over any matching `block`, which is why allow rows
 * sort first in every read. Stored lowercased so the unique key dedupes
 * case-variants instead of letting "GitHub.com" and "github.com" diverge.
 */
export const focusBlocklistKind = pgEnum("focus_blocklist_kind", ["block", "allow"]);

export const focusBlocklist = pgTable(
  "focus_blocklist",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    pattern: text("pattern").notNull(),
    kind: focusBlocklistKind("kind").notNull().default("block"),
    ...mutable,
  },
  (t) => [
    // One verdict per pattern per workspace, live rows only: archiving frees
    // the pattern for re-adding, the same lifecycle focus_sessions_active_idx
    // gives the live session above.
    uniqueIndex("focus_blocklist_pattern_key")
      .on(t.workspaceId, t.pattern)
      .where(sql`${t.archivedAt} is null`),
  ],
);
