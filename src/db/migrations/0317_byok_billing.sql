CREATE TABLE "model_usage_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"key_source" text NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(14, 8),
	"run_id" uuid,
	"source_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_usage_ledger_key_source_check" CHECK (key_source in ('own', 'house')),
	CONSTRAINT "model_usage_ledger_purpose_check" CHECK (purpose in ('chat', 'generation', 'grading', 'embedding'))
);
--> statement-breakpoint
CREATE TABLE "workspace_model_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"sealed_key" text NOT NULL,
	"last4" text NOT NULL,
	"validated_at" timestamp with time zone NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_plans" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"plan" text DEFAULT 'free' NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_plans_plan_check" CHECK (plan in ('free', 'pro', 'own-key'))
);
--> statement-breakpoint
ALTER TABLE "model_usage_ledger" ADD CONSTRAINT "model_usage_ledger_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_model_keys" ADD CONSTRAINT "workspace_model_keys_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_plans" ADD CONSTRAINT "workspace_plans_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "model_usage_ledger_workspace_week_idx" ON "model_usage_ledger" USING btree ("workspace_id","key_source","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "model_usage_ledger_source_ref_key" ON "model_usage_ledger" USING btree ("workspace_id","source_ref") WHERE source_ref is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_model_keys_provider_key" ON "workspace_model_keys" USING btree ("workspace_id","provider");