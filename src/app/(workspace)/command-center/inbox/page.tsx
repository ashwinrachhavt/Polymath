import { connection } from "next/server";
import Link from "next/link";
import { Suspense } from "react";
import { Status } from "@/components/workspace/ui";
import { Pagination } from "@/components/list/pagination";
import { ListToolbar } from "@/components/list/list-toolbar";
import { redirectPastEnd } from "@/components/list/clamp";
import { NoResults } from "@/components/list/no-results";
import { CAPTURE_KINDS, type InboxFilter } from "@/domains/capture/queries";
import { countInboxTabsForPage, getCaptureForPage, searchCapturesForPage } from "./data";
import { listHref, offsetFor, parseListParams } from "@/lib/list-params";
import { getAuthContext } from "@/lib/auth";
import { CaptureForm } from "./inbox-client";
import { InboxList } from "./inbox-list";
import { InboxDetail } from "./inbox-detail";

export const metadata = { title: "Inbox · Polymath" };

/*
 * The durable inbox (ASH-137 A02), two panes (2026-10-20 redesign): the list
 * shows clamped previews and bulk select; the detail pane is a server-rendered
 * view of the same captures row, selected by ?id=. URL is the state, so
 * back/forward and refresh hold the selection. Nothing is classified or
 * converted by a model on this page.
 */

const filters: Array<{ value: InboxFilter; label: string }> = [
  { value: "unprocessed", label: "To clarify" },
  { value: "converted", label: "Converted" },
  { value: "discarded", label: "Archived" },
  { value: "all", label: "All captures" },
];

async function Inbox({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = await searchParams;
  const list = parseListParams(query, { filters: { kind: CAPTURE_KINDS } });
  const raw = typeof query.filter === "string" ? query.filter : "unprocessed";
  const filter: InboxFilter = filters.some((f) => f.value === raw) ? (raw as InboxFilter) : "unprocessed";
  // A malformed id (or a non-uuid string) would make Postgres reject the
  // uuid comparison with 22P02 and crash the screen; treat it as no
  // selection, matching the valid-but-unknown id path.
  const rawId = typeof query.id === "string" ? query.id : null;
  const selectedId = rawId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawId) ? rawId : null;
  await connection();
  const auth = await getAuthContext();
  const kind = list.filters.kind as (typeof CAPTURE_KINDS)[number] | undefined;
  const [found, tabs, selected] = await Promise.all([
    searchCapturesForPage(auth, {
      filter,
      kind,
      query: list.q,
      limit: list.pageSize,
      offset: offsetFor(list.page, list.pageSize),
    }),
    countInboxTabsForPage(auth),
    // The detail pane is a view of the record, not of the current filter: a
    // capture outside the view still renders, the list just shows no highlight.
    selectedId ? getCaptureForPage(auth, selectedId) : Promise.resolve(null),
  ]);
  const rows = found.items;
  const pageSize = list.pageSize;
  redirectPastEnd("/command-center/inbox", query, list.page, pageSize, found.total);
  const page = list.page;
  const filtered = Boolean(list.q || list.filters.kind);

  return (
    <div className="flex h-[calc(100dvh-3rem)] flex-col overflow-hidden">
      <header className="flex flex-wrap items-start justify-between gap-3 border-border border-b px-6 py-4">
        <div>
          <h1 className="font-serif text-[26px] leading-tight">Inbox</h1>
          <p className="mt-1 text-[13px] text-muted-foreground">
            Clarify before committing. Original text stays here after conversion.
          </p>
        </div>
        <Status>{tabs.unprocessed} to clarify</Status>
      </header>
      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[420px_minmax(0,1fr)]">
        <section aria-label="Capture queue" className="flex min-h-0 min-w-0 flex-col overflow-y-auto p-6 lg:border-r">
          <CaptureForm />

          <nav aria-label="Inbox filters" className="mt-4 flex flex-wrap gap-3 text-[13px]">
            {filters.map((f) => (
              <Link
                key={f.value}
                href={listHref("/command-center/inbox", query, {
                  filter: f.value === "unprocessed" ? undefined : f.value,
                  id: undefined,
                  page: 1,
                })}
                aria-current={f.value === filter ? "page" : undefined}
                className={f.value === filter ? "font-medium underline underline-offset-4" : "text-muted-foreground hover:underline"}
              >
                {f.label}
                <span className="readout ml-1 text-muted-foreground">{tabs[f.value]}</span>
              </Link>
            ))}
          </nav>

          <div className="mt-3">
            <ListToolbar
              searchPlaceholder="Search captures"
              filters={[
                {
                  key: "kind",
                  label: "Type",
                  allLabel: "All types",
                  options: CAPTURE_KINDS.map((k) => ({ value: k, label: k[0]!.toUpperCase() + k.slice(1) })),
                },
              ]}
            />
          </div>

          <InboxList
            view={filter}
            selectedId={selectedId}
            rawQuery={query}
            rows={rows.map((capture) => ({
              id: capture.id,
              processingState: capture.processingState,
              kind: capture.kind,
              createdAt: capture.createdAt.toISOString(),
              preview: capture.preview,
              url: capture.url,
              version: capture.version,
              convertedType: capture.convertedType,
              convertedId: capture.convertedId,
            }))}
          />

          {!rows.length ? (
            <NoResults
              filtered={filtered}
              clearHref={listHref("/command-center/inbox", query, { q: undefined, kind: undefined, page: 1 })}
              emptyTitle="Nothing in this view"
              emptyDescription="Capture material above or choose another filter."
            />
          ) : null}

          <Pagination basePath="/command-center/inbox" raw={query} page={page} pageSize={pageSize} total={found.total} />
        </section>

        <section aria-label="Capture detail" className="min-w-0 overflow-y-auto border-border p-6 lg:border-l">
          <InboxDetail
            capture={
              selected
                ? {
                    id: selected.id,
                    processingState: selected.processingState,
                    kind: selected.kind,
                    createdAt: selected.createdAt.toISOString(),
                    text: selected.text,
                    url: selected.url,
                    version: selected.version,
                    convertedType: selected.convertedType,
                    convertedId: selected.convertedId,
                  }
                : null
            }
          />
        </section>
      </div>
    </div>
  );
}

export default function InboxPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  return (
    <Suspense fallback={<p role="status" className="p-6 text-[13px] text-muted-foreground">Opening the inbox…</p>}>
      <Inbox searchParams={searchParams} />
    </Suspense>
  );
}
