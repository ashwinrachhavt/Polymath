ALTER TYPE "public"."ledger_reason" ADD VALUE 'foundry_drop';--> statement-breakpoint
ALTER TABLE "reward_definitions" ADD COLUMN "recipe" jsonb;