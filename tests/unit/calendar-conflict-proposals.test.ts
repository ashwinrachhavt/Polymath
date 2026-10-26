import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConflictWindow } from "@/domains/calendar/conflict-queries";
import type { ConflictEvent } from "@/domains/calendar/conflicts";

/*
 * The agent-facing seam, with the database and the proposal store faked: what
 * is read, what is refused, and exactly what reaches proposeCalendarChange.
 * The real queries and the approved execution are covered by
 * tests/integration/calendar-conflicts.test.ts, which needs TEST_DATABASE_URL.
 */

const loadConflictWindow = vi.fn();
const proposeCalendarChange = vi.fn();
vi.mock("@/domains/calendar/conflict-queries", () => ({ loadConflictWindow: (...a: unknown[]) => loadConflictWindow(...a) }));
vi.mock("@/domains/calendar/proposals", () => ({ proposeCalendarChange: (...a: unknown[]) => proposeCalendarChange(...a) }));

const { listCalendarConflicts, proposeConflictMove } = await import("@/domains/calendar/conflict-proposals");

const auth = { workspaceId: "ws-1", userId: "user-1" };
const now = new Date(Date.UTC(2030, 0, 7, 0));
const at = (d: number, h: number, m = 0) => new Date(Date.UTC(2030, 0, d, h, m));
let n = 0;
const ev = (title: string, start: Date, end: Date, over: Partial<ConflictEvent> = {}): ConflictEvent => ({
  id: `00000000-0000-4000-8000-${String((n += 1)).padStart(12, "0")}`,
  title,
  startsAt: start,
  endsAt: end,
  version: 3,
  taskId: null,
  external: false,
  tentative: false,
  attendeeCount: 0,
  ...over,
});
const window = (events: ConflictEvent[], over: Partial<ConflictWindow> = {}): ConflictWindow => ({
  events,
  timezone: "UTC",
  earliestMinute: 9 * 60,
  latestMinute: 18 * 60,
  bufferMinutes: 0,
  providers: [],
  ...over,
});

beforeEach(() => {
  loadConflictWindow.mockReset();
  proposeCalendarChange.mockReset();
  proposeCalendarChange.mockResolvedValue({ proposalId: "p-1", deduplicated: false });
});

describe("listCalendarConflicts", () => {
  it("reads only the caller's workspace and user", async () => {
    loadConflictWindow.mockResolvedValue(window([]));
    await listCalendarConflicts(auth, { now, days: 7 });
    expect(loadConflictWindow).toHaveBeenCalledWith(auth, now, new Date(now.getTime() + 7 * 86_400_000));
  });

  it("clamps the window", async () => {
    loadConflictWindow.mockResolvedValue(window([]));
    await listCalendarConflicts(auth, { now, days: 400 });
    expect(loadConflictWindow.mock.calls[0][2]).toEqual(new Date(now.getTime() + 30 * 86_400_000));
  });

  it("labels the source of each event and gives advice only for the Google one", async () => {
    const local = ev("Focus", at(7, 10), at(7, 11));
    const google = ev("Sync", at(7, 10), at(7, 11), { external: true });
    loadConflictWindow.mockResolvedValue(window([local, google]));
    const report = await listCalendarConflicts(auth, { now });
    expect(report.conflicts).toHaveLength(1);
    expect(report.conflicts[0].events.map((e) => e.source).sort()).toEqual(["google", "polymath"]);
    const kinds = report.conflicts[0].options.map((o) => (o.kind === "move" ? `move:${o.eventId === local.id ? "local" : "other"}` : `advice:${o.eventId === google.id}`));
    expect(kinds).toContain("advice:true");
    expect(kinds.filter((k) => k.startsWith("move")).every((k) => k === "move:local")).toBe(true);
  });

  it("says what was not checked about Google", async () => {
    const run = async (providers: ConflictWindow["providers"]) => {
      loadConflictWindow.mockResolvedValue(window([], { providers }));
      return (await listCalendarConflicts(auth, { now })).notices.join(" ");
    };
    expect(await run([])).toContain("No Google Calendar is connected");
    expect(await run([{ alias: "work", status: "expired", lastSyncedAt: null }])).toContain("is expired");
    expect(await run([{ alias: "work", status: "active", lastSyncedAt: null }])).toContain("has not synced yet");
    expect(await run([{ alias: "work", status: "active", lastSyncedAt: at(6, 12) }])).toContain("2030-01-06T12:00:00.000Z");
  });
});

