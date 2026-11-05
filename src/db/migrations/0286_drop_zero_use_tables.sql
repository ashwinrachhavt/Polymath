-- 0286: drop the 17 verified-dead tables (YAGNI sweep, spec art_bmbIcMBS D2-D4).
--
-- Zero non-schema references per table (camelCase + snake_case, all dirs):
-- the applications ghost domain's 3 tables, the 4 agents trace tables, the
-- audit webhook_inbox, 3 work planning tables, daily_snapshots,
-- schedule_proposals, notebook_questions, opportunity_extensions, and the
-- identity external_identities / party_relationships pair. Their enum types go
-- with them. The dangling FK constraints on live tables (tool_calls.step_id,
-- tasks.recurrence_template_id) are dropped BEFORE the tables — DROP TABLE
-- CASCADE would remove them implicitly, and an explicit drop after that fails.
--> statement-breakpoint
ALTER TABLE "tool_calls" DROP CONSTRAINT IF EXISTS "tool_calls_step_id_agent_steps_id_fk";
--> statement-breakpoint
ALTER TABLE "tasks" DROP CONSTRAINT IF EXISTS "tasks_recurrence_template_id_recurrence_templates_id_fk";
--> statement-breakpoint
DROP TABLE IF EXISTS "agent_steps" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "memory_reviews" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "run_artifacts" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "thread_checkpoints" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "application_materials" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "application_preparations" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "application_snapshots" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "webhook_inbox" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "schedule_proposals" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "daily_snapshots" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "external_identities" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "party_relationships" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "notebook_questions" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "opportunity_extensions" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "board_columns" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "recurrence_templates" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "saved_views" CASCADE;--> statement-breakpoint
DROP TYPE IF EXISTS "public"."step_kind";--> statement-breakpoint
DROP TYPE IF EXISTS "public"."material_kind";--> statement-breakpoint
DROP TYPE IF EXISTS "public"."preparation_status";--> statement-breakpoint
DROP TYPE IF EXISTS "public"."snapshot_kind";--> statement-breakpoint
DROP TYPE IF EXISTS "public"."recurrence_cadence";
