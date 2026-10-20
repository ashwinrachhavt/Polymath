import { describe, expect, it } from "vitest";
import { findFreeSlot } from "@/domains/calendar/slots";

const at = (h: number, m = 0, day = 19) => new Date(Date.UTC(2026, 9, day, h, m));

describe("findFreeSlot", () => {
  it("returns the start of the window on an empty day", () => {
    const s = findFreeSlot({ from: at(0), minutes: 60, busy: [] });
    expect(s).toEqual({ start: at(9), end: at(10) });
  });
  it("starts no earlier than `from`", () => {
    expect(findFreeSlot({ from: at(13, 20), minutes: 30, busy: [] })?.start).toEqual(at(13, 20));
  });
  it("skips busy blocks and honours the buffer", () => {
    const s = findFreeSlot({ from: at(0), minutes: 60, bufferMinutes: 10, busy: [{ start: at(9), end: at(10) }] });
    expect(s?.start).toEqual(at(10, 10));
  });
  it("finds a gap between two events", () => {
    const busy = [{ start: at(9), end: at(10) }, { start: at(12), end: at(13) }];
    expect(findFreeSlot({ from: at(0), minutes: 90, busy })?.start).toEqual(at(10));
    expect(findFreeSlot({ from: at(0), minutes: 150, busy })?.start).toEqual(at(13));
  });
  it("rolls to the next day when today is full", () => {
    const s = findFreeSlot({ from: at(17), minutes: 120, busy: [] });
    expect(s?.start).toEqual(at(9, 0, 20));
  });
  it("uses the local offset for the working window", () => {
    const s = findFreeSlot({ from: at(8), minutes: 30, busy: [], utcOffsetMinutes: -420 });
    expect(s?.start).toEqual(at(16)); // 9:00 PDT
  });
  it("returns null when nothing fits in the horizon", () => {
    expect(findFreeSlot({ from: at(0), minutes: 600, busy: [] })).toBeNull();
  });
});
