import { io } from "next/cache";
import { Suspense } from "react";
import { EmptyState } from "@/components/empty-state";
import { ListToolbar } from "@/components/list/list-toolbar";
import { NoResults } from "@/components/list/no-results";
import { PageHeader } from "@/components/page-header";
import {
  decodeActivityCursor,
  getActivityEvent,
  listActivityActors,
  listActivityEvents,
} from "@/domains/audit/queries";
import { presentActivityEvents, type ActivityItem } from "@/domains/audit/present";
import { cachedPreferences } from "@/lib/cached-shell-reads";
import { getAuthContext } from "@/lib/auth";
import { listHref, parseListParams } from "@/lib/list-params";
import { DeepLinkFocus } from "./deep-link-focus";
import { ActivityEntry, ActivityFeed } from "./feed";
import { groupActivityByDay } from "./day-groups";
import { ACTIVITY_CATEGORY_OPTIONS, ACTIVITY_PAGE_SIZE, buildEventFilters, foldedStepTargets } from "./present-view";
import { TechnicalToggle } from "./technical-toggle";

export const metadata = { title: "Activity · Polymath" };

/*
 * The workspace's outcome feed, built on the audit domain's presenter (spec
 * section 5): what happened, in code-authored sentences; what it produced,
 * as a link verified against the owning domain; when, in the viewer's
 * timezone. Every filter is URL state, so a filtered view is a shareable
 * link, and a deep link to one event scrolls it into view. The feed is never
 * silently empty: a read failure propagates to the (workspace) error
 * boundary's retry state.
 */

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A `?cursor=` the read model will accept; anything else degrades to page 1. */
function isAcceptableCursor(cursor: string): boolean {
  try {
    decodeActivityCursor(cursor);
    return true;
  } catch {
    return false;
  }
}

/*
 * "Load more" is incremental (spec W3): the server renders page one — the
 * single keyset query the view needs for first paint — and the feed island
 * appends further pages through the loadActivityPage action, one cursor page
 * per click. A `?cursor=` deep link renders the page at that keyset position
 * (self-contained); a legacy `?pages=N` degrades to page 1. Five pages is
 * still the cap; beyond it the feed says so honestly.
 */
const CATEGORY_VALUES = ACTIVITY_CATEGORY_OPTIONS.map((option) => option.value);

