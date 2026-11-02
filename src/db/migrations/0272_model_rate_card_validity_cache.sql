ALTER TABLE "model_rate_cards" ADD COLUMN "cache_read_per_million" numeric(12, 6);--> statement-breakpoint
ALTER TABLE "model_rate_cards" ADD COLUMN "cache_write_per_million" numeric(12, 6);--> statement-breakpoint
ALTER TABLE "model_rate_cards" ADD COLUMN "valid_to" timestamp with time zone;