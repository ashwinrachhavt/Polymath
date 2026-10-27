import { and, eq, gte, ilike, isNull, notInArray, sql, type SQL } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { artifacts, artifactVersions } from "@/domains/knowledge/schema";
import { taskDependencies, tasks } from "@/domains/work/schema";
import { seedTaskWithNote } from "../helpers/task-note";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * Task prose reads from the note (one note substrate).
 *
 * Every read in work/queries.ts joins `artifacts` on `tasks.note_id` instead of
 * selecting a task column for the prose. 0260 dropped `tasks.title` and
 * `tasks.description`, so the column the read must NOT use no longer exists;
 * what is still provable, and what this suite therefore pins, is:
 *
 *  1. the prose shown is the note's CURRENT version, not the fixture's original
 *     one - every fixture is seeded with one title and body and then reworded
 *     into a version 2, so a read that returned anything but the current note
 *     (the creation values, a stale version, or a cached copy) fails;
 *  2. no task is silently dropped. An inner join on a missing note would lose
 *     rows rather than misread them, and a per-row assertion still passes on
 *     the rows that survive. Each list read is therefore checked as a set
 *     difference against the tasks the same filters say exist.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
let queries: typeof import("@/domains/work/queries");

beforeAll(async () => {
  if (!handle) return;
  ({ db } = handle);
  queries = await import("@/domains/work/queries");
});

afterAll(async () => {
  await handle?.client.end();
});

/** A task with a note, seeded under its "original" (pre-rewording) prose. */
async function seedTask(
  workspaceId: string,
  row: {
    title: string;
    description?: string | null;
    status?: (typeof tasks.$inferSelect)["status"];
    dueAt?: Date | null;
    completedAt?: Date | null;
    parentTaskId?: string;
  },
): Promise<string> {
  const created = await seedTaskWithNote(db, {
    workspaceId,
    title: row.title,
    body: row.description ?? null,
    ...(row.status ? { status: row.status } : {}),
    ...(row.dueAt ? { dueAt: row.dueAt } : {}),
    ...(row.completedAt ? { completedAt: row.completedAt } : {}),
    ...(row.parentTaskId ? { parentTaskId: row.parentTaskId } : {}),
  });
  return created.id;
}

/**
 * Give the task's note new prose: a renamed title and a version 2 body. Without
 * this the note still holds the values it was seeded with and no read can be
 * told apart from a fixture echoing its input.
 */
async function rewordNote(taskId: string, title: string, body: string | null): Promise<void> {
  const [row] = await db
    .select({ noteId: tasks.noteId, workspaceId: tasks.workspaceId })
    .from(tasks)
    .where(eq(tasks.id, taskId));
  const noteId = row.noteId!;
  const [version] = await db
    .insert(artifactVersions)
    .values({
      workspaceId: row.workspaceId,
      artifactId: noteId,
      versionNumber: 2,
      content: body ? { format: "markdown", text: body } : { type: "doc", content: [] },
      plainText: body,
      reason: "edited",
    })
    .returning({ id: artifactVersions.id });
  await db.update(artifacts).set({ title, currentVersionId: version.id }).where(eq(artifacts.id, noteId));
}

/** What the note says now, per task: the expected side of every row assertion. */
async function noteProse(workspaceId: string) {
  const rows = await db
    .select({ id: tasks.id, title: artifacts.title, plainText: artifactVersions.plainText })
    .from(tasks)
    .innerJoin(artifacts, eq(artifacts.id, tasks.noteId))
    .leftJoin(artifactVersions, eq(artifactVersions.id, artifacts.currentVersionId))
    .where(eq(tasks.workspaceId, workspaceId));
  return new Map(rows.map((row) => [row.id, row]));
}

/**
 * The set difference the row assertions cannot see: tasks matching the query's
 * own filters that the read did not return. Measured in SQL against `tasks`
 * alone, so a task the read dropped counts as missing. A filter written on the
 * note's prose passes `onNote`, which adds the same join the read has.
 */
async function missingFrom(where: SQL, returnedIds: string[], onNote = false): Promise<string[]> {
  const base = db.select({ id: tasks.id }).from(tasks);
  const source = onNote ? base.innerJoin(artifacts, eq(artifacts.id, tasks.noteId)) : base;
  const rows = await source.where(
    returnedIds.length ? and(where, notInArray(tasks.id, returnedIds)) : where,
  );
  return rows.map((row) => row.id).sort();
}

async function expectProse(
  workspaceId: string,
  returned: Array<{ id: string; title: string; description?: string | null }>,
) {
  const prose = await noteProse(workspaceId);
  for (const row of returned) {
    const note = prose.get(row.id);
    expect(note, `task ${row.id} has no note`).toBeDefined();
    expect(row.title).toBe(note!.title);
    if ("description" in row) expect(row.description).toBe(note!.plainText);
  }
}

