import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
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
  /*
   * A capture dropped on a slot (ASH-308). Not a lifecycle state: "planned"
   * is derived from scheduled_at + started_at. The value exists because
   * 'running'/'paused' trip the one-live-session index and the closed
   * states pollute history - see migration 0252.
   */
  "scheduled",
]);

export const focusSessions = pgTable(
  "focus_sessions",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "set null" }),
    /** What the owner is focusing on, when it is not a task. */
    subject: text("subject"),
    state: focusSessionState("state").notNull().default("running"),
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
      .where(sql`state in ('running', 'paused')`),
  ],
);
