import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentProfiles, agentRuns } from "@/domains/agents/schema";
import { calendars, eventAttendees, events } from "@/domains/calendar/schema";
import { userPreferences } from "@/domains/identity/schema";
import { externalAccounts, syncCursors } from "@/domains/integrations/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * ASH-282 against a real database: the conflict window read (tenancy, source,
 * links, attendees, timezone, sync freshness), and the propose-then-approve
 * path with the checks that must bite at propose time.
 *
 * Skipped unless TEST_DATABASE_URL points at a migrated scratch database.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let queries: typeof import("@/domains/calendar/conflict-queries");
let service: typeof import("@/domains/calendar/conflict-proposals");
let cal: typeof import("@/domains/calendar/commands");
let proposals: typeof import("@/domains/calendar/proposals");
let work: typeof import("@/domains/work/commands");

beforeAll(async () => {
  if (!handle) return;
  queries = await import("@/domains/calendar/conflict-queries");
  service = await import("@/domains/calendar/conflict-proposals");
  cal = await import("@/domains/calendar/commands");
  proposals = await import("@/domains/calendar/proposals");
  work = await import("@/domains/work/commands");
});
afterAll(async () => {
  await handle?.client.end();
});

const at = (day: number, h: number, m = 0) => new Date(Date.UTC(2030, 0, day, h, m));
const from = at(7, 0); // a Monday, far from "now"
const to = at(14, 0);

async function seed(slug: string) {
  const { userId, workspaceId } = await seedWorkspace(handle!.db, `${slug}-${crypto.randomUUID().slice(0, 8)}`);
  return { auth: ownerAuth(userId, workspaceId), userId, workspaceId };
}

async function seedRun(workspaceId: string, userId: string, allowedTools: string[]) {
  const db = handle!.db;
  const [profile] = await db.insert(agentProfiles).values({ workspaceId, name: `alfred-${crypto.randomUUID()}` }).returning();
  const [run] = await db
    .insert(agentRuns)
    .values({ workspaceId, agentProfileId: profile.id, objective: "Resolve conflicts", state: "running", policySnapshot: { allowedTools }, createdBy: userId })
    .returning();
  return run.id;
}

/** A synced Google event on an external calendar, the way the sync writes it. */
async function seedGoogleEvent(workspaceId: string, title: string, startsAt: Date, endsAt: Date) {
  const db = handle!.db;
  const [account] = await db
    .insert(externalAccounts)
    .values({ workspaceId, provider: "google-calendar", alias: `g-${crypto.randomUUID().slice(0, 6)}`, status: "active" })
    .returning();
  const [calendar] = await db
    .insert(calendars)
    .values({ workspaceId, kind: "external", name: `Google (${account.alias})`, externalAccountId: account.id, providerObjectId: "primary" })
    .returning();
  const [row] = await db
    .insert(events)
    .values({ workspaceId, calendarId: calendar.id, title, startsAt, endsAt, externalAccountId: account.id, providerObjectId: `p-${crypto.randomUUID()}` })
    .returning();
  return { account, event: row };
}

suite("conflict window read", () => {
  it("returns only this workspace's live timed events, with source, task link and attendees", async () => {
    const mine = await seed("cc-mine");
    const theirs = await seed("cc-theirs");
    const task = await work.createOwnerTask(mine.auth, { title: "Deep work", estimateMinutes: 60 });
    const local = await cal.createEvent(mine.auth, { title: "Local", startsAt: at(8, 10), endsAt: at(8, 11) });
    const block = await cal.blockTimeForTask(mine.auth, { taskId: task.id, from: at(9, 0) });
    await handle!.db.insert(eventAttendees).values({ workspaceId: mine.workspaceId, eventId: local.id, email: "a@example.com" });
    const { event: google } = await seedGoogleEvent(mine.workspaceId, "Google sync", at(8, 10), at(8, 11));
    const cancelled = await cal.createEvent(mine.auth, { title: "Cancelled", startsAt: at(8, 12), endsAt: at(8, 13) });
    await cal.cancelEvent(mine.auth, { eventId: cancelled.id, expectedVersion: cancelled.version });
    await cal.createEvent(theirs.auth, { title: "Other tenant", startsAt: at(8, 10), endsAt: at(8, 11) });

    const window = await queries.loadConflictWindow(mine.auth, from, to);
    const byTitle = new Map(window.events.map((e) => [e.title, e]));
    expect([...byTitle.keys()].sort()).toEqual(["Deep work", "Google sync", "Local"]);
    expect(byTitle.has("Other tenant")).toBe(false);
    expect(byTitle.has("Cancelled")).toBe(false);
    expect(byTitle.get("Google sync")).toMatchObject({ id: google.id, external: true });
    expect(byTitle.get("Local")).toMatchObject({ external: false, attendeeCount: 1, taskId: null });
    const blockRow = window.events.find((e) => e.id === block.id);
    expect(blockRow?.taskId).toBe(task.id);
  });

  it("leaves all-day events out", async () => {
    const { auth, workspaceId } = await seed("cc-allday");
    const created = await cal.createEvent(auth, { title: "Holiday", startsAt: at(8, 0), endsAt: at(8, 23) });
    await handle!.db.update(events).set({ allDay: true }).where(eq(events.id, created.id));
    const window = await queries.loadConflictWindow({ workspaceId, userId: auth.userId }, from, to);
    expect(window.events).toEqual([]);
  });

  it("reads the owner's timezone, falling back to UTC for none or an unknown one", async () => {
    const { auth, workspaceId, userId } = await seed("cc-tz");
    expect((await queries.loadConflictWindow(auth, from, to)).timezone).toBe("UTC");
    await handle!.db.insert(userPreferences).values({ workspaceId, userId, timezone: "America/Los_Angeles" });
    expect((await queries.loadConflictWindow(auth, from, to)).timezone).toBe("America/Los_Angeles");
    await handle!.db.update(userPreferences).set({ timezone: "Not/AZone" }).where(eq(userPreferences.userId, userId));
    expect((await queries.loadConflictWindow(auth, from, to)).timezone).toBe("UTC");
  });

  it("reports Google freshness per account and nothing from another workspace", async () => {
    const mine = await seed("cc-fresh");
    const theirs = await seed("cc-fresh-other");
    const { account } = await seedGoogleEvent(mine.workspaceId, "Synced", at(8, 10), at(8, 11));
    await seedGoogleEvent(theirs.workspaceId, "Not mine", at(8, 10), at(8, 11));
    expect((await queries.loadConflictWindow(mine.auth, from, to)).providers).toEqual([
      { alias: account.alias, status: "active", lastSyncedAt: null },
    ]);
    const synced = at(7, 6);
    await handle!.db.insert(syncCursors).values({ workspaceId: mine.workspaceId, externalAccountId: account.id, resource: "events", lastSyncedAt: synced });
    const [provider] = (await queries.loadConflictWindow(mine.auth, from, to)).providers;
    expect(provider.lastSyncedAt?.toISOString()).toBe(synced.toISOString());
  });
});

