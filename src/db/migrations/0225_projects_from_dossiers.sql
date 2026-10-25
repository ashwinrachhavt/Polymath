-- 0225: Dossiers become Projects (Perplexity-Spaces parity). The dossier
-- tables are renamed in place - existing notebooks are projects, not a
-- parallel store - and gain the fields the project surface needs:
-- description, custom instructions, pinning, an emoji, automations,
-- project memory, and a per-project connector allowlist.

ALTER TABLE "dossiers" RENAME TO "projects";
ALTER TABLE "dossier_sources" RENAME TO "project_sources";
ALTER TABLE "dossier_questions" RENAME TO "project_questions";

ALTER TABLE "projects"
  ADD COLUMN IF NOT EXISTS "description" text,
  ADD COLUMN IF NOT EXISTS "instructions" text,
  ADD COLUMN IF NOT EXISTS "emoji" text,
  ADD COLUMN IF NOT EXISTS "pinned_at" timestamptz;

ALTER TABLE "projects" RENAME COLUMN "research_question" TO "description_seed";

-- Names carried the old concept; indexes follow the tables.
ALTER INDEX IF EXISTS "dossiers_workspace_updated_idx" RENAME TO "projects_workspace_updated_idx";
ALTER INDEX IF EXISTS "dossier_sources_key" RENAME TO "project_sources_key";
ALTER INDEX IF EXISTS "dossier_sources_source_idx" RENAME TO "project_sources_source_idx";
ALTER INDEX IF EXISTS "dossier_questions_open_idx" RENAME TO "project_questions_open_idx";

-- Automations: a prompt on a schedule, ticked by the cron dispatcher. A run
-- started by an automation is an ordinary agent run bound to the project.
CREATE TABLE IF NOT EXISTS "project_automations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL,
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "prompt" text NOT NULL,
  "schedule" text NOT NULL,
  "enabled" boolean NOT NULL DEFAULT true,
  "last_run_at" timestamptz,
  "next_run_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "archived_at" timestamptz,
  "version" integer NOT NULL DEFAULT 1,
  "created_by" uuid,
  "updated_by" uuid
);
CREATE INDEX IF NOT EXISTS "project_automations_due_idx" ON "project_automations" ("next_run_at") WHERE "archived_at" IS NULL AND "enabled" IS TRUE;
CREATE INDEX IF NOT EXISTS "project_automations_project_idx" ON "project_automations" ("project_id", "created_at");

-- Project memory: context this project remembers, injected into its sessions.
CREATE TABLE IF NOT EXISTS "project_memories" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL,
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "content" text NOT NULL,
  "source" text NOT NULL DEFAULT 'manual',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "archived_at" timestamptz,
  "version" integer NOT NULL DEFAULT 1,
  "created_by" uuid,
  "updated_by" uuid
);
CREATE INDEX IF NOT EXISTS "project_memories_project_idx" ON "project_memories" ("project_id", "created_at");

-- Per-project connector allowlist. No rows means every workspace account is
-- available (projects created before scoping keep working); rows make it an
-- allowlist the assistant's tool builder reads.
CREATE TABLE IF NOT EXISTS "project_accounts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL,
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "gateway_account_id" uuid NOT NULL,
  "enabled" boolean NOT NULL DEFAULT true,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("project_id", "gateway_account_id")
);
CREATE INDEX IF NOT EXISTS "project_accounts_project_idx" ON "project_accounts" ("project_id");

-- Sessions are scoped to a project through the existing threads.subject_type
-- / subject_id pair ("project", <id>); no conversation schema change.
