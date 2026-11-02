-- Per-message comments (chat-actions PR B, plan Task 6). A comment belongs to
-- a whole stored message - the same whole-message ceiling note_comments keeps,
-- because anchors need span storage and a drift rule of their own. Resolved is
-- a visible state (resolved_at), never a deletion. Messages cascade with their
-- thread, so deleting the thread cascades its comments - the same honesty rule
-- as note_comments.
CREATE TABLE IF NOT EXISTS "message_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"body" text NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "message_comments_body_check" CHECK (length(btrim(body)) between 1 and 2000)
);--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "message_comments" ADD CONSTRAINT "message_comments_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "message_comments" ADD CONSTRAINT "message_comments_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "message_comments" ADD CONSTRAINT "message_comments_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "message_comments_message_idx" ON "message_comments" USING btree ("workspace_id","message_id","created_at");--> statement-breakpoint
-- The proposals seam: a zettel proposal may be drawn from a succeeded document
-- (the enrichment pipeline) or from an artifact (a conversation mined for
-- ideas, PR C). Relaxing the NOT NULLs makes the 0012 (document_id,
-- dedupe_key) index stop constraining artifact-sourced rows - Postgres treats
-- NULLs as distinct - so the partial index below restores the guarantee on the
-- artifact path. The 0012 index is untouched: document-sourced proposals keep
-- their own key. Exactly one origin per row, enforced.
ALTER TABLE "zettel_proposals" ALTER COLUMN "document_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "zettel_proposals" ALTER COLUMN "extraction_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "zettel_proposals" ADD COLUMN IF NOT EXISTS "source_artifact_id" uuid;--> statement-breakpoint
ALTER TABLE "zettel_proposals" ADD COLUMN IF NOT EXISTS "duplicate_of_artifact_id" uuid;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "zettel_proposals" ADD CONSTRAINT "zettel_proposals_source_artifact_id_artifacts_id_fk" FOREIGN KEY ("source_artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "zettel_proposals" ADD CONSTRAINT "zettel_proposals_duplicate_of_artifact_id_artifacts_id_fk" FOREIGN KEY ("duplicate_of_artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "zettel_proposals" ADD CONSTRAINT "zettel_proposals_one_source_check" CHECK (num_nonnulls(document_id, source_artifact_id) = 1);
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "zettel_proposals_artifact_dedupe_key" ON "zettel_proposals" ("source_artifact_id","dedupe_key") WHERE "source_artifact_id" IS NOT NULL;
