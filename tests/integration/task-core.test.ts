import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditEvents, outboxEvents, requestReceipts } from "@/domains/audit/schema";
import { people } from "@/domains/identity/schema";
import { artifactVersions, artifacts } from "@/domains/knowledge/schema";
import { taskDependencies, tasks } from "@/domains/work/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * A03 task core against real Postgres: version compare-and-set, idempotency
 * receipts, audit + outbox atomicity, subtasks, dependencies (cycles, both
 * orientations, auto-resolve on completion), and rank moves.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
let work: typeof import("@/domains/work/commands");
let cmd: typeof import("@/domains/work/task-commands");
let queries: typeof import("@/domains/work/queries");
let receipt: typeof import("@/domains/audit/receipt");

beforeAll(async () => {
  if (!handle) return;
  ({ db } = handle);
  work = await import("@/domains/work/commands");
  cmd = await import("@/domains/work/task-commands");
  queries = await import("@/domains/work/queries");
  receipt = await import("@/domains/audit/receipt");
});
afterAll(async () => {
  await handle?.client.end();
});

async function setup(label: string) {
  const { userId, workspaceId } = await seedWorkspace(db, `core-${label}-${Date.now()}`);
  return { a: ownerAuth(userId, workspaceId), workspaceId };
}
const key = () => crypto.randomUUID();
const version = async (id: string) => (await db.select({ v: tasks.version }).from(tasks).where(eq(tasks.id, id)))[0].v;

/**
 * A task inserted by hand, with the note every read joins on. Used where the
 * fixture needs a state the create command will not produce - a shared legacy
 * rank, for instance - so it writes the note itself rather than calling the
 * production writer under test.
 */
async function seedTask(workspaceId: string, title: string, rank: string) {
  const [note] = await db
    .insert(artifacts)
    .values({ workspaceId, kind: "note", title, template: "issue" })
    .returning({ id: artifacts.id });
  const [v] = await db
    .insert(artifactVersions)
    .values({ workspaceId, artifactId: note.id, versionNumber: 1, content: { type: "doc", content: [] }, reason: "created" })
    .returning({ id: artifactVersions.id });
  await db.update(artifacts).set({ currentVersionId: v.id }).where(eq(artifacts.id, note.id));
  const [row] = await db
    .insert(tasks)
    .values({ workspaceId, noteId: note.id, title, rank })
    .returning({ id: tasks.id });
  return row.id;
}

