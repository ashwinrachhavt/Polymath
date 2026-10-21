import { afterEach, describe, expect, it, vi } from "vitest";
import type { CalendarEvent, Task, TaskStatus } from "@/components/workspace/types";
import { advanceRecurrence, compareTasks, completionPatch, nextRank, recurrenceLabel, reorderTasks } from "@/components/workspace/tasks";
import { createPreviewWorkspace } from "@/components/workspace/workspace-provider";
import { expandRecurrence } from "@/components/products/neuralflow/planning";

const task = (id: string, status: TaskStatus, rank?: number, priority: Task["priority"] = "Medium"): Task =>
  ({ id, title: id, status, priority, estimate: 25, description: "", tags: [], version: 1, rank });

describe("canonical task rules", () => {
  it("appends a new task to the end of its own status column", () => {
    const tasks = [task("a", "READY", 1), task("b", "READY", 2), task("c", "BACKLOG", 9)];
    expect(nextRank(tasks, "READY")).toBe(3);
    expect(nextRank(tasks, "INBOX")).toBe(1);
  });

  it("renumbers only the rows whose rank actually changed", () => {
    const tasks = [task("a", "READY", 1), task("b", "READY", 2), task("c", "READY", 3)];
    expect(reorderTasks(tasks, "a", "READY", 2)).toEqual([{ id: "b", rank: 1 }, { id: "c", rank: 2 }, { id: "a", rank: 3 }]);
    expect(reorderTasks(tasks, "b", "READY", 1)).toEqual([]);
    expect(reorderTasks(tasks, "missing", "READY", 0)).toEqual([]);
  });

  it("clamps a drop index past the end of the column instead of dropping the task", () => {
    const tasks = [task("a", "READY", 1), task("b", "READY", 2)];
    expect(reorderTasks(tasks, "a", "READY", 99)).toEqual([{ id: "b", rank: 1 }, { id: "a", rank: 2 }]);
  });

  it("keeps unranked tasks behind ranked ones and then falls back to priority", () => {
    const tasks = [task("unranked", "READY", undefined, "High"), task("ranked", "READY", 5, "Low")];
    expect([...tasks].sort(compareTasks).map((item) => item.id)).toEqual(["ranked", "unranked"]);
  });

  it("advances a monthly recurrence by clamping to the shorter month", () => {
    const january = new Date("2026-01-31T12:00:00");
    expect(advanceRecurrence("2026-01-31", { frequency: "monthly", interval: 1 }, january)).toBe("2026-02-28");
    expect(advanceRecurrence("2026-10-11", { frequency: "daily", interval: 3 }, new Date("2026-10-11T12:00:00"))).toBe("2026-10-14");
    expect(advanceRecurrence("2026-10-11", { frequency: "weekly", interval: 2 }, new Date("2026-10-11T12:00:00"))).toBe("2026-10-25");
  });

  it("stops a recurrence at its until date and rolls a stale schedule forward", () => {
    expect(advanceRecurrence("2026-10-11", { frequency: "daily", interval: 1, until: "2026-10-11" })).toBeUndefined();
    expect(advanceRecurrence("2020-01-01", { frequency: "daily", interval: 1 }, new Date("2026-10-11T12:00:00"))).toBe("2026-10-12");
  });

  it("keeps a recurring task open on its next date and closes a one-off", () => {
    const recurring: Task = { ...task("r", "IN_PROGRESS", 1), dueDate: "2026-10-11", recurrence: { frequency: "weekly", interval: 1 } };
    expect(completionPatch(recurring, new Date("2026-10-11T12:00:00"))).toMatchObject({ status: "READY", dueDate: "2026-10-18", completionCount: 1 });
    expect(completionPatch(task("one-off", "READY", 1), new Date("2026-10-11T12:00:00"))).toMatchObject({ status: "DONE" });
  });

  it("labels a recurrence without an em dash", () => {
    expect(recurrenceLabel({ frequency: "weekly", interval: 2 })).toBe("Every 2 weeks");
    expect(recurrenceLabel({ frequency: "daily", interval: 1, until: "2026-12-01" })).toBe("Every day until 2026-12-01");
  });
});

