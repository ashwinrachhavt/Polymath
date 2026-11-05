"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import type { ActivityItem, Destination } from "@/domains/audit/present";
import { loadActivityPage, type ActivityFeedFilters } from "./actions";
import { ACTIVITY_MAX_PAGES, ACTIVITY_PAGE_SIZE, mergeDayGroups, type ActivityDayGroup } from "./day-groups";

/*
 * The Activity feed island (spec W3): the initial page renders server-side
 * and this island appends every further page. "Load more" calls the
 * loadActivityPage server action — one keyset query, presented and grouped
 * — and merges the result into the accumulated groups. Nothing above the
 * island re-renders, so the fifth click costs one query where the old
 * ?pages=N walk re-ran five and re-presented the whole feed.
 */

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

export function ActivityEntry({
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
          {item.timeAgo}
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

export function ActivityFeed({
  initialGroups,
  initialNextCursor,
  filters,
  timezone,
  highlightId,
  openedStepsOutcomeId,
}: {
  initialGroups: ActivityDayGroup[];
  initialNextCursor: string | null;
  filters: ActivityFeedFilters;
  timezone: string;
  highlightId: string | null;
  openedStepsOutcomeId: string | null;
}) {
  const [groups, setGroups] = useState(initialGroups);
  const [cursor, setCursor] = useState(initialNextCursor);
  const [appends, setAppends] = useState(0);
  const [invalidCursor, setInvalidCursor] = useState(false);
  const [pending, startTransition] = useTransition();

  // Five pages is the view's cap (spec W3 keeps it): the initial render is
  // page one, so four appends reach it — beyond it the feed says so honestly.
  const atCap = appends >= ACTIVITY_MAX_PAGES - 1;
  const canLoadMore = cursor !== null && !atCap && !pending;

  function loadMore() {
    if (cursor === null || pending) return;
    startTransition(async () => {
      const result = await loadActivityPage(filters, cursor, timezone);
      if (!result.ok) {
        setInvalidCursor(true);
        return;
      }
      setInvalidCursor(false);
      setGroups((current) => mergeDayGroups(current, result.groups));
      setCursor(result.nextCursor);
      setAppends((count) => count + 1);
    });
  }

  return (
    <>
      {invalidCursor ? (
        <p role="note" className="panel-empty mt-3 rounded-lg px-3.5 py-3 text-body-dense text-muted-foreground">
          The next page could not be loaded — the feed&rsquo;s cursor is out of date. Reload to start from the newest
          activity.
        </p>
      ) : null}
      <div className="mt-2">
        {groups.map((group, groupIndex) => (
          <section key={group.key}>
            <h2
              className={`readout text-muted-foreground pb-1 text-xs font-medium ${groupIndex > 0 ? "pt-5" : "pt-2"}`}
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

      {canLoadMore ? (
        <div className="pt-4">
          <button
            type="button"
            onClick={loadMore}
            className="border-border hover:bg-muted inline-flex h-8 items-center justify-center rounded-md border px-3 text-body-dense outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {pending ? "Loading…" : "Load more"}
          </button>
        </div>
      ) : atCap ? (
        <p className="readout text-muted-foreground pt-4 text-xs">
          Showing the most recent {ACTIVITY_PAGE_SIZE * ACTIVITY_MAX_PAGES} events.
        </p>
      ) : null}
    </>
  );
}
