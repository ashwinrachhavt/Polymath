import { readFileSync } from "node:fs";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeTestDb, seedWorkspace } from "../helpers/test-workspace";

/*
 * One note substrate, phase two (0260). The drop is the irreversible half: after
 * this file runs a task is an artifacts row plus a 1:1 extension row, and there
 * is no tasks.title / tasks.description left to drift from the note.
 *
 * The migration file itself is what runs here, never a transcription of it. The
 * suite asserts three things about the shipped SQL:
 *
 *  - the binding is required (note_id NOT NULL) and 1:1 (tasks_note_key), so a
 *    task cannot exist without a note and two tasks cannot share one;
 *  - a note backing a task cannot be deleted out from under it; the FK from
 *    0259 refuses rather than cascades, and the API is expected to turn that
 *    refusal into a 409;
 *  - the abort precedes the drops. This is the assertion that proves the order:
 *    with an orphan row present the file must raise and leave title/description
 *    in place, because a partial apply that reached DROP COLUMN would be
 *    unrecoverable.
 *
 * The abort case runs in a throwaway schema rather than on the real tasks
 * table. The real table can only be dropped once, so seeding an orphan into it
 * would make the suite pass exactly once per database; a shadow table with the
 * pre-0260 shape lets the shipped file execute verbatim on every run and pin the
 * ordering without touching the rows other suites share.
 *
 * Applying the real migration is guarded: on CI the migration runner has already
 * applied 0260 before vitest starts (psql in glob order), so the file only runs
 * here when tasks.title is still present.
 */

const MIGRATION = readFileSync("src/db/migrations/0260_one_note_substrate_drop.sql", "utf8");

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let client: NonNullable<typeof handle>["client"];
let db: NonNullable<typeof handle>["db"];

beforeAll(async () => {
  if (!handle) return;
  ({ client, db } = handle);
  // Only on a database that is still at 0259. Re-running the file on an already
  // dropped table would fail on SET NOT NULL's absent column, so the guard is
  // also what makes this suite repeatable locally.
  if (await hasColumn("title")) {
    await client.unsafe(MIGRATION);
  }
});

afterAll(async () => {
  await client?.end();
});

async function hasColumn(column: string): Promise<boolean> {
  const rows = await client.unsafe(
    `select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'tasks' and column_name = $1`,
    [column],
  );
  return rows.length > 0;
}

/** The pg error code for a statement that must be refused. */
async function rejection(statement: Promise<unknown>): Promise<{ code?: string; message: string }> {
  try {
    await statement;
  } catch (error) {
    return error as { code?: string; message: string };
  }
  throw new Error("expected the statement to be rejected, but it succeeded");
}

/** A note in the workspace, inserted raw so a test can also insert one with a null id. */
async function insertNote(workspaceId: string, userId: string, title: string): Promise<string> {
  const [note] = await client.unsafe(
    `insert into artifacts (workspace_id, kind, title, created_by, updated_by)
     values ($1, 'note', $2, $3, $4) returning id`,
    [workspaceId, title, userId, userId],
  );
  return note!.id as string;
}

