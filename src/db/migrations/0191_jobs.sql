-- ASH-134 Q04: canonical job and attempt persistence. Generic, additive, and
-- not read by any request path yet. A job is claimed under a lease with a
-- generation fence; every attempt leaves a history row. "unknown" is a
-- terminal-until-reconciled state for work whose effect may have happened.
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"input" jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"generation" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dedupe_key" text,
	"lease_owner" text,
	"lease_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"heartbeat_at" timestamp with time zone,
	"result" jsonb,
	"last_error" text,
	"cancel_requested_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "jobs_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "jobs_workspace_id_id_key" UNIQUE ("workspace_id", "id"),
	CONSTRAINT "jobs_status_check" CHECK (status in ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'unknown')),
	CONSTRAINT "jobs_attempts_check" CHECK (attempts >= 0 AND max_attempts >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_dedupe_key" ON "jobs" USING btree ("workspace_id","kind","dedupe_key") WHERE dedupe_key is not null;
--> statement-breakpoint
CREATE INDEX "jobs_queue_idx" ON "jobs" USING btree ("priority" DESC,"available_at") WHERE status = 'queued';
--> statement-breakpoint
CREATE INDEX "jobs_lease_expiry_idx" ON "jobs" USING btree ("lease_expires_at") WHERE status = 'running';
--> statement-breakpoint
CREATE INDEX "jobs_workspace_created_idx" ON "jobs" USING btree ("workspace_id","created_at");
--> statement-breakpoint
CREATE TABLE "job_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"generation" integer NOT NULL,
	"worker" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"outcome" text,
	"error" text,
	CONSTRAINT "job_attempts_job_fk" FOREIGN KEY ("workspace_id", "job_id") REFERENCES "public"."jobs"("workspace_id", "id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "job_attempts_outcome_check" CHECK (outcome is null or outcome in ('succeeded', 'failed', 'lease_expired', 'cancelled', 'unknown'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "job_attempts_generation_key" ON "job_attempts" USING btree ("job_id","generation");
