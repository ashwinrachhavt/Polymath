import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  check,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import {
  linkTargetKind,
  linkTargetKindCheck,
  mutable,
  primaryId,
  recorded,
  tenantId,
} from "../../db/columns";

/*
 * One task model, many views. Boards and saved views are projections and own
 * no tasks; a second task universe behind a prettier screen is the failure
 * mode this schema exists to prevent.
 *
 * Ordering is by fractional rank (text), so a drag writes one row rather than
 * renumbering a column.
 */

export const projectPhase = pgEnum("project_phase", [
  "proposed",
  "active",
  "paused",
  "completed",
  "abandoned",
]);
export const taskStatus = pgEnum("task_status", [
  "inbox",
  "backlog",
  "ready",
  "in_progress",
  "waiting",
  "done",
  "cancelled",
]);
export const taskPriority = pgEnum("task_priority", ["none", "low", "medium", "high", "urgent"]);
export const dependencyKind = pgEnum("dependency_kind", ["blocks", "blocked_by", "waiting_on"]);

export const spaces = pgTable(
  "spaces",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    name: text("name").notNull(),
    /** Organizational grouping: area of life or work, not an outcome. */
    description: text("description"),
    color: text("color"),
    rank: text("rank").notNull().default("m"),
    ...mutable,
  },
  (t) => [uniqueIndex("spaces_workspace_name_key").on(t.workspaceId, t.name)],
);

export const projects = pgTable(
  "projects",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    spaceId: uuid("space_id").references(() => spaces.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    /** Projects are outcome-oriented; this is the outcome, stated once. */
    intendedOutcome: text("intended_outcome"),
    description: text("description"),
    phase: projectPhase("phase").notNull().default("proposed"),
    /** [{ title, dueAt, doneAt }] — milestones are listed, not queried. */
    milestones: jsonb("milestones").notNull().default([]),
    assumptions: jsonb("assumptions").notNull().default([]),
    risks: jsonb("risks").notNull().default([]),
    completionCriteria: text("completion_criteria"),
    nextReviewAt: timestamp("next_review_at", { withTimezone: true }),
    targetDate: date("target_date"),
    ...mutable,
  },
  (t) => [
    index("projects_workspace_phase_idx").on(t.workspaceId, t.phase),
    index("projects_space_idx").on(t.spaceId),
  ],
);

/*
 * Recurrences are templates, never tasks. Completing an instance generates the
 * next one and records which template produced it, so a recurring chore cannot
 * masquerade as a project or duplicate itself on retry.
 */

export const tasks = pgTable(
  "tasks",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    spaceId: uuid("space_id").references(() => spaces.id, { onDelete: "set null" }),
    parentTaskId: uuid("parent_task_id").references((): AnyPgColumn => tasks.id, { onDelete: "set null" }),
    /** Legacy column: its recurrence_templates FK was dropped with that dead table. */
    recurrenceTemplateId: uuid("recurrence_template_id"),
    title: text("title").notNull(),
    description: text("description"),
    status: taskStatus("status").notNull().default("inbox"),
    priority: taskPriority("priority").notNull().default("none"),
    /** Fractional rank for list and board order; a drag writes one row. */
    rank: text("rank").notNull().default("m"),
    plannedStartAt: timestamp("planned_start_at", { withTimezone: true }),
    plannedEndAt: timestamp("planned_end_at", { withTimezone: true }),
    dueAt: timestamp("due_at", { withTimezone: true }),
    /** Minutes. Estimation is advisory; nothing schedules from it automatically. */
    estimateMinutes: integer("estimate_minutes"),
    tags: jsonb("tags").notNull().default([]),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    /** Set when the task is waiting on an external action proposal. */
    actionProposalId: uuid("action_proposal_id"),
    ...mutable,
  },
  (t) => [
    index("tasks_workspace_status_idx").on(t.workspaceId, t.status, t.rank),
    index("tasks_workspace_due_idx").on(t.workspaceId, t.dueAt).where(sql`status not in ('done', 'cancelled')`),
    index("tasks_project_idx").on(t.projectId),
    index("tasks_space_idx").on(t.spaceId),
    index("tasks_recurrence_template_idx").on(t.recurrenceTemplateId),
    index("tasks_parent_idx").on(t.parentTaskId).where(sql`parent_task_id is not null`),
    check("tasks_parent_not_self_check", sql`parent_task_id is null or parent_task_id <> id`),
    check("tasks_rank_format_check", sql`rank ~ '^[a-z]+$'`),
  ],
);

