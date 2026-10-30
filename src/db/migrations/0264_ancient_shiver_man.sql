ALTER TABLE "daily_outcomes" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "daily_outcomes" CASCADE;--> statement-breakpoint
ALTER TABLE "note_comments" ADD PRIMARY KEY ("id");--> statement-breakpoint
ALTER TABLE "captures" ADD CONSTRAINT "captures_identity_hash_present" CHECK (url is null or capture_mode in ('url-reference', 'blob') or content_hash is not null);--> statement-breakpoint
DROP TYPE "public"."card_state";--> statement-breakpoint
DROP TYPE "public"."card_review_outcome";