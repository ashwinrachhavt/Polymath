-- B02 (ASH-143) + cleanup review items 1-2 (ASH-133): one doc-type signal on
-- documents, set by an accepted classification proposal; the rename manifest
-- (who/what/why for every title change). Renaming a document no longer
-- changes its obligations - the rules key off doc_type. Additive only.
ALTER TABLE "documents" ADD COLUMN "doc_type" text;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_doc_type_check" CHECK (doc_type is null or doc_type in ('invoice', 'receipt', 'agreement', 'resume', 'statement', 'letter', 'report', 'form', 'other'));--> statement-breakpoint
CREATE TABLE "document_classification_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"extraction_id" uuid,
	"proposed_type" text NOT NULL,
	"confidence" text NOT NULL,
	"signals" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"proposer" text NOT NULL,
	"status" text NOT NULL DEFAULT 'proposed',
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);--> statement-breakpoint
CREATE TABLE "document_rename_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"old_title" text NOT NULL,
	"new_title" text NOT NULL,
	"basis" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "document_classification_proposals" ADD CONSTRAINT "document_classification_proposals_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_classification_proposals" ADD CONSTRAINT "document_classification_proposals_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_classification_proposals" ADD CONSTRAINT "document_classification_proposals_extraction_id_fk" FOREIGN KEY ("extraction_id") REFERENCES "public"."document_extractions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_classification_proposals" ADD CONSTRAINT "document_classification_proposals_type_check" CHECK (proposed_type in ('invoice', 'receipt', 'agreement', 'resume', 'statement', 'letter', 'report', 'form', 'other'));--> statement-breakpoint
ALTER TABLE "document_classification_proposals" ADD CONSTRAINT "document_classification_proposals_confidence_check" CHECK (confidence in ('high', 'medium', 'low'));--> statement-breakpoint
ALTER TABLE "document_classification_proposals" ADD CONSTRAINT "document_classification_proposals_status_check" CHECK (status in ('proposed', 'accepted', 'rejected'));--> statement-breakpoint
ALTER TABLE "document_rename_events" ADD CONSTRAINT "document_rename_events_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_rename_events" ADD CONSTRAINT "document_rename_events_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_rename_events" ADD CONSTRAINT "document_rename_events_source_check" CHECK (source in ('suggested', 'manual', 'classification'));--> statement-breakpoint
CREATE UNIQUE INDEX "document_classification_open_key" ON "document_classification_proposals" USING btree ("workspace_id","document_id","proposer") WHERE status = 'proposed';--> statement-breakpoint
CREATE INDEX "document_classification_document_idx" ON "document_classification_proposals" USING btree ("workspace_id","document_id");--> statement-breakpoint
CREATE INDEX "document_rename_events_document_idx" ON "document_rename_events" USING btree ("workspace_id","document_id","created_at");
