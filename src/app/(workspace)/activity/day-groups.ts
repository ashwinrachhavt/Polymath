import type { ActivityItem } from "@/domains/audit/present";
import { dateKeyInTimezone, shiftDateKey, todayKeyInTimezone } from "@/lib/local-date";

/*
 * Pure day-grouping for the Activity feed — client-safe by construction (no
 * database, no React, no server-only imports): the initial server render and
 * the incremental "Load more" island both group with these functions, so a
 * page appended over a server action lands in the same buckets the server
 * would have rendered (spec W3).
 */

/** Page size for the "Load more" keyset walk; five pages is the view's cap. */
export const ACTIVITY_PAGE_SIZE = 50;
export const ACTIVITY_MAX_PAGES = 5;

export type ActivityDayGroup = {
  /** The group's date key (YYYY-MM-DD in the viewer's timezone). */
  key: string;
  label: string;
  items: ActivityItem[];
};

const dayNameFormatters = new Map<string, Intl.DateTimeFormat>();

function dayNameFormatter(timeZone: string): Intl.DateTimeFormat {
  let fmt = dayNameFormatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", { weekday: "long", month: "short", day: "numeric", timeZone });
    dayNameFormatters.set(timeZone, fmt);
  }
  return fmt;
}

/** The label names the same calendar day the key names, in the viewer's timezone. */
function dayLabel(key: string, todayKey: string, yesterdayKey: string, occurredAt: Date, timeZone: string): string {
  if (key === todayKey) return "Today";
  if (key === yesterdayKey) return "Yesterday";
  return dayNameFormatter(timeZone).format(occurredAt);
}

/**
 * Group a page of items into day buckets in the viewer's timezone. Input
 * order (newest first, the read model's order) is preserved within and
 * across groups; a group appears the first time one of its items does.
 * Labels are TODAY / YESTERDAY for the two relative days, otherwise the
 * weekday and date.
 */
export function groupActivityByDay(items: ActivityItem[], timeZone: string, now: Date): ActivityDayGroup[] {
  const todayKey = todayKeyInTimezone(timeZone, now);
  const yesterdayKey = shiftDateKey(todayKey, -1);
  const groups: ActivityDayGroup[] = [];
  const byKey = new Map<string, ActivityDayGroup>();
  for (const item of items) {
    const key = dateKeyInTimezone(item.occurredAt, timeZone);
    let group = byKey.get(key);
    if (!group) {
      group = { key, label: dayLabel(key, todayKey, yesterdayKey, item.occurredAt, timeZone), items: [] };
      byKey.set(key, group);
      groups.push(group);
    }
    group.items.push(item);
  }
  return groups;
}

/**
 * Append one presented page to the accumulated groups. The pages are keyset
 * ordered, so the only legal seam is the one where the trailing day and the
 * leading day are the same calendar day — merged there, in order; every
 * other incoming group starts a new bucket. Order is preserved and rows are
 * neither duplicated nor dropped (spec W3's append semantics).
 */
export function mergeDayGroups(existing: ActivityDayGroup[], incoming: ActivityDayGroup[]): ActivityDayGroup[] {
  if (existing.length === 0 || incoming.length === 0) return [...existing, ...incoming];
  const last = existing[existing.length - 1]!;
  const [first, ...rest] = incoming;
  if (first.key === last.key) {
    return [...existing.slice(0, -1), { ...last, items: [...last.items, ...first.items] }, ...rest];
  }
  return [...existing, ...incoming];
}
