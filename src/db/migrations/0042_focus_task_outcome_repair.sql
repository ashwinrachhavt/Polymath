-- Repair for 0033_focus_task_outcome. Its journal entry carries `when:
-- 1760000100000`, which sorts before 0040/0041, so drizzle's timestamp-only
-- skip rule (`created_at < folderMillis`) never applied it to a database that
-- had already run 0041. Fresh databases were unaffected, which is why CI
-- stayed green while upgraded ones were missing the columns and Focus threw
-- on every load. Idempotent so it is a no-op where 0033 did run.
ALTER TABLE "focus_sessions" ADD COLUMN IF NOT EXISTS "what_changed" text;--> statement-breakpoint
ALTER TABLE "focus_sessions" ADD COLUMN IF NOT EXISTS "next_step" text;
