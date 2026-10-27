import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";
import { artifacts, artifactVersions } from "@/domains/knowledge/schema";
import { auditEvents } from "@/domains/audit/schema";
import { focusSessions } from "@/domains/focus/schema";
import { captures } from "@/domains/capture/schema";
import { tasks } from "@/domains/work/schema";

/*
 * The daybook invariants (eng review T1/T2): the day page is a view whose
 * bounds derive from user_preferences at read time, and pins are its only
 * persisted state. A mock cannot prove the composite FK rejects a
 * cross-artifact version pin, that bounds survive DST, or that a
 * midnight-crossing session shows on both days — these run against real
 * Postgres.
 *
 * Skipped unless TEST_DATABASE_URL points at a database with the migrations
 * applied (see spending.test.ts for the lazy-import rationale).
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
const holder: { db: ReturnType<typeof drizzle> | undefined } = { db: undefined };
vi.mock("@/lib/db", () => ({ get db() { return holder.db; } }));

let queries: typeof import("@/domains/daybook/queries");
let commands: typeof import("@/domains/daybook/commands");
let work: typeof import("@/domains/work/commands");

beforeAll(async () => {
  if (!handle) return;
  holder.db = handle.db;
  queries = await import("@/domains/daybook/queries");
  commands = await import("@/domains/daybook/commands");
  work = await import("@/domains/work/commands");
});

async function noteWithVersion(
  workspaceId: string,
  userId: string,
  title: string,
  createdAt: Date,
): Promise<{ artifactId: string; versionId: string }> {
  const db = holder.db!;
  const [artifact] = await db
    .insert(artifacts)
    .values({ workspaceId, kind: "note", title, createdAt, updatedAt: createdAt, createdBy: userId, updatedBy: userId })
    .returning({ id: artifacts.id });
  const [version] = await db
    .insert(artifactVersions)
    .values({ workspaceId, artifactId: artifact.id, versionNumber: 1, content: { type: "doc", content: [] }, createdBy: userId })
    .returning({ id: artifactVersions.id });
  await db.update(artifacts).set({ currentVersionId: version.id }).where(eq(artifacts.id, artifact.id));
  await db.insert(auditEvents).values({
    workspaceId,
    actorId: userId,
    actorKind: "user",
    action: "note.created",
    subjectType: "artifact",
    subjectId: artifact.id,
    summary: `Created note "${title}"`,
    createdAt,
  });
  return { artifactId: artifact.id, versionId: version.id };
}

suite("daybook (Neon)", () => {
  let auth: ReturnType<typeof ownerAuth>;
  let ws: { userId: string; workspaceId: string };

  beforeAll(async () => {
    if (!handle) return;
    const seed = await seedWorkspace(handle.db, `daybook-${Date.now()}`);
    ws = seed;
    auth = ownerAuth(seed.userId, seed.workspaceId);
    await handle.db.execute(
      sql`insert into user_preferences (workspace_id, user_id, timezone) values (${seed.workspaceId}, ${seed.userId}, 'America/Los_Angeles')`,
    );
  });

  it("derives day bounds from the read-time timezone, not UTC", async () => {
    if (!handle) return;
    // 2026-10-22 20:00 Los Angeles = 2026-10-23 03:00 UTC: an artifact created
    // then belongs to LA's Oct 22, not UTC's Oct 23.
    const at = new Date("2026-10-23T03:00:00Z");
    const { artifactId } = await noteWithVersion(ws.workspaceId, ws.userId, "late-evening note", at);
    const day = await queries.getDayPage(auth, "2026-10-22");
    expect(day.timezone).toBe("America/Los_Angeles");
    expect(day.created.map((r) => r.id)).toContain(artifactId);
    const nextDay = await queries.getDayPage(auth, "2026-10-23");
    expect(nextDay.created.map((r) => r.id)).not.toContain(artifactId);
  });

  it("keeps a DST-spring artifact on one day and never double-counts", async () => {
    if (!handle) return;
    // 2026-03-08 01:30 PST (before the 02:00 jump) and 03:30 PDT (after).
    const before = new Date("2026-03-08T09:30:00Z"); // 01:30 PST
    const after = new Date("2026-03-08T10:30:00Z"); // 03:30 PDT (DST began 10:00Z)
    const a = await noteWithVersion(ws.workspaceId, ws.userId, "pre-jump", before);
    const b = await noteWithVersion(ws.workspaceId, ws.userId, "post-jump", after);
    const day = await queries.getDayPage(auth, "2026-03-08");
    expect(day.created.map((r) => r.id)).toContain(a.artifactId);
    expect(day.created.map((r) => r.id)).toContain(b.artifactId);
    expect(day.created).toHaveLength(2);
  });

  it("shows a midnight-crossing session on both days", async () => {
    if (!handle) return;
    await holder.db!.insert(focusSessions).values({
      workspaceId: ws.workspaceId,
      subject: "night stretch",
      state: "finished",
      startedAt: new Date("2026-10-22T23:30:00Z"), // 16:30 LA Oct 22
      endedAt: new Date("2026-10-23T01:00:00Z"), // 18:00 LA Oct 22 — still same LA day
    });
    // A session that truly crosses LA midnight: 18:00 Oct 22 -> 01:00 Oct 23 LA time.
    const [crossing] = await holder.db!
      .insert(focusSessions)
      .values({
        workspaceId: ws.workspaceId,
        subject: "across midnight",
        state: "finished",
        startedAt: new Date("2026-10-23T01:00:00Z"), // 18:00 LA Oct 22
        endedAt: new Date("2026-10-23T08:00:00Z"), // 01:00 LA Oct 23
      })
      .returning({ id: focusSessions.id });
    const day22 = await queries.getDayPage(auth, "2026-10-22");
    const day23 = await queries.getDayPage(auth, "2026-10-23");
    expect(day22.sessions.map((s) => s.id)).toContain(crossing.id);
    expect(day23.sessions.map((s) => s.id)).toContain(crossing.id);
    expect(day23.sessions.map((s) => s.id)).not.toContain("never-inserted");
    void focusSessions;
  });

  it("excludes agent and system actors from worked-on", async () => {
    if (!handle) return;
    await holder.db!.insert(auditEvents).values({
      workspaceId: ws.workspaceId,
      actorId: ws.userId,
      actorKind: "agent",
      action: "note.snapshot",
      subjectType: "artifact",
      subjectId: ws.workspaceId,
      summary: "agent-generated version",
      createdAt: new Date("2026-10-22T20:00:00Z"),
    });
    await holder.db!.insert(auditEvents).values({
      workspaceId: ws.workspaceId,
      actorId: ws.userId,
      actorKind: "user",
      action: "note.snapshot",
      subjectType: "artifact",
      subjectId: ws.workspaceId,
      summary: "human edit",
      createdAt: new Date("2026-10-22T20:05:00Z"),
    });
    const day = await queries.getDayPage(auth, "2026-10-22");
    const summaries = day.workedOn.map((r) => r.title);
    expect(summaries).toContain("human edit");
    expect(summaries).not.toContain("agent-generated version");
  });

  it("rejects pinning a version from a different artifact (composite FK)", async () => {
    if (!handle) return;
    const a = await noteWithVersion(ws.workspaceId, ws.userId, "artifact a", new Date("2026-10-22T18:00:00Z"));
    const b = await noteWithVersion(ws.workspaceId, ws.userId, "artifact b", new Date("2026-10-22T18:05:00Z"));
    await expect(
      commands.pinArtifactToDay(auth, { localDate: "2026-10-22", artifactId: b.artifactId, pinnedVersionId: a.versionId }),
    ).rejects.toThrow();
  });

  it("keeps pins idempotent per (user, local_date, artifact)", async () => {
    if (!handle) return;
    const a = await noteWithVersion(ws.workspaceId, ws.userId, "pinned once", new Date("2026-10-22T18:00:00Z"));
    const first = await commands.pinArtifactToDay(auth, { localDate: "2026-10-22", artifactId: a.artifactId });
    const second = await commands.pinArtifactToDay(auth, { localDate: "2026-10-22", artifactId: a.artifactId });
    const day = await queries.getDayPage(auth, "2026-10-22");
    expect(day.pins).toHaveLength(1);
    expect(day.pins[0].artifactId).toBe(a.artifactId);
    expect(first.id).toBeTruthy();
    expect(second.id).toBeTruthy();
    expect(day.pins[0].pinnedVersionNumber).toBeNull();
  });

  it("renders an archived pinned artifact with its archived state", async () => {
    if (!handle) return;
    const a = await noteWithVersion(ws.workspaceId, ws.userId, "archived pin", new Date("2026-10-22T18:00:00Z"));
    await commands.pinArtifactToDay(auth, { localDate: "2026-10-21", artifactId: a.artifactId });
    await holder.db!.update(artifacts).set({ archivedAt: new Date() }).where(eq(artifacts.id, a.artifactId));
    const day = await queries.getDayPage(auth, "2026-10-21");
    expect(day.pins).toHaveLength(1);
    expect(day.pins[0].archived).toBe(true);
  });

  it("shows a processed capture on its capture day", async () => {
    if (!handle) return;
    await holder.db!.insert(captures).values({
      workspaceId: ws.workspaceId,
      kind: "text",
      captureMode: "authored",
      rawPayload: { text: "a captured thought" },
      text: "a captured thought",
      processingState: "enriched",
      createdAt: new Date("2026-10-22T19:00:00Z"),
      createdBy: ws.userId,
      updatedBy: ws.userId,
    });
    const day = await queries.getDayPage(auth, "2026-10-22");
    expect(day.captured.map((c) => c.title)).toContain("a captured thought");
  });

  it("lists one task creation exactly once across created and worked-on", async () => {
    if (!handle) return;
    // A task is a note plus an extension row, and createOwnerTask writes both a
    // note.created and a task.created audit row. The day page must still show
    // one entry: the task's own creation. Its note is not a separately created
    // note, and the Created panel already lists artifacts, so a note.created
    // audit row alongside it would make one act look like two.
    const created = await work.createOwnerTask(auth, { title: "One act, one entry" });
    const [row] = await holder.db!
      .select({ id: tasks.id, noteId: tasks.noteId })
      .from(tasks)
      .where(eq(tasks.id, created.id));
    const [artifact] = await holder.db!
      .select({ createdAt: artifacts.createdAt })
      .from(artifacts)
      .where(eq(artifacts.id, row.noteId!));

    // The day the seed actually landed on, with a margin wide enough for the
    // test's timezone offset so the assertion never depends on what time it is.
    const dayOf = (at: Date) => {
      const shifted = new Date(at.getTime() - 12 * 3_600_000);
      return shifted.toISOString().slice(0, 10);
    };
    // The task and the note it stands on are the only ids this act could have
    // produced, so counting their appearances across both panels is the whole
    // question.
    const counted: string[] = [];
    // Both brackets usually resolve to the same local date; query it once.
    for (const localDate of new Set([dayOf(artifact.createdAt), dayOf(new Date())])) {
      const day = await queries.getDayPage(auth, localDate);
      for (const item of [...day.created, ...day.workedOn]) {
        if (item.id === created.id || item.id === row.noteId) counted.push(item.id);
      }
    }

    // The exact count, not "the panel renders": one task creation is one entry,
    // and it is the task's own - its note is not a separately created note.
    expect(counted).toEqual([created.id]);
  });

  it("rejects a malformed local date", async () => {
    if (!handle) return;
    await expect(queries.getDayPage(auth, "2026-10-22; drop table users")).rejects.toThrow("Invalid local date");
    await expect(commands.pinArtifactToDay(auth, { localDate: "not-a-date", artifactId: crypto.randomUUID() })).rejects.toThrow(
      "Invalid local date",
    );
  });

  it("re-opens the same daily note for one day instead of creating another", async () => {
    if (!handle) return;
    const dailyNote = await import("@/domains/daybook/daily-note");
    const first = await dailyNote.getOrCreateDailyNote(auth, {
      localDate: "2026-10-22",
      idempotencyKey: `daybook-daily-${ws.workspaceId}-2026-10-22-1`,
    });
    const second = await dailyNote.getOrCreateDailyNote(auth, {
      localDate: "2026-10-22",
      idempotencyKey: `daybook-daily-${ws.workspaceId}-2026-10-22-2`,
    });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.id).toBe(first.id);
  });
});
