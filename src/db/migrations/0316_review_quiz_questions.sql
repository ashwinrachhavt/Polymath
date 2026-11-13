ALTER TABLE "flashcard_reviews" ALTER COLUMN "flashcard_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "flashcard_reviews" ADD COLUMN "quiz_question_id" uuid;--> statement-breakpoint
ALTER TABLE "flashcard_reviews" ADD CONSTRAINT "flashcard_reviews_quiz_question_id_quiz_questions_id_fk" FOREIGN KEY ("quiz_question_id") REFERENCES "public"."quiz_questions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "flashcard_reviews_user_question_key" ON "flashcard_reviews" USING btree ("workspace_id","quiz_question_id","user_id");--> statement-breakpoint
ALTER TABLE "flashcard_reviews" ADD CONSTRAINT "flashcard_reviews_one_item_check" CHECK (num_nonnulls("flashcard_id", "quiz_question_id") = 1);