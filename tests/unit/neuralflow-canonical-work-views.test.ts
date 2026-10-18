import { describe, expect, it } from "vitest";
import { isTodayWork, workView } from "@/components/products/neuralflow/work-views";
import type { Task, TaskStatus } from "@/components/workspace/types";

function task(status: TaskStatus): Task {
  return { id: status, title: "Review the working plan", status, priority: "High", dueDate: "2020-01-01", estimate: 25, description: "", tags: [], version: 1 };
}

describe("canonical NeuralFlow Work views", () => {
  it("opens all supported views and falls back to Today for invalid URL values", () => {
    for (const view of ["today", "list", "board", "calendar"]) expect(workView(view)).toBe(view);
    for (const value of [undefined, "", "projects", ["list", "board"]]) expect(workView(value)).toBe("today");
  });

  it("shows explicitly ready and running work without promoting captures or overdue backlog", () => {
    expect(isTodayWork(task("READY"))).toBe(true);
    expect(isTodayWork(task("IN_PROGRESS"))).toBe(true);
    for (const status of ["INBOX", "BACKLOG", "WAITING", "DONE"] as const) expect(isTodayWork(task(status))).toBe(false);
  });
});
