-- 0212 (ASH-174/ASH-184): the document enrichment state machine. After a
-- source is captured and extracted, the stages that follow (embed the text,
-- propose zettels, link accepted cards into the semantic graph) are tracked
-- one row per document per stage, so a failure is visible and retryable and
-- the pipeline survives a restart - nothing derives stage state from memory.
CREATE TABLE "document_enrichment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"stage" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"last_run_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_enrichment_document_stage_key" UNIQUE ("document_id","stage"),
	CONSTRAINT "document_enrichment_stage_check" CHECK (stage in ('extract', 'embed', 'zettels', 'link')),
	CONSTRAINT "document_enrichment_status_check" CHECK (status in ('pending', 'running', 'succeeded', 'failed', 'skipped')),
	CONSTRAINT "document_enrichment_attempts_check" CHECK (attempts >= 0)
);
--> statement-breakpoint
ALTER TABLE "document_enrichment" ADD CONSTRAINT "document_enrichment_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "document_enrichment" ADD CONSTRAINT "document_enrichment_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "document_enrichment_workspace_document_idx" ON "document_enrichment" USING btree ("workspace_id","document_id");
