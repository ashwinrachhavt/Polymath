-- ASH-121 AC04: resource grants. A grant binds one membership to one custom
-- role definition on one resource row, with optional expiry. Revocation is a
-- lifecycle event, not a delete. Forward-only and additive: nothing reads
-- these rows for authorization yet (guards.ts remains the surface), so no
-- existing behavior changes.
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_workspace_id_id_key" UNIQUE ("workspace_id", "id");
--> statement-breakpoint
CREATE TABLE "resource_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"role_definition_id" uuid NOT NULL,
	"target_kind" text NOT NULL,
	"target_id" uuid NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "resource_grants_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "resource_grants_membership_fk" FOREIGN KEY ("workspace_id", "membership_id") REFERENCES "public"."memberships"("workspace_id", "id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "resource_grants_role_fk" FOREIGN KEY ("workspace_id", "role_definition_id") REFERENCES "public"."role_definitions"("workspace_id", "id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "resource_grants_target_kind_check" CHECK (target_kind in ('person', 'organization'))
);
--> statement-breakpoint
-- One active grant per subject/role/target; revoked rows accumulate as history.
CREATE UNIQUE INDEX "resource_grants_active_key" ON "resource_grants" USING btree ("workspace_id","membership_id","target_kind","target_id","role_definition_id") WHERE revoked_at is null;
--> statement-breakpoint
CREATE INDEX "resource_grants_target_idx" ON "resource_grants" USING btree ("workspace_id","target_kind","target_id");
