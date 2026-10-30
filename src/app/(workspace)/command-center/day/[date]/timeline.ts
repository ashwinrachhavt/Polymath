import type { DayPage } from "@/domains/daybook/queries";

/*
 * The day page's timeline merge (mockup 2026-10-28): the four parallel lists
 * become one record ordered by time — the day reads as one ledger, not four
 * silos. Ties keep list order via sort's stability: a capture keeps its row
 * ahead of the conversion a later audit recorded for the same second.
 * Extracted from the page so the merge has a testable seam without a test-only
 * export of page internals.
 */

export type TimelineRow = {
  key: string;
  at: Date | null;
  /** The record's kind, spoken as the timeline's pill: Captured, Created, Changed, Session, Meeting. */
  kind: string;
  title: string;
  detail?: string;
  /** Artifacts can be pinned; other rows cannot. */
  artifactId?: string;
};

export function buildTimeline(day: DayPage): TimelineRow[] {
  const rows: TimelineRow[] = [];
  for (const item of day.captured) {
    rows.push({ key: `captured-${item.id}`, at: item.at, kind: "Captured", title: item.title });
  }
  for (const item of day.created) {
    rows.push({
      key: `created-${item.id}`,
      at: item.at,
      kind: "Created",
      title: item.title,
      detail: item.kind ? item.kind.charAt(0).toUpperCase() + item.kind.slice(1) : undefined,
      artifactId: item.kind === "artifact" || item.kind === "note" ? item.id : undefined,
    });
  }
  for (const item of day.workedOn) {
    rows.push({ key: `changed-${item.id}`, at: item.at, kind: "Changed", title: item.title, detail: item.kind });
  }
  for (const session of day.sessions) {
    rows.push({
      key: `session-${session.id}`,
      at: session.startedAt,
      kind: "Session",
      title: session.subject ?? "Focus session",
      detail: `${session.minutes} min`,
    });
  }
  for (const item of day.meetings) {
    rows.push({ key: `meeting-${item.id}`, at: item.at, kind: "Meeting", title: item.title });
  }
  return rows.sort((a, b) => (a.at?.getTime() ?? 0) - (b.at?.getTime() ?? 0));
}
