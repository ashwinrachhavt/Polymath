CREATE TYPE "public"."focus_strictness" AS ENUM('normal', 'timeout', 'deep');--> statement-breakpoint
ALTER TABLE "focus_sessions" ADD COLUMN "strictness" "focus_strictness" DEFAULT 'normal' NOT NULL;--> statement-breakpoint
ALTER TABLE "focus_sessions" ADD COLUMN "pause_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "focus_sessions" ADD COLUMN "abandon_requested_at" timestamp with time zone;