-- Margin comments on notes (Notion-feel, owner direction 2026-10-28). A
-- comment belongs to the note as a whole - no text-anchor ranges yet; that
-- ceiling is deliberate and lives with the composer. Resolved is a visible
-- state (`resolved_at`), never a deletion. The note is an artifacts row
-- (kind note/zettel), so deleting the note cascades its comments - the same
-- honesty rule as claim_evidence and cards.
CREATE TABLE IF NOT EXISTS "note_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"note_id" uuid NOT NULL,
	"body" text NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "note_comments_body_check" CHECK (length(btrim(body)) between 1 and 2000)
);--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "note_comments" ADD CONSTRAINT "note_comments_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "note_comments" ADD CONSTRAINT "note_comments_note_id_artifacts_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."artifacts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "note_comments_note_idx" ON "note_comments" USING btree ("workspace_id","note_id","created_at");
