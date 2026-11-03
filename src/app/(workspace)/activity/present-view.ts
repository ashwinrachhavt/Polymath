import { planOperationGroups, type ActivityItem } from "@/domains/audit/present";
import type { ActivityEventFilters, ActivityEventRow } from "@/domains/audit/queries";
import type { EventCategory } from "@/domains/audit/events/registry";
import { dateKeyInTimezone, shiftDateKey, todayKeyInTimezone } from "@/lib/local-date";

/*
 * Pure view helpers for the Activity page: what the presenter deliberately
 * does not decide (day grouping in the viewer's timezone, and where a
 * deep-linked step row lives after operation folding). No database, no React
 * - the page composes these with the presenter's output.
 */

/** Page size for the "Load more" keyset walk; five pages is the view's cap. */
export const ACTIVITY_PAGE_SIZE = 50;
export const ACTIVITY_MAX_PAGES = 5;

/** The category filter's options, in registry order. */
export const ACTIVITY_CATEGORY_OPTIONS: Array<{ value: EventCategory; label: string }> = [
  { value: "knowledge", label: "Knowledge" },
  { value: "work", label: "Work" },
  { value: "agents", label: "Agents" },
  { value: "connections", label: "Connections" },
  { value: "workspace", label: "Workspace" },
];

export function isEventCategory(value: string): value is EventCategory {
  return ACTIVITY_CATEGORY_OPTIONS.some((option) => option.value === value);
}

/**
 * The page's URL-derived filters, narrowed to the read model's contract:
 * an unknown category string drops out (the registry, not the URL, owns
 * the vocabulary), and the technical toggle rides the same object so the
 * walk loop passes one shape.
 */
export function buildEventFilters(
  filters: { category?: string; q?: string; actorId?: string },
  includeTechnical: boolean,
): ActivityEventFilters {
  return {
    category: filters.category && isEventCategory(filters.category) ? filters.category : undefined,
    actorId: filters.actorId,
    q: filters.q,
    includeTechnical,
  };
}

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

/** The label names the same calendar day the key names, in the viewer's timezone. */
function dayLabel(key: string, todayKey: string, yesterdayKey: string, occurredAt: Date, timeZone: string): string {
  if (key === todayKey) return "Today";
  if (key === yesterdayKey) return "Yesterday";
  return dayNameFormatter(timeZone).format(occurredAt);
}

/**
 * Step row id → the outcome row id its disclosure lives under. The deep link
 * targets an event id, but a folded step renders inside its outcome's
 * disclosure, so the highlight lands on the outcome and the disclosure opens.
 */
export function foldedStepTargets(rows: ActivityEventRow[]): Map<string, string> {
  const targets = new Map<string, string>();
  for (const plan of planOperationGroups(rows).values()) {
    for (const step of plan.steps) targets.set(step.id, plan.outcome.id);
  }
  return targets;
}
