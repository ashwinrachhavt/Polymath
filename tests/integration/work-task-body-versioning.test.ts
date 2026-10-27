import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditEvents } from "@/domains/audit/schema";
import { artifactVersions, artifacts } from "@/domains/knowledge/schema";
import { tasks } from "@/domains/work/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * Editing a task's prose writes its note, not the task row.
 *
 * A task is a note plus a 1:1 extension row, so "change the body" is a new
 * artifact version and "rename" is a write to `artifacts.title`. Neither is
 * task activity: a board sorted by `tasks.updated_at` must not reorder while
 * somebody types. Status, priority, due, estimate and tags are the opposite
 * case - they are task activity and must stay a single-row write that leaves
 * the note alone. Both directions are asserted here, because a "save the whole
 * task through the note path" regression only fails the second one.
 *
 * Every assertion is on a derived value (what a reader sees through
 * `getTaskDetail`) or on the version ledger, never on "the column was set".
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
let work: typeof import("@/domains/work/commands");
let cmd: typeof import("@/domains/work/task-commands");
let queries: typeof import("@/domains/work/queries");

beforeAll(async () => {
  if (!handle) return;
  ({ db } = handle);
  work = await import("@/domains/work/commands");
  cmd = await import("@/domains/work/task-commands");
  queries = await import("@/domains/work/queries");
});
afterAll(async () => {
  await handle?.client.end();
});

async function setup(label: string) {
  const { userId, workspaceId } = await seedWorkspace(db, `body-${label}-${Date.now()}`);
  return { a: ownerAuth(userId, workspaceId), workspaceId };
}

const key = () => crypto.randomUUID();

/**
 * A task that stands on a note, whatever the create path in this tree does.
 *
 * Task 4 (a parallel change) makes `createTask` write the note itself; before
 * it lands, a created task has a null `note_id`. The fixture only fills the gap
 * it finds, so it asserts nothing about the create path and keeps this suite
 * about the update path.
 */
async function ensureNote(taskId: string, workspaceId: string): Promise<string> {
  const [task] = await db.select({ noteId: tasks.noteId, title: tasks.title }).from(tasks).where(eq(tasks.id, taskId));
  if (task.noteId) return task.noteId;
  const [note] = await db
    .insert(artifacts)
    .values({ workspaceId, kind: "note", title: task.title })
    .returning({ id: artifacts.id });
  const [v] = await db
    .insert(artifactVersions)
    .values({ workspaceId, artifactId: note.id, versionNumber: 1, content: { type: "doc", content: [] }, reason: "created" })
    .returning({ id: artifactVersions.id });
  await db.update(artifacts).set({ currentVersionId: v.id }).where(eq(artifacts.id, note.id));
  await db.update(tasks).set({ noteId: note.id }).where(eq(tasks.id, taskId));
  return note.id;
}

async function taskRow(taskId: string) {
  const [row] = await db.select().from(tasks).where(eq(tasks.id, taskId));
  return row;
}

async function noteLedger(noteId: string) {
  const versions = await db
    .select({ versionNumber: artifactVersions.versionNumber, plainText: artifactVersions.plainText })
    .from(artifactVersions)
    .where(eq(artifactVersions.artifactId, noteId))
    .orderBy(artifactVersions.versionNumber);
  const [note] = await db.select().from(artifacts).where(eq(artifacts.id, noteId));
  return { versions, note };
}

/**
 * The note's `note.*` audit rows, ids and all. Every assertion about "this
 * patch wrote no note activity" is a delta against this, never an absolute
 * emptiness check: creation legitimately writes `note.created` now that a task
 * writes its note in the create transaction, and forbidding that outright
 * would pass for the wrong reason the moment creation changes again.
 */
async function noteAuditIds(noteId: string): Promise<string[]> {
  const rows = await db
    .select({ id: auditEvents.id })
    .from(auditEvents)
    .where(and(eq(auditEvents.subjectId, noteId), sql`${auditEvents.action} like 'note.%'`));
  return rows.map((r) => r.id).sort();
}

