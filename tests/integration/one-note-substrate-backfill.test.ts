import { readFileSync } from "node:fs";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { artifacts, artifactVersions } from "@/domains/knowledge/schema";
import { recurrenceTemplates, tasks } from "@/domains/work/schema";
import { makeTestDb, seedWorkspace } from "../helpers/test-workspace";

/*
 * One note substrate, phase one (0259). Every existing task gains a note: an
 * artifacts row of kind `note` carrying the `issue` template, plus version 1
 * whose plain text is the task's description (or an empty doc when there is
 * none), and tasks.note_id pointing at it.
 *
 * The migration file itself is what runs here, twice, so the assertions cover
 * the shipped SQL rather than a transcription of it. Three things this suite
 * exists to catch:
 *
 *  - correlation by title. Two tasks may share a title, so a backfill that
 *    matched on one would attribute the wrong body to the wrong task. The pair
 *    of tasks below share a title on purpose.
 *  - a backfill that re-creates rows on retry. The second run must insert
 *    nothing.
 *  - a backfill written as a loop. A recurrence template's spawned instances
 *    are the population where per-task statements would show, so the fan-out
 *    case asserts an exact artifact count and the file's shape (one INSERT, no
 *    LOOP) in the same test.
 */

const MIGRATION = readFileSync("src/db/migrations/0259_one_note_substrate_add.sql", "utf8");

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
let noteMarkdown: typeof import("@/app/(workspace)/alfred/notes/page").noteMarkdown;

beforeAll(async () => {
  if (!handle) return;
  ({ db } = handle);
  // Lazy, after makeTestDb has pointed DATABASE_URL at the scratch database:
  // the notes page reaches @/lib/db at module load.
  ({ noteMarkdown } = await import("@/app/(workspace)/alfred/notes/page"));
});

afterAll(async () => {
  await handle?.client.end();
});

async function runBackfill(): Promise<void> {
  await handle!.client.unsafe(MIGRATION);
}

async function noteRows(workspaceId: string) {
  return db
    .select({
      noteId: tasks.noteId,
      description: tasks.description,
      artifactId: artifacts.id,
      artifactTitle: artifacts.title,
      template: artifacts.template,
      kind: artifacts.kind,
      artifactWorkspaceId: artifacts.workspaceId,
      currentVersionId: artifacts.currentVersionId,
    })
    .from(tasks)
    .innerJoin(artifacts, eq(artifacts.id, tasks.noteId))
    .where(eq(tasks.workspaceId, workspaceId));
}

async function versionRows(workspaceId: string, notes: { noteId: string | null }[]) {
  const noteIds = notes.flatMap((note) => (note.noteId === null ? [] : [note.noteId]));
  return db
    .select({
      versionId: artifactVersions.id,
      artifactId: artifactVersions.artifactId,
      versionNumber: artifactVersions.versionNumber,
      content: artifactVersions.content,
      plainText: artifactVersions.plainText,
      reason: artifactVersions.reason,
      versionWorkspaceId: artifactVersions.workspaceId,
    })
    .from(artifactVersions)
    .where(
      and(
        eq(artifactVersions.workspaceId, workspaceId),
        inArray(artifactVersions.artifactId, noteIds),
      ),
    );
}

