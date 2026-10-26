import { describe, expect, it } from "vitest";
import { detectConflicts, resolutionOptions, slotIsFree, type ConflictEvent, type MoveOption } from "@/domains/calendar/conflicts";

// Mon 2030-01-07, UTC. Working window 9:00-18:00, no buffer unless a test says so.
const at = (day: number, h: number, m = 0) => new Date(Date.UTC(2030, 0, day, h, m));
let n = 0;
const ev = (title: string, start: Date, end: Date, over: Partial<ConflictEvent> = {}): ConflictEvent => ({
  id: `e${(n += 1)}`,
  title,
  startsAt: start,
  endsAt: end,
  version: 1,
  taskId: null,
  external: false,
  tentative: false,
  attendeeCount: 0,
  ...over,
});
const ctx = (busy: ConflictEvent[]) => ({ now: at(7, 0), busy, timeZone: "UTC", bufferMinutes: 0 });
const moves = (options: ReturnType<typeof resolutionOptions>) => options.filter((o): o is MoveOption => o.kind === "move");

describe("detectConflicts", () => {
  it("finds an overlap and measures it", () => {
    const [c] = detectConflicts([ev("A", at(7, 10), at(7, 11)), ev("B", at(7, 10, 30), at(7, 11, 30))]);
    expect(c.events.map((e) => e.title)).toEqual(["A", "B"]);
    expect(c.overlapMinutes).toBe(30);
  });

  it("does not count back-to-back events", () => {
    expect(detectConflicts([ev("A", at(7, 10), at(7, 11)), ev("B", at(7, 11), at(7, 12))])).toEqual([]);
  });

  it("chains overlaps into one cluster and counts only the doubled time", () => {
    const list = detectConflicts([ev("A", at(7, 10), at(7, 11)), ev("B", at(7, 10, 45), at(7, 11, 45)), ev("C", at(7, 11, 30), at(7, 12))]);
    expect(list).toHaveLength(1);
    expect(list[0].events).toHaveLength(3);
    expect(list[0].overlapMinutes).toBe(30);
  });

  it("keeps separate clusters apart", () => {
    const list = detectConflicts([
      ev("A", at(7, 9), at(7, 10)),
      ev("B", at(7, 9, 30), at(7, 10, 30)),
      ev("C", at(8, 9), at(8, 10)),
      ev("D", at(8, 9), at(8, 10)),
    ]);
    expect(list).toHaveLength(2);
  });

  it("ignores a lone event", () => {
    expect(detectConflicts([ev("A", at(7, 9), at(7, 10))])).toEqual([]);
  });
});

