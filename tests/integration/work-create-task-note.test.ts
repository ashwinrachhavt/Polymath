import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditEvents } from "@/domains/audit/schema";
import { artifactVersions, artifacts } from "@/domains/knowledge/schema";
import { tasks } from "@/domains/work/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * Task 4: a task is written as a note plus a 1:1 extension row, in one
 * transaction. These pin the write itself - the reads that depend on it are
 * covered in work-task-prose.test.ts, and the rest of the task suites prove
 * nothing regressed.
 *
 * The dual write is asserted, not tolerated: during this window `tasks.title`
 * is still NOT NULL and `tasks.description` still exists, so a create that
 * wrote only the note would fail the constraint and one that wrote only the
 * columns would leave an invisible task. Both must carry the same prose.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
let work: typeof import("@/domains/work/commands");
let cmd: typeof import("@/domains/work/task-commands");
// Destructured rather than imported at module load: db-transaction reads
// DATABASE_URL when it evaluates, and the test URL is set by makeTestDb().
let withTransaction: typeof import("@/lib/db-transaction").withTransaction;

beforeAll(async () => {
  if (!handle) return;
  ({ db } = handle);
  work = await import("@/domains/work/commands");
  cmd = await import("@/domains/work/task-commands");
  ({ withTransaction } = await import("@/lib/db-transaction"));
});

afterAll(async () => {
  await handle?.client.end();
});

async function setup(label: string) {
  const { userId, workspaceId } = await seedWorkspace(db, `task-note-${label}-${Date.now()}`);
  return { a: ownerAuth(userId, workspaceId), userId, workspaceId };
}

/**
 * createTask assigns its rank under the caller's advisory lock, so it takes a
 * transaction. Wrapped here so each case reads as the caller's intent.
 */
async function createInTx(
  auth: ReturnType<typeof ownerAuth>,
  input: Parameters<typeof work.createTask>[1],
) {
  return withTransaction((tx) => work.createTask(auth, input, tx));
}

/** The one task row, its note and the note's version, all in one workspace. */
async function written(workspaceId: string, taskId: string) {
  const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId));
  expect(task.workspaceId).toBe(workspaceId);
  expect(task.noteId, "the task must carry its note").not.toBeNull();
  const [note] = await db
    .select()
    .from(artifacts)
    .where(and(eq(artifacts.id, task.noteId!), eq(artifacts.workspaceId, workspaceId)));
  expect(note, "the note must be in the same workspace").toBeDefined();
  const versions = await db
    .select()
    .from(artifactVersions)
    .where(and(eq(artifactVersions.artifactId, note.id), eq(artifactVersions.workspaceId, workspaceId)));
  return { task, note, versions, version: versions.find((v) => v.id === note.currentVersionId) };
}

suite("a task is created with its note", () => {
  it("createTask writes one note, one version at 1 with the description, the task, and both audit rows", async () => {
    const { a, workspaceId } = await setup("create");
    const description = "Renew the domains before they lapse.";
    const task = await createInTx(a, { title: "Renew domains", description });

    const { note, versions, version } = await written(workspaceId, task.id);

    expect(note).toMatchObject({ kind: "note", template: "issue", title: "Renew domains" });
    expect(versions).toHaveLength(1);
    expect(version).toMatchObject({
      versionNumber: 1,
      reason: "created",
      plainText: description,
      // Markdown, not doc JSON: the Notes surface reads content.text, so a
      // doc-shaped body would open blank and the next autosave would erase it.
      content: { format: "markdown", text: description },
    });

    // Dual write: the columns still carry the same prose until 0260 drops them.
    const [column] = await db
      .select({ title: tasks.title, description: tasks.description })
      .from(tasks)
      .where(eq(tasks.id, task.id));
    expect(column).toEqual({ title: "Renew domains", description });

    // The note's own audit row (written by createNoteInTx) plus the caller's,
    // never two of either.
    const audits = await db
      .select({ action: auditEvents.action, subjectId: auditEvents.subjectId })
      .from(auditEvents)
      .where(eq(auditEvents.workspaceId, workspaceId));
    expect(audits.filter((row) => row.subjectId === note.id && row.action === "note.created")).toHaveLength(1);
  });

  it("createOwnerTask writes the task audit row alongside the note's", async () => {
    const { a, workspaceId } = await setup("owner");
    const { id } = await work.createOwnerTask(a, { title: "Draft the memo" });
    const { note, version } = await written(workspaceId, id);
    expect(version).toMatchObject({ versionNumber: 1 });

    const audits = await db
      .select({ action: auditEvents.action, subjectId: auditEvents.subjectId })
      .from(auditEvents)
      .where(eq(auditEvents.workspaceId, workspaceId));
    expect(audits.filter((r) => r.action === "task.created" && r.subjectId === id)).toHaveLength(1);
    expect(audits.filter((r) => r.action === "note.created" && r.subjectId === note.id)).toHaveLength(1);
  });

  it("a task with no description still gets a version, with an empty body", async () => {
    const { a, workspaceId } = await setup("empty");
    const task = await createInTx(a, { title: "No body" });
    const { versions, version } = await written(workspaceId, task.id);
    expect(versions).toHaveLength(1);
    expect(version).toMatchObject({ plainText: null, content: { type: "doc", content: [] } });
  });

  it("a whitespace-only description is the same nothing as a missing one", async () => {
    const { a, workspaceId } = await setup("blank");
    const task = await createInTx(a, { title: "Blank body", description: "  \n\t " });
    const { version } = await written(workspaceId, task.id);
    expect(version).toMatchObject({ plainText: null, content: { type: "doc", content: [] } });
  });

  it("createSubtask writes a note of its own and reads back through the join", async () => {
    const { a, workspaceId } = await setup("subtask");
    const { id: parent } = await work.createOwnerTask(a, { title: "Launch" });
    const sub = await cmd.createSubtask(a, { parentTaskId: parent, title: "Write copy", idempotencyKey: crypto.randomUUID() });
    const { note, version } = await written(workspaceId, sub.id);
    expect(note).toMatchObject({ kind: "note", template: "issue", title: "Write copy" });
    expect(version).toMatchObject({ versionNumber: 1 });
    // Two notes in this workspace now, one per task, never shared.
    const notes = await db
      .select({ id: artifacts.id })
      .from(artifacts)
      .where(eq(artifacts.workspaceId, workspaceId));
    expect(new Set(notes.map((n) => n.id)).size).toBe(2);
  });
});
