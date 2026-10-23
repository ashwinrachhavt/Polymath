import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditEvents } from "@/domains/audit/schema";
import { rewardLedger } from "@/domains/gamification/schema";
import { taskDependencies, tasks } from "@/domains/work/schema";
import { sql } from "drizzle-orm";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * Undo for terminal transitions (Product Spec): reopenTask lands a done or
 * cancelled task back in `ready`, un-settles the blocker edges its
 * completion resolved, and writes its own audit row that carries the status
 * it came from. The row's own status guard is the concurrency primitive:
 * the loser of a race sees no rows and gets `null`.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
let work: typeof import("@/domains/work/commands");
let cmd: typeof import("@/domains/work/task-commands");
let queries: typeof import("@/domains/work/queries");

beforeAll(async () => {
  if (!handle) return;
  db = handle.db;
  work = await import("@/domains/work/commands");
  cmd = await import("@/domains/work/task-commands");
  queries = await import("@/domains/work/queries");
});
afterAll(async () => {
  await handle?.client.end();
});

async function setup(label: string) {
  const { userId, workspaceId } = await seedWorkspace(db, `reopen-${label}-${Date.now()}`);
  return { a: ownerAuth(userId, workspaceId), workspaceId };
}
const key = () => crypto.randomUUID();

suite("reopenTask - undo for terminal transitions", () => {
  it("reopens a completed task and records the previous status", async () => {
    const { a } = await setup("done");
    const { id } = await work.createOwnerTask(a, { title: "Ship the draft" });
    await work.completeTask(a, { taskId: id });
    const result = await work.reopenTask(a, { taskId: id });
    expect(result).toEqual({ id, from: "done" });
    const [row] = await db.select().from(tasks).where(eq(tasks.id, id));
    expect(row.status).toBe("ready");
    expect(row.completedAt).toBeNull();
    const [audit] = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.subjectId, id), eq(auditEvents.action, "task.reopened")));
    expect(audit.metadata).toEqual({ from: "done" });
  });

  it("reopens a cancelled task", async () => {
    const { a } = await setup("cancelled");
    const { id } = await work.createOwnerTask(a, { title: "Obsolete" });
    await cmd.updateTask(a, { taskId: id, expectedVersion: 1, idempotencyKey: key(), patch: { status: "cancelled" } });
    const result = await work.reopenTask(a, { taskId: id });
    expect(result).toEqual({ id, from: "cancelled" });
  });

  it("un-settles the blockers its completion resolved", async () => {
    const { a, workspaceId } = await setup("blockers");
    const { id: blocker } = await work.createOwnerTask(a, { title: "Get approval" });
    const { id: blocked } = await work.createOwnerTask(a, { title: "Send contract" });
    await cmd.addDependency(a, { taskId: blocker, otherTaskId: blocked, kind: "blocks", idempotencyKey: key() });
    await work.completeTask(a, { taskId: blocker });
    expect((await queries.getTaskDetail(a, blocked))?.blockedBy).toHaveLength(0);
    await work.reopenTask(a, { taskId: blocker });
    expect((await queries.getTaskDetail(a, blocked))?.blockedBy).toHaveLength(1);
    const [edge] = await db.select().from(taskDependencies).where(eq(taskDependencies.workspaceId, workspaceId));
    expect(edge.resolvedAt).toBeNull();
  });

  it("refuses a task that is not terminal and records nothing", async () => {
    const { a } = await setup("open");
    const { id } = await work.createOwnerTask(a, { title: "Still open" });
    expect(await work.reopenTask(a, { taskId: id })).toBeNull();
    const audits = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.subjectId, id), eq(auditEvents.action, "task.reopened")));
    expect(audits).toHaveLength(0);
  });

  it("lets exactly one of two concurrent reopens win", async () => {
    const { a } = await setup("race");
    const { id } = await work.createOwnerTask(a, { title: "Race me" });
    await work.completeTask(a, { taskId: id });
    const [x, y] = await Promise.all([work.reopenTask(a, { taskId: id }), work.reopenTask(a, { taskId: id })]);
    expect([x, y].filter(Boolean)).toHaveLength(1);
    const audits = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.subjectId, id), eq(auditEvents.action, "task.reopened")));
    expect(audits).toHaveLength(1);
  });

  it("reopening twice in a row only wins once (stale second click)", async () => {
    const { a } = await setup("double");
    const { id } = await work.createOwnerTask(a, { title: "Click twice" });
    await work.completeTask(a, { taskId: id });
    expect(await work.reopenTask(a, { taskId: id })).not.toBeNull();
    expect(await work.reopenTask(a, { taskId: id })).toBeNull();
  });

  it("keeps edges resolved by another path: only its own terminalization is undone", async () => {
    const { a, workspaceId } = await setup("other-path");
    const { id: blocker } = await work.createOwnerTask(a, { title: "Already done" });
    await work.completeTask(a, { taskId: blocker });
    // Deterministic discrimination without sleeps: the completion reads as
    // 10s old, so the edge linked below (resolved by the pre-done insert
    // rule, not by the completion) lands clearly after the terminal time.
    await db.execute(sql`update tasks set completed_at = now() - interval '10 seconds' where id = ${blocker}`);
    const { id: blocked } = await work.createOwnerTask(a, { title: "Linked later" });
    await cmd.addDependency(a, { taskId: blocker, otherTaskId: blocked, kind: "blocks", idempotencyKey: key() });
    expect((await queries.getTaskDetail(a, blocked))?.blockedBy).toHaveLength(0);
    expect(await work.reopenTask(a, { taskId: blocker })).not.toBeNull();
    const [edge] = await db.select().from(taskDependencies).where(eq(taskDependencies.workspaceId, workspaceId));
    expect(edge.resolvedAt).not.toBeNull();
    expect((await queries.getTaskDetail(a, blocked))?.blockedBy).toHaveLength(0);
  });

  it("re-complete after reopen settles edges once, earns no second stone the same day", async () => {
    const { a, workspaceId } = await setup("recomplete");
    const { id: blocker } = await work.createOwnerTask(a, { title: "Gate" });
    const { id: blocked } = await work.createOwnerTask(a, { title: "Behind the gate" });
    await cmd.addDependency(a, { taskId: blocker, otherTaskId: blocked, kind: "blocks", idempotencyKey: key() });
    const first = await work.completeTask(a, { taskId: blocker });
    expect(first).not.toBeNull();
    const ledgerCount = async () =>
      (await db.select().from(rewardLedger).where(eq(rewardLedger.workspaceId, workspaceId))).length;
    const stonesAfterFirst = await ledgerCount();

    // Reopening itself writes no ledger row: scoped undo, not history edits.
    expect(await work.reopenTask(a, { taskId: blocker })).not.toBeNull();
    expect(await ledgerCount()).toBe(stonesAfterFirst);

    // Re-completing settles the same edges again (once - they are rows, not
    // events) and the daily-stone idempotency key refuses a second award.
    const second = await work.completeTask(a, { taskId: blocker });
    expect(second).not.toBeNull();
    expect(second?.quartzEarned).toBe(false);
    expect(await ledgerCount()).toBe(stonesAfterFirst);
    expect((await queries.getTaskDetail(a, blocked))?.blockedBy).toHaveLength(0);
    const [row] = await db.select().from(tasks).where(eq(tasks.id, blocker));
    expect(row.status).toBe("done");
    expect(row.completedAt).not.toBeNull();
  });

  it("cannot reopen another workspace's task", async () => {
    const one = await setup("t1");
    const two = await setup("t2");
    const { id } = await work.createOwnerTask(two.a, { title: "Theirs" });
    expect(await work.reopenTask(one.a, { taskId: id })).toBeNull();
    const [row] = await db.select().from(tasks).where(eq(tasks.id, id));
    expect(row.status).not.toBe("ready");
  });
});
