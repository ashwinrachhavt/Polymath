-- 0261 / ASH-174: tenancy for a task's note, made structural.
--
-- A task is a note plus a 1:1 extension row. 0259 gave tasks.note_id a
-- single-column FK to artifacts(id), which proves the note EXISTS but says
-- nothing about whose it is: Postgres will accept a task in workspace A whose
-- note_id names an artifact in workspace B, and nothing about either row looks
-- wrong. The leak only appears one layer up, where the prose read joins the
-- artifact and shows another tenant's title and body - the top guardrail in
-- agents/product.md, violated by a row that passes every constraint.
--
-- So tenancy was enforced in application code (notes.ts
-- assertArtifactInWorkspace, called inside the write transaction). That guard
-- is necessary - it produces a readable 409 instead of a driver error - but it
-- is only as good as every future caller remembering to invoke it. This
-- constraint is the half that survives new callers.
--
-- It is expressible with no new index: artifacts has carried
-- UNIQUE (workspace_id, id) since 0150 (artifacts_workspace_id_id_key), which
-- is exactly the referenced key a composite FK needs. Column order in the
-- constraint is (workspace_id, note_id) -> (workspace_id, id); the pairing is
-- what ties the note's tenant to the task's.
--
-- Ordering against 0260: in this tree tasks.note_id is still nullable, and a
-- composite FK is satisfied whenever ANY component is NULL, so a task with no
-- note is unaffected. That makes this migration correct before AND after 0260's
-- SET NOT NULL - it does not have to wait, and it must not be folded into 0260,
-- which is already committed on another branch. The "a note is required" half
-- stays 0260's job; this one only says "if there is a note, it is yours".
--
-- Safe to re-run: the DO block swallows duplicate_object, so a second pass is
-- inert.
DO $$ BEGIN
  ALTER TABLE "tasks" ADD CONSTRAINT "tasks_note_workspace_fk"
    FOREIGN KEY ("workspace_id", "note_id") REFERENCES "artifacts" ("workspace_id", "id");
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
