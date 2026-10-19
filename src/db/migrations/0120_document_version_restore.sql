-- Version restore (ASH-108 15E, Box-feel library): an explicit pointer to
-- the extraction version a document currently reads as. Null means the
-- newest extraction, which is every existing document. Additive only.
ALTER TABLE "documents" ADD COLUMN "active_extraction_id" uuid;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_active_extraction_id_fk" FOREIGN KEY ("active_extraction_id") REFERENCES "public"."document_extractions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "documents_active_extraction_idx" ON "documents" USING btree ("active_extraction_id") WHERE active_extraction_id is not null;
