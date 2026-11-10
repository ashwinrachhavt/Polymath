CREATE TABLE "graph_recall_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"notebook_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"source_artifact_id" uuid NOT NULL,
	"target_artifact_id" uuid NOT NULL,
	"expected_relation" text NOT NULL,
	"submitted_relation" text NOT NULL,
	"is_correct" boolean NOT NULL,
	"request_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "graph_recall_attempts_distinct_cards" CHECK (source_artifact_id <> target_artifact_id)
);
--> statement-breakpoint
ALTER TABLE "graph_recall_attempts" ADD CONSTRAINT "graph_recall_attempts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "graph_recall_attempts" ADD CONSTRAINT "graph_recall_attempts_notebook_id_notebooks_id_fk" FOREIGN KEY ("notebook_id") REFERENCES "public"."notebooks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "graph_recall_attempts" ADD CONSTRAINT "graph_recall_attempts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "graph_recall_attempts" ADD CONSTRAINT "graph_recall_attempts_source_artifact_id_artifacts_id_fk" FOREIGN KEY ("source_artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "graph_recall_attempts" ADD CONSTRAINT "graph_recall_attempts_target_artifact_id_artifacts_id_fk" FOREIGN KEY ("target_artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "graph_recall_attempts_request_key" ON "graph_recall_attempts" USING btree ("workspace_id","user_id","request_key");--> statement-breakpoint
CREATE INDEX "graph_recall_attempts_notebook_user_idx" ON "graph_recall_attempts" USING btree ("workspace_id","notebook_id","user_id","created_at");