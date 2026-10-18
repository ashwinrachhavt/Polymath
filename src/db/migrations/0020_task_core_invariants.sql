-- Hand-written (see 0008 for why drizzle-kit generate is not used here).
-- ASH-137 / A03: the task graph's invariants move into the database so every
-- future caller inherits them. Forward-only; no data rewrite beyond the
-- cleanup of rows that already violate a new constraint.

-- A subtask points at a real task, and never at itself. Deleting a parent
-- detaches its children rather than deleting work.
UPDATE "tasks" SET "parent_task_id" = NULL
  WHERE "parent_task_id" IS NOT NULL
    AND ("parent_task_id" = "id" OR NOT EXISTS (SELECT 1 FROM "tasks" p WHERE p."id" = "tasks"."parent_task_id"));--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_parent_task_id_fk"
  FOREIGN KEY ("parent_task_id") REFERENCES "tasks"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_parent_not_self_check" CHECK ("parent_task_id" IS NULL OR "parent_task_id" <> "id");--> statement-breakpoint
CREATE INDEX "tasks_parent_idx" ON "tasks" ("parent_task_id") WHERE "parent_task_id" IS NOT NULL;--> statement-breakpoint

-- Dependencies: task edges name another task and never the task itself;
-- waiting_on edges name an external party instead.
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_target_check" CHECK (
  ("kind" = 'waiting_on' AND "depends_on_task_id" IS NULL AND "waiting_on_id" IS NOT NULL)
  OR ("kind" <> 'waiting_on' AND "depends_on_task_id" IS NOT NULL AND "depends_on_task_id" <> "task_id")
);--> statement-breakpoint
CREATE UNIQUE INDEX "task_dependencies_waiting_key"
  ON "task_dependencies" ("task_id", "waiting_on_type", "waiting_on_id") WHERE "waiting_on_id" IS NOT NULL;--> statement-breakpoint

-- Ranks are compared bytewise (src/domains/work/rank.ts); keep them to lowercase letters.
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_rank_format_check" CHECK ("rank" ~ '^[a-z]+$');
