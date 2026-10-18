ALTER TABLE "document_extractions" ADD COLUMN "embedded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "document_extractions" ADD COLUMN "embed_model" text;--> statement-breakpoint
ALTER TABLE "document_extractions" ADD COLUMN "embed_error" text;--> statement-breakpoint
ALTER TABLE "embeddings" ADD COLUMN "span_start" integer;--> statement-breakpoint
ALTER TABLE "embeddings" ADD COLUMN "span_end" integer;--> statement-breakpoint
ALTER TABLE "embeddings" ADD COLUMN "page" integer;