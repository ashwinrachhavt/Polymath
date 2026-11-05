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
ALTER TABLE "tool_calls" DROP CONSTRAINT "tool_calls_step_id_agent_steps_id_fk";
--> statement-breakpoint
ALTER TABLE "tasks" DROP CONSTRAINT "tasks_recurrence_template_id_recurrence_templates_id_fk";
--> statement-breakpoint
ALTER TABLE "agent_steps" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "memory_reviews" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "run_artifacts" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "thread_checkpoints" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "application_materials" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "application_preparations" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "application_snapshots" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "webhook_inbox" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "schedule_proposals" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "daily_snapshots" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "external_identities" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "party_relationships" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "notebook_questions" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "opportunity_extensions" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "board_columns" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "recurrence_templates" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "saved_views" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "agent_steps" CASCADE;--> statement-breakpoint
DROP TABLE "memory_reviews" CASCADE;--> statement-breakpoint
DROP TABLE "run_artifacts" CASCADE;--> statement-breakpoint
DROP TABLE "thread_checkpoints" CASCADE;--> statement-breakpoint
DROP TABLE "application_materials" CASCADE;--> statement-breakpoint
DROP TABLE "application_preparations" CASCADE;--> statement-breakpoint
DROP TABLE "application_snapshots" CASCADE;--> statement-breakpoint
DROP TABLE "webhook_inbox" CASCADE;--> statement-breakpoint
DROP TABLE "schedule_proposals" CASCADE;--> statement-breakpoint
DROP TABLE "daily_snapshots" CASCADE;--> statement-breakpoint
DROP TABLE "external_identities" CASCADE;--> statement-breakpoint
DROP TABLE "party_relationships" CASCADE;--> statement-breakpoint
DROP TABLE "notebook_questions" CASCADE;--> statement-breakpoint
DROP TABLE "opportunity_extensions" CASCADE;--> statement-breakpoint
DROP TABLE "board_columns" CASCADE;--> statement-breakpoint
DROP TABLE "recurrence_templates" CASCADE;--> statement-breakpoint
DROP TABLE "saved_views" CASCADE;--> statement-breakpoint
DROP TYPE "public"."step_kind";--> statement-breakpoint
DROP TYPE "public"."material_kind";--> statement-breakpoint
DROP TYPE "public"."preparation_status";--> statement-breakpoint
DROP TYPE "public"."snapshot_kind";--> statement-breakpoint
DROP TYPE "public"."recurrence_cadence";
