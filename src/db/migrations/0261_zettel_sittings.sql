-- 2026-10-29 zettel sittings (plan 2026-10-29 §2): a sitting is a timed
-- writing session; cards join with a role, and deleting a sitting cascades
-- only the join rows - the artifacts survive. Multiple open sittings per
-- workspace are allowed (§14.8); ended sittings reopen browse-only.
-- artifacts.metadata is the namespaced annotation column (§16.8): Bloom
-- suggestion, dismissed link candidates, sitting lineage - never user
-- mastery, and annotation writes never touch updated_at.
ALTER TABLE "artifacts" ADD COLUMN IF NOT EXISTS "metadata" jsonb;--> statement-breakpoint
CREATE TABLE "zettel_sittings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE cascade,
  "topic" text,
  "tags" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "source_context" text,
  "closing_reflection" text,
  "started_at" timestamptz NOT NULL DEFAULT now(),
  "ended_at" timestamptz,
  "created_by" uuid,
  "updated_by" uuid,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "archived_at" timestamptz,
  "version" integer NOT NULL DEFAULT 1
);--> statement-breakpoint
CREATE INDEX "zettel_sittings_workspace_idx" ON "zettel_sittings" ("workspace_id", "updated_at");--> statement-breakpoint
-- Partial index: the "which sittings are open" read never scans history.
CREATE INDEX "zettel_sittings_open_idx" ON "zettel_sittings" ("workspace_id") WHERE "ended_at" IS NULL;--> statement-breakpoint
CREATE TYPE "sitting_card_role" AS ENUM ('created_here', 'referenced_here', 'revised_here');--> statement-breakpoint
CREATE TABLE "zettel_sitting_cards" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE cascade,
  "sitting_id" uuid NOT NULL REFERENCES "zettel_sittings"("id") ON DELETE cascade,
  "artifact_id" uuid NOT NULL REFERENCES "artifacts"("id") ON DELETE cascade,
  "position" integer NOT NULL DEFAULT 0,
  "role_in_sitting" "sitting_card_role" NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE UNIQUE INDEX "zettel_sitting_cards_sitting_artifact_key" ON "zettel_sitting_cards" ("sitting_id", "artifact_id");--> statement-breakpoint
CREATE INDEX "zettel_sitting_cards_sitting_idx" ON "zettel_sitting_cards" ("sitting_id", "position");--> statement-breakpoint
CREATE INDEX "zettel_sitting_cards_artifact_idx" ON "zettel_sitting_cards" ("artifact_id");
