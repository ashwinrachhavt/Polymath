import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let cal: typeof import("@/domains/calendar/commands");
let queries: typeof import("@/domains/calendar/queries");
let work: typeof import("@/domains/work/commands");

beforeAll(async () => {
  if (!handle) return;
  cal = await import("@/domains/calendar/commands");
  queries = await import("@/domains/calendar/queries");
  work = await import("@/domains/work/commands");
});
afterAll(async () => {
  await handle?.client.end();
});

async function seed(slug: string) {
  const { userId, workspaceId } = await seedWorkspace(handle!.db, `${slug}-${Date.now()}`);
  return ownerAuth(userId, workspaceId);
}

const from = new Date(Date.UTC(2030, 0, 7, 0, 0)); // a Monday, far from "now"

suite("calendar time blocks", () => {
  it("blocks the first free slot, then the next one after it", async () => {
    const auth = await seed("cal-block");
    const t1 = await work.createOwnerTask(auth, { title: "Write spec", estimateMinutes: 60 });
    const t2 = await work.createOwnerTask(auth, { title: "Review PR" });
    const a = await cal.blockTimeForTask(auth, { taskId: t1.id, from });
    const b = await cal.blockTimeForTask(auth, { taskId: t2.id, from, minutes: 30 });
    expect(a.startsAt).toBe("2030-01-07T09:00:00.000Z");
    expect(a.endsAt).toBe("2030-01-07T10:00:00.000Z");
    expect(new Date(b.startsAt).getTime()).toBeGreaterThanOrEqual(new Date(a.endsAt).getTime());
    const week = await queries.listEventsBetween(auth, from, new Date(from.getTime() + 7 * 86_400_000));
    expect(week.map((e) => e.taskId).sort()).toEqual([t1.id, t2.id].sort());
  });

  it("moves with a version check and cancels out of the week", async () => {
    const auth = await seed("cal-move");
    const e = await cal.createEvent(auth, {
      title: "Focus",
      startsAt: new Date(Date.UTC(2030, 0, 8, 15)),
      endsAt: new Date(Date.UTC(2030, 0, 8, 16)),
    });
    const moved = await cal.moveEvent(auth, {
      eventId: e.id,
      expectedVersion: e.version,
      startsAt: new Date(Date.UTC(2030, 0, 8, 17)),
      endsAt: new Date(Date.UTC(2030, 0, 8, 18)),
    });
    await expect(
      cal.moveEvent(auth, { eventId: e.id, expectedVersion: e.version, startsAt: from, endsAt: new Date(from.getTime() + 3_600_000) }),
    ).rejects.toMatchObject({ code: "event_version_conflict" });
    await cal.cancelEvent(auth, { eventId: e.id, expectedVersion: moved.version });
    expect(await queries.listEventsBetween(auth, from, new Date(from.getTime() + 7 * 86_400_000))).toHaveLength(0);
  });

  it("rejects bad ranges and a task from another workspace", async () => {
    const a = await seed("cal-tenant-a");
    const b = await seed("cal-tenant-b");
    await expect(cal.createEvent(a, { title: "x", startsAt: from, endsAt: from })).rejects.toMatchObject({ code: "invalid_range" });
    const foreign = await work.createOwnerTask(b, { title: "Not yours" });
    await expect(cal.blockTimeForTask(a, { taskId: foreign.id, from })).rejects.toThrow("task not found");
  });

  it("replays an idempotent block instead of double-booking", async () => {
    const auth = await seed("cal-idem");
    const t = await work.createOwnerTask(auth, { title: "Once" });
    const key = crypto.randomUUID();
    const x = await cal.blockTimeForTask(auth, { taskId: t.id, from, idempotencyKey: key });
    const y = await cal.blockTimeForTask(auth, { taskId: t.id, from, idempotencyKey: key });
    expect(y).toEqual(x);
  });
});

suite("agent calendar proposals", () => {
  it("an agent proposal changes nothing until approved, then executes once", async () => {
    const auth = await seed("cal-proposal");
    const proposals = await import("@/domains/calendar/proposals");
    const task = await work.createOwnerTask(auth, { title: "Deep work", estimateMinutes: 60 });
    const proposed = await proposals.proposeCalendarChange(auth, {
      change: { kind: "block", taskId: task.id, minutes: 60 },
      dedupeKey: "agent-run-1:block",
    });
    const again = await proposals.proposeCalendarChange(auth, {
      change: { kind: "block", taskId: task.id, minutes: 60 },
      dedupeKey: "agent-run-1:block",
    });
    expect(again).toEqual({ proposalId: proposed.proposalId, deduplicated: true });

    const horizon = new Date(Date.now() + 30 * 86_400_000);
    expect(await queries.listEventsBetween(auth, new Date(Date.now() - 86_400_000), horizon)).toHaveLength(0);
    const [pending] = await proposals.listPendingCalendarProposals(auth);
    expect(pending.id).toBe(proposed.proposalId);

    await proposals.approveCalendarProposal(auth, { proposalId: pending.id, expectedVersion: pending.version, revisionId: pending.revisionId });
    // A retry after approval must not book a second block.
    await proposals.approveCalendarProposal(auth, { proposalId: pending.id, expectedVersion: pending.version, revisionId: pending.revisionId });
    const events = await queries.listEventsBetween(auth, new Date(Date.now() - 86_400_000), horizon);
    expect(events).toHaveLength(1);
    expect(events[0].taskId).toBe(task.id);
    expect(await proposals.listPendingCalendarProposals(auth)).toHaveLength(0);
  });

  it("a rejected proposal never executes", async () => {
    const auth = await seed("cal-reject");
    const proposals = await import("@/domains/calendar/proposals");
    const { proposalId } = await proposals.proposeCalendarChange(auth, {
      change: { kind: "create", title: "Nope", startsAt: from.toISOString(), endsAt: new Date(from.getTime() + 3_600_000).toISOString() },
      dedupeKey: "reject-1",
    });
    const [p] = await proposals.listPendingCalendarProposals(auth);
    await proposals.rejectCalendarProposal(auth, { proposalId, expectedVersion: p.version, revisionId: p.revisionId });
    expect(await queries.listEventsBetween(auth, from, new Date(from.getTime() + 7 * 86_400_000))).toHaveLength(0);
  });
});
