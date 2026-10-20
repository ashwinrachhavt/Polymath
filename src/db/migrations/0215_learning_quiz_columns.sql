-- 0215 (NotebookLM parity, PR 2): quiz items become takeable.
--
-- The v1 learning tables stored a prompt and an answer, which is a flashcard.
-- A multiple-choice question needs its options, the correct index and the
-- explanation as columns: the quiz UI reads answerIndex and the approval
-- surface counts options. JSON inside `answer` would put a queried value in an
-- opaque blob.
ALTER TABLE "learning_items" ADD COLUMN "options" jsonb;--> statement-breakpoint
ALTER TABLE "learning_items" ADD COLUMN "answer_index" integer;--> statement-breakpoint
ALTER TABLE "learning_items" ADD COLUMN "explanation" text;--> statement-breakpoint
ALTER TABLE "learning_items" ADD COLUMN "dedupe_key" text;--> statement-breakpoint

-- A quiz question with no options cannot be taken, so the database refuses it
-- rather than letting the UI discover it later.
ALTER TABLE "learning_items" ADD CONSTRAINT "learning_items_quiz_shape" CHECK (kind <> 'quiz_question' or (options is not null and answer_index is not null));--> statement-breakpoint

-- Regenerating a quiz must not duplicate an item. The key is a digest, not the
-- quote itself: a quote can exceed the btree row limit. Hand-written items have
-- no key and sit outside the rule.
CREATE UNIQUE INDEX "learning_items_dedupe_key" ON "learning_items" ("deck_id", "dedupe_key") WHERE "dedupe_key" is not null;
