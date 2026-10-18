import type { Task } from "@/components/workspace/types";

export const workViews = ["today", "list", "board", "calendar"] as const;
export type WorkView = (typeof workViews)[number];

export function workView(value: string | string[] | undefined): WorkView {
  return workViews.find((view) => view === value) || "today";
}

// Until daily outcomes are connected, Ready is the owner's explicit commitment.
// Captures, deadlines, and waiting work never silently enter the execution queue.
export function isTodayWork(task: Task) {
  return task.status === "READY" || task.status === "IN_PROGRESS";
}
