import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditEvents } from "@/domains/audit/schema";
import { rewardLedger } from "@/domains/gamification/schema";
import { taskDependencies, tasks } from "@/domains/work/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * Undo for terminal transitions (Product Spec). reopenTask reopens a done or
 * cancelled task into `ready` behind two row-level guards (terminal status +
 * expected version - the version guard is the ABA defense against a stale
 * view undoing a newer transition). Blocker edges un-settle by exact
 * attribution: the terminal audit event names the edges it settled, and only
 * those are undone. The reward ledger is append-only and never touched.
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
const reopenAudits = (id: string) =>
  db.select().from(auditEvents).where(and(eq(auditEvents.subjectId, id), eq(auditEvents.action, "task.reopened")));

suite("reopenTask - undo for terminal transitions", () => {
  it("reopens a completed task and records the previous status and undone edges", async () => {
    const { a } = await setup("done");
    const { id } = await work.createOwnerTask(a, { title: "Ship the draft" });
    await work.completeTask(a, { taskId: id });
    const result = await work.reopenTask(a, { taskId: id, expectedVersion: 2 });
    expect(result).toEqual({ id, from: "done" });
    const [row] = await db.select().from(tasks).where(eq(tasks.id, id));
    expect(row.status).toBe("ready");
    expect(row.completedAt).toBeNull();
    const [audit] = await reopenAudits(id);
    expect(audit.metadata).toMatchObject({ from: "done", unsettledEdgeIds: [] });
  });

  it("reopens a cancelled task, undoing exactly the edges its cancellation settled", async () => {
    const { a, workspaceId } = await setup("cancelled");
    const { id: blocker } = await work.createOwnerTask(a, { title: "Gate" });
    const { id: blocked } = await work.createOwnerTask(a, { title: "Behind" });
    await cmd.addDependency(a, { taskId: blocker, otherTaskId: blocked, kind: "blocks", idempotencyKey: key() });
    await cmd.updateTask(a, { taskId: blocker, expectedVersion: 1, idempotencyKey: key(), patch: { status: "cancelled" } });
    expect((await queries.getTaskDetail(a, blocked))?.blockedBy).toHaveLength(0);
    const result = await work.reopenTask(a, { taskId: blocker, expectedVersion: 2 });
    expect(result).toEqual({ id: blocker, from: "cancelled" });
    expect((await queries.getTaskDetail(a, blocked))?.blockedBy).toHaveLength(1);
    const [edge] = await db.select().from(taskDependencies).where(eq(taskDependencies.workspaceId, workspaceId));
    expect(edge.resolvedAt).toBeNull();
  });

  it("exact attribution: an edge resolved another way is never undone", async () => {
    const { a, workspaceId } = await setup("other-path");
    const { id: blocker } = await work.createOwnerTask(a, { title: "Already done" });
    await work.completeTask(a, { taskId: blocker });
    // Linked AFTER the completion: resolved by the pre-done insert rule, not
    // by the completion, so the completion's audit row never named it.
    const { id: blocked } = await work.createOwnerTask(a, { title: "Linked later" });
    await cmd.addDependency(a, { taskId: blocker, otherTaskId: blocked, kind: "blocks", idempotencyKey: key() });
    expect((await queries.getTaskDetail(a, blocked))?.blockedBy).toHaveLength(0);
    expect(await work.reopenTask(a, { taskId: blocker, expectedVersion: 2 })).toEqual({ id: blocker, from: "done" });
    const [edge] = await db.select().from(taskDependencies).where(eq(taskDependencies.workspaceId, workspaceId));
    expect(edge.resolvedAt).not.toBeNull();
    expect((await queries.getTaskDetail(a, blocked))?.blockedBy).toHaveLength(0);
    const [audit] = await reopenAudits(blocker);
    expect(audit.metadata).toMatchObject({ unsettledEdgeIds: [] });
  });

  it("un-settles only the edges the latest terminal transition settled", async () => {
    const { a, workspaceId } = await setup("mixed");
    const { id: blocker } = await work.createOwnerTask(a, { title: "Gate" });
    const { id: early } = await work.createOwnerTask(a, { title: "Early edge" });
    await cmd.addDependency(a, { taskId: blocker, otherTaskId: early, kind: "blocks", idempotencyKey: key() });
    await work.completeTask(a, { taskId: blocker }); // settles the early edge
    const { id: late } = await work.createOwnerTask(a, { title: "Late edge" });
    await cmd.addDependency(a, { taskId: blocker, otherTaskId: late, kind: "blocks", idempotencyKey: key() }); // resolved by insert rule
    expect(await work.reopenTask(a, { taskId: blocker, expectedVersion: 2 })).toEqual({ id: blocker, from: "done" });
    expect((await queries.getTaskDetail(a, early))?.blockedBy).toHaveLength(1); // un-settled
    expect((await queries.getTaskDetail(a, late))?.blockedBy).toHaveLength(0); // untouched
    const edges = await db.select().from(taskDependencies).where(eq(taskDependencies.workspaceId, workspaceId));
    expect(edges.filter((e) => e.resolvedAt === null)).toHaveLength(1);
  });

  it("re-saving a done task does not clobber the completion's attribution", async () => {
    const { a } = await setup("resave");
    const { id: blocker } = await work.createOwnerTask(a, { title: "Gate" });
    const { id: blocked } = await work.createOwnerTask(a, { title: "Behind" });
    await cmd.addDependency(a, { taskId: blocker, otherTaskId: blocked, kind: "blocks", idempotencyKey: key() });
    await work.completeTask(a, { taskId: blocker }); // v2, settles and names the edge
    // The detail form always sends its status: editing a done task's title
    // re-sends status "done". That re-save is not a transition and must not
    // overwrite the attribution with an empty set.
    await cmd.updateTask(a, { taskId: blocker, expectedVersion: 2, idempotencyKey: key(), patch: { title: "Gate (renamed)", status: "done" } });
    expect(await work.reopenTask(a, { taskId: blocker, expectedVersion: 3 })).toEqual({ id: blocker, from: "done" });
    expect((await queries.getTaskDetail(a, blocked))?.blockedBy).toHaveLength(1);
  });

  it("ABA: a stale view cannot undo a newer reopen-and-recomplete", async () => {
    const { a } = await setup("aba");
    const { id: blocker } = await work.createOwnerTask(a, { title: "Gate" });
    const { id: blocked } = await work.createOwnerTask(a, { title: "Behind" });
    await cmd.addDependency(a, { taskId: blocker, otherTaskId: blocked, kind: "blocks", idempotencyKey: key() });
    await work.completeTask(a, { taskId: blocker }); // v2; a stale screen captured version 2 here
    await work.reopenTask(a, { taskId: blocker, expectedVersion: 2 }); // v3
    await work.completeTask(a, { taskId: blocker }); // v4 - a NEWER terminal transition
    // The stale screen's click arrives now, still carrying version 2.
    expect(await work.reopenTask(a, { taskId: blocker, expectedVersion: 2 })).toBe("stale");
    const [row] = await db.select().from(tasks).where(eq(tasks.id, blocker));
    expect(row.status).toBe("done");
    expect((await queries.getTaskDetail(a, blocked))?.blockedBy).toHaveLength(0);
    expect(await reopenAudits(blocker)).toHaveLength(1); // only the first, live reopen
  });

  it("refuses a task that is not terminal and records nothing", async () => {
    const { a } = await setup("open");
    const { id } = await work.createOwnerTask(a, { title: "Still open" });
    expect(await work.reopenTask(a, { taskId: id, expectedVersion: 1 })).toBe("not_terminal");
    expect(await reopenAudits(id)).toHaveLength(0);
  });

  it("lets exactly one of two concurrent reopens win; the loser reads stale", async () => {
    const { a } = await setup("race");
    const { id } = await work.createOwnerTask(a, { title: "Race me" });
    await work.completeTask(a, { taskId: id });
    const [x, y] = await Promise.all([
      work.reopenTask(a, { taskId: id, expectedVersion: 2 }),
      work.reopenTask(a, { taskId: id, expectedVersion: 2 }),
    ]);
    expect([x, y].filter((r) => typeof r === "object" && r !== null)).toHaveLength(1);
    // The loser refuses honestly either way the statements interleave:
    // "stale" if its guarded UPDATE lost the row lock, "not_terminal" if its
    // read already saw the winner's committed reopen.
    expect([x, y].filter((r) => r === "stale" || r === "not_terminal")).toHaveLength(1);
    expect(await reopenAudits(id)).toHaveLength(1);
  });

  it("cannot reopen another workspace's task", async () => {
    const one = await setup("t1");
    const two = await setup("t2");
    const { id } = await work.createOwnerTask(two.a, { title: "Theirs" });
    expect(await work.reopenTask(one.a, { taskId: id, expectedVersion: 1 })).toBeNull();
    const [row] = await db.select().from(tasks).where(eq(tasks.id, id));
    expect(row.status).not.toBe("ready");
  });

  it("re-complete after reopen settles edges once and earns no second stone the same day", async () => {
    const { a, workspaceId } = await setup("recomplete");
    const { id: blocker } = await work.createOwnerTask(a, { title: "Gate" });
    const { id: blocked } = await work.createOwnerTask(a, { title: "Behind" });
    await cmd.addDependency(a, { taskId: blocker, otherTaskId: blocked, kind: "blocks", idempotencyKey: key() });
    const first = await work.completeTask(a, { taskId: blocker });
    expect(first?.quartzEarned).toBe(true);
    const ledgerCount = async () =>
      (await db.select().from(rewardLedger).where(eq(rewardLedger.workspaceId, workspaceId))).length;
    const stonesAfterFirst = await ledgerCount();
    expect(stonesAfterFirst).toBe(1);

    // Reopening itself writes no ledger row: scoped undo, not history edits.
    expect(await work.reopenTask(a, { taskId: blocker, expectedVersion: 2 })).toEqual({ id: blocker, from: "done" });
    expect(await ledgerCount()).toBe(stonesAfterFirst);

    const second = await work.completeTask(a, { taskId: blocker });
    expect(second?.quartzEarned).toBe(false); // quartz:YYYY-MM-DD key already spent today
    expect(await ledgerCount()).toBe(stonesAfterFirst);
    expect((await queries.getTaskDetail(a, blocked))?.blockedBy).toHaveLength(0);
    const [row] = await db.select().from(tasks).where(eq(tasks.id, blocker));
    expect(row.status).toBe("done");
    expect(row.completedAt).not.toBeNull();
  });

  it("next-day semantics: a re-completion on a later day earns that day's first stone", async () => {
    const { a, workspaceId } = await setup("nextday");
    const { id } = await work.createOwnerTask(a, { title: "Daily" });
    const first = await work.completeTask(a, { taskId: id });
    expect(first?.quartzEarned).toBe(true);
    // Simulate the first stone having been earned on an earlier day: the
    // daily idempotency key is quartz:YYYY-MM-DD, so rename it to a past day.
    await db.update(rewardLedger).set({ idempotencyKey: "quartz:2000-01-01" }).where(eq(rewardLedger.workspaceId, workspaceId));
    await work.reopenTask(a, { taskId: id, expectedVersion: 2 });
    const second = await work.completeTask(a, { taskId: id });
    // The stone belongs to the DAY's first completion, not the task's first
    // ever completion - a re-completed task is a genuine completion that day,
    // exactly as completing any other task would be.
    expect(second?.quartzEarned).toBe(true);
    const stones = await db.select().from(rewardLedger).where(eq(rewardLedger.workspaceId, workspaceId));
    expect(stones).toHaveLength(2);
  });
});
