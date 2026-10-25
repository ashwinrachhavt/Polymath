/*
 * ASH-308 Day Theatre: a capture becomes a planned session. "Planned" is
 * derived - scheduled_at set, started_at null - so started_at drops its NOT
 * NULL (running sessions still set it explicitly in the start flow).
 *
 * The ticket forbids changing focus_session_state, so a planned row borrows
 * 'paused' (the only non-terminal value) and is told apart by its columns:
 * scheduled_at set, started_at null. That makes the one-live-session unique
 * index wrong for it - a never-started row is not live - so the index gains
 * the started_at guard. The tradeoff and the rejected enum alternative are
 * on the PR and the ticket.
 */
ALTER TABLE "focus_sessions"
  ADD COLUMN "scheduled_at" timestamptz,
  ADD COLUMN "capture_id" uuid REFERENCES "captures"("id"),
  ALTER COLUMN "started_at" DROP NOT NULL;--> statement-breakpoint

DROP INDEX "focus_sessions_active_idx";--> statement-breakpoint

-- One live session per workspace means one STARTED live session: planned
-- rows (started_at null) never count.
CREATE UNIQUE INDEX "focus_sessions_active_idx"
  ON "focus_sessions" ("workspace_id")
  WHERE state in ('running', 'paused') AND started_at IS NOT NULL;--> statement-breakpoint

CREATE INDEX "focus_sessions_scheduled_day_idx"
  ON "focus_sessions" ("scheduled_at")
  WHERE "scheduled_at" IS NOT NULL AND "started_at" IS NULL;--> statement-breakpoint

CREATE INDEX "focus_sessions_capture_idx" ON "focus_sessions" ("capture_id");
