-- 0216 (NotebookLM parity): video sources keep their timestamps.
--
-- A transcript's text is a document like any other, but a video citation points
-- at seconds into the media, not at a page in a PDF. Extraction spans are
-- character offsets; putting seconds there makes every citation wrong. This
-- table holds the cue list beside the document instead.
CREATE TABLE IF NOT EXISTS "youtube_transcripts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"video_id" text NOT NULL,
	"language" text,
	"cues" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"generated" boolean DEFAULT false NOT NULL,
	"extraction_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "youtube_transcripts" ADD CONSTRAINT "youtube_transcripts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "youtube_transcripts" ADD CONSTRAINT "youtube_transcripts_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "youtube_transcripts" ADD CONSTRAINT "youtube_transcripts_extraction_id_document_extractions_id_fk" FOREIGN KEY ("extraction_id") REFERENCES "public"."document_extractions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "youtube_transcripts_document_key" ON "youtube_transcripts" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "youtube_transcripts_workspace_idx" ON "youtube_transcripts" USING btree ("workspace_id","video_id");
