CREATE TABLE "superagent_policies" (
	"workspace_id" uuid NOT NULL,
	"version" text NOT NULL,
	"paused" boolean DEFAULT false NOT NULL,
	"accept_mode" text DEFAULT 'off' NOT NULL,
	"eval_timeout_ms" integer NOT NULL,
	"sources" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "superagent_policies_workspace_id_pk" PRIMARY KEY("workspace_id"),
	CONSTRAINT "superagent_policies_accept_mode_check" CHECK ("superagent_policies"."accept_mode" in ('off', 'observe', 'auto')),
	CONSTRAINT "superagent_policies_eval_timeout_check" CHECK ("superagent_policies"."eval_timeout_ms" > 0)
);
--> statement-breakpoint
CREATE TABLE "superagent_policy_rules" (
	"workspace_id" uuid NOT NULL,
	"rule_id" text NOT NULL,
	"name" text NOT NULL,
	"instruction" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "superagent_policy_rules_workspace_id_rule_id_pk" PRIMARY KEY("workspace_id","rule_id")
);
--> statement-breakpoint
CREATE TABLE "ticket_runs" (
	"workspace_id" uuid NOT NULL,
	"id" text NOT NULL,
	"ticket_id" text NOT NULL,
	"state" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"ended_reason" text,
	"report" jsonb,
	"delivered_at" timestamp with time zone,
	"idle_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"seq" bigserial NOT NULL,
	CONSTRAINT "ticket_runs_workspace_id_id_pk" PRIMARY KEY("workspace_id","id"),
	CONSTRAINT "ticket_runs_state_check" CHECK ("ticket_runs"."state" in ('pending', 'running', 'ended'))
);
--> statement-breakpoint
CREATE TABLE "work_assessments" (
	"workspace_id" uuid NOT NULL,
	"id" text NOT NULL,
	"thread_key" text NOT NULL,
	"trigger_ids" jsonb NOT NULL,
	"primary_trigger_id" text,
	"strength" text NOT NULL,
	"actor" jsonb NOT NULL,
	"basis" jsonb NOT NULL,
	"policy_version" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"deadline" timestamp with time zone NOT NULL,
	"delivered_at" timestamp with time zone,
	"paused_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "work_assessments_workspace_id_id_pk" PRIMARY KEY("workspace_id","id"),
	CONSTRAINT "work_assessments_strength_check" CHECK ("work_assessments"."strength" in ('explicit', 'inferred'))
);
--> statement-breakpoint
CREATE TABLE "work_decisions" (
	"workspace_id" uuid NOT NULL,
	"id" text NOT NULL,
	"assessment_id" text NOT NULL,
	"thread_key" text NOT NULL,
	"trigger_ids" jsonb NOT NULL,
	"policy_version" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"kind" text NOT NULL,
	"reason" jsonb NOT NULL,
	"strength" text NOT NULL,
	"ticket_id" text,
	"mandate" jsonb,
	"audit" jsonb,
	"dismissed" boolean DEFAULT false NOT NULL,
	"seq" bigserial NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "work_decisions_workspace_id_id_pk" PRIMARY KEY("workspace_id","id"),
	CONSTRAINT "work_decisions_kind_check" CHECK ("work_decisions"."kind" in ('ignore', 'accept', 'reopen', 'stop', 'unavailable')),
	CONSTRAINT "work_decisions_strength_check" CHECK ("work_decisions"."strength" in ('explicit', 'inferred'))
);
--> statement-breakpoint
CREATE TABLE "work_effects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"key" text NOT NULL,
	"payload" jsonb,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_owner" text,
	"lease_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"last_error" text,
	"needs_attention" boolean GENERATED ALWAYS AS (consecutive_failures >= 3) STORED NOT NULL,
	"done_at" timestamp with time zone,
	CONSTRAINT "work_effects_kind_check" CHECK ("work_effects"."kind" in ('assessment', 'launch', 'delivery', 'relay', 'notice', 'reply')),
	CONSTRAINT "work_effects_status_check" CHECK ("work_effects"."status" in ('pending', 'done'))
);
--> statement-breakpoint
CREATE TABLE "work_outbox_receipts" (
	"workspace_id" uuid NOT NULL,
	"id" text NOT NULL,
	"channel" jsonb NOT NULL,
	"text" text NOT NULL,
	"kind" text NOT NULL,
	"ticket_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"sent_at" timestamp with time zone,
	"dropped_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"seq" bigserial NOT NULL,
	CONSTRAINT "work_outbox_receipts_workspace_id_id_pk" PRIMARY KEY("workspace_id","id"),
	CONSTRAINT "work_outbox_receipts_kind_check" CHECK ("work_outbox_receipts"."kind" in ('acknowledgement', 'reply', 'notice')),
	CONSTRAINT "work_outbox_receipts_status_check" CHECK ("work_outbox_receipts"."status" in ('pending', 'sent', 'dropped'))
);
--> statement-breakpoint
CREATE TABLE "work_subscriptions" (
	"workspace_id" uuid NOT NULL,
	"thread_key" text NOT NULL,
	"ticket_id" text NOT NULL,
	"kind" text NOT NULL,
	CONSTRAINT "work_subscriptions_workspace_id_thread_key_ticket_id_kind_pk" PRIMARY KEY("workspace_id","thread_key","ticket_id","kind"),
	CONSTRAINT "work_subscriptions_kind_check" CHECK ("work_subscriptions"."kind" in ('subscription', 'context'))
);
--> statement-breakpoint
CREATE TABLE "work_threads" (
	"workspace_id" uuid NOT NULL,
	"key" text NOT NULL,
	"ref" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"last_at" timestamp with time zone,
	"correlated" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"pending" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"evaluating" jsonb,
	"expired" integer,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_active" boolean GENERATED ALWAYS AS (jsonb_array_length(pending) > 0 or evaluating is not null) STORED NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "work_threads_workspace_id_key_pk" PRIMARY KEY("workspace_id","key")
);
--> statement-breakpoint
CREATE TABLE "work_tickets" (
	"workspace_id" uuid NOT NULL,
	"id" text NOT NULL,
	"title" text NOT NULL,
	"decision_id" text NOT NULL,
	"mandate" jsonb NOT NULL,
	"channels" jsonb NOT NULL,
	"ended_at" timestamp with time zone,
	"ended_by" text,
	"ended_outcome" text,
	"ended_reason" text,
	"attention" jsonb,
	"inputs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"undelivered" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"follows" jsonb,
	"answers" jsonb,
	"origin" jsonb NOT NULL,
	"execution" jsonb,
	"delivery" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"latest_run_state" text,
	"is_active" boolean GENERATED ALWAYS AS (ended_at is null and (jsonb_array_length(undelivered) > 0 or (latest_run_state is not null and latest_run_state in ('pending', 'running')))) STORED NOT NULL,
	"seq" bigserial NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "work_tickets_workspace_id_id_pk" PRIMARY KEY("workspace_id","id"),
	CONSTRAINT "work_tickets_ended_by_check" CHECK ("work_tickets"."ended_by" is null or "work_tickets"."ended_by" in ('executor', 'human')),
	CONSTRAINT "work_tickets_ended_outcome_check" CHECK ("work_tickets"."ended_outcome" is null or "work_tickets"."ended_outcome" in ('completed', 'merged', 'closed', 'dropped', 'stopped')),
	CONSTRAINT "work_tickets_latest_run_state_check" CHECK ("work_tickets"."latest_run_state" is null or "work_tickets"."latest_run_state" in ('pending', 'running', 'ended'))
);
--> statement-breakpoint
CREATE TABLE "work_triggers" (
	"workspace_id" uuid NOT NULL,
	"id" text NOT NULL,
	"source" text NOT NULL,
	"threads" jsonb NOT NULL,
	"actor" jsonb NOT NULL,
	"human" boolean NOT NULL,
	"addressed" text,
	"at" timestamp with time zone NOT NULL,
	"text" text NOT NULL,
	"channel" jsonb,
	"url" text,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"disposition" jsonb,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "work_triggers_workspace_id_id_pk" PRIMARY KEY("workspace_id","id"),
	CONSTRAINT "work_triggers_addressed_check" CHECK ("work_triggers"."addressed" is null or "work_triggers"."addressed" in ('mention', 'direct'))
);
--> statement-breakpoint
ALTER TABLE "superagent_policies" ADD CONSTRAINT "superagent_policies_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "superagent_policy_rules" ADD CONSTRAINT "superagent_policy_rules_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "superagent_policy_rules" ADD CONSTRAINT "superagent_policy_rules_policy_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."superagent_policies"("workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_runs" ADD CONSTRAINT "ticket_runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_runs" ADD CONSTRAINT "ticket_runs_ticket_fk" FOREIGN KEY ("workspace_id","ticket_id") REFERENCES "public"."work_tickets"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_assessments" ADD CONSTRAINT "work_assessments_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_assessments" ADD CONSTRAINT "work_assessments_thread_fk" FOREIGN KEY ("workspace_id","thread_key") REFERENCES "public"."work_threads"("workspace_id","key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_decisions" ADD CONSTRAINT "work_decisions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_decisions" ADD CONSTRAINT "work_decisions_thread_fk" FOREIGN KEY ("workspace_id","thread_key") REFERENCES "public"."work_threads"("workspace_id","key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_effects" ADD CONSTRAINT "work_effects_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_outbox_receipts" ADD CONSTRAINT "work_outbox_receipts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_outbox_receipts" ADD CONSTRAINT "work_outbox_receipts_ticket_fk" FOREIGN KEY ("workspace_id","ticket_id") REFERENCES "public"."work_tickets"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_subscriptions" ADD CONSTRAINT "work_subscriptions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_subscriptions" ADD CONSTRAINT "work_subscriptions_thread_fk" FOREIGN KEY ("workspace_id","thread_key") REFERENCES "public"."work_threads"("workspace_id","key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_subscriptions" ADD CONSTRAINT "work_subscriptions_ticket_fk" FOREIGN KEY ("workspace_id","ticket_id") REFERENCES "public"."work_tickets"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_threads" ADD CONSTRAINT "work_threads_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_tickets" ADD CONSTRAINT "work_tickets_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_triggers" ADD CONSTRAINT "work_triggers_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "superagent_policy_rules_position_idx" ON "superagent_policy_rules" USING btree ("workspace_id","position");--> statement-breakpoint
CREATE INDEX "ticket_runs_ticket_idx" ON "ticket_runs" USING btree ("workspace_id","ticket_id","seq");--> statement-breakpoint
CREATE INDEX "ticket_runs_open_idx" ON "ticket_runs" USING btree ("workspace_id","state") WHERE "ticket_runs"."state" <> 'ended';--> statement-breakpoint
CREATE INDEX "work_assessments_open_idx" ON "work_assessments" USING btree ("workspace_id","deadline") WHERE "work_assessments"."ended_at" is null;--> statement-breakpoint
CREATE INDEX "work_decisions_thread_idx" ON "work_decisions" USING btree ("workspace_id","thread_key","seq");--> statement-breakpoint
CREATE INDEX "work_effects_dispatch_idx" ON "work_effects" USING btree ("workspace_id","status","available_at");--> statement-breakpoint
CREATE UNIQUE INDEX "work_effects_pending_key_idx" ON "work_effects" USING btree ("workspace_id","kind","key") WHERE "work_effects"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "work_effects_attention_idx" ON "work_effects" USING btree ("workspace_id") WHERE "work_effects"."needs_attention";--> statement-breakpoint
CREATE INDEX "work_outbox_receipts_pending_idx" ON "work_outbox_receipts" USING btree ("workspace_id","seq") WHERE "work_outbox_receipts"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "work_threads_active_idx" ON "work_threads" USING btree ("workspace_id") WHERE "work_threads"."is_active";--> statement-breakpoint
CREATE INDEX "work_tickets_active_idx" ON "work_tickets" USING btree ("workspace_id") WHERE "work_tickets"."is_active";--> statement-breakpoint
CREATE INDEX "work_tickets_open_idx" ON "work_tickets" USING btree ("workspace_id","seq") WHERE "work_tickets"."ended_at" is null;--> statement-breakpoint
CREATE INDEX "work_triggers_workspace_at_idx" ON "work_triggers" USING btree ("workspace_id","at");