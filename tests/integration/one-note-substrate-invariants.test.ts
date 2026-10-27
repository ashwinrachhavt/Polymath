import { readFileSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { artifactVersions, artifacts } from "@/domains/knowledge/schema";
import { tasks } from "@/domains/work/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * The invariants the one-note migration must never violate. Three of them, each
 * one a case where a bug is quiet rather than loud:
 *
 *  (a) tenancy   - a task's note must be in the task's workspace. The
 *                  single-column FK on note_id proves the note exists and says
 *                  nothing about whose it is, and the leak (another tenant's
 *                  prose in a task read) is invisible in the rows. 0261's
 *                  composite FK on (workspace_id, note_id) makes the mismatch
 *                  impossible to insert; notes.ts's guard is what turns the
 *                  attempt into a readable 409 for a command caller. Both are
 *                  asserted.
 *  (b) template  - a template is a starting point, not a state. An unknown slug
 *                  on a write must be refused with a stable code, while a slug
 *                  that has since been removed from the registry must degrade to
 *                  a plain note on read: removing a template can never break a
 *                  note someone is already reading.
 *  (c) empty body - Review Focus 1. A task with no body has to open as a blank
 *                  note, not as null, not as an error, and not indistinguishably
 *                  from a failed read. This asserts the contrast, not just the
 *                  string.
 */

const BACKFILL = readFileSync("src/db/migrations/0259_one_note_substrate_add.sql", "utf8");

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
// Lazy imports: makeTestDb points DATABASE_URL at the scratch database, and
// these modules read it (directly or through lib/db-transaction) at load.
let notes: typeof import("@/domains/knowledge/notes");
let templates: typeof import("@/domains/knowledge/templates");
let withTransaction: typeof import("@/lib/db-transaction").withTransaction;
let noteMarkdown: typeof import("@/app/(workspace)/alfred/notes/page").noteMarkdown;

beforeAll(async () => {
  if (!handle) return;
  ({ db } = handle);
  notes = await import("@/domains/knowledge/notes");
  templates = await import("@/domains/knowledge/templates");
  ({ withTransaction } = await import("@/lib/db-transaction"));
  ({ noteMarkdown } = await import("@/app/(workspace)/alfred/notes/page"));
});

afterAll(async () => {
  await handle?.client.end();
});

async function setup(label: string) {
  const { userId, workspaceId } = await seedWorkspace(db, `invariants-${label}-${Date.now()}`);
  return { a: ownerAuth(userId, workspaceId), userId, workspaceId };
}

/** A note in `workspaceId` with one committed markdown version. The raw row shape tests need. */
async function seedNote(
  workspaceId: string,
  row: { userId: string; title: string; markdown?: string; template?: string | null },
): Promise<string> {
  const [artifact] = await db
    .insert(artifacts)
    .values({
      workspaceId,
      kind: "note",
      title: row.title,
      template: row.template ?? null,
      createdBy: row.userId,
      updatedBy: row.userId,
    })
    .returning({ id: artifacts.id });
  const [version] = await db
    .insert(artifactVersions)
    .values({
      workspaceId,
      artifactId: artifact.id,
      versionNumber: 1,
      content: { format: "markdown", text: row.markdown ?? "" },
      plainText: row.markdown ?? null,
      reason: "created",
      createdBy: row.userId,
    })
    .returning({ id: artifactVersions.id });
  await db.update(artifacts).set({ currentVersionId: version.id }).where(eq(artifacts.id, artifact.id));
  return artifact.id;
}

/** A task row, inserted raw: this suite is about what the table accepts, not what a command writes. */
async function seedTask(workspaceId: string, row: { title: string; noteId?: string | null; userId: string }) {
  const [task] = await db
    .insert(tasks)
    .values({
      workspaceId,
      title: row.title,
      noteId: row.noteId ?? null,
      createdBy: row.userId,
      updatedBy: row.userId,
    })
    .returning({ id: tasks.id });
  return task.id;
}

suite("one note substrate invariants", () => {
  /*
   * (a) Tenancy. Two layers, both asserted here because either one alone is a
   * weaker promise than the product makes:
   *
   *  - the database, structurally. 0261's composite FK on (workspace_id,
   *    note_id) -> artifacts (workspace_id, id) makes a cross-tenant attach
   *    impossible for every caller, present and future. artifacts already
   *    carries UNIQUE (workspace_id, id) from 0150, so no extra index.
   *  - the write path, for the error. The same attempt through a command should
   *    surface a readable 409 rather than a driver's foreign-key violation,
   *    which is what assertArtifactInWorkspace gives it.
   */
  it("the write-path guard refuses a note from another workspace", async () => {
    const mine = await setup("tenancy-a");
    const theirs = await setup("tenancy-b");
    const ownNote = await seedNote(mine.workspaceId, { userId: mine.userId, title: "My note" });
    const foreignNote = await seedNote(theirs.workspaceId, { userId: theirs.userId, title: "Their note" });

    // The same transaction shape createTask and createNoteInTx run in.
    await expect(
      withTransaction((tx) => notes.assertArtifactInWorkspace(tx, mine.workspaceId, foreignNote)),
    ).rejects.toMatchObject({ code: "workspace_mismatch", status: 409 });

    // ...and the guard is not simply rejecting everything: the workspace's own
    // note passes, so a false positive in the guard would show here.
    await expect(
      withTransaction((tx) => notes.assertArtifactInWorkspace(tx, mine.workspaceId, ownNote)),
    ).resolves.toBeUndefined();
  });

  it("a hand-written task insert carrying another workspace's note_id is rejected by the database", async () => {
    // The structural half. This statement bypasses every command and every
    // guard, so what stops it is only the constraint: the single-column FK
    // would accept it (the artifact exists) and the mismatch would surface as
    // leaked prose one layer up. 0261 makes it fail at the insert instead.
    const mine = await setup("tenancy-raw-a");
    const theirs = await setup("tenancy-raw-b");
    const foreignNote = await seedNote(theirs.workspaceId, { userId: theirs.userId, title: "Not yours" });

    await expect(
      seedTask(mine.workspaceId, { title: "Smuggler", noteId: foreignNote, userId: mine.userId }),
    ).rejects.toMatchObject({
      // Named, not just "a foreign-key error": a bare 23503 would also pass if
      // the insert failed on tasks_workspace_id_workspaces_id_fk or on the
      // single-column note reference, neither of which is the invariant here.
      cause: expect.objectContaining({ code: "23503", constraint_name: "tasks_note_workspace_fk" }),
    });

    // The insert never ran, so nothing needs cleaning up - and the control case
    // below shows a same-workspace note is still accepted, so this is tenancy
    // and not the constraint rejecting every note.
    expect(
      await db.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.workspaceId, mine.workspaceId), eq(tasks.title, "Smuggler"))),
    ).toEqual([]);
  });

  it("the row a task may legitimately point at is accepted, so the case above fails for the right reason", async () => {
    // The control for the expected failure: a same-workspace note is a valid
    // target, which is why the rejected case is about tenancy and not about the
    // insert being malformed.
    const mine = await setup("tenancy-control");
    const ownNote = await seedNote(mine.workspaceId, { userId: mine.userId, title: "Mine" });
    const taskId = await seedTask(mine.workspaceId, { title: "Legit", noteId: ownNote, userId: mine.userId });

    const [row] = await db
      .select({ noteId: tasks.noteId, noteWorkspace: artifacts.workspaceId, taskWorkspace: tasks.workspaceId })
      .from(tasks)
      .innerJoin(artifacts, eq(artifacts.id, tasks.noteId))
      .where(and(eq(tasks.id, taskId), eq(tasks.workspaceId, mine.workspaceId)));
    expect(row.noteId).toBe(ownNote);
    expect(row.noteWorkspace).toBe(row.taskWorkspace);
  });

  /*
   * (b) Templates. The write rejects an unknown slug with a stable code; the
   * read degrades to a plain note. Both directions matter: a lenient write
   * stores a value no reader can interpret, and a strict read breaks every note
   * whose template is retired.
   */
  it("an unknown template slug is rejected on write with unknown_template, and nothing is committed", async () => {
    const { a, workspaceId } = await setup("template-write");

    await expect(
      withTransaction((tx) =>
        notes.createNoteInTx(tx, a, { title: "Bogus scaffold", template: "retired-scaffold" }),
      ),
    ).rejects.toMatchObject({ code: "unknown_template", status: 422 });
    // Rejected before the insert, so the failed attempt leaves no artifact
    // behind: a half-written note would be worse than the error.
    expect(await db.select({ id: artifacts.id }).from(artifacts).where(eq(artifacts.workspaceId, workspaceId))).toEqual([]);

    // Every registered slug is accepted, and a null template is a plain note -
    // the default must not become "the first template".
    const { id: issueNote } = await withTransaction((tx) =>
      notes.createNoteInTx(tx, a, { title: "An issue", template: "issue" }),
    );
    const { id: plainNote } = await withTransaction((tx) => notes.createNoteInTx(tx, a, { title: "Just a note" }));
    expect((await notes.getNote(a, issueNote))!.template).toBe("issue");
    expect((await notes.getNote(a, plainNote))!.template).toBeNull();
  });

  it("a stored template no longer in the registry reads as a plain note, without throwing", async () => {
    const { a, userId, workspaceId } = await setup("template-read");
    const body = "The body must survive a retired template.";
    const noteId = await seedNote(workspaceId, {
      userId,
      title: "Started from something",
      markdown: body,
      template: "retired-scaffold",
    });

    // resolveTemplate is the read barrier: null for anything unregistered, the
    // slug itself for anything registered, null for null.
    expect(templates.resolveTemplate("retired-scaffold")).toBeNull();
    expect(templates.resolveTemplate("issue")).toBe("issue");
    expect(templates.resolveTemplate(null)).toBeNull();
    for (const slug of templates.DRAFT_TEMPLATES) expect(templates.resolveTemplate(slug)).toBe(slug);

    const detail = await notes.getNote(a, noteId);
    expect(detail).not.toBeNull();
    expect(detail!.template).toBeNull();
    // The note is otherwise intact: degrading the label must not degrade the note.
    expect(detail!.title).toBe("Started from something");
    expect(noteMarkdown(detail!.content)).toBe(body);
  });

  /*
   * (c) The empty body. The 0259 backfill stores the empty doc
   * `{"type":"doc","content":[]}` for a task with no description. Read through
   * the Notes surface's own function, that is "" - and the assertion has to
   * separate that from a failed read, which returns no detail at all.
   */
  it("a task with no body opens as an empty note, not as a failed read", async () => {
    const { a, userId, workspaceId } = await setup("empty-body");
    const taskId = await seedTask(workspaceId, { title: "Nothing written yet", userId });

    // The shipped backfill, verbatim, so the fixture is exactly what production
    // holds for an undescribed task.
    await handle!.client.unsafe(BACKFILL);

    const [row] = await db
      .select({ noteId: tasks.noteId })
      .from(tasks)
      .where(and(eq(tasks.id, taskId), eq(tasks.workspaceId, workspaceId)));
    expect(row.noteId, "the backfill must give the task its note").not.toBeNull();

    const detail = await notes.getNote(a, row.noteId!);
    // Three separate claims, and they are separate on purpose: a blank page is
    // produced both by an empty note and by a read that returned nothing, so
    // the identity, the content and the rendered string each have to hold.
    expect(detail, "an empty note is still a note, not a missing one").not.toBeNull();
    expect(detail!.content, "content must be the empty doc, not null").toEqual({ type: "doc", content: [] });
    expect(noteMarkdown(detail!.content)).toBe("");

    // The contrast this case exists for: a read that genuinely failed returns
    // null, so "" above cannot be mistaken for it.
    expect(await notes.getNote(a, "00000000-0000-4000-8000-000000000000")).toBeNull();
  });
});
