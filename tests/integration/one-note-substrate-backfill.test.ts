import { readFileSync } from "node:fs";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, type TestContext } from "vitest";
import { artifacts, artifactVersions } from "@/domains/knowledge/schema";
import { recurrenceTemplates } from "@/domains/work/schema";
import { makeTestDb, seedWorkspace } from "../helpers/test-workspace";

/*
 * One note substrate, phase one (0259). Every existing task gains a note: an
 * artifacts row of kind `note` carrying the `issue` template, plus version 1
 * whose plain text is the task's description (or an empty doc when there is
 * none), and tasks.note_id pointing at it.
 *
 * This suite tests a migration that is now history. 0259 reads `tasks.title`
 * and `tasks.description`, and 0260 dropped both - so on a database past 0260
 * the file cannot run at all, and pretending otherwise would need a second
 * schema. The suite therefore SKIPS when the columns are absent (checked in
 * `information_schema`, per test, with the reason attached) and still runs in
 * full against a database that stops before 0260. The fixtures are raw SQL for
 * the same reason: naming the dropped columns through Drizzle cannot compile
 * now that the schema no longer declares them.
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

const SKIP_REASON =
  "requires tasks.title / tasks.description, which 0260 drops; run this suite against a database migrated to 0259 only";

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
let noteMarkdown: typeof import("@/app/(workspace)/alfred/notes/page").noteMarkdown;
/** Whether this database still has the pre-0260 columns 0259 reads. */
let legacyColumns = false;

beforeAll(async () => {
  if (!handle) return;
  ({ db } = handle);
  // Lazy, after makeTestDb has pointed DATABASE_URL at the scratch database:
  // the notes page reaches @/lib/db at module load.
  ({ noteMarkdown } = await import("@/app/(workspace)/alfred/notes/page"));

  const columns = (await db.execute(sql`
    select column_name from information_schema.columns
     where table_schema = 'public' and table_name = 'tasks'
       and column_name in ('title', 'description')`)) as unknown as { column_name: string }[];
  legacyColumns = columns.length === 2;
});

afterAll(async () => {
  await handle?.client.end();
});

/** Skip with the reason visible in the reporter, rather than passing vacuously. */
function requireLegacyColumns(ctx: TestContext) {
  if (!legacyColumns) ctx.skip(SKIP_REASON);
}

async function runBackfill(): Promise<void> {
  await handle!.client.unsafe(MIGRATION);
}

/** A pre-0260 task row, written in raw SQL because the columns are gone from the schema. */
async function insertLegacyTask(
  row: { title: string; description: string | null; recurrenceTemplateId?: string },
  ids: { workspaceId: string; userId: string },
): Promise<string> {
  const rows = (await db.execute(sql`
    insert into tasks (workspace_id, title, description, created_by, updated_by, recurrence_template_id)
    values (${ids.workspaceId}, ${row.title}, ${row.description}, ${ids.userId}, ${ids.userId}, ${row.recurrenceTemplateId ?? null})
    returning id`)) as unknown as { id: string }[];
  return rows[0]!.id;
}

type NoteRow = {
  noteId: string | null;
  description: string | null;
  artifactId: string;
  artifactTitle: string;
  template: string | null;
  kind: string;
  artifactWorkspaceId: string;
  currentVersionId: string | null;
};

async function noteRows(workspaceId: string): Promise<NoteRow[]> {
  return (await db.execute(sql`
    select t.note_id as "noteId",
           t.description as "description",
           a.id as "artifactId",
           a.title as "artifactTitle",
           a.template as "template",
           a.kind as "kind",
           a.workspace_id as "artifactWorkspaceId",
           a.current_version_id as "currentVersionId"
      from tasks t
      join artifacts a on a.id = t.note_id
     where t.workspace_id = ${workspaceId}`)) as unknown as NoteRow[];
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
  it("gives every task a note, in the task's workspace, and never by title", async (ctx) => {
    requireLegacyColumns(ctx);
    const { userId, workspaceId } = await seedWorkspace(db, `notes-backfill-${Date.now()}`);
    const ids = { workspaceId, userId };
    // Same title, different bodies: title-matching would collide here.
    const seeded = await Promise.all([
      insertLegacyTask(
        {
          title: "Ship the weekly digest",
          description: "Send it Friday, to the paying customers first.",
        },
        ids,
      ),
      insertLegacyTask({ title: "Ship the weekly digest", description: null }, ids),
      insertLegacyTask(
        {
          title: "Whitespace only",
          // Not null, but the same nothing: content and plain_text must agree
          // that this note is empty rather than storing a body of spaces.
          description: "  \n\t ",
        },
        ids,
      ),
    ]);
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

  it("writes a body the Notes surface can actually render", async (ctx) => {
    requireLegacyColumns(ctx);
    const { userId, workspaceId } = await seedWorkspace(db, `notes-render-${Date.now()}`);
    const description = "Cut the release on Wednesday, then post the changelog.";
    await insertLegacyTask({ title: "Release the digest", description }, { workspaceId, userId });

    await runBackfill();

    const [note] = await noteRows(workspaceId);
    const [version] = await versionRows(workspaceId, [note!]);
    // The consequence, end to end: the real reader this defect was reported
    // against returns the description, not "". noteMarkdown is the exact
    // function the /alfred/notes page uses, so this is the assertion that would
    // have caught the original bug at the level a user would notice it.
    expect(noteMarkdown(version!.content as Record<string, unknown>)).toBe(description);
  });

  it("is idempotent: a second run inserts no artifact and no version", async (ctx) => {
    requireLegacyColumns(ctx);
    const { userId, workspaceId } = await seedWorkspace(db, `notes-idempotent-${Date.now()}`);
    const ids = { workspaceId, userId };
    for (const n of [1, 2, 3]) {
      await insertLegacyTask({ title: `Retry check ${n}`, description: n === 2 ? null : `Body ${n}` }, ids);
    }

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

  it("fans a recurrence template's 200 instances out in one statement set", async (ctx) => {
    requireLegacyColumns(ctx);
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

    // One INSERT … SELECT, so the fixture itself stays a fan-out rather than
    // 200 round trips that would make the migration's cost unreadable.
    await db.execute(sql`
      insert into tasks (workspace_id, recurrence_template_id, title, description, created_by, updated_by)
      select ${workspaceId}, ${template!.id}, 'Weekly review',
             case when i % 2 = 0 then 'Instance ' || i else null end,
             ${userId}, ${userId}
        from generate_series(0, 199) as i`);

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
