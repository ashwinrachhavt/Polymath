import type { Recurrence, Task, TaskStatus } from "./types";

/*
 * Canonical task rules. Shared by all three product lenses so ranking,
 * recurrence and ordering cannot diverge between Work, Boards, Calendar and
 * the Command Center queue. Pure functions only: no React, no storage.
 */

export const taskStatuses: TaskStatus[] = ["INBOX", "BACKLOG", "READY", "IN_PROGRESS", "WAITING", "DONE"];
export const statusLabels: Record<TaskStatus, string> = { INBOX: "Inbox", BACKLOG: "Backlog", READY: "Ready", IN_PROGRESS: "In progress", WAITING: "Waiting", DONE: "Done" };

export const priorityRank: Record<Task["priority"], number> = { High: 0, Medium: 1, Low: 2 };
export const recurrenceFrequencies: Recurrence["frequency"][] = ["daily", "weekly", "monthly"];
export const recurringStatuses: TaskStatus[] = ["INBOX", "BACKLOG", "READY", "IN_PROGRESS", "WAITING"];
export const attachmentKinds: NonNullable<Task["attachments"]>[number]["kind"][] = ["file", "url", "note"];

/*
 * Manual order. Rank is only meaningful inside a status column, which is what
 * a board lane is. A task with no rank sorts after every ranked task and then
 * by the deterministic fallback, so imported or legacy rows never jump the
 * queue and the list never reorders itself between renders.
 */
export function nextRank(tasks: Task[], status: TaskStatus) {
  const ranks = tasks.filter((task) => task.status === status && typeof task.rank === "number").map((task) => task.rank as number);
  return ranks.length ? Math.max(...ranks) + 1 : 1;
}

export function compareTasks(a: Task, b: Task) {
  const ranked = a.rank !== undefined && b.rank !== undefined;
  if (ranked && a.rank !== b.rank) return (a.rank as number) - (b.rank as number);
  if (a.rank !== undefined !== (b.rank !== undefined)) return a.rank !== undefined ? -1 : 1;
  return priorityRank[a.priority] - priorityRank[b.priority] || (a.dueDate || "9999").localeCompare(b.dueDate || "9999") || a.title.localeCompare(b.title);
}

/*
 * Drop `id` at `index` within its status column and return only the rows whose
 * rank changed, renumbered from 1. Returning a delta rather than the whole
 * column keeps the caller's transaction narrow and the audit entry readable.
 */
export function reorderTasks(tasks: Task[], id: string, status: TaskStatus, index: number) {
  const column = tasks.filter((task) => task.status === status).sort(compareTasks);
  const from = column.findIndex((task) => task.id === id);
  if (from === -1) return [];
  const target = Math.max(0, Math.min(index, column.length - 1));
  if (from === target) return [];
  const [moved] = column.splice(from, 1);
  column.splice(target, 0, moved);
  return column.reduce<{ id: string; rank: number }[]>((changed, task, position) => {
    const rank = position + 1;
    if (task.rank !== rank) changed.push({ id: task.id, rank });
    return changed;
  }, []);
}

/*
 * Local date arithmetic, not UTC. A date string is a calendar date the owner
 * typed, so month-end clamping happens on the parsed local date.
 */
export function advanceRecurrence(date: string, recurrence: Recurrence, completedAt = new Date()) {
  const parsed = new Date(`${date}T12:00:00`);
  const step = Math.max(1, Math.trunc(recurrence.interval) || 1);
  if (recurrence.frequency === "daily") parsed.setDate(parsed.getDate() + step);
  else if (recurrence.frequency === "weekly") parsed.setDate(parsed.getDate() + step * 7);
  else {
    const day = parsed.getDate();
    parsed.setDate(1);
    parsed.setMonth(parsed.getMonth() + step);
    const lastDay = new Date(parsed.getFullYear(), parsed.getMonth() + 1, 0).getDate();
    parsed.setDate(Math.min(day, lastDay));
  }
  const next = `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, "0")}-${String(parsed.getDate()).padStart(2, "0")}`;
  if (recurrence.count !== undefined && recurrence.count <= 1) return undefined;
  if (recurrence.until && next > recurrence.until) return undefined;
  // A rule whose next date is in the past (a schedule that was missed for
  // several periods) rolls forward instead of emitting a run of stale dates.
  const today = `${completedAt.getFullYear()}-${String(completedAt.getMonth() + 1).padStart(2, "0")}-${String(completedAt.getDate()).padStart(2, "0")}`;
  if (next < today) return advanceRecurrence(today, recurrence, completedAt);
  return next;
}

export function recurrenceLabel(recurrence: Recurrence) {
  const every = Math.max(1, Math.trunc(recurrence.interval) || 1);
  const unit = recurrence.frequency === "daily" ? "day" : recurrence.frequency === "weekly" ? "week" : "month";
  const base = every === 1 ? `Every ${unit}` : `Every ${every} ${unit}s`;
  return recurrence.until ? `${base} until ${recurrence.until}` : base;
}

/*
 * Completing a task. A recurring task keeps its status and moves to its next
 * date; a one-off closes. Returns the patch so the store records one audited
 * change rather than two that could interleave.
 */
export function completionPatch(task: Task, completedAt = new Date()): Partial<Task> {
  if (!task.recurrence) return { status: "DONE", completedAt: completedAt.toISOString() };
  const next = advanceRecurrence(task.dueDate || "", task.recurrence, completedAt);
  if (!next) return { status: "DONE", completedAt: completedAt.toISOString(), recurrence: undefined };
  return { status: task.status === "IN_PROGRESS" ? "READY" : task.status, dueDate: next, completedAt: completedAt.toISOString(), completionCount: (task.completionCount || 0) + 1 };
}

export function isRecurring(task: Task) { return Boolean(task.recurrence); }

export function matchesTask(task: Task, query: string) {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [task.title, task.description, task.tags.join(" "), task.dueDate || "", task.status, task.priority, ...(task.attachments || []).map((attachment) => attachment.label)]
    .join(" ")
    .toLowerCase()
    .includes(needle);
}
