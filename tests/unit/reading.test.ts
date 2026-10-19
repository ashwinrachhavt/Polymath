import { describe, expect, it } from "vitest";
import {
  EMPTY_READING_STATE,
  FINISHED_AT,
  MAX_ACTIVE_SECONDS,
  STARTED_AT,
  clampActiveSeconds,
  clampProgress,
  foldReadingEvent,
  libraryGroup,
} from "@/domains/knowledge/reading";

/*
 * The reading fold, pure: opened counts sittings, progress only ever raises
 * the furthest mark, active seconds clamp so a wedged tab cannot inflate
 * engagement, and the library grouping follows from the folded progress.
 */

describe("clampProgress", () => {
  it("keeps 0..1 and rejects the rest", () => {
    expect(clampProgress(0)).toBe(0);
    expect(clampProgress(0.42)).toBe(0.42);
    expect(clampProgress(1)).toBe(1);
    expect(clampProgress(-0.5)).toBe(0);
    expect(clampProgress(1.7)).toBe(1);
    expect(clampProgress(Number.NaN)).toBeNull();
    expect(clampProgress(null)).toBeNull();
    expect(clampProgress(undefined)).toBeNull();
  });
});

describe("clampActiveSeconds", () => {
  it("floors, drops non-positive, and caps at the per-event ceiling", () => {
    expect(clampActiveSeconds(0)).toBe(0);
    expect(clampActiveSeconds(-30)).toBe(0);
    expect(clampActiveSeconds(null)).toBe(0);
    expect(clampActiveSeconds(12.9)).toBe(12);
    expect(clampActiveSeconds(MAX_ACTIVE_SECONDS + 999)).toBe(MAX_ACTIVE_SECONDS);
  });
});

describe("foldReadingEvent", () => {
  it("opened counts a sitting without touching progress", () => {
    const next = foldReadingEvent(EMPTY_READING_STATE, { kind: "opened" });
    expect(next.openCount).toBe(1);
    expect(next.furthestProgress).toBe(0);
    expect(next.totalActiveSeconds).toBe(0);
  });

  it("progress raises the furthest mark but never lowers it", () => {
    let state = foldReadingEvent(EMPTY_READING_STATE, { kind: "progress", progress: 0.6 });
    state = foldReadingEvent(state, { kind: "progress", progress: 0.2 });
    expect(state.furthestProgress).toBe(0.6);
    state = foldReadingEvent(state, { kind: "progress", progress: 0.95 });
    expect(state.furthestProgress).toBe(0.95);
  });

  it("active seconds accumulate across events of a sitting", () => {
    let state = foldReadingEvent(EMPTY_READING_STATE, { kind: "opened" });
    state = foldReadingEvent(state, { kind: "progress", progress: 0.5, activeSeconds: 42 });
    state = foldReadingEvent(state, { kind: "closed", activeSeconds: 18 });
    expect(state.totalActiveSeconds).toBe(60);
  });

  it("a wedged tab's hours cap at the ceiling", () => {
    const state = foldReadingEvent(EMPTY_READING_STATE, {
      kind: "closed",
      activeSeconds: 48 * 3600,
    });
    expect(state.totalActiveSeconds).toBe(MAX_ACTIVE_SECONDS);
  });

  it("remembers the last page and keeps it when later events omit it", () => {
    let state = foldReadingEvent(EMPTY_READING_STATE, { kind: "progress", progress: 0.3, page: 4 });
    expect(state.lastPage).toBe(4);
    state = foldReadingEvent(state, { kind: "progress", progress: 0.35 });
    expect(state.lastPage).toBe(4);
  });
});

describe("libraryGroup", () => {
    const row = (progress: number | null) => ({
      extractionStatus: "succeeded",
      state:
        progress === null
          ? null
          : { lastOpenedAt: new Date(), openCount: 1, totalActiveSeconds: 0, furthestProgress: progress },
    });

  it("sorts continue, unread, finished by folded progress", () => {
    expect(libraryGroup(row(null))).toBe("unread");
    expect(libraryGroup(row(0))).toBe("unread");
    expect(libraryGroup(row(STARTED_AT))).toBe("continue");
    expect(libraryGroup(row(0.5))).toBe("continue");
    expect(libraryGroup(row(FINISHED_AT))).toBe("finished");
    expect(libraryGroup(row(1))).toBe("finished");
  });
});
