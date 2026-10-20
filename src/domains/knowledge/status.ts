/*
 * The inbox's one status vocabulary (ASH-127). The database stores enum rows;
 * a human reads words. Every state maps to a label plus a tone, and the tone
 * is never the only signal — the label carries the meaning, the glyph and
 * color just point at it.
 */

export type DocumentStatusTone = "neutral" | "progress" | "attention" | "done" | "error";

/**
 * How long a queued read may sit before the row stops claiming to be in
 * progress. Comfortably longer than one worker tick plus a Docling first run,
 * short enough that a stopped worker is obvious the same session.
 */
export const STALLED_AFTER_MS = 5 * 60_000;

/**
 * Accepts a Date or an ISO string. Postgres timestamps cross a server-component
 * boundary as strings, and a raw `.getTime()` on one throws for the whole inbox.
 */
function stalled(createdAt: Date | string | null | undefined, now: Date): boolean {
  if (createdAt == null) return false;
  const at = createdAt instanceof Date ? createdAt : new Date(createdAt);
  const ms = at.getTime();
  return Number.isFinite(ms) && now.getTime() - ms > STALLED_AFTER_MS;
}

export type DocumentStatus = { label: string; tone: DocumentStatusTone };

/**
 * Human state for one inbox row, from the latest extraction plus how many
 * field proposals are still undecided. No extraction row yet means the file is
 * uploaded but not read; a succeeded extraction with undecided proposals is
 * the one state that asks for the owner. Text that was read but whose fields
 * were never proposed (or whose proposal pass failed) is never "Filed".
 */
export function documentStatus(
  extraction: {
    status: string;
    error?: string | null;
    proposalStatus?: string | null;
    /** When this attempt was created. Omit for callers that have no timestamp. */
    createdAt?: Date | string | null;
  } | null | undefined,
  undecidedProposals: number,
  /** Anything that can move the row along. Gives "Reading" an age. */
  now: Date = new Date(),
): DocumentStatus {
  if (!extraction) return { label: "Added", tone: "neutral" };
  switch (extraction.status) {
    case "pending":
    case "skipped":
      // A pending extraction only moves when something drains the queue. If
      // nothing has for a long time, the honest word is not "Reading" - it is
      // that nothing is reading. ASH-178: the worker being off must be visible.
      return stalled(extraction.createdAt, now) ? { label: "Waiting for the queue", tone: "attention" } : { label: "Reading", tone: "progress" };
    case "failed":
      return { label: "Could not read", tone: "error" };
    case "succeeded":
      // Text alone is not filed: the proposal pass must have run too.
      if (extraction.proposalStatus === "failed") return { label: "Fields not read", tone: "error" };
      if (extraction.proposalStatus === "pending") {
        return stalled(extraction.createdAt, now)
          ? { label: "Waiting for the queue", tone: "attention" }
          : { label: "Reading", tone: "progress" };
      }
      if (extraction.proposalStatus !== "succeeded") return { label: "Fields not proposed", tone: "attention" };
      return undecidedProposals > 0
        ? { label: "Needs your check", tone: "attention" }
        : { label: "Filed", tone: "done" };
    default:
      return { label: "Added", tone: "neutral" };
  }
}