describe("resolutionOptions", () => {
  it("offers a free later slot that clears the overlap, and never lands on another event", () => {
    const a = ev("Planning", at(7, 10), at(7, 11));
    const b = ev("Dentist", at(7, 10, 30), at(7, 11, 30));
    const [conflict] = detectConflicts([a, b]);
    const found = moves(resolutionOptions(conflict, ctx([a, b])));
    expect(found.length).toBeGreaterThan(0);
    for (const m of found) {
      const other = m.eventId === a.id ? b : a;
      expect(m.startsAt < other.endsAt && other.startsAt < m.endsAt).toBe(false);
      expect(m.endsAt.getTime() - m.startsAt.getTime()).toBe(60 * 60_000);
    }
    expect(found[0].clearsConflict).toBe(true);
  });

  it("moves the task block before the meeting with attendees", () => {
    const block = ev("Write spec", at(7, 10), at(7, 11), { taskId: "t1" });
    const meeting = ev("Review", at(7, 10), at(7, 11), { attendeeCount: 3 });
    const [conflict] = detectConflicts([block, meeting]);
    const found = moves(resolutionOptions(conflict, ctx([block, meeting])));
    expect(found[0].eventId).toBe(block.id);
    expect(found[0].tradeOffs.join(" ")).toContain("time block for a task");
  });

  it("says attendees are not notified when a meeting with attendees is moved", () => {
    const a = ev("Standup", at(7, 10), at(7, 11), { attendeeCount: 2 });
    const b = ev("Lunch", at(7, 10), at(7, 11), { external: true });
    const [conflict] = detectConflicts([a, b]);
    const found = moves(resolutionOptions(conflict, ctx([a, b])));
    expect(found[0].tradeOffs.join(" ")).toContain("does not tell them");
  });

  it("never offers to move a synced Google event, and says where to resolve it", () => {
    const local = ev("Focus", at(7, 10), at(7, 11));
    const google = ev("Team sync", at(7, 10), at(7, 11), { external: true });
    const [conflict] = detectConflicts([local, google]);
    const options = resolutionOptions(conflict, ctx([local, google]));
    expect(moves(options).every((m) => m.eventId === local.id)).toBe(true);
    const advice = options.find((o) => o.kind === "resolve_in_provider");
    expect(advice?.eventId).toBe(google.id);
  });

  it("gives only advice when every event is synced", () => {
    const a = ev("One", at(7, 10), at(7, 11), { external: true });
    const b = ev("Two", at(7, 10), at(7, 11), { external: true });
    const [conflict] = detectConflicts([a, b]);
    const options = resolutionOptions(conflict, ctx([a, b]));
    expect(moves(options)).toEqual([]);
    expect(options.every((o) => o.kind === "resolve_in_provider")).toBe(true);
  });

  it("flags a move that leaves a three-way cluster overlapping", () => {
    const a = ev("A", at(7, 10), at(7, 11), { external: true });
    const b = ev("B", at(7, 10), at(7, 11), { external: true });
    const c = ev("C", at(7, 10), at(7, 11));
    const [conflict] = detectConflicts([a, b, c]);
    const found = moves(resolutionOptions(conflict, ctx([a, b, c])));
    expect(found.length).toBeGreaterThan(0);
    // a and b still overlap each other, so no single move clears it.
    expect(found.every((m) => m.clearsConflict === false)).toBe(true);
  });

  it("respects the working window and does not suggest the past", () => {
    const a = ev("A", at(7, 16), at(7, 17, 30));
    const b = ev("B", at(7, 16, 30), at(7, 17));
    const [conflict] = detectConflicts([a, b]);
    const found = moves(resolutionOptions(conflict, { ...ctx([a, b]), now: at(7, 15) }));
    for (const m of found) {
      expect(m.startsAt.getTime()).toBeGreaterThanOrEqual(at(7, 15).getTime());
      const startMinute = m.startsAt.getUTCHours() * 60 + m.startsAt.getUTCMinutes();
      const endMinute = startMinute + (m.endsAt.getTime() - m.startsAt.getTime()) / 60_000;
      expect(startMinute).toBeGreaterThanOrEqual(9 * 60);
      expect(endMinute).toBeLessThanOrEqual(18 * 60);
    }
  });

  it("offers an earlier same-day slot when one is free", () => {
    const a = ev("Late", at(7, 15), at(7, 16));
    const b = ev("Clash", at(7, 15), at(7, 16), { external: true });
    const [conflict] = detectConflicts([a, b]);
    const found = moves(resolutionOptions(conflict, ctx([a, b])));
    expect(found.some((m) => m.shiftMinutes < 0)).toBe(true);
    expect(found.some((m) => m.shiftMinutes > 0)).toBe(true);
  });
});

describe("slotIsFree", () => {
  const target = ev("Move me", at(7, 10), at(7, 11));
  const other = ev("Other", at(7, 14), at(7, 15));
  const now = at(7, 0);

  it("accepts a free slot of the same length", () => {
    expect(slotIsFree(target, { start: at(7, 12), end: at(7, 13) }, [target, other], now)).toBe(true);
  });
  it("refuses a slot another event took since the options were read", () => {
    expect(slotIsFree(target, { start: at(7, 14, 30), end: at(7, 15, 30) }, [target, other], now)).toBe(false);
  });
  it("refuses a different length, so the agent cannot stretch an event", () => {
    expect(slotIsFree(target, { start: at(7, 12), end: at(7, 14) }, [target, other], now)).toBe(false);
  });
  it("refuses a slot in the past", () => {
    expect(slotIsFree(target, { start: at(7, 12), end: at(7, 13) }, [target, other], at(7, 13))).toBe(false);
  });
});
