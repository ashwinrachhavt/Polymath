CREATE TYPE "public"."extraction_attempt_outcome" AS ENUM('succeeded', 'failed', 'abandoned');--> statement-breakpoint
CREATE TABLE "document_extraction_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"extraction_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"claimed_by" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"outcome" "extraction_attempt_outcome",
	"error" text
);
--> statement-breakpoint
ALTER TABLE "document_extractions" ADD COLUMN "claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "document_extractions" ADD COLUMN "claimed_by" text;--> statement-breakpoint
ALTER TABLE "document_extraction_attempts" ADD CONSTRAINT "document_extraction_attempts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_extraction_attempts" ADD CONSTRAINT "document_extraction_attempts_extraction_id_document_extractions_id_fk" FOREIGN KEY ("extraction_id") REFERENCES "public"."document_extractions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "document_extraction_attempts_number_key" ON "document_extraction_attempts" USING btree ("extraction_id","attempt");--> statement-breakpoint
CREATE INDEX "document_extraction_attempts_workspace_idx" ON "document_extraction_attempts" USING btree ("workspace_id","extraction_id");
