-- 0228: onboarding state and the supervisor agent's personified brief.
--
-- Onboarding is one conversation with the workspace's future agent, not a
-- wizard: the flow interviews the person, then writes what it learned into
-- agent_profiles (name, description, instructions). This table holds only the
-- flow's own state so a half-finished onboarding can be resumed, and so "never
-- onboarded" is knowable without scanning profile text.
--
-- personified_brief holds the onboarding output verbatim until the operator
-- edits the profile; it is provenance, not a second source of truth.
CREATE TABLE IF NOT EXISTS "onboarding_sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "status" text NOT NULL DEFAULT 'in_progress',
  "role" text,
  "tools" jsonb,
  "priorities" jsonb,
  "personified_brief" text,
  "completed_at" timestamp with time zone,
  "created_by" uuid,
  "updated_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "archived_at" timestamp with time zone,
  "version" integer DEFAULT 1 NOT NULL,
  CONSTRAINT "onboarding_sessions_status_check" CHECK (status IN ('in_progress', 'completed', 'abandoned'))
);
CREATE UNIQUE INDEX IF NOT EXISTS "onboarding_sessions_workspace_active_key"
  ON "onboarding_sessions" ("workspace_id")
  WHERE "archived_at" IS NULL AND "status" = 'in_progress';
CREATE INDEX IF NOT EXISTS "onboarding_sessions_workspace_idx"
  ON "onboarding_sessions" ("workspace_id");
--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "onboarded_at" timestamp with time zone;
