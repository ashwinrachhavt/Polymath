import { describe, expect, it } from "vitest";
import {
  chooseSession,
  estimatedSeconds,
  interleave,
  missionUrgency,
  priorityOf,
  type StudyCandidate,
} from "@/domains/learning/study-queue";

const now = new Date("2026-11-13T09:00:00.000Z");
const daysAgo = (n: number) => new Date(now.getTime() - n * 24 * 60 * 60 * 1000);

let seq = 0;
function item(over: Partial<StudyCandidate> = {}): StudyCandidate {
  seq += 1;
  return {
    kind: "flashcard",
    id: `item-${String(seq).padStart(3, "0")}`,
    sourceKey: "doc-a",
    dueAt: now,
    conceptIds: [],
    ...over,
  };
}

describe("missionUrgency", () => {
  it("is 0 for a past date and for one 14 or more days away, and 1 on the day", () => {
    expect(missionUrgency(-1)).toBe(0);
    expect(missionUrgency(14)).toBe(0);
    expect(missionUrgency(30)).toBe(0);
    expect(missionUrgency(0)).toBe(1);
    expect(missionUrgency(7)).toBeCloseTo(0.5);
  });
});

describe("priorityOf", () => {
  it("rises with how overdue an item is and saturates at 14 days", () => {
    expect(priorityOf(item({ dueAt: now }), [], now)).toBe(0);
    expect(priorityOf(item({ dueAt: daysAgo(7) }), [], now)).toBeCloseTo(0.5);
    expect(priorityOf(item({ dueAt: daysAgo(40) }), [], now)).toBe(1);
  });

  it("adds twice the urgency of the soonest mission that covers the item's concept", () => {
    const covered = item({ conceptIds: ["c1"] });
    const missions = [
      { conceptIds: new Set(["c1"]), daysLeft: 7 },
      { conceptIds: new Set(["c1"]), daysLeft: 1 },
      { conceptIds: new Set(["other"]), daysLeft: 0 },
    ];
    expect(priorityOf(covered, missions, now)).toBeCloseTo(2 * (13 / 14));
    expect(priorityOf(item({ conceptIds: ["c9"] }), missions, now)).toBe(0);
  });
});

describe("chooseSession", () => {
  it("fills a 10-minute budget from the highest priority down: 20 s a card, 40 s a question", () => {
    const cards = Array.from({ length: 40 }, (_, i) => item({ sourceKey: `doc-${i}`, dueAt: daysAgo(i) }));
    const session = chooseSession(cards, { missions: [], now });
    expect(session).toHaveLength(30);
    expect(estimatedSeconds(session)).toBe(600);
    // The 10 least overdue (due now to 9 days ago) were left out.
    const kept = new Set(session.map((s) => s.id));
    expect(cards.slice(10).every((c) => kept.has(c.id))).toBe(true);
    const mixed = [
      ...Array.from({ length: 10 }, (_, i) => item({ kind: "quiz_question", sourceKey: `q-${i}` })),
      ...Array.from({ length: 10 }, (_, i) => item({ sourceKey: `f-${i}` })),
    ];
    expect(estimatedSeconds(chooseSession(mixed, { missions: [], now }))).toBeLessThanOrEqual(600);
  });

  it("always offers at least one item, however small the budget", () => {
    expect(chooseSession([item({ kind: "quiz_question" })], { missions: [], now, minutes: 0 })).toHaveLength(1);
    expect(chooseSession([], { missions: [], now })).toEqual([]);
  });

  it("puts items for a mission that is days away ahead of items that are only overdue", () => {
    const overdue = item({ sourceKey: "a", dueAt: daysAgo(10) });
    const forMission = item({ sourceKey: "b", dueAt: now, conceptIds: ["c1"] });
    const session = chooseSession([overdue, forMission], {
      missions: [{ conceptIds: new Set(["c1"]), daysLeft: 3 }],
      now,
      minutes: 0.3,
    });
    // One slot of budget: the mission item takes it.
    expect(session.map((s) => s.id)).toEqual([forMission.id]);
  });

  it("without a mission date, nothing about a mission changes the order", () => {
    const older = item({ sourceKey: "a", dueAt: daysAgo(5) });
    const newer = item({ sourceKey: "b", dueAt: daysAgo(1), conceptIds: ["c1"] });
    const session = chooseSession([newer, older], { missions: [], now, minutes: 0.3 });
    expect(session.map((s) => s.id)).toEqual([older.id]);
  });
});

describe("interleave", () => {
  it("never shows two items from one source in a row while another source is waiting", () => {
    const ordered = [
      item({ sourceKey: "a" }),
      item({ sourceKey: "a" }),
      item({ sourceKey: "a" }),
      item({ sourceKey: "b" }),
      item({ sourceKey: "b" }),
      item({ sourceKey: "c" }),
    ];
    const out = interleave(ordered);
    expect(out.map((s) => s.sourceKey)).toEqual(["a", "b", "a", "b", "a", "c"]);
    expect(out).toHaveLength(ordered.length);
  });

  it("keeps the order when there is only one source", () => {
    const ordered = [item(), item(), item()];
    expect(interleave(ordered).map((s) => s.id)).toEqual(ordered.map((s) => s.id));
  });
});
