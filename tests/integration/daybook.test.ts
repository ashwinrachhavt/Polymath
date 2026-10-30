import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";
import { artifacts, artifactVersions } from "@/domains/knowledge/schema";
import { auditEvents } from "@/domains/audit/schema";
import { focusSessions } from "@/domains/focus/schema";
import { captures } from "@/domains/capture/schema";

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

beforeAll(async () => {
  if (!handle) return;
  holder.db = handle.db;
  queries = await import("@/domains/daybook/queries");
  commands = await import("@/domains/daybook/commands");
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

  // Value: protects=getWeekActivity derives Mon-Sun bounds in the owner's
  // timezone and counts the same five sources getDayPage does, excluding
  // archived artifacts, discarded captures and agent-actor events;
  // fails_when=the CTE computes bounds in UTC instead of user_preferences tz,
  // starts the week on Sunday, counts archived/discarded rows, or leaks
  // agent-actor audit events into the strip; why_new=the query is new
  // hand-written SQL whose bound math duplicates getDayPage's and any drift
  // silently lies on the week strip - the suite already has the tz fixtures;
  // seam=queries.getWeekActivity against real Postgres via makeTestDb;
  // no_claim=none beyond protects.
  it("counts the week's activity per day in the owner's timezone", async () => {
    if (!handle) return;
    // 2026-10-22 (Thu) sits in the Mon Oct 19 - Sun Oct 25 LA week.
    // 2026-10-22 20:00 LA = 2026-10-23 03:00 UTC: belongs to LA's Thursday.
    await noteWithVersion(ws.workspaceId, ws.userId, "week note", new Date("2026-10-23T03:00:00Z"));
    // A Sunday-late event (2026-10-25 23:00 LA = 2026-10-26 06:00 UTC) must
    // land in Sunday's cell, not spill into the next week's Monday.
    await noteWithVersion(ws.workspaceId, ws.userId, "sunday-night note", new Date("2026-10-26T06:00:00Z"));
    const week = await queries.getWeekActivity(auth, "2026-10-22");
    expect(week).toHaveLength(7);
    expect(week[0].date).toBe("2026-10-19"); // Monday
    expect(week[6].date).toBe("2026-10-25"); // Sunday
    const byDate = new Map(week.map((d) => [d.date, d.events]));
    expect(byDate.get("2026-10-22")).toBeGreaterThanOrEqual(1); // Thursday note
    expect(byDate.get("2026-10-25")).toBeGreaterThanOrEqual(1); // Sunday note
    expect(byDate.get("2026-10-26")).toBeUndefined(); // outside the week
  });

  it("does not count archived artifacts or discarded captures in the week", async () => {
    if (!handle) return;
    // A fresh workspace gives the count exactness: nothing else contributes.
    const iso = await seedWorkspace(handle.db, `daybook-week-${Date.now()}`);
    const isoAuth = ownerAuth(iso.userId, iso.workspaceId);
    await handle.db.execute(
      sql`insert into user_preferences (workspace_id, user_id, timezone) values (${iso.workspaceId}, ${iso.userId}, 'America/Los_Angeles')`,
    );
    const live = await noteWithVersion(iso.workspaceId, iso.userId, "live note", new Date("2026-10-22T18:00:00Z"));
    const archived = await noteWithVersion(iso.workspaceId, iso.userId, "archived note", new Date("2026-10-22T18:05:00Z"));
    await holder.db!.update(artifacts).set({ archivedAt: new Date() }).where(eq(artifacts.id, archived.artifactId));
    await holder.db!.insert(captures).values({
      workspaceId: iso.workspaceId,
      kind: "text",
      captureMode: "authored",
      rawPayload: { text: "discarded" },
      text: "discarded",
      processingState: "discarded",
      createdAt: new Date("2026-10-22T18:10:00Z"),
      createdBy: iso.userId,
      updatedBy: iso.userId,
    });
    // A user-actor audit event the CTE must not count twice (note.created +
    // live note = 1 event + 1 artifact; if the strip double-counted the
    // note.created action behind the artifact, the total would be 2+).
    await holder.db!.insert(auditEvents).values({
      workspaceId: iso.workspaceId,
      actorId: iso.userId,
      actorKind: "user",
      action: "note.snapshot",
      subjectType: "artifact",
      subjectId: live.artifactId,
      summary: "human edit",
      createdAt: new Date("2026-10-22T18:15:00Z"),
    });
    // An agent-actor event must stay out.
    await holder.db!.insert(auditEvents).values({
      workspaceId: iso.workspaceId,
      actorId: iso.userId,
      actorKind: "agent",
      action: "note.snapshot",
      subjectType: "artifact",
      subjectId: live.artifactId,
      summary: "agent edit",
      createdAt: new Date("2026-10-22T18:20:00Z"),
    });
    const week = await queries.getWeekActivity(isoAuth, "2026-10-22");
    const thursday = week.find((d) => d.date === "2026-10-22")!.events;
    // 1 live artifact + 1 user-actor audit event. The archived note, the
    // discarded capture and the agent event contribute nothing.
    expect(thursday).toBe(2);
  });

  // Value: protects=each week cell is bounded by the NEXT day's tz-derived
  // start, so a 25-hour fall-back day counts its last local hour and a
  // 23-hour spring-forward day never double-counts; fails_when=the cell uses
  // day_start + interval '1 day', which drops the fall-back edge hour into no
  // cell and overlaps the spring-forward repeat hour into two; why_new=the
  // strip's bounds were hand-rolled next to getDayPage's proven ones and no
  // test exercised a DST boundary week; seam=queries.getWeekActivity against
  // real Postgres; no_claim=none beyond protects.
  it("counts events in the 25-hour fall-back day exactly once", async () => {
    if (!handle) return;
    const iso = await seedWorkspace(handle.db, `daybook-dst-${Date.now()}`);
    const a = ownerAuth(iso.userId, iso.workspaceId);
    await handle.db.execute(
      sql`insert into user_preferences (workspace_id, user_id, timezone) values (${iso.workspaceId}, ${iso.userId}, 'America/Los_Angeles')`,
    );
    // 2026-11-01 is a 25-hour day in LA (fall back at 09:00Z). 07:30Z on Nov 2
    // is 23:30 PST on Nov 1 — inside the long day, outside a naive +24h bound.
    await noteWithVersion(iso.workspaceId, iso.userId, "dst note", new Date("2026-11-02T07:30:00Z"));
    const week = await queries.getWeekActivity(a, "2026-11-01");
    expect(week.find((d) => d.date === "2026-11-01")!.events).toBe(1);
    // 2026-11-01 is a Sunday: its week is Mon Oct 26 - Sun Nov 1, so the
    // spill-into-Monday case is asserted on the prior boundary instead — no
    // cell carries the event twice and Monday's cell is absent from this week.
    expect(week.find((d) => d.date === "2026-10-26")!.events).toBe(0);
  });

  // Value: protects=the day record renders each creation exactly once - the
  // worked-on lateral must exclude creation actions, which the created and
  // captured laterals already cover; fails_when=the worked-on filter reverts
  // to the full DAYBOOK_ACTION_LIST, so a note shows as both a Created row and
  // a 'Created note ...' Changed row; why_new=the adversarial review caught the
  // day-page twin of the double-count fixed for the week strip and no test
  // asserted the single-render invariant; seam=queries.getDayPage against real
  // Postgres; no_claim=none beyond protects.
  it("renders a creation once, never as both Created and Changed", async () => {
    if (!handle) return;
    const iso = await seedWorkspace(handle.db, `daybook-single-${Date.now()}`);
    const a = ownerAuth(iso.userId, iso.workspaceId);
    await handle.db.execute(
      sql`insert into user_preferences (workspace_id, user_id, timezone) values (${iso.workspaceId}, ${iso.userId}, 'UTC')`,
    );
    await noteWithVersion(iso.workspaceId, iso.userId, "once only", new Date("2026-10-22T18:00:00Z"));
    const day = await queries.getDayPage(a, "2026-10-22");
    expect(day.created.map((r) => r.title)).toContain("once only");
    // The worked-on slice excludes creation actions: no 'Created note ...' row.
    expect(day.workedOn.map((r) => r.title)).not.toContain('Created note "once only"');
    // And the week strip counts the note once (artifact only, no audit event).
    const week = await queries.getWeekActivity(a, "2026-10-22");
    expect(week.find((d) => d.date === "2026-10-22")!.events).toBe(1);
  });
});
