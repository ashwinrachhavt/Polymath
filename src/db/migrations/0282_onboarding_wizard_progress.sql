ALTER TABLE "onboarding_sessions" ADD COLUMN "step" text DEFAULT 'role' NOT NULL;--> statement-breakpoint
ALTER TABLE "onboarding_sessions" ADD COLUMN "draft" jsonb;--> statement-breakpoint
ALTER TABLE "onboarding_sessions" ADD COLUMN "welcomed_at" timestamp with time zone;