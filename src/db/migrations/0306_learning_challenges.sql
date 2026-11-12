CREATE TABLE "learning_challenge_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"challenge_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"submit_key" text NOT NULL,
	"answer" text NOT NULL,
	"dont_know" boolean DEFAULT false NOT NULL,
	"hints_used" integer DEFAULT 0 NOT NULL,
	"grade" text,
	"failed_step" text,
	"feedback" text NOT NULL,
	"graded_by" text NOT NULL,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "learning_challenge_attempts_grade_check" CHECK (grade is null or grade in ('correct', 'partial', 'incorrect', 'uncertain')),
	CONSTRAINT "learning_challenge_attempts_dont_know_check" CHECK ((grade is null) = dont_know),
	CONSTRAINT "learning_challenge_attempts_graded_by_check" CHECK (graded_by in ('rules', 'model')),
	CONSTRAINT "learning_challenge_attempts_hints_check" CHECK (hints_used between 0 and 3)
);
--> statement-breakpoint
CREATE TABLE "learning_challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"notebook_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"format" text NOT NULL,
	"status" text DEFAULT 'preparing' NOT NULL,
	"source_manifest" jsonb NOT NULL,
	"generation_key" text NOT NULL,
	"objective" text,
	"content" jsonb,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"prompt_version" text,
	"error" text,
	"hints_shown" integer DEFAULT 0 NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "learning_challenges_format_check" CHECK (format in ('predict', 'bug_hunt')),
	CONSTRAINT "learning_challenges_status_check" CHECK (status in ('preparing', 'ready', 'failed')),
	CONSTRAINT "learning_challenges_ready_check" CHECK (status <> 'ready' or content is not null),
	CONSTRAINT "learning_challenges_hints_check" CHECK (hints_shown between 0 and 3)
);
--> statement-breakpoint
ALTER TABLE "learning_challenge_attempts" ADD CONSTRAINT "learning_challenge_attempts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_challenge_attempts" ADD CONSTRAINT "learning_challenge_attempts_challenge_id_learning_challenges_id_fk" FOREIGN KEY ("challenge_id") REFERENCES "public"."learning_challenges"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_challenge_attempts" ADD CONSTRAINT "learning_challenge_attempts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_challenges" ADD CONSTRAINT "learning_challenges_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_challenges" ADD CONSTRAINT "learning_challenges_notebook_id_notebooks_id_fk" FOREIGN KEY ("notebook_id") REFERENCES "public"."notebooks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_challenges" ADD CONSTRAINT "learning_challenges_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "learning_challenge_attempts_ordinal_key" ON "learning_challenge_attempts" USING btree ("challenge_id","ordinal");--> statement-breakpoint
CREATE UNIQUE INDEX "learning_challenge_attempts_submit_key" ON "learning_challenge_attempts" USING btree ("workspace_id","user_id","submit_key");--> statement-breakpoint
CREATE UNIQUE INDEX "learning_challenges_generation_key" ON "learning_challenges" USING btree ("workspace_id","user_id","generation_key");--> statement-breakpoint
CREATE INDEX "learning_challenges_notebook_user_idx" ON "learning_challenges" USING btree ("workspace_id","notebook_id","user_id","created_at");