import { describe, expect, it } from "vitest";
import { buildTimeline, type TimelineRow } from "@/app/(workspace)/command-center/day/[date]/timeline";
import type { DayPage } from "@/domains/daybook/queries";

/*
 * Value: protects=the day timeline merges all five record lists exactly once,
 * ordered by time, with null timestamps sorting first without throwing and
 * pin eligibility limited to artifact/note created rows; fails_when=a list is
 * dropped or double-counted, the comparator throws on a null `at`, or pinning
 * widens to captures/changes; why_new=buildTimeline is the pure merge at the
 * heart of the rebuilt day page and its only coverage was the route smoke
 * test; seam=none (timeline.ts is a production module imported by the page);
 * no_claim=none beyond protects.
 */

function day(overrides: Partial<DayPage> = {}): DayPage {
  return {
    localDate: "2026-10-29",
    timezone: "UTC",
    created: [],
    workedOn: [],
    captured: [],
    sessions: [],
    meetings: [],
    pins: [],
    ...overrides,
  };
}

const at = (iso: string) => new Date(iso);

describe("buildTimeline", () => {
  it("merges all five lists into one time-ordered record", () => {
    const rows = buildTimeline(
      day({
        captured: [{ id: "c1", kind: "text", title: "a capture", at: at("2026-10-29T10:00:00Z") }],
        created: [{ id: "n1", kind: "note", title: "a note", at: at("2026-10-29T09:00:00Z") }],
        workedOn: [{ id: "w1", kind: "note.snapshot", title: "a change", at: at("2026-10-29T11:00:00Z") }],
        sessions: [{ id: "s1", subject: "deep work", startedAt: at("2026-10-29T08:00:00Z"), endedAt: null, minutes: 45 }],
        meetings: [{ id: "m1", kind: "event", title: "standup", at: at("2026-10-29T09:30:00Z") }],
      }),
    );
    expect(rows.map((r) => r.kind)).toEqual(["Session", "Created", "Meeting", "Captured", "Changed"]);
    expect(rows).toHaveLength(5);
  });

  it("sorts null-timestamp rows first without throwing", () => {
    const rows = buildTimeline(
      day({
        captured: [{ id: "c1", kind: "text", title: "no time", at: null }],
        created: [{ id: "n1", kind: "note", title: "timed", at: at("2026-10-29T09:00:00Z") }],
      }),
    );
    expect(rows[0].key).toBe("captured-c1");
    expect(rows[1].key).toBe("created-n1");
  });

  it("marks only artifact and note created rows as pinnable", () => {
    const rows = buildTimeline(
      day({
        created: [
          { id: "a1", kind: "artifact", title: "an artifact", at: at("2026-10-29T09:00:00Z") },
          { id: "n1", kind: "note", title: "a note", at: at("2026-10-29T09:01:00Z") },
          { id: "o1", kind: "task", title: "a task", at: at("2026-10-29T09:02:00Z") },
        ],
        captured: [{ id: "c1", kind: "text", title: "a capture", at: at("2026-10-29T09:03:00Z") }],
        workedOn: [{ id: "w1", kind: "note.snapshot", title: "a change", at: at("2026-10-29T09:04:00Z") }],
      }),
    );
    const pinned = rows.filter((r) => r.artifactId).map((r) => r.key);
    expect(pinned).toEqual(["created-a1", "created-n1"]);
  });

  it("falls back to a generic session title when the subject is null", () => {
    const rows = buildTimeline(
      day({
        sessions: [{ id: "s1", subject: null, startedAt: at("2026-10-29T08:00:00Z"), endedAt: null, minutes: 30 }],
      }),
    );
    expect(rows[0].kind).toBe("Session");
    expect(rows[0].title).toBe("Focus session");
    expect(rows[0].detail).toBe("30 min");
  });
});
