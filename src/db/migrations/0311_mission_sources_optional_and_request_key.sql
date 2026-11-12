ALTER TABLE "mission_concepts" ALTER COLUMN "source_quote" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "mission_concepts" ALTER COLUMN "source_document_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "missions" ADD COLUMN "request_key" text NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "missions_request_key" ON "missions" USING btree ("workspace_id","request_key");