describe("proposeConflictMove", () => {
  const target = ev("Planning", at(7, 10), at(7, 11), { version: 3 });
  const other = ev("Dentist", at(7, 10, 30), at(7, 11, 30));
  const base = { eventId: target.id, expectedVersion: 3, startsAt: at(7, 12), endsAt: at(7, 13), runId: "run-1", now };

  it("files one move proposal naming the owner-facing change", async () => {
    loadConflictWindow.mockResolvedValue(window([target, other]));
    const result = await proposeConflictMove(auth, base);
    expect(result).toEqual({ ok: true, proposalId: "p-1", deduplicated: false });
    expect(proposeCalendarChange).toHaveBeenCalledTimes(1);
    const [calledAuth, input] = proposeCalendarChange.mock.calls[0];
    expect(calledAuth).toEqual(auth);
    expect(input.runId).toBe("run-1");
    expect(input.change).toMatchObject({
      kind: "move",
      eventId: target.id,
      expectedVersion: 3,
      startsAt: at(7, 12).toISOString(),
      endsAt: at(7, 13).toISOString(),
    });
    expect(input.change.note).toBe(
      'Moves "Planning" from Mon, Jan 7, 10:00 AM to Mon, Jan 7, 12:00 PM (UTC), clearing its overlap with "Dentist". Only the Polymath copy moves - Google Calendar stays unchanged and nobody is notified.',
    );
  });

  it("derives a stable dedupe key so a retry resolves the same proposal", async () => {
    loadConflictWindow.mockResolvedValue(window([target, other]));
    await proposeConflictMove(auth, base);
    await proposeConflictMove(auth, base);
    expect(proposeCalendarChange.mock.calls[0][1].dedupeKey).toBe(proposeCalendarChange.mock.calls[1][1].dedupeKey);
    expect(proposeCalendarChange.mock.calls[0][1].dedupeKey).toContain(target.id);
  });

  it("refuses an event that is not in this workspace's window", async () => {
    loadConflictWindow.mockResolvedValue(window([other]));
    expect(await proposeConflictMove(auth, base)).toMatchObject({ ok: false, code: "event_not_found" });
    expect(proposeCalendarChange).not.toHaveBeenCalled();
  });

  it("refuses a synced Google event", async () => {
    const google = ev("Team sync", at(7, 10), at(7, 11), { external: true, version: 3 });
    loadConflictWindow.mockResolvedValue(window([google]));
    expect(await proposeConflictMove(auth, { ...base, eventId: google.id })).toMatchObject({ ok: false, code: "event_is_external" });
    expect(proposeCalendarChange).not.toHaveBeenCalled();
  });

  it("refuses when the event changed since it was read", async () => {
    loadConflictWindow.mockResolvedValue(window([{ ...target, version: 4 }, other]));
    expect(await proposeConflictMove(auth, base)).toMatchObject({ ok: false, code: "event_changed" });
    expect(proposeCalendarChange).not.toHaveBeenCalled();
  });

  it("refuses a slot another event has taken, a stretched event, and the past", async () => {
    const taken = ev("Taken", at(7, 12), at(7, 13));
    loadConflictWindow.mockResolvedValue(window([target, other, taken]));
    expect(await proposeConflictMove(auth, base)).toMatchObject({ ok: false, code: "slot_unavailable" });

    loadConflictWindow.mockResolvedValue(window([target, other]));
    expect(await proposeConflictMove(auth, { ...base, endsAt: at(7, 14) })).toMatchObject({ ok: false, code: "slot_unavailable" });
    expect(await proposeConflictMove(auth, { ...base, now: at(7, 13) })).toMatchObject({ ok: false, code: "slot_unavailable" });
    expect(proposeCalendarChange).not.toHaveBeenCalled();
  });
});
