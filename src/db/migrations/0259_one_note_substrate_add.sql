-- 0259 / ASH-174: one note substrate, phase one. A task becomes a note (an
-- artifacts row) plus a 1:1 extension row in tasks, so this is the additive
-- half: two nullable columns and a backfill that gives every existing task the
-- note it will stand on. The drops land in 0260 - tasks.title and
-- tasks.description are removed, and note_id loses its nullability once every
-- read and write has moved. Additive and nullable, so mixed version deploys are
-- safe: old code never names template or note_id, and the artifacts this
-- creates are ordinary notes.
--
-- Safe to re-run. The backfill only touches tasks whose note_id is still null,
-- so a second pass inserts nothing and updates nothing.
--
-- Correlation between a task and the note it is getting is a pair of UUIDs
-- generated up front, never the title (two tasks may share a title) and never
-- produced_by_run_id (that column already means "a run produced this"). One
-- statement carries the whole backfill regardless of how many tasks there are,
-- so a recurrence template with 200 spawned instances fans out in the same
-- pass as a workspace with two.
ALTER TABLE "artifacts" ADD COLUMN IF NOT EXISTS "template" text;
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "note_id" uuid;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "tasks" ADD CONSTRAINT "tasks_note_id_artifacts_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."artifacts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
-- MATERIALIZED so gen_random_uuid() is evaluated once per task and every branch
-- below sees the same artifact/version ids. A task gets an issue-templated note
-- titled after it; the version body is the task's description as markdown.
--
-- Markdown ({format, text}), not ProseMirror doc JSON: the Notes surface renders
-- a note by reading content.text and returns "" otherwise (notes.ts markdownOf,
-- and the /alfred/notes page's noteMarkdown), so a doc-shaped body would open
-- blank and the next autosave would overwrite it with empty text. Only the empty
-- case keeps the doc shape, matching what createNoteInTx writes for a fresh
-- note - an empty doc and empty markdown both render blank.
--
-- body_text is computed once so `content` and `plain_text` cannot disagree: a
-- whitespace-only description is the same nothing as a null one, and both
-- projections take that verdict from the same column. A description with real
-- text is carried verbatim - the regex is the emptiness test, not a normalizer.
-- A regex, not btrim: single-argument btrim strips spaces only, so "  \n\t "
-- would pass for a body of real text. \s covers tabs and newlines too.
WITH pending AS MATERIALIZED (
  SELECT
    t.id AS task_id,
    t.workspace_id,
    t.title,
    CASE WHEN t.description ~ '^\s*$' THEN NULL ELSE t.description END AS body_text,
    t.created_by,
    t.updated_by,
    gen_random_uuid() AS note_id,
    gen_random_uuid() AS version_id
  FROM "tasks" t
  WHERE t.note_id IS NULL
), notes AS (
  INSERT INTO "artifacts" ("id", "workspace_id", "kind", "title", "template", "current_version_id", "created_by", "updated_by")
  SELECT p.note_id, p.workspace_id, 'note', p.title, 'issue', p.version_id, p.created_by, p.updated_by
  FROM pending p
), versions AS (
  INSERT INTO "artifact_versions" ("id", "workspace_id", "artifact_id", "version_number", "content", "plain_text", "reason", "created_by")
  SELECT
    p.version_id,
    p.workspace_id,
    p.note_id,
    1,
    CASE
      WHEN p.body_text IS NULL THEN '{"type": "doc", "content": []}'::jsonb
      ELSE jsonb_build_object('format', 'markdown', 'text', p.body_text)
    END,
    p.body_text,
    'created',
    p.created_by
  FROM pending p
)
UPDATE "tasks" SET "note_id" = p.note_id FROM pending p WHERE "tasks"."id" = p.task_id;
