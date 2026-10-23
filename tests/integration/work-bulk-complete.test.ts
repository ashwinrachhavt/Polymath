import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditEvents } from "@/domains/audit/schema";
import { tasks } from "@/domains/work/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * Bulk edit (Product Spec: "bulk edit") composes over the single-task
 * command: every guard, audit row and Quartz rule still applies per item,
 * and an id that no longer qualifies is named as skipped - never rolled
 * back into, and never silently absorbed by, the ones that completed. Real
 * Postgres, because the status and tenant guards live in the WHERE clause.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
let work: typeof import("@/domains/work/commands");

beforeAll(async () => {
  if (!handle) return;
  ({ db } = handle);
  work = await import("@/domains/work/commands");
});

afterAll(async () => {
  await handle?.client.end();
});

suite("bulk complete", () => {
  it("completes each open task with its own audit row and names the rest as skipped", async () => {
    const { userId, workspaceId } = await seedWorkspace(db, `bulk-mix-${Date.now()}`);
    const a = ownerAuth(userId, workspaceId);
    const one = (await work.createOwnerTask(a, { title: "One" })).id;
    const two = (await work.createOwnerTask(a, { title: "Two" })).id;
    const doneAlready = (await work.createOwnerTask(a, { title: "Done already" })).id;
    await work.completeTask(a, { taskId: doneAlready });

    const other = await seedWorkspace(db, `bulk-other-${Date.now()}`);
    const foreign = (await work.createOwnerTask(ownerAuth(other.userId, other.workspaceId), { title: "Not yours" })).id;

    const outcome = await work.completeTasks(a, [one, doneAlready, foreign, two]);
    expect(outcome.completed).toEqual([one, two]);
    expect(outcome.skipped).toEqual([doneAlready, foreign]);
    // The day's Quartz went to the earlier single completion, so the batch
    // earns nothing - the Quartz rule is per item, not per batch.
    expect(outcome.quartzEarned).toBe(false);

    const rows = await db
      .select({ id: tasks.id, status: tasks.status, completedAt: tasks.completedAt })
      .from(tasks)
      .where(inArray(tasks.id, [one, two, doneAlready, foreign]));
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get(one)?.status).toBe("done");
    expect(byId.get(one)?.completedAt).not.toBeNull();
    expect(byId.get(two)?.status).toBe("done");
    // The tenant guard held: the other workspace's task is untouched.
    expect(byId.get(foreign)?.status).toBe("inbox");
    expect(byId.get(foreign)?.completedAt).toBeNull();

    const completions = await db
      .select({ subjectId: auditEvents.subjectId })
      .from(auditEvents)
      .where(and(eq(auditEvents.workspaceId, workspaceId), eq(auditEvents.action, "task.completed")));
    const completedSubjects = completions.map((row) => row.subjectId);
    expect(completedSubjects).toEqual(expect.arrayContaining([one, two, doneAlready]));
    // One audit row per completion - the batch adds exactly one per item,
    // and the already-done task keeps its single original row.
    expect(completedSubjects.filter((id) => id === doneAlready)).toHaveLength(1);
    expect(completedSubjects).not.toContain(foreign);
  });

  it("two concurrent completes of the same task write one completion, not two", async () => {
    const { userId, workspaceId } = await seedWorkspace(db, `bulk-race-${Date.now()}`);
    const a = ownerAuth(userId, workspaceId);
    const id = (await work.createOwnerTask(a, { title: "Race me" })).id;

    // The guard lives in the UPDATE's WHERE clause: the loser blocks on the
    // row lock, re-evaluates the predicate against the winner's committed
    // state, and matches nothing. One row, one audit, one completion - never
    // a double write or a second Quartz check.
    const [first, second] = await Promise.all([
      work.completeTasks(a, [id]),
      work.completeTasks(a, [id]),
    ]);
    expect(first.completed.length + second.completed.length).toBe(1);
    expect(first.skipped.length + second.skipped.length).toBe(1);
    expect(first.unknown).toEqual([]);
    expect(second.unknown).toEqual([]);

    const completions = await db
      .select({ id: auditEvents.id })
      .from(auditEvents)
      .where(and(eq(auditEvents.subjectId, id), eq(auditEvents.action, "task.completed")));
    expect(completions).toHaveLength(1);
  });

  it("an unexpected error lands in unknown, keeps the completed prefix, and stops the batch", async () => {
    const { userId, workspaceId } = await seedWorkspace(db, `bulk-error-${Date.now()}`);
    const a = ownerAuth(userId, workspaceId);
    const one = (await work.createOwnerTask(a, { title: "Before the error" })).id;
    const two = (await work.createOwnerTask(a, { title: "After the error" })).id;
    // A malformed uuid makes Postgres raise inside the write - an unexpected
    // error, distinct from a guard no-op. Its true state is "unknown", the
    // completed prefix stays reported, and the task after it is never tried.
    const outcome = await work.completeTasks(a, [one, "not-a-uuid", two]);
    expect(outcome.completed).toEqual([one]);
    expect(outcome.skipped).toEqual([]);
    expect(outcome.unknown).toEqual(["not-a-uuid"]);

    const [after] = await db.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, two));
    expect(after.status).toBe("inbox");
  });

  it("earns the daily Quartz on the batch's first completion", async () => {
    const { userId, workspaceId } = await seedWorkspace(db, `bulk-quartz-${Date.now()}`);
    const a = ownerAuth(userId, workspaceId);
    const one = (await work.createOwnerTask(a, { title: "First" })).id;
    const two = (await work.createOwnerTask(a, { title: "Second" })).id;

    const outcome = await work.completeTasks(a, [one, two]);
    expect(outcome.completed).toEqual([one, two]);
    expect(outcome.skipped).toEqual([]);
    expect(outcome.quartzEarned).toBe(true);
  });

  it("reports every id as skipped when nothing qualifies and writes no completion audit", async () => {
    const { userId, workspaceId } = await seedWorkspace(db, `bulk-none-${Date.now()}`);
    const a = ownerAuth(userId, workspaceId);
    const cancelled = (await work.createOwnerTask(a, { title: "Dropped" })).id;
    await db.update(tasks).set({ status: "cancelled", cancelledAt: new Date() }).where(eq(tasks.id, cancelled));
    const missing = crypto.randomUUID();

    const outcome = await work.completeTasks(a, [cancelled, missing]);
    expect(outcome.completed).toEqual([]);
    expect(outcome.skipped).toEqual([cancelled, missing]);
    expect(outcome.quartzEarned).toBe(false);

    const completions = await db
      .select({ id: auditEvents.id })
      .from(auditEvents)
      .where(and(eq(auditEvents.workspaceId, workspaceId), eq(auditEvents.action, "task.completed")));
    expect(completions).toHaveLength(0);
  });
});
