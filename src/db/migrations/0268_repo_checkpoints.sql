CREATE TABLE "repo_checkpoints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"run_id" uuid,
	"repo_url" text NOT NULL,
	"base_commit_sha" text NOT NULL,
	"commit_sha" text NOT NULL,
	"diff_blob_id" uuid,
	"test_results" jsonb,
	"decision_note" text,
	"decision_status" text DEFAULT 'inferred' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repo_checkpoints_decision_status_check" CHECK (decision_status in ('recorded', 'inferred'))
);
--> statement-breakpoint
ALTER TABLE "repo_checkpoints" ADD CONSTRAINT "repo_checkpoints_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repo_checkpoints" ADD CONSTRAINT "repo_checkpoints_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repo_checkpoints" ADD CONSTRAINT "repo_checkpoints_diff_blob_id_blob_objects_id_fk" FOREIGN KEY ("diff_blob_id") REFERENCES "public"."blob_objects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "repo_checkpoints_workspace_created_idx" ON "repo_checkpoints" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "repo_checkpoints_run_idx" ON "repo_checkpoints" USING btree ("run_id");