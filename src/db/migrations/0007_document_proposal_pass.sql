ALTER TABLE "document_extractions" ADD COLUMN "proposal_status" "extraction_status";--> statement-breakpoint
ALTER TABLE "document_extractions" ADD COLUMN "proposer" text;--> statement-breakpoint
ALTER TABLE "document_extractions" ADD COLUMN "proposal_error" text;--> statement-breakpoint
ALTER TABLE "document_extractions" ADD COLUMN "proposal_claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "field_proposals" ADD COLUMN "party_role" "document_party_role";