suite("task prose edits version the note and leave task activity alone", () => {
  it("patching description mints a new note version and does not move tasks.updated_at", async () => {
    const { a, workspaceId } = await setup("body");
    const { id } = await work.createOwnerTask(a, { title: "Draft the memo" });
    const noteId = await ensureNote(id, workspaceId);
    const before = await taskRow(id);
    expect(before.noteId).toBe(noteId);
    const auditsBefore = await noteAuditIds(noteId);

    await cmd.updateTask(a, {
      taskId: id,
      expectedVersion: before.version,
      idempotencyKey: key(),
      patch: { description: "Ship it Friday.\n\nAsk Priya first." },
    });

    const after = await taskRow(id);
    // Activity is untouched: a board ordered by task activity must not reorder.
    expect(after.updatedAt).toEqual(before.updatedAt);
    // The optimistic-concurrency token still moves, so a stale edit is refused.
    expect(after.version).toBe(before.version + 1);

    const { versions, note } = await noteLedger(noteId);
    expect(versions).toHaveLength(2);
    expect(versions[1]).toMatchObject({
      versionNumber: 2,
      plainText: "Ship it Friday.\n\nAsk Priya first.",
    });
    expect(note.currentVersionId).not.toBeNull();

    // The body edit is note activity: wrapping the version commit in
    // "no note audits" would contradict the very thing this test proves.
    expect((await noteAuditIds(noteId)).length).toBe(auditsBefore.length + 1);

    // What a reader sees is the new body, not a copy left on the task row.
    const detail = await queries.getTaskDetail(a, id);
    expect(detail?.task.description).toBe("Ship it Friday.\n\nAsk Priya first.");
    expect(detail?.task.title).toBe("Draft the memo");
  });

  it("patching title renames the note, not the task row's activity", async () => {
    const { a, workspaceId } = await setup("rename");
    const { id } = await work.createOwnerTask(a, { title: "Old name" });
    const noteId = await ensureNote(id, workspaceId);
    const before = await taskRow(id);
    const auditsBefore = await noteAuditIds(noteId);

    await cmd.updateTask(a, {
      taskId: id,
      expectedVersion: before.version,
      idempotencyKey: key(),
      patch: { title: "New name" },
    });

    const after = await taskRow(id);
    expect(after.updatedAt).toEqual(before.updatedAt);
    expect(after.version).toBe(before.version + 1);

    const { note, versions } = await noteLedger(noteId);
    expect(note.title).toBe("New name");
    // A rename is a title write, not a body write: no new version is minted,
    // and it is note activity exactly once (`note.renamed`).
    expect(versions).toHaveLength(1);
    expect((await noteAuditIds(noteId)).length).toBe(auditsBefore.length + 1);
    expect((await queries.getTaskDetail(a, id))?.task.title).toBe("New name");
  });

  it("patching status alone writes the task row and touches no artifact", async () => {
    const { a, workspaceId } = await setup("status");
    const { id } = await work.createOwnerTask(a, { title: "Move the furniture" });
    const noteId = await ensureNote(id, workspaceId);
    const before = await taskRow(id);
    const ledgerBefore = await noteLedger(noteId);
    const auditsBefore = await noteAuditIds(noteId);

    await cmd.updateTask(a, {
      taskId: id,
      expectedVersion: before.version,
      idempotencyKey: key(),
      patch: { status: "in_progress" },
    });

    const after = await taskRow(id);
    expect(after.status).toBe("in_progress");
    expect(after.version).toBe(before.version + 1);
    // Status is task activity, so this one does move the clock.
    expect(after.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());

    // The note is untouched across the patch - not "the note is empty", which
    // creation already made false: the same versions, the same pointer, the
    // same clock, and not one new note audit row.
    const ledgerAfter = await noteLedger(noteId);
    expect(ledgerAfter.versions).toEqual(ledgerBefore.versions);
    expect(ledgerAfter.note.currentVersionId).toBe(ledgerBefore.note.currentVersionId);
    expect(ledgerAfter.note.version).toBe(ledgerBefore.note.version);
    expect(ledgerAfter.note.updatedAt).toEqual(ledgerBefore.note.updatedAt);
    expect(await noteAuditIds(noteId)).toEqual(auditsBefore);
    expect((await queries.getTaskDetail(a, id))?.task.status).toBe("in_progress");
  });
});
