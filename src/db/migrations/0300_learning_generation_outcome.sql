ALTER TABLE "flashcard_decks" ADD COLUMN "requested_count" integer;--> statement-breakpoint
ALTER TABLE "flashcard_decks" ADD COLUMN "stopped_by" text;--> statement-breakpoint
ALTER TABLE "quizzes" ADD COLUMN "requested_count" integer;--> statement-breakpoint
ALTER TABLE "quizzes" ADD COLUMN "stopped_by" text;--> statement-breakpoint
ALTER TABLE "flashcard_decks" ADD CONSTRAINT "flashcard_decks_stopped_by_check" CHECK ("stopped_by" in ('complete', 'source_exhausted', 'batch_failed'));--> statement-breakpoint
ALTER TABLE "quizzes" ADD CONSTRAINT "quizzes_stopped_by_check" CHECK ("stopped_by" in ('complete', 'source_exhausted', 'batch_failed'));--> statement-breakpoint
-- Decks made before this migration were written whole in one transaction, so
-- each one finished. Null now means a deck whose batches are still running.
UPDATE "flashcard_decks" SET "stopped_by" = 'complete' WHERE "stopped_by" IS NULL;
