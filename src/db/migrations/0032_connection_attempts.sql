-- D09 OAuth scaffolding (ASH-160): one row per hosted-auth attempt. The state
-- token is the only value the browser round-trips; the provider redirect URL
-- and (on success) the Composio connected-account id land here before the
-- account row flips to active. Additive - no changes to external_accounts,
-- sync_cursors or integration_catalog (the Notion importer builds on them).
CREATE TABLE "connection_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"external_account_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"state_token" text NOT NULL,
	"status" text NOT NULL DEFAULT 'pending',
	"provider_redirect_url" text,
	"provider_connected_account_id" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);--> statement-breakpoint
ALTER TABLE "connection_attempts" ADD CONSTRAINT "connection_attempts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_attempts" ADD CONSTRAINT "connection_attempts_external_account_id_external_accounts_id_fk" FOREIGN KEY ("external_account_id") REFERENCES "public"."external_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_attempts" ADD CONSTRAINT "connection_attempts_status_check" CHECK (status in ('pending', 'completed', 'failed', 'expired'));--> statement-breakpoint
CREATE UNIQUE INDEX "connection_attempts_state_key" ON "connection_attempts" USING btree ("state_token");--> statement-breakpoint
CREATE INDEX "connection_attempts_account_idx" ON "connection_attempts" USING btree ("workspace_id","external_account_id");
