-- 0248: Notebook tables take their own name. The dossier→projects rename in
-- 0225 was written against a table name that was already taken: the work
-- domain's `projects` (tasks, boards, and recurrence templates hold foreign
-- keys to it), so drizzle never applied the file and the knowledge schema
-- could not read the table it described. The Notebook resource is a notebook
-- — the rail already labels it that — so the tables rename to the free name
-- and the work domain keeps `projects` untouched.
--
-- The original 0225_projects_from_dossiers.sql file is removed by the same
-- change that adds this one: it never ran, so no database holds it as a
-- checkpoint, and leaving it would keep check:migrations failing.

ALTER TABLE "dossiers" RENAME TO "notebooks";
ALTER TABLE "dossier_sources" RENAME TO "notebook_sources";
ALTER TABLE "dossier_questions" RENAME TO "notebook_questions";

ALTER TABLE "notebooks"
  ADD COLUMN IF NOT EXISTS "description" text,
  ADD COLUMN IF NOT EXISTS "instructions" text,
  ADD COLUMN IF NOT EXISTS "emoji" text,
  ADD COLUMN IF NOT EXISTS "pinned_at" timestamptz;

ALTER TABLE "notebooks" RENAME COLUMN "research_question" TO "description_seed";

-- Names carried the old concept; indexes follow the tables.
ALTER INDEX IF EXISTS "dossiers_workspace_updated_idx" RENAME TO "notebooks_workspace_updated_idx";
ALTER INDEX IF EXISTS "dossier_sources_key" RENAME TO "notebook_sources_key";
ALTER INDEX IF EXISTS "dossier_sources_source_idx" RENAME TO "notebook_sources_source_idx";
ALTER INDEX IF EXISTS "dossier_questions_open_idx" RENAME TO "notebook_questions_open_idx";

-- Automations: a prompt on a schedule, ticked by the cron dispatcher. A run
-- started by an automation is an ordinary agent run bound to the notebook.
CREATE TABLE IF NOT EXISTS "notebook_automations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL,
  "notebook_id" uuid NOT NULL REFERENCES "notebooks"("id") ON DELETE CASCADE,
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
CREATE INDEX IF NOT EXISTS "notebook_automations_due_idx" ON "notebook_automations" ("next_run_at") WHERE "archived_at" IS NULL AND "enabled" IS TRUE;
CREATE INDEX IF NOT EXISTS "notebook_automations_notebook_idx" ON "notebook_automations" ("notebook_id", "created_at");

-- Notebook memory: context this notebook remembers, injected into its sessions.
CREATE TABLE IF NOT EXISTS "notebook_memories" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL,
  "notebook_id" uuid NOT NULL REFERENCES "notebooks"("id") ON DELETE CASCADE,
  "content" text NOT NULL,
  "source" text NOT NULL DEFAULT 'manual',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "archived_at" timestamptz,
  "version" integer NOT NULL DEFAULT 1,
  "created_by" uuid,
  "updated_by" uuid
);
CREATE INDEX IF NOT EXISTS "notebook_memories_notebook_idx" ON "notebook_memories" ("notebook_id", "created_at");

-- Per-notebook connector allowlist. No rows means every workspace account is
-- available (notebooks created before scoping keep working); rows make it an
-- allowlist the assistant's tool builder reads.
CREATE TABLE IF NOT EXISTS "notebook_accounts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL,
  "notebook_id" uuid NOT NULL REFERENCES "notebooks"("id") ON DELETE CASCADE,
  "gateway_account_id" uuid NOT NULL,
  "enabled" boolean NOT NULL DEFAULT true,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("notebook_id", "gateway_account_id")
);
CREATE INDEX IF NOT EXISTS "notebook_accounts_notebook_idx" ON "notebook_accounts" ("notebook_id");

-- Sessions are scoped to a notebook through the existing threads.subject_type
-- / subject_id pair ("notebook", <id>); no conversation schema change.
