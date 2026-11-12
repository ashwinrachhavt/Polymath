CREATE TYPE "public"."generation_job_status" AS ENUM('queued', 'running', 'ready', 'failed');--> statement-breakpoint
CREATE TABLE "generation_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" "generation_job_status" DEFAULT 'queued' NOT NULL,
	"idempotency_key" text NOT NULL,
	"subject" text,
	"title" text NOT NULL,
	"input" jsonb NOT NULL,
	"result" jsonb,
	"error" text,
	"attempt" integer DEFAULT 1 NOT NULL,
	"heartbeat_at" timestamp with time zone,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "generation_jobs_result_check" CHECK ((status = 'ready') = (result is not null)),
	CONSTRAINT "generation_jobs_error_check" CHECK ((status = 'failed') = (error is not null)),
	CONSTRAINT "generation_jobs_attempt_check" CHECK (attempt >= 1)
);
--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD CONSTRAINT "generation_jobs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD CONSTRAINT "generation_jobs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "generation_jobs_idempotency_key" ON "generation_jobs" USING btree ("workspace_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "generation_jobs_owner_status_idx" ON "generation_jobs" USING btree ("workspace_id","created_by","status");--> statement-breakpoint
CREATE INDEX "generation_jobs_owner_updated_idx" ON "generation_jobs" USING btree ("workspace_id","created_by","updated_at");