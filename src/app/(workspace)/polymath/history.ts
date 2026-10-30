import { timeAgoShort } from "@/lib/time";

/*
 * Conversations, bucketed the way a person remembers them: today, yesterday,
 * the week before, then everything older. One array feeds both views of the
 * history (the list on the idle home and the chip's popover), so the two can
 * never disagree about which day a conversation belongs to.
 *
 * Bucketing runs on the server. A client-side bucket would flip rows between
 * "Today" and "Yesterday" at the reader's timezone, not the server's, and the
 * same conversation would sit in two places depending on where it was opened.
 */

export type HistoryRow = { id: string; title: string; href: string; at: Date };
export type HistoryRowView = { id: string; title: string; href: string; time: string };
export type HistoryGroup = { key: string; label: string; rows: HistoryRowView[] };

const DAY = 86_400_000;

export function groupHistory(rows: HistoryRow[], now: Date = new Date()): HistoryGroup[] {
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const buckets: HistoryGroup[] = [
    { key: "today", label: "Today", rows: [] },
    { key: "yesterday", label: "Yesterday", rows: [] },
    { key: "week", label: "Previous 7 days", rows: [] },
    { key: "older", label: "Older", rows: [] },
  ];
  for (const row of rows) {
    const at = row.at.getTime();
    const index = at >= midnight ? 0 : at >= midnight - DAY ? 1 : at >= midnight - 7 * DAY ? 2 : 3;
    buckets[index].rows.push({ id: row.id, title: row.title, href: row.href, time: timeAgoShort(row.at) });
  }
  return buckets.filter((bucket) => bucket.rows.length > 0);
}
