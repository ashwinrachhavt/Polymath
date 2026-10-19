-- ASH-122 GA03 + GA10: the append-only authorization decision log. Forward-
-- only and additive. Every gateway verdict, allow or deny, is recorded with
-- the grant it cited and its reasons; rows never change.
CREATE TABLE "agent_authorization_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"grant_id" uuid NOT NULL,
	"agent_principal_id" uuid NOT NULL,
	"run_id" uuid,
	"invocation_id" text,
	"operation" text NOT NULL,
	"account_alias" text,
	"resource_ref" text,
	"destination" text,
	"decision" text NOT NULL,
	"reasons" jsonb DEFAULT '[]' NOT NULL,
	"requires_approval" boolean DEFAULT false NOT NULL,
	"grant_content_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_authorization_decisions_decision_check" CHECK ("decision" in ('allowed', 'denied')),
	CONSTRAINT "agent_authorization_decisions_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "agent_authorization_decisions_grant_fk" FOREIGN KEY ("workspace_id", "grant_id") REFERENCES "public"."agent_delegation_grants"("workspace_id", "id") ON DELETE restrict ON UPDATE no action,
	CONSTRAINT "agent_authorization_decisions_principal_fk" FOREIGN KEY ("workspace_id", "agent_principal_id") REFERENCES "public"."agent_principals"("workspace_id", "id") ON DELETE restrict ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX "agent_authorization_decisions_principal_idx" ON "agent_authorization_decisions" USING btree ("workspace_id","agent_principal_id","created_at");
--> statement-breakpoint
CREATE INDEX "agent_authorization_decisions_grant_idx" ON "agent_authorization_decisions" USING btree ("grant_id");
--> statement-breakpoint
CREATE INDEX "agent_authorization_decisions_denied_idx" ON "agent_authorization_decisions" USING btree ("workspace_id","created_at") WHERE decision = 'denied';
--> statement-breakpoint
-- A recorded verdict is history; it never changes.
CREATE TRIGGER "agent_authorization_decisions_immutable" BEFORE UPDATE ON "agent_authorization_decisions" FOR EACH ROW EXECUTE FUNCTION "axiom_reject_update"();
