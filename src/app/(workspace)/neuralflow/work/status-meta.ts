import type { BoardStatus } from "./work-board";

/*
 * The one status vocabulary for the work surfaces: the display label and the
 * mockup's tinted pill per status. Extracted from card-modal.tsx and
 * work-list.tsx, which had drifted into three copies of the same maps.
 */

export type WorkStatus = BoardStatus;

/** The human label per status. */
export const STATUS_LABEL: Record<WorkStatus, string> = {
  inbox: "Inbox",
  backlog: "Backlog",
  ready: "Ready",
  in_progress: "In progress",
  waiting: "Waiting",
  done: "Done",
  cancelled: "Cancelled",
};

/** The mockup's tinted pills: the state is a colour, not a label squeezed between title and meta. Green ready, blue in-flight, amber waiting. */
export const STATUS_PILL: Record<WorkStatus, string> = {
  inbox: "pill pill-neutral",
  backlog: "pill pill-neutral",
  ready: "pill pill-success",
  in_progress: "pill pill-info",
  waiting: "pill pill-working",
  done: "pill pill-neutral",
  cancelled: "pill pill-neutral",
};
