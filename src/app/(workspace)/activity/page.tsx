import { io } from "next/cache";
import Link from "next/link";
import { Suspense } from "react";
import { EmptyState } from "@/components/empty-state";
import { ListToolbar } from "@/components/list/list-toolbar";
import { NoResults } from "@/components/list/no-results";
import { PageHeader } from "@/components/page-header";
import {
  getActivityEvent,
  listActivityActors,
  listActivityEvents,
  type ActivityEventRow,
} from "@/domains/audit/queries";
import { presentActivityEvents, type ActivityItem, type Destination } from "@/domains/audit/present";
import { getPreferences } from "@/domains/identity/preferences";
import { getAuthContext } from "@/lib/auth";
import { listHref, parseListParams, parsePageNumber } from "@/lib/list-params";
import { timeAgoShort } from "@/lib/time";
import { DeepLinkFocus } from "./deep-link-focus";
import {
  ACTIVITY_CATEGORY_OPTIONS,
  ACTIVITY_MAX_PAGES,
  ACTIVITY_PAGE_SIZE,
  buildEventFilters,
  foldedStepTargets,
  groupActivityByDay,
} from "./present-view";
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

/*
 * "Load more" stacks keyset pages: the server walks the cursor chain once
 * per page and renders the accumulated rows, so the button is a plain link
 * (no client fetching, deterministic in tests) while pagination itself stays
 * keyset. Five pages is the cap; beyond it the feed says so honestly.
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
  const { timezone } = await getPreferences(auth);
  const list = parseListParams(query, { filters: { category: CATEGORY_VALUES } });

  const q = list.q;
  const category = list.filters.category;
  const actorParam = first(query.actor);
  const actorId = actorParam && UUID_PATTERN.test(actorParam) ? actorParam : undefined;
  const includeTechnical = first(query.technical) === "1";
  const pages = Math.min(Math.max(parsePageNumber(query.pages), 1), ACTIVITY_MAX_PAGES);
  const eventParam = first(query.event);
  const requestedEventId = eventParam && UUID_PATTERN.test(eventParam) ? eventParam : undefined;

  const filters = buildEventFilters({ category, q: q || undefined, actorId }, includeTechnical);
  const rows: ActivityEventRow[] = [];
  let cursor: string | null = null;
  let hasMore = false;
  for (let page = 0; page < pages; page += 1) {
    const result = await listActivityEvents(auth, { limit: ACTIVITY_PAGE_SIZE, cursor, filters });
    rows.push(...result.rows);
    hasMore = result.nextCursor !== null;
    cursor = result.nextCursor;
    if (!cursor) break;
  }

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
  });
  const loadMoreHref =
    hasMore && pages < ACTIVITY_MAX_PAGES ? listHref("/activity", query, { pages: pages + 1, event: undefined }) : null;

  const actorOptions = await listActivityActors(auth);

  return (
    <>
      <PageHeader title="Activity" purpose="What changed in this workspace." />
      <div className="page-content">
        <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
          <ListToolbar
            searchPlaceholder="Search activity"
            pageKeys={["page", "cpage", "rpage", "pages"]}
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
          <div className="mt-2">
            {groups.map((group, groupIndex) => (
              <section key={group.key}>
                <h2
                  className={`readout text-muted-foreground pb-1 text-xs font-medium tracking-wide uppercase ${groupIndex > 0 ? "pt-5" : "pt-2"}`}
                >
                  {group.label}
                </h2>
                <ul className="space-y-0.5">
                  {group.items.map((item) => (
                    <ActivityEntry
                      key={item.id}
                      item={item}
                      timeZone={timezone}
                      highlighted={item.id === highlightId}
                      stepsOpen={item.id === openedStepsOutcomeId}
                    />
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}

        {loadMoreHref ? (
          <div className="pt-4">
            <Link
              href={loadMoreHref}
              scroll={false}
              className="border-border hover:bg-muted inline-flex h-8 items-center justify-center rounded-md border px-3 text-body-dense outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Load more
            </Link>
          </div>
        ) : hasMore ? (
          <p className="readout text-muted-foreground pt-4 text-xs">
            Showing the most recent {ACTIVITY_PAGE_SIZE * ACTIVITY_MAX_PAGES} events.
          </p>
        ) : null}
      </div>
      {highlightId ? <DeepLinkFocus targetId={highlightId} /> : null}
    </>
  );
}

function DestinationChip({ destination }: { destination: Destination }) {
  if ("state" in destination) {
    // A checked miss is provably gone: honest text, never a dead href.
    return (
      <span className="text-muted-foreground inline-flex h-6 items-center rounded-full border border-dashed px-2.5 text-xs">
        No longer available
      </span>
    );
  }
  return (
    <Link
      href={destination.href}
      className="border-border hover:bg-muted inline-flex h-6 items-center rounded-full border px-2.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {destination.label}
    </Link>
  );
}

function ActivityEntry({
  item,
  timeZone,
  highlighted = false,
  stepsOpen = false,
}: {
  item: ActivityItem;
  timeZone: string;
  highlighted?: boolean;
  stepsOpen?: boolean;
}) {
  const destinations = [item.primary, ...item.related].filter(
    (destination): destination is Destination => destination !== null,
  );
  return (
    <li id={`event-${item.id}`} data-deep-linked={highlighted ? "true" : undefined} className="rounded-lg px-3 py-2.5">
      <div className="flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
        <p className="min-w-0 text-body-dense font-medium">{item.sentence}</p>
        <time
          className="readout text-muted-foreground shrink-0 text-xs"
          dateTime={item.occurredAt.toISOString()}
          title={item.occurredAt.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone })}
        >
          {timeAgoShort(item.occurredAt)}
        </time>
      </div>
      {item.title ? (
        <details className="activity-title-toggle mt-0.5">
          <summary className="text-muted-foreground cursor-pointer list-none text-body-dense [&::-webkit-details-marker]:hidden">
            <span className="title-preview line-clamp-2">{item.title}</span>
            <span className="title-collapse hidden">Show less</span>
          </summary>
          <span className="text-muted-foreground block text-body-dense">{item.title}</span>
        </details>
      ) : null}
      {destinations.length > 0 ? (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {destinations.map((destination, i) => (
            <DestinationChip key={i} destination={destination} />
          ))}
        </div>
      ) : null}
      {item.steps.length > 0 ? (
        <details open={stepsOpen} className="mt-1.5">
          <summary className="text-muted-foreground cursor-pointer text-xs">
            Show {item.steps.length} recorded {item.steps.length === 1 ? "step" : "steps"}
          </summary>
          <ul className="border-border mt-1.5 space-y-1 border-l pl-3">
            {item.steps.map((step, i) => (
              <li key={i} className="text-muted-foreground text-xs">
                {step}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      <p className="readout text-muted-foreground/70 mt-1 text-data">
        {item.technical.action} · {item.technical.subjectType}
      </p>
    </li>
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
