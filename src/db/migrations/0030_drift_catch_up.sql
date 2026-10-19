-- Hand-reviewed schema-drift catch-up. Several merged PRs changed domain
-- schema.ts without a migration; this reconciles a fully migrated database
-- (0000-0020 applied) with the current schema. Produced by `drizzle-kit
-- generate` and then pruned statement-by-statement against 0008, 0010, 0012
-- and 0020, whose statements are already applied and were removed. Forward-
-- only, no data rewrites. What remains is the true drift:
--
-- 1. event_links, artifact_links and opportunity_links still carry the
--    13-kind target_type check from 0002. linkTargetKinds (src/db/columns.ts)
--    gained "person" and "organization", and 0008 widened only task_links.
--    Existing rows satisfy the old list, so nothing can violate the widened
--    one.
ALTER TABLE "event_links" DROP CONSTRAINT "event_links_target_type_check";--> statement-breakpoint
ALTER TABLE "event_links" ADD CONSTRAINT "event_links_target_type_check" CHECK (target_type in ('task', 'project', 'space', 'note', 'artifact', 'document', 'source', 'event', 'contact', 'company', 'person', 'organization', 'opportunity', 'run', 'thread'));--> statement-breakpoint
ALTER TABLE "artifact_links" DROP CONSTRAINT "artifact_links_target_type_check";--> statement-breakpoint
ALTER TABLE "artifact_links" ADD CONSTRAINT "artifact_links_target_type_check" CHECK (target_type in ('task', 'project', 'space', 'note', 'artifact', 'document', 'source', 'event', 'contact', 'company', 'person', 'organization', 'opportunity', 'run', 'thread'));--> statement-breakpoint
ALTER TABLE "opportunity_links" DROP CONSTRAINT "opportunity_links_target_type_check";--> statement-breakpoint
ALTER TABLE "opportunity_links" ADD CONSTRAINT "opportunity_links_target_type_check" CHECK (target_type in ('task', 'project', 'space', 'note', 'artifact', 'document', 'source', 'event', 'contact', 'company', 'person', 'organization', 'opportunity', 'run', 'thread'));--> statement-breakpoint
-- 2. party_employment's workspace FK was hand-written in 0008 with ON DELETE
--    no action; every tenant FK from tenantId() (src/db/columns.ts) is ON
--    DELETE cascade. Rebind it to the convention.
ALTER TABLE "party_employment" DROP CONSTRAINT "party_employment_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER TABLE "party_employment" ADD CONSTRAINT "party_employment_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
