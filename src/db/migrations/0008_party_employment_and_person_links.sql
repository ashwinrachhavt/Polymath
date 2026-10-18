-- Hand-written: `drizzle-kit generate` rejects the existing 0005/0006 snapshots
-- on main ("data is malformed") and exits without diffing, so there is no
-- generated artifact to review. This is the two statements that diff was
-- supposed to produce, read against src/domains/identity/schema.ts and
-- src/db/columns.ts. Forward-only and additive.

CREATE TABLE "party_employment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"title" text,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "party_employment" ADD CONSTRAINT "party_employment_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "party_employment" ADD CONSTRAINT "party_employment_person_fk" FOREIGN KEY ("workspace_id","person_id") REFERENCES "public"."people"("workspace_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "party_employment" ADD CONSTRAINT "party_employment_organization_fk" FOREIGN KEY ("workspace_id","organization_id") REFERENCES "public"."organizations"("workspace_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "party_employment_person_idx" ON "party_employment" USING btree ("person_id","ended_at");
--> statement-breakpoint
CREATE INDEX "party_employment_organization_idx" ON "party_employment" USING btree ("organization_id","ended_at");
--> statement-breakpoint
-- The import probes "is this person already at this org" per row; the two
-- indexes above lead with one column each and cannot serve both.
CREATE UNIQUE INDEX "party_employment_current_key" ON "party_employment" USING btree ("workspace_id","person_id","organization_id") WHERE ended_at IS NULL;
--> statement-breakpoint
-- The connections import keys organizations on lower(name) (the Company column
-- is the curated fact; the address domain usually is not the employer). The
-- schema's name index is case-sensitive and cannot serve that lookup.
CREATE INDEX "organizations_workspace_lower_name_idx" ON "organizations" USING btree ("workspace_id", lower(name)) WHERE archived_at IS NULL;
--> statement-breakpoint
-- Same target-type set as linkTargetKindCheck("task_links_target_type_check")
-- in src/db/columns.ts, which gained "person" and "organization" for tasks
-- that are about someone.
ALTER TABLE "task_links" DROP CONSTRAINT "task_links_target_type_check";
--> statement-breakpoint
ALTER TABLE "task_links" ADD CONSTRAINT "task_links_target_type_check" CHECK (target_type in ('task', 'project', 'space', 'note', 'artifact', 'document', 'source', 'event', 'contact', 'company', 'person', 'organization', 'opportunity', 'run', 'thread'));
