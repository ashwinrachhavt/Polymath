-- The same-workspace foreign key below needs this key to exist first.
CREATE UNIQUE INDEX "concepts_workspace_id_id_key" ON "concepts" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE TABLE "concept_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"concept_id" uuid NOT NULL,
	"quiz_question_id" uuid,
	"flashcard_id" uuid,
	"explain_turn_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "concept_links_one_subject_check" CHECK (num_nonnulls("quiz_question_id", "flashcard_id", "explain_turn_id") = 1)
);
--> statement-breakpoint
ALTER TABLE "concept_links" ADD CONSTRAINT "concept_links_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concept_links" ADD CONSTRAINT "concept_links_quiz_question_id_quiz_questions_id_fk" FOREIGN KEY ("quiz_question_id") REFERENCES "public"."quiz_questions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concept_links" ADD CONSTRAINT "concept_links_flashcard_id_flashcards_id_fk" FOREIGN KEY ("flashcard_id") REFERENCES "public"."flashcards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concept_links" ADD CONSTRAINT "concept_links_explain_turn_id_explain_turns_id_fk" FOREIGN KEY ("explain_turn_id") REFERENCES "public"."explain_turns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concept_links" ADD CONSTRAINT "concept_links_concept_same_workspace_fk" FOREIGN KEY ("workspace_id","concept_id") REFERENCES "public"."concepts"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "concept_links_quiz_question_key" ON "concept_links" USING btree ("quiz_question_id","concept_id");--> statement-breakpoint
CREATE UNIQUE INDEX "concept_links_flashcard_key" ON "concept_links" USING btree ("flashcard_id","concept_id");--> statement-breakpoint
CREATE UNIQUE INDEX "concept_links_explain_turn_key" ON "concept_links" USING btree ("explain_turn_id","concept_id");--> statement-breakpoint
CREATE INDEX "concept_links_concept_idx" ON "concept_links" USING btree ("workspace_id","concept_id");