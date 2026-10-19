-- ASH-117 (RT03): immutable profile revisions, runtime execution bindings,
-- durable signal identity, and tool invocation identity. Additive only: no
-- applied migration is edited, and existing run/tool rows stay valid (new
-- columns are nullable).
CREATE TYPE "public"."dispatch_state" AS ENUM('pending','dispatched','bound','uncertain','completed','failed');--> statement-breakpoint
CREATE TYPE "public"."signal_status" AS ENUM('pending','delivered','failed','unknown');--> statement-breakpoint
CREATE TYPE "public"."signal_reconciliation" AS ENUM('not_needed','pending','resolved');--> statement-breakpoint
-- Tenant-composite keys so runtime tables can FK (workspace_id, run/profile id):
-- a cross-workspace reference is rejected by the constraint itself.
CREATE UNIQUE INDEX "agent_profiles_workspace_id_key" ON "agent_profiles" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_runs_workspace_id_key" ON "agent_runs" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE TABLE "agent_profile_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"revision_number" integer NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"instructions" text,
	"model_policy" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"allowed_tools" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"allowed_accounts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"context_policy" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"budget_policy" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"memory_policy" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_profile_revisions_profile_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."agent_profiles"("id") ON DELETE restrict ON UPDATE no action,
	CONSTRAINT "agent_profile_revisions_tenant_profile_fk" FOREIGN KEY ("workspace_id","profile_id") REFERENCES "public"."agent_profiles"("workspace_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "agent_profile_revisions_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE "run_executions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"generation" integer NOT NULL,
	"provider" text NOT NULL,
	"environment" text DEFAULT 'production' NOT NULL,
	"provider_execution_id" text,
	"workflow_version" text,
	"dispatch_key" text,
	"state" "dispatch_state" DEFAULT 'pending' NOT NULL,
	"dispatched_at" timestamp with time zone,
	"bound_at" timestamp with time zone,
	"uncertain_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_executions_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "run_executions_tenant_run_fk" FOREIGN KEY ("workspace_id","run_id") REFERENCES "public"."agent_runs"("workspace_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "run_executions_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE "run_signals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"execution_id" uuid,
	"generation" integer NOT NULL,
	"signal_key" text NOT NULL,
	"payload_hash" text NOT NULL,
	"payload_summary" jsonb,
	"status" "signal_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"reconciliation" "signal_reconciliation" DEFAULT 'not_needed' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_signals_execution_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."run_executions"("id") ON DELETE set null ON UPDATE no action,
	CONSTRAINT "run_signals_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "run_signals_tenant_run_fk" FOREIGN KEY ("workspace_id","run_id") REFERENCES "public"."agent_runs"("workspace_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "run_signals_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "profile_revision_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_profile_revision_id_fk" FOREIGN KEY ("profile_revision_id") REFERENCES "public"."agent_profile_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_calls" ADD COLUMN "invocation_id" text;--> statement-breakpoint
ALTER TABLE "tool_calls" ADD COLUMN "argument_hash" text;--> statement-breakpoint
ALTER TABLE "tool_calls" ADD COLUMN "execution_state" text;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_profile_revisions_number_key" ON "agent_profile_revisions" USING btree ("profile_id","revision_number");--> statement-breakpoint
CREATE INDEX "agent_profile_revisions_workspace_idx" ON "agent_profile_revisions" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "run_executions_generation_key" ON "run_executions" USING btree ("run_id","generation");--> statement-breakpoint
CREATE UNIQUE INDEX "run_executions_provider_execution_key" ON "run_executions" USING btree ("provider","environment","provider_execution_id") WHERE provider_execution_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "run_executions_dispatch_key_key" ON "run_executions" USING btree ("workspace_id","dispatch_key") WHERE dispatch_key is not null;--> statement-breakpoint
CREATE INDEX "run_executions_uncertain_idx" ON "run_executions" USING btree ("workspace_id","uncertain_at") WHERE state = 'uncertain';--> statement-breakpoint
CREATE UNIQUE INDEX "run_signals_delivery_key" ON "run_signals" USING btree ("run_id","generation","signal_key");--> statement-breakpoint
CREATE INDEX "run_signals_pending_idx" ON "run_signals" USING btree ("workspace_id","created_at") WHERE status in ('pending', 'unknown');--> statement-breakpoint
CREATE UNIQUE INDEX "tool_calls_invocation_key" ON "tool_calls" USING btree ("workspace_id","invocation_id") WHERE invocation_id is not null;
