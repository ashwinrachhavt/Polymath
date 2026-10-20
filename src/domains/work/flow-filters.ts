/*
 * Quick Filters for Today's Flow (ASH-185): a topic (a task tag) and a
 * priority chip P1-P3. Pure, so the chips and their tests share one mapping.
 * P1 = urgent, P2 = high, P3 = medium; low and unset tasks have no chip but
 * show whenever no priority filter is on.
 */

export const FLOW_PRIORITIES = { p1: "urgent", p2: "high", p3: "medium" } as const;
export type FlowPriorityKey = keyof typeof FLOW_PRIORITIES;

export type FlowFilter = { topic: string | null; priority: FlowPriorityKey | null };

export function parseFlowFilter(raw: { ft?: string | string[]; fp?: string | string[] }): FlowFilter {
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const topic = one(raw.ft)?.trim().toLowerCase() || null;
  const fp = one(raw.fp)?.toLowerCase();
  const priority = fp && fp in FLOW_PRIORITIES ? (fp as FlowPriorityKey) : null;
  return { topic, priority };
}

type Filterable = { priority: string; tags?: unknown };

const tagsOf = (t: Filterable): string[] =>
  Array.isArray(t.tags) ? t.tags.filter((x): x is string => typeof x === "string").map((x) => x.toLowerCase()) : [];

export function applyFlowFilter<T extends Filterable>(tasks: T[], filter: FlowFilter): T[] {
  return tasks.filter(
    (t) =>
      (!filter.topic || tagsOf(t).includes(filter.topic)) &&
      (!filter.priority || t.priority === FLOW_PRIORITIES[filter.priority]),
  );
}

/** Distinct topics across the tasks, most used first, capped so the chip row stays one line. */
export function topicsOf(tasks: Filterable[], max = 6): string[] {
  const counts = new Map<string, number>();
  for (const t of tasks) for (const tag of tagsOf(t)) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, max).map(([tag]) => tag);
}
