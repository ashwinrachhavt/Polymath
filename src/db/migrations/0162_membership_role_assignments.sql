-- ASH-121 AC03: assignment of custom roles to memberships (workspace-wide;
-- per-resource authority lives in resource_grants). Unassignment is a
-- lifecycle event, not a delete. Forward-only and additive: nothing reads
-- these rows for authorization yet, so no existing behavior changes.
CREATE TABLE "membership_role_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"role_definition_id" uuid NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "membership_role_assignments_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "membership_role_assignments_membership_fk" FOREIGN KEY ("workspace_id", "membership_id") REFERENCES "public"."memberships"("workspace_id", "id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "membership_role_assignments_role_fk" FOREIGN KEY ("workspace_id", "role_definition_id") REFERENCES "public"."role_definitions"("workspace_id", "id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
-- One active assignment of a role per membership; revoked rows are history.
CREATE UNIQUE INDEX "membership_role_assignments_active_key" ON "membership_role_assignments" USING btree ("workspace_id","membership_id","role_definition_id") WHERE revoked_at is null;
--> statement-breakpoint
-- Serves "who holds this role" (the role-change preview's impact list).
CREATE INDEX "membership_role_assignments_role_idx" ON "membership_role_assignments" USING btree ("workspace_id","role_definition_id") WHERE revoked_at is null;
