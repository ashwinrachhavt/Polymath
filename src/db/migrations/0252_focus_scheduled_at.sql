/*
 * ASH-308 Day Theatre: a capture becomes a planned session. "Planned" is
 * derived - scheduled_at set, started_at null - so started_at drops its NOT
 * NULL (running sessions still set it explicitly in the start flow).
 *
 * DEVIATION FROM THE TICKET (disclosed in the PR): the ticket says "no
 * change to focus_session_state", but every existing value breaks an
 * invariant for a row that has not run: 'running'/'paused' trip the
 * one-live-session partial unique index, and 'interrupted'/'finished'/
 * 'abandoned' pollute history reads (listFocusHistory filters on those
 * states alone). The row needs a value that means "not started", so the
 * enum gains 'scheduled'. The derivation rule is unchanged: planned is
 * scheduled_at + started_at, never the state.
 */
ALTER TYPE "public"."focus_session_state" ADD VALUE IF NOT EXISTS 'scheduled';--> statement-breakpoint

ALTER TABLE "focus_sessions"
  ADD COLUMN "scheduled_at" timestamptz,
  ADD COLUMN "capture_id" uuid REFERENCES "captures"("id"),
  ALTER COLUMN "started_at" DROP NOT NULL;--> statement-breakpoint

CREATE INDEX "focus_sessions_scheduled_day_idx"
  ON "focus_sessions" ("scheduled_at")
  WHERE "scheduled_at" IS NOT NULL AND "started_at" IS NULL;--> statement-breakpoint

CREATE INDEX "focus_sessions_capture_idx" ON "focus_sessions" ("capture_id");