describe("preview workspace task mutations", () => {
  function memoryStorage() {
    const values = new Map<string, string>();
    return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  }

  function seeded() {
    const workspace = createPreviewWorkspace("task-rules-owner", memoryStorage());
    const starting = workspace.getSnapshot().tasks.length;
    return { workspace, starting };
  }

  it("ranks a new task inside its own column only", () => {
    const { workspace, starting } = seeded();
    workspace.addTask("Existing ready task", { status: "READY" });
    workspace.addTask("Ranked task", { status: "READY" });
    const created = workspace.getSnapshot().tasks.find((item) => item.title === "Ranked task");
    const first = workspace.getSnapshot().tasks.find((item) => item.title === "Existing ready task");
    expect(created?.rank).toBe((first?.rank ?? 0) + 1);
    expect(workspace.getSnapshot().tasks.length).toBe(starting + 2);
  });

  it("lands a status change at the end of the target column rather than keeping its old rank", () => {
    const { workspace } = seeded();
    workspace.addTask("Already waiting", { status: "WAITING" });
    workspace.addTask("Source task", { status: "READY" });
    const source = workspace.getSnapshot().tasks.find((item) => item.title === "Source task");
    workspace.updateTask(source!.id, { status: "WAITING" });
    const moved = workspace.getSnapshot().tasks.find((item) => item.id === source!.id);
    const waiting = workspace.getSnapshot().tasks.filter((item) => item.status === "WAITING" && item.id !== moved!.id);
    expect(moved?.rank).toBe(nextRank(waiting, "WAITING"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("advances a recurring task instead of closing it", () => {
    // completeTask defaults completedAt to the real clock, and completing a
    // stale weekly task correctly rolls forward past today - so the clock is
    // pinned to the day after the due date, where 2026-10-18 is the next
    // occurrence, or this test fails on every later date.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-12T12:00:00"));
    const workspace = createPreviewWorkspace("recurrence-owner", memoryStorage());
    const record = workspace.addTask("Weekly review", { status: "READY", dueDate: "2026-10-11", recurrence: { frequency: "weekly", interval: 1 } })!;
    workspace.completeTask(record.id);
    const after = workspace.getSnapshot().tasks.find((item) => item.id === record.id);
    expect(after?.status).toBe("READY");
    expect(after?.dueDate).toBe("2026-10-18");
    expect(after?.completionCount).toBe(1);
  });

  it("refuses a duplicate attachment on the same task", () => {
    const workspace = createPreviewWorkspace("attachment-owner", memoryStorage());
    const record = workspace.addTask("Has a brief")!;
    workspace.addAttachment(record.id, { kind: "url", label: "Spec", value: "https://example.test/spec" });
    expect(workspace.addAttachment(record.id, { kind: "url", label: "Spec again", value: "https://example.test/spec" })).toEqual({ ok: false, persisted: true });
    expect(workspace.getSnapshot().tasks.find((item) => item.id === record.id)?.attachments).toHaveLength(1);
  });
});

describe("calendar recurrence expansion", () => {
  it("shows one stored series on every date it lands", () => {
    const series: CalendarEvent = { id: "series", title: "Weekly review", date: "2026-10-11", start: "09:00", duration: 50, provider: "local", recurrence: { frequency: "weekly", interval: 1 } };
    expect(expandRecurrence(series, "2026-11-01").map((item) => item.date)).toEqual(["2026-10-11", "2026-10-18", "2026-10-25", "2026-11-01"]);
  });

  it("skips a cancelled occurrence without breaking the rest of the series", () => {
    const series: CalendarEvent = { id: "series", title: "Weekly review", date: "2026-10-11", start: "09:00", duration: 50, provider: "local", recurrence: { frequency: "weekly", interval: 1 }, exceptionDates: ["2026-10-18"] };
    expect(expandRecurrence(series, "2026-10-25").map((item) => item.date)).toEqual(["2026-10-11", "2026-10-25"]);
  });

  it("shifts a multi-day block by the same offset on each occurrence", () => {
    const series: CalendarEvent = { id: "series", title: "Offsite", date: "2026-10-11", start: "09:00", duration: 480, endDate: "2026-10-12", provider: "local", recurrence: { frequency: "weekly", interval: 1 } };
    expect(expandRecurrence(series, "2026-10-18").map((item) => item.endDate)).toEqual(["2026-10-12", "2026-10-19"]);
  });

  it("leaves a one-off block alone", () => {
    const single: CalendarEvent = { id: "single", title: "Focus", date: "2026-10-11", start: "09:00", duration: 50, provider: "local" };
    expect(expandRecurrence(single, "2026-12-01")).toEqual([single]);
  });
});
