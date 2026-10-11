import { describe, expect, it } from "vitest";
import type { CalendarEvent, Task, TaskStatus } from "@/components/workspace/types";
import { createBoardViewStore, defaultBoardViews } from "@/components/products/neuralflow/board-views";
import { brainDumpLines, calendarDaySegments, eventEnd, focusRemaining, focusRewardKey, hasConflict, minuteOfDay, proposeSchedule, shiftDate, validDate } from "@/components/products/neuralflow/planning";

const task = (id: string, priority: Task["priority"] = "Medium", estimate = 25, status: TaskStatus = "READY"): Task => ({ id, title: id, priority, estimate, status, description: "", tags: [], version: 1 });
const block = (date: string, start: string, duration: number, taskId?: string): CalendarEvent => ({ id: `block-${date}-${start}`, title: "Local block", date, start, duration, taskId, provider: "local" });

describe("NeuralFlow owner-scoped saved board views", () => {
  function memoryStorage() {
    const values = new Map<string, string>();
    return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  }
  it("isolates snapshots, storage, listeners and remount state across owners", () => {
    const storage = memoryStorage();
    const ownerA = createBoardViewStore("owner-a-hash", storage);
    const ownerB = createBoardViewStore("owner-b-hash", storage);
    let callsA = 0; let callsB = 0;
    ownerA.subscribe(() => { callsA++; }); ownerB.subscribe(() => { callsB++; });
    ownerA.addView({ id: "private-a", title: "Owner A private view", query: "Private project", project: "project-a" });
    expect(ownerA.getSnapshot().some((view) => view.id === "private-a")).toBe(true);
    expect(ownerB.getSnapshot()).toEqual(defaultBoardViews);
    expect(callsA).toBe(1); expect(callsB).toBe(0);
    expect(storage.values.has("axiom-neuralflow-board-views-v2:owner-a-hash")).toBe(true);
    expect(storage.values.has("axiom-neuralflow-board-views-v2:owner-b-hash")).toBe(false);
    expect(createBoardViewStore("owner-a-hash", storage).getSnapshot().some((view) => view.id === "private-a")).toBe(true);
    expect(createBoardViewStore("owner-b-hash", storage).getSnapshot()).toEqual(defaultBoardViews);
  });
  it("does not migrate ownerless legacy records into signed-in or anonymous views", () => {
    const storage = memoryStorage();
    storage.setItem("axiom-neuralflow-board-views-v1", JSON.stringify([{ id: "legacy-private", title: "Previous owner's private title", project: "all", query: "secret" }]));
    expect(createBoardViewStore("owner-c-hash", storage).getSnapshot()).toEqual(defaultBoardViews);
    expect(createBoardViewStore("anonymous", storage).getSnapshot()).toEqual(defaultBoardViews);
  });
  it("merges a same-owner tab's saved view before writing from an already cached tab", () => {
    const storage = memoryStorage();
    const tabA = createBoardViewStore("same-owner-hash", storage);
    const tabB = createBoardViewStore("same-owner-hash", storage);
    tabA.getSnapshot(); tabB.getSnapshot();
    tabA.addView({ id: "view-a", title: "View saved by tab A", project: "all", query: "first" });
    tabB.addView({ id: "view-b", title: "View saved by tab B", project: "all", query: "second" });
    expect(tabA.getSnapshot().map((view) => view.id)).toEqual(["all", "deep", "view-a", "view-b"]);
    expect(tabB.getSnapshot().map((view) => view.id)).toEqual(["all", "deep", "view-a", "view-b"]);
    expect(createBoardViewStore("same-owner-hash", storage).getSnapshot().map((view) => view.id)).toEqual(["all", "deep", "view-a", "view-b"]);
  });
  it("keeps snapshot references stable until storage changes and resets on storage removal", () => {
    const storage = memoryStorage();
    const store = createBoardViewStore("same-owner-hash", storage);
    const original = store.getSnapshot();
    expect(store.getSnapshot()).toBe(original);
    const otherTab = createBoardViewStore("same-owner-hash", storage);
    otherTab.addView({ id: "other-tab-view", title: "Other tab view", project: "all", query: "" });
    const refreshed = store.getSnapshot();
    expect(refreshed).not.toBe(original);
    expect(store.getSnapshot()).toBe(refreshed);
    storage.values.delete("axiom-neuralflow-board-views-v2:same-owner-hash");
    expect(store.getSnapshot()).toEqual(defaultBoardViews);
  });
  it("does not erase a persistence warning when a later storage refresh succeeds", () => {
    const storage = memoryStorage();
    const store = createBoardViewStore("same-owner-hash", { getItem: storage.getItem, setItem: () => { throw new Error("Storage blocked"); } });
    store.addView({ id: "unsaved", title: "Unsaved view", project: "all", query: "" });
    storage.setItem("axiom-neuralflow-board-views-v2:same-owner-hash", JSON.stringify(defaultBoardViews));
    store.getSnapshot();
    expect(store.getNotice()).toContain("could not save");
  });
  it("shows malformed-storage notices without loading another owner's views", () => {
    const storage = memoryStorage();
    storage.setItem("axiom-neuralflow-board-views-v2:owner-d-hash", "{invalid-json");
    const store = createBoardViewStore("owner-d-hash", storage);
    expect(store.getSnapshot()).toEqual(defaultBoardViews);
    expect(store.getNotice()).toContain("could not be loaded");
  });
  it("keeps failed-persistence changes only in their own factory and reports the failure", () => {
    const storage = { getItem: () => null, setItem: () => { throw new Error("Storage blocked"); } };
    const ownerA = createBoardViewStore("owner-a-hash", storage);
    ownerA.addView({ id: "tab-only", title: "Tab-only owner A view", project: "all", query: "" });
    expect(ownerA.getNotice()).toContain("could not save");
    expect(ownerA.getSnapshot().some((view) => view.id === "tab-only")).toBe(true);
    expect(createBoardViewStore("owner-b-hash", storage).getSnapshot()).toEqual(defaultBoardViews);
  });
});