suite("propose a conflict move", () => {
  it("proposes, changes nothing until approved, then moves the event once", async () => {
    const { auth, userId, workspaceId } = await seed("cc-propose");
    const runId = await seedRun(workspaceId, userId, ["calendar.read", "calendar.propose"]);
    const a = await cal.createEvent(auth, { title: "Planning", startsAt: at(8, 10), endsAt: at(8, 11) });
    await seedGoogleEvent(workspaceId, "Dentist", at(8, 10), at(8, 11));

    const report = await service.listCalendarConflicts({ workspaceId, userId }, { now: from, days: 14 });
    expect(report.conflicts).toHaveLength(1);
    const option = report.conflicts[0].options.find((o) => o.kind === "move" && o.eventId === a.id);
    expect(option).toBeDefined();
    if (!option || option.kind !== "move") throw new Error("no move option");

    const result = await service.proposeConflictMove(
      { workspaceId, userId },
      { eventId: a.id, expectedVersion: option.expectedVersion, startsAt: new Date(option.startsAt), endsAt: new Date(option.endsAt), runId, now: from },
    );
    expect(result).toMatchObject({ ok: true, deduplicated: false });

    // Nothing moved yet.
    const before = await queries.loadConflictWindow({ workspaceId, userId }, from, to);
    expect(before.events.find((e) => e.id === a.id)?.startsAt.toISOString()).toBe(at(8, 10).toISOString());

    const [pending] = await proposals.listPendingCalendarProposals({ workspaceId });
    expect(pending.effect).toContain('Moves "Planning"');
    await proposals.approveCalendarProposal(auth, { proposalId: pending.id, expectedVersion: pending.version, revisionId: pending.revisionId });
    await proposals.approveCalendarProposal(auth, { proposalId: pending.id, expectedVersion: pending.version, revisionId: pending.revisionId });

    const after = await queries.loadConflictWindow({ workspaceId, userId }, from, to);
    expect(after.events.find((e) => e.id === a.id)?.startsAt.toISOString()).toBe(option.startsAt);
    expect(after.events.find((e) => e.id === a.id)?.version).toBe(a.version + 1);
    expect((await service.listCalendarConflicts({ workspaceId, userId }, { now: from })).conflicts).toHaveLength(0);
  });

  it("refuses a Google event, a stale version, a taken slot, and another workspace's event", async () => {
    const mine = await seed("cc-refuse");
    const theirs = await seed("cc-refuse-other");
    const runId = await seedRun(mine.workspaceId, mine.userId, ["calendar.propose"]);
    const a = await cal.createEvent(mine.auth, { title: "Planning", startsAt: at(8, 10), endsAt: at(8, 11) });
    await cal.createEvent(mine.auth, { title: "Taken", startsAt: at(8, 12), endsAt: at(8, 13) });
    const { event: google } = await seedGoogleEvent(mine.workspaceId, "Google", at(8, 10), at(8, 11));
    const foreign = await cal.createEvent(theirs.auth, { title: "Foreign", startsAt: at(8, 10), endsAt: at(8, 11) });
    const base = { startsAt: at(8, 14), endsAt: at(8, 15), runId, now: from };
    const who = { workspaceId: mine.workspaceId, userId: mine.userId };

    expect(await service.proposeConflictMove(who, { ...base, eventId: google.id, expectedVersion: google.version })).toMatchObject({ ok: false, code: "event_is_external" });
    expect(await service.proposeConflictMove(who, { ...base, eventId: a.id, expectedVersion: a.version + 5 })).toMatchObject({ ok: false, code: "event_changed" });
    expect(await service.proposeConflictMove(who, { ...base, eventId: a.id, expectedVersion: a.version, startsAt: at(8, 12), endsAt: at(8, 13) })).toMatchObject({ ok: false, code: "slot_unavailable" });
    expect(await service.proposeConflictMove(who, { ...base, eventId: foreign.id, expectedVersion: foreign.version })).toMatchObject({ ok: false, code: "event_not_found" });
    expect(await proposals.listPendingCalendarProposals({ workspaceId: mine.workspaceId })).toHaveLength(0);
  });
});