suite("one note substrate drop (0260)", () => {
  it("aborts instead of dropping when a task has no note", async () => {
    // The ordering, in the file's own text: the raise is above every destructive
    // statement, so no reader can reorder them without failing here.
    expect(MIGRATION.indexOf("RAISE EXCEPTION")).toBeLessThan(MIGRATION.indexOf('DROP COLUMN "title"'));

    const schema = `t7_drop_${Date.now()}`;
    const shadow = postgres(process.env.TEST_DATABASE_URL!, { max: 1 });
    // One reserved connection: `search_path` is session state and the migration
    // names "tasks" unqualified, so every statement must land on the session
    // that points at the shadow schema.
    const session = await shadow.reserve();
    try {
      await session.unsafe(`create schema "${schema}"`);
      await session.unsafe(`create table "${schema}"."tasks" (
        id uuid primary key default gen_random_uuid(),
        note_id uuid,
        title text not null,
        description text
      )`);
      // The orphan this file must refuse to migrate.
      await session.unsafe(`insert into "${schema}"."tasks" (title, description) values ('Has no note', 'Body')`);
      await session.unsafe(`set search_path to "${schema}"`);

      // Statements in the written order, stopping at the first error the way the
      // runner does (CI applies migrations with psql -v ON_ERROR_STOP=1, and
      // drizzle's migrator wraps a migration in a transaction). This is what
      // proves the order: a DROP moved above the raise would execute first and
      // the assertion on title below would fail. The index the loop stops at is
      // asserted to be the guard itself, so "nothing destructive ran" is a
      // measured fact rather than a reading of the file.
      const statements = MIGRATION.split("--> statement-breakpoint");
      let failure: { code?: string; message: string } | undefined;
      let stoppedAt = -1;
      for (const [index, statement] of statements.entries()) {
        try {
          await session.unsafe(statement);
        } catch (error) {
          failure = error as { code?: string; message: string };
          stoppedAt = index;
          break;
        }
      }
      expect(stoppedAt).toBe(0);
      expect(failure).toBeDefined();
      expect(failure!.message).toMatch(/backfill is incomplete/);
      // 23514 (check_violation), not a syntax or missing-column error: the raise
      // fired because of the orphan and for no other reason.
      expect(failure!.code).toBe("23514");

      // Nothing was dropped, and the binding was not tightened: the two columns
      // the destructive half would have removed are both still there.
      const columns = await session.unsafe(
        `select column_name, is_nullable from information_schema.columns
          where table_schema = $1 and table_name = 'tasks'`,
        [schema],
      );
      const byName = new Map(columns.map((row) => [row.column_name as string, row.is_nullable as string]));
      expect(byName.get("title")).toBe("NO");
      expect(byName.get("description")).toBe("YES");
      expect(byName.get("note_id")).toBe("YES");
      const [orphan] = await session.unsafe(`select note_id from "${schema}"."tasks"`);
      expect(orphan!.note_id).toBeNull();
    } finally {
      session.release();
      await shadow.unsafe(`drop schema if exists "${schema}" cascade`).catch(() => {});
      await shadow.end();
    }
  });

  it("leaves note_id required, unique, and the prose columns gone", async () => {
    expect(await hasColumn("title")).toBe(false);
    expect(await hasColumn("description")).toBe(false);

    const [noteId] = await client.unsafe(
      `select is_nullable from information_schema.columns
        where table_schema = 'public' and table_name = 'tasks' and column_name = 'note_id'`,
    );
    expect(noteId!.is_nullable).toBe("NO");

    const [noteKey] = await client.unsafe(
      `select indexdef from pg_indexes where schemaname = 'public' and indexname = 'tasks_note_key'`,
    );
    expect(noteKey!.indexdef).toMatch(/CREATE UNIQUE INDEX/);
    expect(noteKey!.indexdef).toMatch(/\(note_id\)/);
  });

  it("refuses a task with no note", async () => {
    const { userId, workspaceId } = await seedWorkspace(db, `drop-null-${Date.now()}`);
    // Raw, because the Drizzle type no longer lets a caller omit note_id; this
    // asserts the database says the same thing the type does.
    const error = await rejection(
      client.unsafe(
        `insert into tasks (workspace_id, created_by, updated_by) values ($1, $2, $3)`,
        [workspaceId, userId, userId],
      ),
    );
    expect(error.code).toBe("23502");
    expect(error.message).toMatch(/note_id/);
  });

  it("refuses a second task on the same note", async () => {
    const { userId, workspaceId } = await seedWorkspace(db, `drop-dupe-${Date.now()}`);
    const noteId = await insertNote(workspaceId, userId, "The one note");
    await client.unsafe(`insert into tasks (workspace_id, note_id, created_by, updated_by) values ($1, $2, $3, $4)`, [
      workspaceId,
      noteId,
      userId,
      userId,
    ]);

    const error = await rejection(
      client.unsafe(`insert into tasks (workspace_id, note_id, created_by, updated_by) values ($1, $2, $3, $4)`, [
        workspaceId,
        noteId,
        userId,
        userId,
      ]),
    );
    expect(error.code).toBe("23505");
    expect(error.message).toMatch(/tasks_note_key/);
  });

  it("refuses to delete the note that backs a task", async () => {
    const { userId, workspaceId } = await seedWorkspace(db, `drop-delete-${Date.now()}`);
    const noteId = await insertNote(workspaceId, userId, "Pinned by a task");
    await client.unsafe(`insert into tasks (workspace_id, note_id, created_by, updated_by) values ($1, $2, $3, $4)`, [
      workspaceId,
      noteId,
      userId,
      userId,
    ]);

    const error = await rejection(client.unsafe(`delete from artifacts where id = $1`, [noteId]));
    // NO ACTION, not CASCADE: the note is not disposable, and the route turns
    // this refusal into a 409 rather than losing the task's only copy of its
    // prose.
    expect(error.code).toBe("23503");
    expect(error.message).toMatch(/tasks_note_id_artifacts_id_fk/);

    const [survivor] = await client.unsafe(`select count(*)::int as n from tasks where note_id = $1`, [noteId]);
    expect(survivor!.n).toBe(1);
  });
});
