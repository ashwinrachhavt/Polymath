-- ASH-122 GA02 + GA07: immutable bounded delegation grants. Forward-only and
-- additive. A grant is the only path by which authority reaches a principal;
-- the freeze trigger below makes the granted ceiling tamper-proof at the
-- database, and revocation stays as history. Nothing verifies grants in the
-- request path yet, so no existing behavior changes.
CREATE TABLE "agent_delegation_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"delegator_membership_id" uuid NOT NULL,
	"agent_principal_id" uuid NOT NULL,
	"parent_grant_id" uuid,
	"delegation_depth" integer DEFAULT 0 NOT NULL,
	"profile_revision_id" uuid,
	"context_manifest_id" uuid,
	"allowed_operations" jsonb NOT NULL,
	"allowed_resources" jsonb,
	"allowed_accounts" jsonb,
	"allowed_destinations" jsonb,
	"catalog_version" integer NOT NULL,
	"content_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "agent_delegation_grants_depth_check" CHECK ("delegation_depth" between 0 and 3),
	CONSTRAINT "agent_delegation_grants_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "agent_delegation_grants_delegator_fk" FOREIGN KEY ("workspace_id", "delegator_membership_id") REFERENCES "public"."memberships"("workspace_id", "id") ON DELETE restrict ON UPDATE no action,
	CONSTRAINT "agent_delegation_grants_principal_fk" FOREIGN KEY ("workspace_id", "agent_principal_id") REFERENCES "public"."agent_principals"("workspace_id", "id") ON DELETE restrict ON UPDATE no action,
	CONSTRAINT "agent_delegation_grants_parent_fk" FOREIGN KEY ("workspace_id", "parent_grant_id") REFERENCES "public"."agent_delegation_grants"("workspace_id", "id") ON DELETE restrict ON UPDATE no action,
	CONSTRAINT "agent_delegation_grants_workspace_id_id_key" UNIQUE ("workspace_id", "id")
);
--> statement-breakpoint
CREATE INDEX "agent_delegation_grants_principal_idx" ON "agent_delegation_grants" USING btree ("workspace_id","agent_principal_id") WHERE revoked_at is null;
--> statement-breakpoint
CREATE INDEX "agent_delegation_grants_parent_idx" ON "agent_delegation_grants" USING btree ("parent_grant_id") WHERE parent_grant_id is not null;
--> statement-breakpoint
-- A granted ceiling never changes after issuance: only the revocation
-- bookkeeping may move. Anything else is a new grant.
CREATE FUNCTION "agent_delegation_grants_freeze"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF NEW."delegator_membership_id" IS DISTINCT FROM OLD."delegator_membership_id"
		OR NEW."agent_principal_id" IS DISTINCT FROM OLD."agent_principal_id"
		OR NEW."parent_grant_id" IS DISTINCT FROM OLD."parent_grant_id"
		OR NEW."delegation_depth" IS DISTINCT FROM OLD."delegation_depth"
		OR NEW."profile_revision_id" IS DISTINCT FROM OLD."profile_revision_id"
		OR NEW."context_manifest_id" IS DISTINCT FROM OLD."context_manifest_id"
		OR NEW."allowed_operations" IS DISTINCT FROM OLD."allowed_operations"
		OR NEW."allowed_resources" IS DISTINCT FROM OLD."allowed_resources"
		OR NEW."allowed_accounts" IS DISTINCT FROM OLD."allowed_accounts"
		OR NEW."allowed_destinations" IS DISTINCT FROM OLD."allowed_destinations"
		OR NEW."catalog_version" IS DISTINCT FROM OLD."catalog_version"
		OR NEW."content_hash" IS DISTINCT FROM OLD."content_hash"
		OR NEW."expires_at" IS DISTINCT FROM OLD."expires_at"
		OR NEW."created_by" IS DISTINCT FROM OLD."created_by"
		OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
		RAISE EXCEPTION 'agent_delegation_grants content is immutable; revoke and re-issue' USING ERRCODE = 'check_violation';
	END IF;
	-- Revocation is one-way as well.
	IF OLD."revoked_at" IS NOT NULL THEN
		RAISE EXCEPTION 'a revoked grant stays revoked' USING ERRCODE = 'check_violation';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "agent_delegation_grants_freeze" BEFORE UPDATE ON "agent_delegation_grants" FOR EACH ROW EXECUTE FUNCTION "agent_delegation_grants_freeze"();
