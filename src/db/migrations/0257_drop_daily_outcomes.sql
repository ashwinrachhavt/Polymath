-- Drop the accepted-outcome machinery (2026-10-26).
--
-- `daily_outcomes` recorded the day's accepted commitments. It has had no
-- writer since the Briefing outcome picker was removed, and no reader at all,
-- so it is a table that can only ever be empty. Its replacement is task status:
-- "committed today" is READY or IN_PROGRESS on the canonical task, which the
-- Work page already answers and which cannot go stale the way a day-scoped
-- tag can.
--
-- Safe to apply: nothing in src/ references the table, and `briefing_seeds`
-- (a different, live table written by the shutdown ritual) is untouched.
DROP INDEX IF EXISTS "daily_outcomes_day_task_key";
--> statement-breakpoint
DROP INDEX IF EXISTS "daily_outcomes_day_idx";
--> statement-breakpoint
DROP TABLE IF EXISTS "daily_outcomes";
