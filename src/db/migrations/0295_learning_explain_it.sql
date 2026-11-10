CREATE TABLE "explain_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"notebook_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"source_manifest" jsonb NOT NULL,
	"generation_key" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"question_limit" integer DEFAULT 5 NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "explain_sessions_status_check" CHECK (status in ('active', 'completed')),
	CONSTRAINT "explain_sessions_limit_check" CHECK (question_limit between 1 and 5)
);
--> statement-breakpoint
CREATE TABLE "explain_turns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"prompt" text NOT NULL,
	"answer" text,
	"grade" text,
	"feedback" text,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "explain_turns_grade_check" CHECK (grade is null or grade in ('correct', 'partial', 'incorrect', 'uncertain'))
);
--> statement-breakpoint
ALTER TABLE "explain_sessions" ADD CONSTRAINT "explain_sessions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "explain_sessions" ADD CONSTRAINT "explain_sessions_notebook_id_notebooks_id_fk" FOREIGN KEY ("notebook_id") REFERENCES "public"."notebooks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "explain_sessions" ADD CONSTRAINT "explain_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "explain_turns" ADD CONSTRAINT "explain_turns_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "explain_turns" ADD CONSTRAINT "explain_turns_session_id_explain_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."explain_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "explain_sessions_generation_key" ON "explain_sessions" USING btree ("workspace_id","user_id","generation_key");--> statement-breakpoint
CREATE INDEX "explain_sessions_notebook_user_idx" ON "explain_sessions" USING btree ("workspace_id","notebook_id","user_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "explain_turns_session_ordinal_key" ON "explain_turns" USING btree ("session_id","ordinal");--> statement-breakpoint
CREATE INDEX "explain_turns_workspace_session_idx" ON "explain_turns" USING btree ("workspace_id","session_id","ordinal");