suite("one note substrate backfill (0259)", () => {
  it("gives every task a note, in the task's workspace, and never by title", async () => {
    const { userId, workspaceId } = await seedWorkspace(db, `notes-backfill-${Date.now()}`);
    // Same title, different bodies: title-matching would collide here.
    const seeded = await db.transaction(async (tx) =>
      tx
        .insert(tasks)
        .values([
          {
            workspaceId,
            title: "Ship the weekly digest",
            description: "Send it Friday, to the paying customers first.",
            createdBy: userId,
            updatedBy: userId,
          },
          {
            workspaceId,
            title: "Ship the weekly digest",
            description: null,
            createdBy: userId,
            updatedBy: userId,
          },
          {
            workspaceId,
            title: "Whitespace only",
            // Not null, but the same nothing: content and plain_text must agree
            // that this note is empty rather than storing a body of spaces.
            description: "  \n\t ",
            createdBy: userId,
            updatedBy: userId,
          },
        ])
        .returning({ id: tasks.id }),
    );
    expect(seeded).toHaveLength(3);

    await runBackfill();

    const notes = await noteRows(workspaceId);
    expect(notes).toHaveLength(3);
    // Each task got its own note: a shared title did not collapse the pair.
    expect(new Set(notes.map((note) => note.artifactId)).size).toBe(3);
    expect(new Set(notes.map((note) => note.noteId)).size).toBe(3);
    for (const note of notes) {
      expect(note.noteId).not.toBeNull();
      expect(note.artifactId).toBe(note.noteId);
      expect(note.artifactTitle).toBe(note.description === "  \n\t " ? "Whitespace only" : "Ship the weekly digest");
      expect(note.template).toBe("issue");
      expect(note.kind).toBe("note");
      expect(note.artifactWorkspaceId).toBe(workspaceId);
      expect(note.currentVersionId).not.toBeNull();
    }

    const versions = await versionRows(workspaceId, notes);
    expect(versions).toHaveLength(3);
    for (const version of versions) {
      expect(version.versionNumber).toBe(1);
      expect(version.reason).toBe("created");
      expect(version.versionWorkspaceId).toBe(workspaceId);
    }

    // A description with real text becomes the body as markdown; null and
    // whitespace-only both become the empty doc createNoteInTx writes, and
    // neither is an error.
    const byNote = new Map(versions.map((version) => [version.artifactId, version]));
    for (const note of notes) {
      const version = byNote.get(note.artifactId)!;
      // current_version_id points at the version just written, the same order
      // createNoteInTx uses (insert, insert, then move the pointer).
      expect(note.currentVersionId).toBe(version.versionId);
      const blank = note.description === null || note.description.trim() === "";
      if (blank) {
        expect(version.plainText).toBeNull();
        expect(version.content).toEqual({ type: "doc", content: [] });
      } else {
        expect(version.plainText).toBe(note.description);
        // Markdown, not ProseMirror doc JSON. The Notes surface reads only
        // content.text, so a doc-shaped body opens blank and the next autosave
        // overwrites it with empty text. This assertion is what fails if doc
        // JSON comes back.
        expect(version.content).toEqual({ format: "markdown", text: note.description });
      }
    }
    expect(notes.map((note) => note.description).sort()).toEqual([
      "  \n\t ",
      "Send it Friday, to the paying customers first.",
      null,
    ].sort());
  });

  it("writes a body the Notes surface can actually render", async () => {
    const { userId, workspaceId } = await seedWorkspace(db, `notes-render-${Date.now()}`);
    const description = "Cut the release on Wednesday, then post the changelog.";
    await db.insert(tasks).values({
      workspaceId,
      title: "Release the digest",
      description,
      createdBy: userId,
      updatedBy: userId,
    });

    await runBackfill();

    const [note] = await noteRows(workspaceId);
    const [version] = await versionRows(workspaceId, [note!]);
    // The consequence, end to end: the real reader this defect was reported
    // against returns the description, not "". noteMarkdown is the exact
    // function the /alfred/notes page uses, so this is the assertion that would
    // have caught the original bug at the level a user would notice it.
    expect(noteMarkdown(version!.content as Record<string, unknown>)).toBe(description);
  });

  it("is idempotent: a second run inserts no artifact and no version", async () => {
    const { userId, workspaceId } = await seedWorkspace(db, `notes-idempotent-${Date.now()}`);
    await db.insert(tasks).values(
      [1, 2, 3].map((n) => ({
        workspaceId,
        title: `Retry check ${n}`,
        description: n === 2 ? null : `Body ${n}`,
        createdBy: userId,
        updatedBy: userId,
      })),
    );

    await runBackfill();
    const firstArtifactCount = await db
      .select({ id: artifacts.id })
      .from(artifacts)
      .where(eq(artifacts.workspaceId, workspaceId));
    expect(firstArtifactCount).toHaveLength(3);

    await runBackfill();
    await runBackfill();

    const secondArtifactCount = await db
      .select({ id: artifacts.id })
      .from(artifacts)
      .where(eq(artifacts.workspaceId, workspaceId));
    expect(secondArtifactCount).toHaveLength(3);

    const notes = await noteRows(workspaceId);
    const versions = await versionRows(workspaceId, notes);
    // One version per note, at version 1: a retry that re-inserted would trip
    // artifact_versions_number_key or duplicate the row, and both are visible
    // here.
    expect(versions).toHaveLength(3);
    expect(versions.filter((version) => version.versionNumber !== 1)).toEqual([]);
  });

  it("fans a recurrence template's 200 instances out in one statement set", async () => {
    const { userId, workspaceId } = await seedWorkspace(db, `notes-fanout-${Date.now()}`);
    const [template] = await db
      .insert(recurrenceTemplates)
      .values({
        workspaceId,
        title: "Weekly review",
        cadence: "weekly",
        createdBy: userId,
        updatedBy: userId,
      })
      .returning({ id: recurrenceTemplates.id });

    const instances = Array.from({ length: 200 }, (_, index) => ({
      workspaceId,
      recurrenceTemplateId: template.id,
      title: "Weekly review",
      description: index % 2 === 0 ? `Instance ${index}` : null,
      createdBy: userId,
      updatedBy: userId,
    }));
    await db.insert(tasks).values(instances);

    await runBackfill();

    const notes = await noteRows(workspaceId);
    expect(notes).toHaveLength(200);
    expect(new Set(notes.map((note) => note.artifactId)).size).toBe(200);
    expect(notes.every((note) => note.template === "issue")).toBe(true);

    const versions = await versionRows(workspaceId, notes);
    expect(versions).toHaveLength(200);

    // The statement shape, not just the count: a loop would show as either a
    // second artifact insert or a plpgsql block here. The whole backfill is one
    // INSERT … SELECT … RETURNING chain plus one UPDATE, whatever the row count.
    expect(MIGRATION.match(/INSERT INTO "artifacts"/g)).toHaveLength(1);
    expect(MIGRATION.match(/INSERT INTO "artifact_versions"/g)).toHaveLength(1);
    expect(MIGRATION.match(/UPDATE "tasks" SET "note_id"/g)).toHaveLength(1);
    expect(MIGRATION).not.toMatch(/\bLOOP\b/i);
  });
});