describe("NeuralFlow deterministic planning", () => {
  it("rejects invalid dates and shifts across year boundaries", () => {
    expect(validDate("2026-02-30")).toBe(false);
    expect(validDate("2026-02-28")).toBe(true);
    expect(validDate("not-a-date")).toBe(false);
    expect(shiftDate("2026-12-31", 1)).toBe("2027-01-01");
    expect(minuteOfDay("09:15")).toBe(555);
  });
  it("detects previous-day overnight overlaps and uses half-open boundaries", () => {
    const events = [block("2026-10-10", "23:30", 90)];
    expect(hasConflict(events, "2026-10-11", "00:15", 25)).toBe(true);
    expect(hasConflict(events, "2026-10-11", "01:00", 25)).toBe(false);
    expect(hasConflict(events, "2026-10-10", "23:30", 90, events[0].id)).toBe(false);
    expect(eventEnd(events[0])).toEqual({ date: "2026-10-11", time: "01:00" });
  });
  it("splits overnight events, separates overlapping lanes, and excludes midnight endpoints", () => {
    const overnight = block("2026-10-10", "23:30", 90);
    const overlapping = block("2026-10-11", "00:15", 15);
    const segments = calendarDaySegments([overnight, overlapping], "2026-10-11");
    expect(segments).toHaveLength(2);
    expect(segments[0]).toMatchObject({ from: 0, to: 60, lane: 0, laneCount: 2 });
    expect(segments[1]).toMatchObject({ from: 15, to: 30, lane: 1, laneCount: 2 });
    expect(calendarDaySegments([block("2026-10-10", "23:00", 60)], "2026-10-11")).toEqual([]);
  });
  it("uses ready/in-progress canonical tasks in priority order", () => {
    const proposals = proposeSchedule([task("low", "Low"), task("high", "High"), task("done", "High", 25, "DONE"), task("inbox", "High", 25, "INBOX")], [], "2026-10-11", "09:00", "10:00");
    expect(proposals.map((proposal) => proposal.taskId)).toEqual(["high", "low"]);
    expect(proposals[0].start).toBe("09:00");
    expect(proposals[1].start).toBe("09:30");
    expect(proposals[0].taskVersion).toBe(1);
  });
  it("excludes existing task blocks and avoids conflicts between proposals", () => {
    const events = [block("2026-10-11", "09:00", 50, "existing")];
    const proposals = proposeSchedule([task("existing"), task("new", "High", 26), task("another", "Low", 25)], events, "2026-10-11", "09:00", "12:00");
    expect(proposals).toHaveLength(2);
    expect(proposals[0]).toMatchObject({ taskId: "new", duration: 30, start: "10:00" });
    expect(hasConflict([...events, { ...proposals[0], id: "proposal", provider: "local" }], proposals[1].date, proposals[1].start, proposals[1].duration)).toBe(false);
  });
  it("never crosses the window boundary and caps proposals", () => {
    expect(proposeSchedule([task("large", "High", 50)], [], "2026-10-11", "09:00", "09:25")).toHaveLength(0);
    expect(proposeSchedule(Array.from({ length: 20 }, (_, index) => task(String(index), "Medium", 15)), [], "2026-10-11", "09:00", "17:00")).toHaveLength(5);
  });
  it("derives focus from timestamps, freezes paused time, and clamps clock changes", () => {
    const focus = { taskId: "task", startedAt: 100000, remaining: 1500, duration: 25, status: "running" as const, completed: 0 };
    expect(focusRemaining(focus, 160000)).toBe(1440);
    expect(focusRemaining({ ...focus, status: "paused", remaining: 800 }, 9999999)).toBe(800);
    expect(focusRemaining(focus, 9999999)).toBe(0);
    expect(focusRemaining(focus, 1)).toBe(1500);
    expect(focusRewardKey(focus)).toBe(focusRewardKey({ ...focus }));
    expect(focusRewardKey(focus)).not.toBe(focusRewardKey({ ...focus, startedAt: 100001 }));
  });
  it("splits literal lines without AI, removes repeated lines, strips bullets and caps 30", () => {
    expect(brainDumpLines("- Prepare review\n1. Take notes\n\n- Prepare review\n  * Protect focus  ")).toEqual(["Prepare review", "Take notes", "Protect focus"]);
    expect(brainDumpLines(Array.from({ length: 40 }, (_, index) => `Task ${index}`).join("\n"))).toHaveLength(30);
    expect(brainDumpLines(" \n\n")).toEqual([]);
  });
});
