CREATE TABLE "code_explainers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"request_key" text NOT NULL,
	"repo" text NOT NULL,
	"commit_sha" text NOT NULL,
	"range" text,
	"artifact_id" uuid,
	"document_id" uuid,
	"quiz_id" uuid,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "understanding_preferences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"auto_suggest" boolean DEFAULT false NOT NULL,
	"push_warning" boolean DEFAULT false NOT NULL,
	"question_count" integer DEFAULT 5 NOT NULL,
	"difficulty" text DEFAULT 'standard' NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "understanding_preferences_count_check" CHECK (question_count between 5 and 10),
	CONSTRAINT "understanding_preferences_difficulty_check" CHECK (difficulty in ('easier', 'standard', 'harder'))
);
--> statement-breakpoint
ALTER TABLE "code_explainers" ADD CONSTRAINT "code_explainers_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_explainers" ADD CONSTRAINT "code_explainers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_explainers" ADD CONSTRAINT "code_explainers_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_explainers" ADD CONSTRAINT "code_explainers_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_explainers" ADD CONSTRAINT "code_explainers_quiz_id_quizzes_id_fk" FOREIGN KEY ("quiz_id") REFERENCES "public"."quizzes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "understanding_preferences" ADD CONSTRAINT "understanding_preferences_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "understanding_preferences" ADD CONSTRAINT "understanding_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "code_explainers_request_key" ON "code_explainers" USING btree ("workspace_id","request_key");--> statement-breakpoint
CREATE INDEX "code_explainers_repo_commit_idx" ON "code_explainers" USING btree ("workspace_id","user_id","repo","commit_sha");--> statement-breakpoint
CREATE UNIQUE INDEX "understanding_preferences_user_key" ON "understanding_preferences" USING btree ("workspace_id","user_id");