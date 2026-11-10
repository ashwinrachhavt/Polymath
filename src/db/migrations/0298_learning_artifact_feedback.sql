DROP INDEX "artifact_feedback_user_key";--> statement-breakpoint
DROP INDEX "artifact_feedback_workspace_user_idx";--> statement-breakpoint
ALTER TABLE "artifact_feedback" ALTER COLUMN "artifact_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "artifact_feedback" ADD COLUMN "quiz_id" uuid;--> statement-breakpoint
ALTER TABLE "artifact_feedback" ADD COLUMN "flashcard_deck_id" uuid;--> statement-breakpoint
ALTER TABLE "artifact_feedback" ADD CONSTRAINT "artifact_feedback_quiz_id_quizzes_id_fk" FOREIGN KEY ("quiz_id") REFERENCES "public"."quizzes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_feedback" ADD CONSTRAINT "artifact_feedback_flashcard_deck_id_flashcard_decks_id_fk" FOREIGN KEY ("flashcard_deck_id") REFERENCES "public"."flashcard_decks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "artifact_feedback_artifact_user_key" ON "artifact_feedback" USING btree ("workspace_id","artifact_id","user_id") WHERE "artifact_feedback"."artifact_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "artifact_feedback_quiz_user_key" ON "artifact_feedback" USING btree ("workspace_id","quiz_id","user_id") WHERE "artifact_feedback"."quiz_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "artifact_feedback_flashcard_deck_user_key" ON "artifact_feedback" USING btree ("workspace_id","flashcard_deck_id","user_id") WHERE "artifact_feedback"."flashcard_deck_id" is not null;--> statement-breakpoint
CREATE INDEX "artifact_feedback_workspace_user_idx" ON "artifact_feedback" USING btree ("workspace_id","user_id","updated_at");--> statement-breakpoint
ALTER TABLE "artifact_feedback" ADD CONSTRAINT "artifact_feedback_target_check" CHECK (num_nonnulls("artifact_feedback"."artifact_id", "artifact_feedback"."quiz_id", "artifact_feedback"."flashcard_deck_id") = 1);