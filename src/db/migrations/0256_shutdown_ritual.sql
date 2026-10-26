-- ASH-305: the end-of-day shutdown. Branch-only until the owner applies it.
-- Additive and nullable/new, so mixed-version deploys are safe: old code
-- ignores captures.parked_at (a parked row simply stays in its old queue until
-- new code is live) and never touches briefing_seeds.
ALTER TABLE "captures" ADD COLUMN IF NOT EXISTS "parked_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "captures" ADD COLUMN IF NOT EXISTS "parked_by" uuid;
--> statement-breakpoint
ALTER TABLE "captures" ADD COLUMN IF NOT EXISTS "enrichment_lease_token" uuid;
--> statement-breakpoint
ALTER TABLE "captures" ADD COLUMN IF NOT EXISTS "enrichment_lease_until" timestamp with time zone;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "captures_parked_idx" ON "captures" USING btree ("workspace_id","parked_at") WHERE parked_at IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "briefing_seeds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"on_date" date NOT NULL,
	"task_id" uuid NOT NULL,
	"reason" text,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "briefing_seeds" ADD CONSTRAINT "briefing_seeds_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "briefing_seeds" ADD CONSTRAINT "briefing_seeds_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "briefing_seeds_day_task_key" ON "briefing_seeds" USING btree ("workspace_id","on_date","task_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "briefing_seeds_day_idx" ON "briefing_seeds" USING btree ("workspace_id","on_date");
