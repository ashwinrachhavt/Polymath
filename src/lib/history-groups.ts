/*
 * Recency buckets for chat history. Pure date math, so it lives beside the
 * relative-time formatter rather than inside the dropdown that renders it.
 *
 * Boundaries are calendar days, not rolling hours: something sent at 23:50 is
 * under "Today" at 00:10 because that is how a person reads a day. The week
 * bucket is the six days before today; a row exactly seven days old is a week
 * old and falls to "Older".
 */

const DAY_MS = 86_400_000;

export type HistoryGroupKey = "today" | "this-week" | "older";

export type HistoryGroup<T> = {
  key: HistoryGroupKey;
  label: string;
  rows: T[];
};

const ORDER: ReadonlyArray<{ key: HistoryGroupKey; label: string }> = [
  { key: "today", label: "Today" },
  { key: "this-week", label: "This week" },
  { key: "older", label: "Older" },
];

function startOfLocalDay(value: Date): number {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
}

export function groupByRecency<T extends { createdAt: Date | string }>(
  rows: ReadonlyArray<T>,
  now: Date = new Date(),
): HistoryGroup<T>[] {
  const today = startOfLocalDay(now);
  const buckets = new Map<HistoryGroupKey, T[]>(ORDER.map(({ key }) => [key, []]));

  for (const row of rows) {
    const at = row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt);
    const ms = at.getTime();
    // Rounding absorbs the 23 and 25 hour days either side of a DST change.
    // Future-dated rows (clock skew between server and browser) read as today.
    const days = Number.isFinite(ms)
      ? Math.round((today - startOfLocalDay(at)) / DAY_MS)
      : Number.POSITIVE_INFINITY;

    const key: HistoryGroupKey = days <= 0 ? "today" : days < 7 ? "this-week" : "older";
    buckets.get(key)!.push(row);
  }

  return ORDER.map(({ key, label }) => ({ key, label, rows: buckets.get(key)! })).filter(
    (group) => group.rows.length > 0,
  );
}
