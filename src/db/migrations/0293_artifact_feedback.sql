CREATE TABLE "artifact_feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"artifact_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"rating" text NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "artifact_feedback_rating_check" CHECK ("artifact_feedback"."rating" in ('helpful', 'not_helpful'))
);
--> statement-breakpoint
ALTER TABLE "artifact_feedback" ADD CONSTRAINT "artifact_feedback_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_feedback" ADD CONSTRAINT "artifact_feedback_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_feedback" ADD CONSTRAINT "artifact_feedback_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "artifact_feedback_user_key" ON "artifact_feedback" USING btree ("workspace_id","artifact_id","user_id");--> statement-breakpoint
CREATE INDEX "artifact_feedback_workspace_user_idx" ON "artifact_feedback" USING btree ("workspace_id","user_id","created_at");