async function ActivitySurface({ searchParams }: { searchParams: SearchParams }) {
  const query = await searchParams;
  await io();
  if (!process.env.DATABASE_URL?.trim()) {
    return (
      <>
        <PageHeader title="Activity" purpose="What changed in this workspace." />
        <div className="page-content">
          <EmptyState
            title="Activity storage is not configured"
            description="Set DATABASE_URL and apply the database migrations to record and read workspace activity."
          />
        </div>
      </>
    );
  }
  const auth = await getAuthContext();
  // The actor filter's options are independent of every other read here, so
  // they start immediately instead of running last (spec W3).
  const actorsPromise = listActivityActors(auth);
  const { timezone } = await cachedPreferences(auth);
  const list = parseListParams(query, { filters: { category: CATEGORY_VALUES } });

  const q = list.q;
  const category = list.filters.category;
  const actorParam = first(query.actor);
  const actorId = actorParam && UUID_PATTERN.test(actorParam) ? actorParam : undefined;
  const includeTechnical = first(query.technical) === "1";
  const eventParam = first(query.event);
  const requestedEventId = eventParam && UUID_PATTERN.test(eventParam) ? eventParam : undefined;

  // `?cursor=` is a self-contained keyset position; a malformed cursor or the
  // legacy `?pages=N` both degrade to page 1.
  const cursorParam = first(query.cursor);
  const startCursor = cursorParam && isAcceptableCursor(cursorParam) ? cursorParam : null;

  const filters = buildEventFilters({ category, q: q || undefined, actorId }, includeTechnical);
  const { rows, nextCursor } = await listActivityEvents(auth, {
    limit: ACTIVITY_PAGE_SIZE,
    cursor: startCursor,
    filters,
  });

  const items = await presentActivityEvents(auth, rows);
  const groups = groupActivityByDay(items, timezone, new Date());

  /*
   * Deep-link resolution. The target is on this rendered view: highlight it
   * (a folded step highlights its outcome, disclosure opened). It exists but
   * paginated or filtered off the view: render it once, highlighted, above
   * the feed. It is not visible to this viewer at all: one honest note -
   * invisible and unknown look the same from the URL, and the note says so.
   */
  let highlightId: string | null = null;
  let openedStepsOutcomeId: string | null = null;
  let linkedItems: ActivityItem[] = [];
  let linkedUnavailable = false;
  if (requestedEventId) {
    const fold = foldedStepTargets(rows);
    const onViewById = rows.find((row) => row.id === requestedEventId)?.id;
    if (onViewById) {
      const target = fold.get(requestedEventId);
      highlightId = target ?? requestedEventId;
      if (target) openedStepsOutcomeId = target;
    } else {
      const row = await getActivityEvent(auth, requestedEventId);
      if (row) {
        highlightId = row.id;
        linkedItems = await presentActivityEvents(auth, [row]);
      } else {
        linkedUnavailable = true;
      }
    }
  }

  const filtered = q !== "" || category !== undefined || actorId !== undefined || includeTechnical;
  const clearHref = listHref("/activity", query, {
    q: undefined,
    category: undefined,
    actor: undefined,
    technical: undefined,
    pages: undefined,
    cursor: undefined,
  });

  const actorOptions = await actorsPromise;

  return (
    <>
      <PageHeader title="Activity" purpose="What changed in this workspace." />
      <div className="page-content">
        <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
          <ListToolbar
            searchPlaceholder="Search activity"
            pageKeys={["page", "cpage", "rpage", "pages", "cursor"]}
            filters={[
              {
                key: "category",
                label: "Category",
                allLabel: "All categories",
                options: ACTIVITY_CATEGORY_OPTIONS,
              },
              {
                key: "actor",
                label: "Actor",
                allLabel: "All actors",
                options: actorOptions.map((actor) => ({ value: actor.id, label: actor.label })),
              },
            ]}
          />
          <TechnicalToggle />
        </div>

        {requestedEventId && linkedUnavailable ? (
          <p role="note" className="panel-empty mt-3 rounded-lg px-3.5 py-3 text-body-dense text-muted-foreground">
            That event is not available. It may be from another workspace, or the link is out of date.
          </p>
        ) : null}
        {linkedItems.length > 0 ? (
          <section aria-label="Linked event" className="mt-3">
            <ul className="space-y-0.5">
              {linkedItems.map((item) => (
                <ActivityEntry key={item.id} item={item} timeZone={timezone} highlighted={item.id === highlightId} />
              ))}
            </ul>
          </section>
        ) : null}

        {items.length === 0 ? (
          filtered ? (
            <div className="mt-4">
              <NoResults
                filtered
                clearHref={clearHref}
                emptyTitle="No activity yet"
                emptyDescription="Workspace actions - captures, decisions, calendar and day changes - are recorded here as they happen."
              />
            </div>
          ) : (
            <div className="mt-4">
              <EmptyState
                title="No activity yet"
                description="Workspace actions - captures, decisions, calendar and day changes - are recorded here as they happen."
              />
            </div>
          )
        ) : (
          <ActivityFeed
            key={`${q}|${category ?? ""}|${actorId ?? ""}|${includeTechnical ? "1" : "0"}|${startCursor ?? ""}`}
            initialGroups={groups}
            initialNextCursor={nextCursor}
            filters={{ category, q: q || undefined, actorId, technical: includeTechnical }}
            timezone={timezone}
            highlightId={highlightId}
            openedStepsOutcomeId={openedStepsOutcomeId}
          />
        )}
      </div>
      {highlightId ? <DeepLinkFocus targetId={highlightId} /> : null}
    </>
  );
}

/*
 * `io()` must sit inside a Suspense boundary under cacheComponents, or
 * navigation here is treated as blocked on uncached data.
 */
export default function ActivityPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <Suspense
      fallback={
        <p role="status" className="text-muted-foreground p-6 text-body-dense">
          Loading activity…
        </p>
      }
    >
      <ActivitySurface searchParams={searchParams} />
    </Suspense>
  );
}
