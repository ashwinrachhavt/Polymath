-- ASH-304: run reviews. The agent's self-critique proposal and the operator's
-- run-level verdict, one row per run each, with the run's provenance copied in.
DO $$ BEGIN
  CREATE TYPE "public"."run_review_kind" AS ENUM('critique', 'user_feedback');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "run_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"kind" "run_review_kind" NOT NULL,
	"verdict" text,
	"reasons" text[] DEFAULT '{}'::text[] NOT NULL,
	"note" text,
	"got_wrong" text,
	"was_thin" text,
	"would_do_differently" text,
	"policy_snapshot" jsonb,
	"profile_revision_id" uuid,
	"model" text,
	"dismissed_at" timestamp with time zone,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "run_reviews_verdict_check" CHECK (verdict is null or verdict in ('up', 'down')),
	CONSTRAINT "run_reviews_reasons_check" CHECK (reasons <@ array['wrong','incomplete','wrong-target','messy','overscoped','other']::text[]),
	CONSTRAINT "run_reviews_field_caps" CHECK (char_length(coalesce(got_wrong, '')) <= 600 and char_length(coalesce(was_thin, '')) <= 600 and char_length(coalesce(would_do_differently, '')) <= 600 and char_length(coalesce(note, '')) <= 280)
);
--> statement-breakpoint
ALTER TABLE "run_reviews" ADD CONSTRAINT "run_reviews_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "run_reviews" ADD CONSTRAINT "run_reviews_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "run_reviews_one_feedback_per_run" ON "run_reviews" USING btree ("workspace_id","run_id") WHERE kind = 'user_feedback';
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "run_reviews_one_critique_per_run" ON "run_reviews" USING btree ("workspace_id","run_id") WHERE kind = 'critique';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "run_reviews_run_idx" ON "run_reviews" USING btree ("run_id");
