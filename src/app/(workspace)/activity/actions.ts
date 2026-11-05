"use server";

import { presentActivityEvents, type ActivityItem } from "@/domains/audit/present";
import { decodeActivityCursor, listActivityEvents } from "@/domains/audit/queries";
import { getAuthContext } from "@/lib/auth";
import { ACTIVITY_PAGE_SIZE, buildEventFilters } from "./present-view";
import { groupActivityByDay, type ActivityDayGroup } from "./day-groups";

/*
 * The incremental "Load more" contract (spec W3): the action fetches exactly
 * the next keyset page and returns it presented and day-grouped — the client
 * appends, nothing upstream re-renders. The page-1 walk, the filters'
 * vocabulary, and the presenter stay the page's; this action is the same
 * composition one page deep. It re-derives identity and re-narrows filters
 * from the arguments it is handed (a server action is untrusted input), so
 * a forged call reads no more than its one cursor page.
 */

/** The serializable view state the feed island needs to ask for its next page. */
export type ActivityFeedFilters = {
  category?: string;
  q?: string;
  actorId?: string;
  technical?: boolean;
};

export type ActivityLoadMoreResult =
  | { ok: true; groups: ActivityDayGroup[]; nextCursor: string | null; hasMore: boolean }
  | { ok: false; error: "invalid-cursor" };

export async function loadActivityPage(
  filters: ActivityFeedFilters,
  cursor: string,
  timezone: string,
): Promise<ActivityLoadMoreResult> {
  const auth = await getAuthContext();
  if (typeof cursor !== "string" || cursor.length === 0 || cursor.length > 256) {
    return { ok: false, error: "invalid-cursor" };
  }
  try {
    // The read model treats a malformed cursor as a caller bug and throws;
    // over a server action the "caller" is a URL the world can edit, so the
    // malformed case degrades to a named failure the island renders as an
    // honest note instead of an error boundary.
    decodeActivityCursor(cursor);
  } catch {
    return { ok: false, error: "invalid-cursor" };
  }

  const result = await listActivityEvents(auth, {
    limit: ACTIVITY_PAGE_SIZE,
    cursor,
    filters: buildEventFilters(
      { category: filters.category, q: filters.q, actorId: filters.actorId },
      filters.technical !== false,
    ),
  });
  const items: ActivityItem[] = await presentActivityEvents(auth, result.rows);
  const groups = groupActivityByDay(items, timezone, new Date());
  return { ok: true, groups, nextCursor: result.nextCursor, hasMore: result.nextCursor !== null };
}
