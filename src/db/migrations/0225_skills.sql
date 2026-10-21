-- 0222 (ASH-200): a skills library replaces the specialist roster.
--
-- A skill is a stored instruction package: a SKILL.md body plus its files, text
-- only. Identity is (workspace, source_kind, source_ref, source_path) and is
-- separate from the display slug, because two packages in one repo may share a
-- name. Rows are a copy of something that still exists at its source, so a
-- removal is a hard delete; provenance for a run lives in
-- agent_runs.policy_snapshot.skill, which is frozen at run start.
CREATE TABLE "skills" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL,
  "slug" text NOT NULL,
  "name" text NOT NULL,
  "description" text NOT NULL,
  "body" text NOT NULL,
  "files" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "source_kind" text NOT NULL,
  "source_ref" text NOT NULL,
  "source_path" text NOT NULL,
  "revision" text NOT NULL,
  "content_hash" text NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "created_by" uuid,
  "updated_by" uuid,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  "archived_at" timestamptz,
  "version" integer DEFAULT 1 NOT NULL
);--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Source kinds are a closed vocabulary; the constraint is what stops a typo
-- from inventing a fourth adapter nobody implemented.
ALTER TABLE "skills" ADD CONSTRAINT "skills_source_kind_check" CHECK ("source_kind" in ('github', 'local', 'bundled'));--> statement-breakpoint
CREATE UNIQUE INDEX "skills_identity_key" ON "skills" USING btree ("workspace_id","source_kind","source_ref","source_path");--> statement-breakpoint
CREATE INDEX "skills_workspace_enabled_idx" ON "skills" USING btree ("workspace_id","enabled");
