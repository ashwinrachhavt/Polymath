-- 0260 / ASH-174: one note substrate, phase two - the drop. 0259 gave every
-- task a note and pointed tasks.note_id at it; this file makes that binding the
-- only one. After it runs, a task is an artifacts row plus a 1:1 extension row,
-- and tasks.title / tasks.description no longer exist to disagree with the
-- note. Irreversible: the prose lives in artifact_versions from here on, so the
-- rollback is a restore, not a statement.
--
-- The abort comes first, on purpose. Everything below it is destructive, and a
-- migration is only atomic per statement batch as the runner issues it, so a
-- partially applied file must never reach the first DROP. If any task still has
-- a null note_id, something upstream missed a create path (0259's backfill only
-- covered rows that existed then), and the right outcome is a failed deploy,
-- not a NOT NULL that silently omitted them. Raising here leaves the table
-- exactly as it was and names the count.
--
-- NOT NULL before the unique index is not a convenience: SET NOT NULL takes a
-- full table scan, and it is the constraint that makes "a task without a note"
-- unrepresentable. The index is what makes the binding 1:1 - two tasks sharing
-- one note would be two records of the same work, which is the second task
-- store this whole change exists to delete.
--
-- The FK on note_id already exists from 0259 (ON DELETE no action), so deleting
-- a note that backs a task is refused rather than cascading; no new constraint
-- is needed and none is added here.
--
-- Not re-runnable as a whole: SET NOT NULL and DROP COLUMN on an already-migrated
-- table fail. Forward-only, applied once, per the journal.
DO $$
DECLARE
  orphans bigint;
BEGIN
  SELECT count(*) INTO orphans FROM "tasks" WHERE "note_id" IS NULL;
  IF orphans > 0 THEN
    RAISE EXCEPTION 'tasks.note_id backfill is incomplete: % task(s) have no note. Run 0259 for rows created after it before dropping the task prose columns.', orphans
      USING ERRCODE = 'check_violation';
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "tasks" ALTER COLUMN "note_id" SET NOT NULL;
--> statement-breakpoint
-- One note backs one task. A plain unique index, not a constraint: there is no
-- second column to name and nothing references the index as a constraint.
CREATE UNIQUE INDEX "tasks_note_key" ON "tasks" USING btree ("note_id");
--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "title";
--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "description";