/*
 * One edge per pair. `blocks` and `blocked_by` are the same relationship read
 * from either end, so a cycle check runs before insert; `waiting_on` points at
 * a person or company instead of a task.
 */
export const taskDependencies = pgTable(
  "task_dependencies",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    kind: dependencyKind("kind").notNull(),
    dependsOnTaskId: uuid("depends_on_task_id").references(() => tasks.id, { onDelete: "cascade" }),
    /** For `waiting_on`: the contact or company being waited on. */
    waitingOnType: text("waiting_on_type"),
    waitingOnId: uuid("waiting_on_id"),
    note: text("note"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    ...mutable,
  },
  (t) => [
    uniqueIndex("task_dependencies_edge_key")
      .on(t.taskId, t.kind, t.dependsOnTaskId)
      .where(sql`depends_on_task_id is not null`),
    uniqueIndex("task_dependencies_waiting_key")
      .on(t.taskId, t.waitingOnType, t.waitingOnId)
      .where(sql`waiting_on_id is not null`),
    check(
      "task_dependencies_target_check",
      sql`(kind = 'waiting_on' and depends_on_task_id is null and waiting_on_id is not null)
        or (kind <> 'waiting_on' and depends_on_task_id is not null and depends_on_task_id <> task_id)`,
    ),
    index("task_dependencies_task_idx").on(t.taskId),
    index("task_dependencies_reverse_idx").on(t.dependsOnTaskId),
  ],
);

/*
 * A constrained generic link table (ASH-107, R21). The target kind is checked
 * against the shared list in `db/columns.ts` rather than free text, and there
 * is no foreign key on `targetId` — a polymorphic FK is not expressible, so
 * the check constraint stops a typo from inventing a new record kind and the
 * owning row's existence is the writing service's job.
 */
export const taskLinks = pgTable(
  "task_links",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    targetType: linkTargetKind(),
    targetId: uuid("target_id").notNull(),
    label: text("label"),
    ...recorded,
  },
  (t) => [
    uniqueIndex("task_links_edge_key").on(t.taskId, t.targetType, t.targetId),
    index("task_links_target_idx").on(t.workspaceId, t.targetType, t.targetId),
    linkTargetKindCheck("task_links_target_type_check"),
  ],
);

export const boards = pgTable(
  "boards",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    /** Null means the board spans every project in the workspace. */
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** Column grouping, e.g. "status" or "priority". */
    groupBy: text("group_by").notNull().default("status"),
    ...mutable,
  },
  (t) => [
    uniqueIndex("boards_workspace_name_key").on(t.workspaceId, t.name),
    index("boards_project_idx").on(t.projectId),
  ],
);



/*
 * ASH-305: tomorrow's briefing seed. The shutdown ritual's suggestion that a
 * task lead the next day's "suggested" list. It is NOT a commitment: a task
 * is committed for a day by its own status (ready or in progress), never by
 * a row here, and nothing is written from this table back onto the task. A
 * seed lives only as long as its task (cascade, so no orphan rows to guard
 * against), is idempotent per (day, task), and is dismissed by archiving the
 * row, never by deleting it, so a replayed shutdown cannot resurrect a seed
 * the owner dismissed (the unique key still holds).
 */
export const briefingSeeds = pgTable(
  "briefing_seeds",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    /** Workspace-local date the seed is for (the briefing's own day key). */
    onDate: date("on_date").notNull(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    /** Why it was suggested, in the owner's or the ritual's plain words. */
    reason: text("reason"),
    ...mutable,
  },
  (t) => [
    uniqueIndex("briefing_seeds_day_task_key").on(t.workspaceId, t.onDate, t.taskId),
    index("briefing_seeds_day_idx").on(t.workspaceId, t.onDate),
  ],
);