suite("task prose reads from the note", () => {
  it("getTaskDetail shows the note's current title and body, and a subtask's title resolves through the join", async () => {
    const { userId, workspaceId } = await seedWorkspace(db, `prose-detail-${Date.now()}`);
    const a = ownerAuth(userId, workspaceId);
    const parent = await seedTask(workspaceId, { title: "Seeded parent", description: "Seeded body", status: "ready" });
    const child = await seedTask(workspaceId, { title: "Seeded child", parentTaskId: parent });
    const peer = await seedTask(workspaceId, { title: "Seeded peer" });

    await rewordNote(parent, "Parent note", "Parent note body");
    await rewordNote(child, "Child note", "Child note body");
    await rewordNote(peer, "Peer note", null);
    await db.insert(taskDependencies).values({
      workspaceId,
      taskId: parent,
      kind: "blocks",
      dependsOnTaskId: peer,
    });

    const detail = await queries.getTaskDetail(a, parent);
    expect(detail).not.toBeNull();
    // The current note version, not the prose the fixture was seeded with.
    expect(detail!.task.title).toBe("Parent note");
    expect(detail!.task.description).toBe("Parent note body");
    expect(detail!.task).toMatchObject({ status: "ready", version: 1 });

    expect(detail!.subtasks.map((s) => [s.id, s.title])).toEqual([[child, "Child note"]]);
    expect(detail!.blocking.map((b) => [b.taskId, b.title])).toEqual([[peer, "Peer note"]]);
    // A task with no body reads as an empty body, not as the seeded one.
    expect((await queries.getTaskDetail(a, peer))!.task.description).toBeNull();
  });

  it("every list read shows the note's prose and returns every task its filters match", async () => {
    const { userId, workspaceId } = await seedWorkspace(db, `prose-lists-${Date.now()}`);
    const a = ownerAuth(userId, workspaceId);
    const dueEarly = new Date("2026-03-02T12:00:00Z");
    const dueLate = new Date("2026-03-03T12:00:00Z");

    const alpha = await seedTask(workspaceId, {
      title: "Seeded Alpha",
      description: "Seeded alpha body",
      status: "ready",
      dueAt: dueEarly,
    });
    const beta = await seedTask(workspaceId, {
      title: "Seeded Beta",
      description: "Seeded beta body",
      status: "done",
      dueAt: dueLate,
      completedAt: new Date(),
    });
    const gamma = await seedTask(workspaceId, { title: "Seeded Gamma", status: "inbox" });
    const child = await seedTask(workspaceId, { title: "Seeded child", parentTaskId: alpha, dueAt: dueEarly });

    await rewordNote(alpha, "Alpha note", "Alpha note body");
    await rewordNote(beta, "Beta note", "Beta note body");
    await rewordNote(gamma, "Gamma note", null);
    await rewordNote(child, "Child note", "Child note body");

    // Open work: unfinished, subtasks included (this read has no parent
    // filter); the done task is not open work.
    const open = await queries.listOpenTasks({ workspaceId });
    expect(open.map((r) => r.id).sort()).toEqual([alpha, child, gamma].sort());
    await expectProse(workspaceId, open);
    expect(
      await missingFrom(
        and(
          eq(tasks.workspaceId, workspaceId),
          isNull(tasks.archivedAt),
          notInArray(tasks.status, ["done", "cancelled"]),
        )!,
        open.map((r) => r.id),
      ),
    ).toEqual([]);

    const recentlyDone = await queries.listRecentlyCompletedTasks({ workspaceId }, { days: 1 });
    expect(recentlyDone.map((r) => r.id)).toEqual([beta]);
    await expectProse(workspaceId, recentlyDone);
    expect(
      await missingFrom(
        and(
          eq(tasks.workspaceId, workspaceId),
          isNull(tasks.archivedAt),
          eq(tasks.status, "done"),
          gte(tasks.completedAt, new Date(Date.now() - 24 * 60 * 60 * 1000)),
        )!,
        recentlyDone.map((r) => r.id),
      ),
    ).toEqual([]);

    // The link picker filters and orders on the note's title. Searching the
    // word the fixtures were seeded with finds nothing once the note has been
    // reworded; searching the note's word finds every task, subtasks and
    // finished ones included (a finished task is still a destination). The
    // limit is raised past the fixture count on purpose - the picker's own
    // default of 3 would turn this into a pagination assertion.
    const byNoteTitle = await queries.searchTasksForLink(a, "note", 10);
    expect(byNoteTitle.map((r) => r.title)).toEqual(["Alpha note", "Beta note", "Child note", "Gamma note"]);
    expect(await queries.searchTasksForLink(a, "Seeded")).toEqual([]);
    expect(
      await missingFrom(
        and(eq(tasks.workspaceId, workspaceId), isNull(tasks.archivedAt), ilike(artifacts.title, "%note%"))!,
        byNoteTitle.map((r) => r.id),
        true,
      ),
    ).toEqual([]);

    const due = await queries.listTasksDueBetween(a, "2026-03-01", "2026-03-31");
    expect(due.map((r) => r.id).sort()).toEqual([alpha, beta].sort());
    await expectProse(workspaceId, due);
    expect(
      await missingFrom(
        and(
          eq(tasks.workspaceId, workspaceId),
          isNull(tasks.archivedAt),
          isNull(tasks.parentTaskId),
          gte(tasks.dueAt, new Date("2026-03-01T00:00:00Z")),
        )!,
        due.map((r) => r.id),
      ),
    ).toEqual([]);

    // Order is listWorkRows' own contract, tested in task-core; the assertion
    // here is membership, because every fixture shares the default rank.
    const workRows = await queries.listWorkRows(a, "open");
    expect(workRows.map((r) => r.id).sort()).toEqual([alpha, gamma].sort());
    await expectProse(workspaceId, workRows);
    const workWhere = and(
      eq(tasks.workspaceId, workspaceId),
      isNull(tasks.archivedAt),
      isNull(tasks.parentTaskId),
      notInArray(tasks.status, ["done", "cancelled"]),
    )!;
    expect(await missingFrom(workWhere, workRows.map((r) => r.id))).toEqual([]);

    // The search box filters on the note's title, and the total has to agree
    // with the rows: a count without the join would say 2 while listing 1, or
    // count a task whose note does not match.
    const filtered = await queries.listWorkPage(a, "open", { limit: 10, offset: 0, query: "Gamma" });
    expect(filtered.rows.map((r) => r.id)).toEqual([gamma]);
    expect(filtered.total).toBe(1);
    await expectProse(workspaceId, filtered.rows);
    const noneMatching = await queries.listWorkPage(a, "open", { limit: 10, offset: 0, query: "Seeded" });
    expect(noneMatching.rows).toEqual([]);
    expect(noneMatching.total).toBe(0);
    expect(
      await missingFrom(
        and(eq(tasks.workspaceId, workspaceId), isNull(tasks.parentTaskId), ilike(artifacts.title, "%Gamma%"))!,
        filtered.rows.map((r) => r.id),
        true,
      ),
    ).toEqual([]);
  });

  it("a note with no current version still reads, with no body", async () => {
    // Ruling 37's third measurement: rows where the join yields no body. The
    // version join is left, not inner, so a note whose pointer is unset reads
    // as a task with an empty body instead of disappearing from the list.
    const { userId, workspaceId } = await seedWorkspace(db, `prose-version-${Date.now()}`);
    const a = ownerAuth(userId, workspaceId);
    const taskId = await seedTask(workspaceId, { title: "No version yet", status: "ready" });
    const [row] = await db.select({ noteId: tasks.noteId }).from(tasks).where(eq(tasks.id, taskId));
    await db.update(artifacts).set({ currentVersionId: null }).where(eq(artifacts.id, row.noteId!));

    const detail = await queries.getTaskDetail(a, taskId);
    expect(detail?.task.title).toBe("No version yet");
    expect(detail?.task.description).toBeNull();
    expect((await queries.listWorkRows(a, "open")).map((r) => r.id)).toEqual([taskId]);

    // The measurement over the rest of this workspace: every live task's note
    // points at a version, so any other broken pointer means a write left a
    // task unreadable. Scoped to the workspace because the shared test database
    // carries other suites' fixtures.
    const orphans = await db.execute(sql`
      select t.id from tasks t
        join artifacts a on a.id = t.note_id
        left join artifact_versions v on v.id = a.current_version_id
       where v.id is null and t.workspace_id = ${workspaceId} and t.id <> ${taskId}`);
    expect(orphans as unknown as unknown[]).toEqual([]);
  });

  it("another workspace's task never appears in a prose read", async () => {
    const one = await seedWorkspace(db, `prose-tenant-a-${Date.now()}`);
    const two = await seedWorkspace(db, `prose-tenant-b-${Date.now()}`);
    const a = ownerAuth(one.userId, one.workspaceId);
    const mine = await seedTask(one.workspaceId, { title: "Mine", status: "ready" });
    const theirs = await seedTask(two.workspaceId, { title: "Theirs", status: "ready" });

    expect((await queries.listOpenTasks({ workspaceId: one.workspaceId })).map((r) => r.id)).toEqual([mine]);
    expect((await queries.listWorkRows(a, "open")).map((r) => r.id)).toEqual([mine]);
    expect(await queries.getTaskDetail(a, theirs)).toBeNull();
    expect(await queries.searchTasksForLink(a, "Theirs")).toEqual([]);
  });
});
