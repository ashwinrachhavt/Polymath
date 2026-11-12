CREATE TYPE "public"."mission_status" AS ENUM('draft', 'active', 'archived');--> statement-breakpoint
CREATE TABLE "mission_concepts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"mission_id" uuid NOT NULL,
	"concept_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"reason" text NOT NULL,
	"source_quote" text NOT NULL,
	"source_document_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mission_mock_questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"mission_concept_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"prompt" text NOT NULL,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"answer" text,
	"grade" text,
	"feedback" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mission_mock_questions_grade_check" CHECK (grade is null or grade in ('correct', 'partial', 'incorrect', 'uncertain')),
	CONSTRAINT "mission_mock_questions_answer_check" CHECK ((answer is null) = (grade is null))
);
--> statement-breakpoint
CREATE TABLE "mission_mock_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"mission_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"request_key" text NOT NULL,
	"status" text DEFAULT 'preparing' NOT NULL,
	"error" text,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "mission_mock_sessions_status_check" CHECK (status in ('preparing', 'asking', 'complete'))
);
--> statement-breakpoint
CREATE TABLE "missions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"goal" text NOT NULL,
	"role" text,
	"due_on" date,
	"status" "mission_status" DEFAULT 'draft' NOT NULL,
	"source_manifest" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"concept_job_id" uuid,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "missions_goal_check" CHECK (length(btrim("goal")) between 1 and 500),
	CONSTRAINT "missions_role_check" CHECK ("role" is null or length("role") <= 2000)
);
--> statement-breakpoint
ALTER TABLE "mission_concepts" ADD CONSTRAINT "mission_concepts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mission_concepts" ADD CONSTRAINT "mission_concepts_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mission_concepts" ADD CONSTRAINT "mission_concepts_concept_same_workspace_fk" FOREIGN KEY ("workspace_id","concept_id") REFERENCES "public"."concepts"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mission_mock_questions" ADD CONSTRAINT "mission_mock_questions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mission_mock_questions" ADD CONSTRAINT "mission_mock_questions_session_id_mission_mock_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."mission_mock_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mission_mock_questions" ADD CONSTRAINT "mission_mock_questions_mission_concept_id_mission_concepts_id_fk" FOREIGN KEY ("mission_concept_id") REFERENCES "public"."mission_concepts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mission_mock_sessions" ADD CONSTRAINT "mission_mock_sessions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mission_mock_sessions" ADD CONSTRAINT "mission_mock_sessions_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mission_mock_sessions" ADD CONSTRAINT "mission_mock_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "missions" ADD CONSTRAINT "missions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mission_concepts_ordinal_key" ON "mission_concepts" USING btree ("mission_id","ordinal");--> statement-breakpoint
CREATE UNIQUE INDEX "mission_concepts_concept_key" ON "mission_concepts" USING btree ("mission_id","concept_id");--> statement-breakpoint
CREATE INDEX "mission_concepts_mission_idx" ON "mission_concepts" USING btree ("workspace_id","mission_id","ordinal");--> statement-breakpoint
CREATE UNIQUE INDEX "mission_mock_questions_ordinal_key" ON "mission_mock_questions" USING btree ("session_id","ordinal");--> statement-breakpoint
CREATE INDEX "mission_mock_questions_session_idx" ON "mission_mock_questions" USING btree ("workspace_id","session_id","ordinal");--> statement-breakpoint
CREATE INDEX "mission_mock_questions_concept_idx" ON "mission_mock_questions" USING btree ("workspace_id","mission_concept_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mission_mock_sessions_request_key" ON "mission_mock_sessions" USING btree ("workspace_id","user_id","request_key");--> statement-breakpoint
CREATE INDEX "mission_mock_sessions_mission_user_idx" ON "mission_mock_sessions" USING btree ("workspace_id","mission_id","user_id","created_at");--> statement-breakpoint
CREATE INDEX "missions_workspace_status_idx" ON "missions" USING btree ("workspace_id","status","created_at");