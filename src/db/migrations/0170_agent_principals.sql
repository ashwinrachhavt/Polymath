-- ASH-122 GA01: agent and service principals. Forward-only and additive.
-- Principals are not memberships and hold no role; authority reaches them
-- only through delegation grants (0171). Nothing resolves these rows in the
-- request path yet, so no existing behavior changes.
CREATE TYPE "public"."agent_principal_kind" AS ENUM('agent', 'service_principal');
--> statement-breakpoint
CREATE TYPE "public"."agent_principal_status" AS ENUM('active', 'suspended', 'revoked');
--> statement-breakpoint
CREATE TABLE "agent_principals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"key" text NOT NULL,
	"kind" "agent_principal_kind" NOT NULL,
	"label" text NOT NULL,
	"description" text,
	"agent_profile_id" uuid,
	"owner_membership_id" uuid NOT NULL,
	"status" "agent_principal_status" DEFAULT 'active' NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "agent_principals_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "agent_principals_profile_fk" FOREIGN KEY ("workspace_id", "agent_profile_id") REFERENCES "public"."agent_profiles"("workspace_id", "id") ON DELETE restrict ON UPDATE no action,
	CONSTRAINT "agent_principals_owner_membership_fk" FOREIGN KEY ("workspace_id", "owner_membership_id") REFERENCES "public"."memberships"("workspace_id", "id") ON DELETE restrict ON UPDATE no action,
	CONSTRAINT "agent_principals_workspace_id_id_key" UNIQUE ("workspace_id", "id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "agent_principals_workspace_key_key" ON "agent_principals" USING btree ("workspace_id","key");
--> statement-breakpoint
CREATE INDEX "agent_principals_workspace_status_idx" ON "agent_principals" USING btree ("workspace_id","status");
