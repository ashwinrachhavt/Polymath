import { describe, expect, it } from "vitest";
import { decodeActivityCursor } from "@/domains/audit/queries";
import {
  ACTIVITY_MAX_PAGES,
  ACTIVITY_PAGE_SIZE,
  groupActivityByDay,
  mergeDayGroups,
} from "@/app/(workspace)/activity/day-groups";
import type { ActivityItem } from "@/domains/audit/present";

/*
 * The Activity feed's incremental "Load more" semantics (spec W3): pages are
 * fetched one keyset page at a time by the client island and appended to the
 * server-rendered first page. The append must preserve row order across
 * pages and neither duplicate nor drop a row; a `?cursor=` deep link names a
 * self-contained keyset position; a malformed cursor (or the legacy
 * `?pages=N`, which carries no cursor at all) degrades to page 1. The
 * database-backed equivalence with the old walk lives in the integration
 * suites.
 */

const NOW = new Date("2026-11-03T12:00:00.000Z"); // a Tuesday

let nextId = 0;
const item = (occurredAt: string, label: string): ActivityItem =>
  ({
    id: `item-${String(++nextId).padStart(3, "0")}-${label}`,
    occurredAt: new Date(occurredAt),
    sentence: label,
  }) as ActivityItem;

/** Flatten accumulated groups back to the row order the viewer reads. */
const flatten = (groups: ReturnType<typeof groupActivityByDay>) =>
  groups.flatMap((group) => group.items.map((item) => item.id));

describe("incremental load-more append", () => {
  it("preserves row order across appended pages with no duplicates and no gaps", () => {
    // Three keyset-ordered pages: page 1 spans two days, page 2 starts in
    // the day page 1 ended in (the only legal seam), page 3 starts a new
    // day. Newest first, the read model's order.
    const page1 = [
      item("2026-11-03T11:00:00.000Z", "p1-newest"),
      item("2026-11-03T10:00:00.000Z", "p1-middle"),
      item("2026-11-02T09:00:00.000Z", "p1-last"),
    ];
    const page2 = [
      item("2026-11-02T08:00:00.000Z", "p2-first"),
      item("2026-11-02T07:00:00.000Z", "p2-second"),
      item("2026-11-01T06:00:00.000Z", "p2-last"),
    ];
    const page3 = [item("2026-11-01T05:00:00.000Z", "p3-first"), item("2026-10-30T04:00:00.000Z", "p3-last")];

    let groups = groupActivityByDay(page1, "UTC", NOW);
    const all = [...page1, ...page2, ...page3];

    groups = mergeDayGroups(groups, groupActivityByDay(page2, "UTC", NOW));
    groups = mergeDayGroups(groups, groupActivityByDay(page3, "UTC", NOW));

    // Order: the accumulated view reads exactly like one server-rendered
    // list of all three pages.
    expect(flatten(groups)).toEqual(all.map((entry) => entry.id));

    // No duplicates, no gaps: every row appears exactly once.
    const seen = flatten(groups);
    expect(new Set(seen).size).toBe(seen.length);
    expect(new Set(seen)).toEqual(new Set(all.map((entry) => entry.id)));
  });

  it("merges an appended page into the trailing day when they share a calendar day", () => {
    const page1 = [item("2026-11-03T11:00:00.000Z", "today-new"), item("2026-11-02T09:00:00.000Z", "yesterday-new")];
    const page2 = [item("2026-11-02T08:00:00.000Z", "yesterday-appended")];

    const groups = mergeDayGroups(groupActivityByDay(page1, "UTC", NOW), groupActivityByDay(page2, "UTC", NOW));

    expect(groups.map((group) => group.key)).toEqual(["2026-11-03", "2026-11-02"]);
    expect(groups[1]!.items.map((entry) => entry.sentence)).toEqual(["yesterday-new", "yesterday-appended"]);
  });

  it("renders an appended page on an older day as its own group in position", () => {
    const page1 = [item("2026-11-03T11:00:00.000Z", "newest")];
    const page2 = [item("2026-10-30T04:00:00.000Z", "older")];

    const groups = mergeDayGroups(groupActivityByDay(page1, "UTC", NOW), groupActivityByDay(page2, "UTC", NOW));

    expect(groups.map((group) => group.key)).toEqual(["2026-11-03", "2026-10-30"]);
  });

  it("keeps an empty existing or incoming side intact", () => {
    const groups = groupActivityByDay([item("2026-11-03T11:00:00.000Z", "only")], "UTC", NOW);
    expect(mergeDayGroups([], groups)).toEqual(groups);
    expect(mergeDayGroups(groups, [])).toEqual(groups);
  });
});

describe("activity pagination bounds", () => {
  it("caps the feed at five server-rendered-or-appended pages", () => {
    // The initial render is page one, so four appends reach the cap; the
    // island's honest note advertises this many rows.
    expect(ACTIVITY_PAGE_SIZE).toBe(50);
    expect(ACTIVITY_MAX_PAGES).toBe(5);
    expect(ACTIVITY_PAGE_SIZE * ACTIVITY_MAX_PAGES).toBe(250);
  });
});

describe("cursor deep links degrade to page 1 on anything malformed", () => {
  it("rejects a malformed cursor (the page's guard then starts from page 1)", () => {
    expect(() => decodeActivityCursor("not-a-cursor")).toThrow();
    expect(() => decodeActivityCursor(Buffer.from("no-separator", "utf8").toString("base64url"))).toThrow();
    expect(() =>
      decodeActivityCursor(Buffer.from(`2026-11-03T12:00:00.000Z\nnot-a-uuid`, "utf8").toString("base64url")),
    ).toThrow();
  });

  it("round-trips a real page-boundary cursor", () => {
    const boundary = { createdAt: new Date("2026-11-03T12:00:00.000Z"), id: crypto.randomUUID() };
    const decoded = decodeActivityCursor(
      Buffer.from(`${boundary.createdAt.toISOString()}\n${boundary.id}`, "utf8").toString("base64url"),
    );
    expect(decoded.createdAt).toEqual(boundary.createdAt);
    expect(decoded.id).toBe(boundary.id);
  });
});
