import { planOperationGroups } from "@/domains/audit/present";
import type { ActivityEventFilters, ActivityEventRow } from "@/domains/audit/queries";
import type { EventCategory } from "@/domains/audit/events/registry";

/*
 * Pure view helpers for the Activity page: what the presenter deliberately
 * does not decide (where a deep-linked step row lives after operation
 * folding). No database, no React - the page composes these with the
 * presenter's output. Day grouping lives in ./day-groups — re-exported here
 * so existing consumers keep one import.
 */

export { groupActivityByDay, mergeDayGroups, type ActivityDayGroup } from "./day-groups";

export { ACTIVITY_PAGE_SIZE, ACTIVITY_MAX_PAGES } from "./day-groups";

/** The category filter's options, in registry order. */
export const ACTIVITY_CATEGORY_OPTIONS: Array<{ value: EventCategory; label: string }> = [
  { value: "knowledge", label: "Knowledge" },
  { value: "work", label: "Work" },
  { value: "agents", label: "Agents" },
  { value: "connections", label: "Connections" },
  { value: "workspace", label: "Workspace" },
];

function isEventCategory(value: string): value is EventCategory {
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
