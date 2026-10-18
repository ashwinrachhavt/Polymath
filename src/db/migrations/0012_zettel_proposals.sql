CREATE TYPE "public"."zettel_proposal_status" AS ENUM('proposed', 'accepted', 'rejected');--> statement-breakpoint
CREATE TABLE "zettel_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"extraction_id" uuid NOT NULL,
	"title" text NOT NULL,
	"claim" text NOT NULL,
	"quote" text NOT NULL,
	"span_start" integer NOT NULL,
	"span_end" integer NOT NULL,
	"dedupe_key" text NOT NULL,
	"status" "zettel_proposal_status" DEFAULT 'proposed' NOT NULL,
	"concept_id" uuid,
	"claim_id" uuid,
	"proposer" text,
	"decided_at" timestamp with time zone,
	"decided_by" uuid,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL
);--> statement-breakpoint
ALTER TABLE "zettel_proposals" ADD CONSTRAINT "zettel_proposals_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "zettel_proposals" ADD CONSTRAINT "zettel_proposals_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "zettel_proposals" ADD CONSTRAINT "zettel_proposals_extraction_id_document_extractions_id_fk" FOREIGN KEY ("extraction_id") REFERENCES "public"."document_extractions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "zettel_proposals" ADD CONSTRAINT "zettel_proposals_span_check" CHECK (span_start >= 0 AND span_end > span_start);--> statement-breakpoint
CREATE UNIQUE INDEX "zettel_proposals_dedupe_key" ON "zettel_proposals" USING btree ("document_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "zettel_proposals_workspace_status_idx" ON "zettel_proposals" USING btree ("workspace_id","status");