suite("task update: compare-and-set, receipts, audit, outbox", () => {
  it("applies a patch, bumps the version, writes one audit and one outbox row", async () => {
    const { a, workspaceId } = await setup("patch");
    const { id } = await work.createOwnerTask(a, { title: "Draft the memo" });
    const out = await cmd.updateTask(a, {
      taskId: id, expectedVersion: 1, idempotencyKey: key(),
      patch: { title: "Draft the board memo", priority: "high", status: "in_progress", tags: ["board"] },
    });
    expect(out).toEqual({ id, version: 2 });
    const [row] = await db.select().from(tasks).where(eq(tasks.id, id));
    expect(row).toMatchObject({ title: "Draft the board memo", priority: "high", status: "in_progress", version: 2 });
    const audits = await db.select().from(auditEvents).where(and(eq(auditEvents.subjectId, id), eq(auditEvents.action, "task.updated")));
    expect(audits).toHaveLength(1);
    const outbox = await db.select().from(outboxEvents).where(eq(outboxEvents.workspaceId, workspaceId));
    expect(outbox.filter((o) => o.topic === "task.updated")).toHaveLength(1);
  });

  it("refuses a stale version and leaves the row, audit, and outbox untouched", async () => {
    const { a, workspaceId } = await setup("stale");
    const { id } = await work.createOwnerTask(a, { title: "Book flights" });
    await cmd.updateTask(a, { taskId: id, expectedVersion: 1, idempotencyKey: key(), patch: { priority: "low" } });
    await expect(
      cmd.updateTask(a, { taskId: id, expectedVersion: 1, idempotencyKey: key(), patch: { priority: "urgent" } }),
    ).rejects.toBeInstanceOf(cmd.VersionConflictError);
    const [row] = await db.select().from(tasks).where(eq(tasks.id, id));
    expect(row.priority).toBe("low");
    const outbox = await db.select().from(outboxEvents).where(eq(outboxEvents.workspaceId, workspaceId));
    // The create also emits note.created, and the first update emitted
    // task.updated; the refused second update must add nothing.
    expect(outbox.filter((o) => o.topic === "task.updated")).toHaveLength(1);
    expect(outbox.filter((o) => o.topic === "note.created")).toHaveLength(1);
  });

  it("replays the same key without a second change, and rejects the key reused for a different request", async () => {
    const { a, workspaceId } = await setup("idem");
    const { id } = await work.createOwnerTask(a, { title: "Pay invoice" });
    const k = key();
    const first = await cmd.updateTask(a, { taskId: id, expectedVersion: 1, idempotencyKey: k, patch: { priority: "high" } });
    const again = await cmd.updateTask(a, { taskId: id, expectedVersion: 1, idempotencyKey: k, patch: { priority: "high" } });
    expect(again).toEqual(first);
    expect(await version(id)).toBe(2);
    await expect(
      cmd.updateTask(a, { taskId: id, expectedVersion: 1, idempotencyKey: k, patch: { priority: "low" } }),
    ).rejects.toBeInstanceOf(receipt.IdempotencyConflictError);
    const receipts = await db.select().from(requestReceipts).where(eq(requestReceipts.workspaceId, workspaceId));
    expect(receipts).toHaveLength(1);
  });

  it("two concurrent attempts with one key apply once", async () => {
    const { a } = await setup("race");
    const { id } = await work.createOwnerTask(a, { title: "Renew passport" });
    const k = key();
    const call = () => cmd.updateTask(a, { taskId: id, expectedVersion: 1, idempotencyKey: k, patch: { title: "Renew passport now" } });
    const [x, y] = await Promise.all([call(), call()]);
    expect(x).toEqual(y);
    expect(await version(id)).toBe(2);
  });

  it("two concurrent edits with different keys: one wins, one conflicts", async () => {
    const { a } = await setup("cas");
    const { id } = await work.createOwnerTask(a, { title: "Plan offsite" });
    const edit = (priority: "low" | "high") =>
      cmd.updateTask(a, { taskId: id, expectedVersion: 1, idempotencyKey: key(), patch: { priority } });
    const results = await Promise.allSettled([edit("low"), edit("high")]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(await version(id)).toBe(2);
  });

  it("cannot touch a task in another workspace", async () => {
    const one = await setup("tenant-a");
    const two = await setup("tenant-b");
    const { id } = await work.createOwnerTask(one.a, { title: "Private" });
    await expect(
      cmd.updateTask(two.a, { taskId: id, expectedVersion: 1, idempotencyKey: key(), patch: { title: "Hijacked" } }),
    ).rejects.toBeInstanceOf(cmd.TaskNotFoundError);
    const [row] = await db.select().from(tasks).where(eq(tasks.id, id));
    expect(row.title).toBe("Private");
  });

  it("a failed command leaves no receipt, so the same key can be retried after fixing the input", async () => {
    const { a, workspaceId } = await setup("retry");
    const { id } = await work.createOwnerTask(a, { title: "Retry me" });
    const k = key();
    await expect(
      cmd.updateTask(a, { taskId: id, expectedVersion: 99, idempotencyKey: k, patch: { priority: "low" } }),
    ).rejects.toBeInstanceOf(cmd.VersionConflictError);
    expect(await db.select().from(requestReceipts).where(eq(requestReceipts.workspaceId, workspaceId))).toHaveLength(0);
    await expect(cmd.updateTask(a, { taskId: id, expectedVersion: 1, idempotencyKey: k, patch: { priority: "low" } })).resolves.toMatchObject({ version: 2 });
  });
});

suite("subtasks", () => {
  it("creates ranked subtasks that inherit the parent's project, one level only", async () => {
    const { a } = await setup("sub");
    const { id: parent } = await work.createOwnerTask(a, { title: "Launch" });
    const s1 = await cmd.createSubtask(a, { parentTaskId: parent, title: "Write copy", idempotencyKey: key() });
    const s2 = await cmd.createSubtask(a, { parentTaskId: parent, title: "Ship page", idempotencyKey: key() });
    const detail = await queries.getTaskDetail(a, parent);
    expect(detail?.subtasks.map((s) => s.id)).toEqual([s1.id, s2.id]);
    await expect(
      cmd.createSubtask(a, { parentTaskId: s1.id, title: "Too deep", idempotencyKey: key() }),
    ).rejects.toBeInstanceOf(cmd.SubtaskDepthError);
  });

  it("concurrent adds under one parent get distinct ranks", async () => {
    const { a } = await setup("sub-race");
    const { id: parent } = await work.createOwnerTask(a, { title: "Parallel" });
    const made = await Promise.all(
      Array.from({ length: 6 }, (_, i) => cmd.createSubtask(a, { parentTaskId: parent, title: `Child ${i}`, idempotencyKey: key() })),
    );
    const rows = await db.select({ rank: tasks.rank }).from(tasks).where(eq(tasks.parentTaskId, parent));
    expect(new Set(rows.map((r) => r.rank)).size).toBe(made.length);
  });

  it("the database refuses a task that is its own parent", async () => {
    const { a } = await setup("self-parent");
    const { id } = await work.createOwnerTask(a, { title: "Loop" });
    await expect(db.update(tasks).set({ parentTaskId: id }).where(eq(tasks.id, id))).rejects.toThrow();
  });

  it("refuses a parent from another workspace", async () => {
    const one = await setup("sub-a");
    const two = await setup("sub-b");
    const { id } = await work.createOwnerTask(one.a, { title: "Theirs" });
    await expect(
      cmd.createSubtask(two.a, { parentTaskId: id, title: "Mine now", idempotencyKey: key() }),
    ).rejects.toBeInstanceOf(cmd.TaskNotFoundError);
  });
});

suite("dependencies", () => {
  it("blocks and blocked_by read as one edge; duplicates in either orientation collapse", async () => {
    const { a } = await setup("dep");
    const { id: x } = await work.createOwnerTask(a, { title: "Design" });
    const { id: y } = await work.createOwnerTask(a, { title: "Build" });
    const one = await cmd.addDependency(a, { taskId: x, otherTaskId: y, kind: "blocks", idempotencyKey: key() });
    const two = await cmd.addDependency(a, { taskId: y, otherTaskId: x, kind: "blocked_by", idempotencyKey: key() });
    expect(one.created).toBe(true);
    expect(two).toEqual({ id: one.id, created: false });
    const build = await queries.getTaskDetail(a, y);
    expect(build?.blockedBy.map((b) => b.taskId)).toEqual([x]);
    const design = await queries.getTaskDetail(a, x);
    expect(design?.blocking.map((b) => b.taskId)).toEqual([y]);
  });

  it("refuses direct, transitive, and self cycles", async () => {
    const { a } = await setup("cycle");
    const ids: string[] = [];
    for (const t of ["A", "B", "C"]) ids.push((await work.createOwnerTask(a, { title: t })).id);
    const [A, B, C] = ids;
    await cmd.addDependency(a, { taskId: A, otherTaskId: B, kind: "blocks", idempotencyKey: key() }); // A -> B
    await cmd.addDependency(a, { taskId: C, otherTaskId: B, kind: "blocked_by", idempotencyKey: key() }); // B -> C
    await expect(cmd.addDependency(a, { taskId: B, otherTaskId: A, kind: "blocks", idempotencyKey: key() })).rejects.toBeInstanceOf(cmd.DependencyCycleError);
    await expect(cmd.addDependency(a, { taskId: C, otherTaskId: A, kind: "blocks", idempotencyKey: key() })).rejects.toBeInstanceOf(cmd.DependencyCycleError);
    await expect(cmd.addDependency(a, { taskId: A, otherTaskId: A, kind: "blocks", idempotencyKey: key() })).rejects.toBeInstanceOf(cmd.DependencyCycleError);
  });

  it("concurrent opposite edges cannot close a loop", async () => {
    const { a, workspaceId } = await setup("cycle-race");
    const { id: x } = await work.createOwnerTask(a, { title: "X" });
    const { id: y } = await work.createOwnerTask(a, { title: "Y" });
    const results = await Promise.allSettled([
      cmd.addDependency(a, { taskId: x, otherTaskId: y, kind: "blocks", idempotencyKey: key() }),
      cmd.addDependency(a, { taskId: y, otherTaskId: x, kind: "blocks", idempotencyKey: key() }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await db.select().from(taskDependencies).where(eq(taskDependencies.workspaceId, workspaceId))).toHaveLength(1);
  });

  it("completing the blocker resolves the edge; reopening it restores the block", async () => {
    const { a } = await setup("resolve");
    const { id: blocker } = await work.createOwnerTask(a, { title: "Get approval" });
    const { id: blocked } = await work.createOwnerTask(a, { title: "Send contract" });
    await cmd.addDependency(a, { taskId: blocker, otherTaskId: blocked, kind: "blocks", idempotencyKey: key() });
    expect((await queries.getTaskDetail(a, blocked))?.blockedBy).toHaveLength(1);
    await work.completeTask(a, { taskId: blocker });
    expect((await queries.getTaskDetail(a, blocked))?.blockedBy).toHaveLength(0);
    await cmd.updateTask(a, { taskId: blocker, expectedVersion: await version(blocker), idempotencyKey: key(), patch: { status: "ready" } });
    expect((await queries.getTaskDetail(a, blocked))?.blockedBy).toHaveLength(1);
  });

  it("a blocker that is already done is recorded as resolved", async () => {
    const { a } = await setup("pre-done");
    const { id: blocker } = await work.createOwnerTask(a, { title: "Done already" });
    await work.completeTask(a, { taskId: blocker });
    const { id: blocked } = await work.createOwnerTask(a, { title: "Next" });
    await cmd.addDependency(a, { taskId: blocked, otherTaskId: blocker, kind: "blocked_by", idempotencyKey: key() });
    expect((await queries.getTaskDetail(a, blocked))?.blockedBy).toHaveLength(0);
  });

  it("waiting-on checks tenancy of the person and dedupes", async () => {
    const one = await setup("wait-a");
    const two = await setup("wait-b");
    const [p] = await db.insert(people).values({ workspaceId: one.workspaceId, displayName: "Ana" }).returning({ id: people.id });
    const { id } = await work.createOwnerTask(one.a, { title: "Await reply" });
    const first = await cmd.addWaitingOn(one.a, { taskId: id, targetType: "person", targetId: p.id, idempotencyKey: key() });
    const second = await cmd.addWaitingOn(one.a, { taskId: id, targetType: "person", targetId: p.id, idempotencyKey: key() });
    expect(second).toEqual({ id: first.id, created: false });
    const { id: other } = await work.createOwnerTask(two.a, { title: "Elsewhere" });
    await expect(cmd.addWaitingOn(two.a, { taskId: other, targetType: "person", targetId: p.id, idempotencyKey: key() })).rejects.toThrow(/not found/);
    expect((await queries.getTaskDetail(one.a, id))?.waitingOn).toHaveLength(1);
  });

  it("removeDependency deletes the edge in-workspace only", async () => {
    const one = await setup("rm-a");
    const two = await setup("rm-b");
    const { id: x } = await work.createOwnerTask(one.a, { title: "X" });
    const { id: y } = await work.createOwnerTask(one.a, { title: "Y" });
    const dep = await cmd.addDependency(one.a, { taskId: x, otherTaskId: y, kind: "blocks", idempotencyKey: key() });
    expect(await cmd.removeDependency(two.a, { dependencyId: dep.id })).toEqual({ removed: false });
    expect(await cmd.removeDependency(one.a, { dependencyId: dep.id })).toEqual({ removed: true });
  });
});

suite("rank moves", () => {
  it("moving between two neighbours writes one row and orders the list", async () => {
    const { a, workspaceId } = await setup("rank");
    const ids: string[] = [];
    for (const t of ["one", "two", "three"]) ids.push((await work.createOwnerTask(a, { title: t })).id);
    // all start at rank "m"; give them an explicit order
    const [one, two, three] = ids;
    await cmd.moveTask(a, { taskId: one, expectedVersion: 1, beforeTaskId: undefined, idempotencyKey: key() });
    await cmd.moveTask(a, { taskId: two, expectedVersion: 1, afterTaskId: one, idempotencyKey: key() });
    await cmd.moveTask(a, { taskId: three, expectedVersion: 1, afterTaskId: one, beforeTaskId: two, idempotencyKey: key() });
    const open = await queries.listOpenTasks({ workspaceId });
    expect(open.map((t) => t.id)).toEqual([one, three, two]);
    const moved = await db.select({ v: tasks.version }).from(tasks).where(eq(tasks.id, one));
    expect(moved[0].v).toBe(2);
  });

  it("refuses neighbours that are no longer in order, and a stale version", async () => {
    const { a } = await setup("rank-stale");
    const { id: p } = await work.createOwnerTask(a, { title: "p" });
    const { id: q } = await work.createOwnerTask(a, { title: "q" });
    const { id: r } = await work.createOwnerTask(a, { title: "r" });
    await cmd.moveTask(a, { taskId: p, expectedVersion: 1, idempotencyKey: key() }); // p -> n
    await cmd.moveTask(a, { taskId: q, expectedVersion: 1, afterTaskId: p, idempotencyKey: key() });
    await expect(
      cmd.moveTask(a, { taskId: r, expectedVersion: 1, afterTaskId: q, beforeTaskId: p, idempotencyKey: key() }),
    ).rejects.toBeInstanceOf(cmd.RankOrderError);
    await expect(
      cmd.moveTask(a, { taskId: r, expectedVersion: 7, afterTaskId: p, idempotencyKey: key() }),
    ).rejects.toBeInstanceOf(cmd.VersionConflictError);
  });

  it("the database refuses a malformed rank", async () => {
    const { a } = await setup("rank-format");
    const { id } = await work.createOwnerTask(a, { title: "bad" });
    await expect(db.update(tasks).set({ rank: "Z9" }).where(eq(tasks.id, id))).rejects.toThrow();
  });
});

suite("work list reads and rank assignment", () => {
  it("new tasks go to the end of the list, so a move between neighbours always has room", async () => {
    const { a } = await setup("end");
    const ids: string[] = [];
    for (const t of ["first", "second", "third"]) ids.push((await work.createOwnerTask(a, { title: t })).id);
    const rows = await queries.listWorkRows(a, "open");
    expect(rows.map((r) => r.id)).toEqual(ids);
    expect(new Set(rows.map((r) => r.rank)).size).toBe(3);
  });

  it("concurrent creates never tie on rank", async () => {
    const { a } = await setup("end-race");
    await Promise.all(Array.from({ length: 8 }, (_, i) => work.createOwnerTask(a, { title: `t${i}` })));
    const rows = await queries.listWorkRows(a, "open");
    expect(new Set(rows.map((r) => r.rank)).size).toBe(8);
  });

  it("createOwnerTask with one key creates one task", async () => {
    const { a } = await setup("create-idem");
    const k = key();
    const one = await work.createOwnerTask(a, { title: "Once", idempotencyKey: k });
    const two = await work.createOwnerTask(a, { title: "Once", idempotencyKey: k });
    expect(two).toEqual(one);
    expect(await queries.listWorkRows(a, "open")).toHaveLength(1);
  });

  it("a move between tasks that share a legacy rank spreads them first instead of failing", async () => {
    const { a, workspaceId } = await setup("tie");
    const made: string[] = [];
    for (const t of ["x", "y", "z"]) made.push(await seedTask(workspaceId, t, "m"));
    const order = (await queries.listWorkRows(a, "open")).map((r) => r.id);
    const [first, second, third] = order;
    // move `third` between first and second, which tie at "m"
    await cmd.moveTask(a, { taskId: third, expectedVersion: 1, afterTaskId: first, beforeTaskId: second, idempotencyKey: key() });
    expect((await queries.listWorkRows(a, "open")).map((r) => r.id)).toEqual([first, third, second]);
  });

  it("the today view is Ready and In progress only; done lists finished work; blocked and subtask counts are exact", async () => {
    const { a } = await setup("views");
    const { id: ready } = await work.createOwnerTask(a, { title: "Ready one" });
    const { id: inbox } = await work.createOwnerTask(a, { title: "Inbox one" });
    const { id: finished } = await work.createOwnerTask(a, { title: "Finished one" });
    await cmd.updateTask(a, { taskId: ready, expectedVersion: 1, idempotencyKey: key(), patch: { status: "ready" } });
    await work.completeTask(a, { taskId: finished });
    const sub = await cmd.createSubtask(a, { parentTaskId: ready, title: "Part", idempotencyKey: key() });
    await cmd.createSubtask(a, { parentTaskId: ready, title: "Part two", idempotencyKey: key() });
    await work.completeTask(a, { taskId: sub.id });
    await cmd.addDependency(a, { taskId: inbox, otherTaskId: ready, kind: "blocked_by", idempotencyKey: key() });
    const today = await queries.listWorkRows(a, "today");
    expect(today.map((r) => r.id)).toEqual([ready]);
    expect(today[0]).toMatchObject({ subtaskCount: 2, subtasksDone: 1, blockedBy: 0 });
    const open = await queries.listWorkRows(a, "open");
    expect(open.map((r) => r.id).sort()).toEqual([ready, inbox].sort());
    expect(open.find((r) => r.id === inbox)?.blockedBy).toBe(1);
    expect((await queries.listWorkRows(a, "done")).map((r) => r.id)).toEqual([finished]);
  });
});
