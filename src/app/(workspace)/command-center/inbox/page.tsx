import { connection } from "next/server";
import Link from "next/link";
import { Suspense } from "react";
import { Button } from "@/components/ui/button";
import { Panel, Screen, Status } from "@/components/workspace/ui";
import { Pagination } from "@/components/list/pagination";
import { ListToolbar } from "@/components/list/list-toolbar";
import { redirectPastEnd } from "@/components/list/clamp";
import { NoResults } from "@/components/list/no-results";
import { CAPTURE_KINDS, countToClarify, type InboxFilter, searchCaptures } from "@/domains/capture/queries";
import { listHref, offsetFor, parseListParams } from "@/lib/list-params";
import { getAuthContext } from "@/lib/auth";
import { CaptureActions, CaptureForm } from "./inbox-client";

export const metadata = { title: "Inbox · Axiom" };

/*
 * The durable inbox (ASH-137 A02): captures live in Postgres, the original
 * material survives conversion, and clarify-before-commit means a capture
 * becomes a canonical task only by an explicit per-row decision. Nothing is
 * classified or converted by a model on this page.
 */

const filters: Array<{ value: InboxFilter; label: string }> = [
  { value: "unprocessed", label: "To clarify" },
  { value: "converted", label: "Converted" },
  { value: "discarded", label: "Archived" },
  { value: "all", label: "All captures" },
];

function when(iso: Date): string {
  return iso.toISOString().slice(0, 16).replace("T", " ") + "Z";
}

async function Inbox({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = await searchParams;
  const list = parseListParams(query, { filters: { kind: CAPTURE_KINDS } });
  const raw = typeof query.filter === "string" ? query.filter : "unprocessed";
  const filter: InboxFilter = filters.some((f) => f.value === raw) ? (raw as InboxFilter) : "unprocessed";
  await connection();
  const auth = await getAuthContext();
  const [found, pending] = await Promise.all([
    searchCaptures(auth, {
      filter,
      kind: list.filters.kind as (typeof CAPTURE_KINDS)[number] | undefined,
      query: list.q,
      limit: list.pageSize,
      offset: offsetFor(list.page, list.pageSize),
    }),
    countToClarify(auth),
  ]);
  const rows = found.items;
  const pageSize = list.pageSize;
  redirectPastEnd("/command-center/inbox", query, list.page, pageSize, found.total);
  const page = list.page;
  const filtered = Boolean(list.q || list.filters.kind);

  return (
    <Screen
      title="Inbox"
      description="Clarify before committing. Original text stays here after conversion; nothing is classified or fetched on arrival."
      actions={<Status>{pending} to clarify</Status>}
    >
      <Panel title="Capture material" description="Text or a URL. Remote content is not fetched; a duplicate URL is a conflict, not a second row.">
        <CaptureForm />
      </Panel>

      <nav aria-label="Inbox filters" className="flex flex-wrap gap-3 text-[13px]">
        {filters.map((f) => (
          <Link
            key={f.value}
            href={listHref("/command-center/inbox", query, { filter: f.value === "unprocessed" ? undefined : f.value, page: 1 })}
            aria-current={f.value === filter ? "page" : undefined}
            className={f.value === filter ? "font-medium underline underline-offset-4" : "text-muted-foreground hover:underline"}
          >
            {f.label}
          </Link>
        ))}
      </nav>

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

      <Panel title={`${found.total} ${found.total === 1 ? "capture" : "captures"}`}>
        <div className="divide-y divide-border">
          {rows.map((capture) => {
            const state =
              capture.processingState === "converted" ? "converted" : capture.processingState === "discarded" ? "discarded" : "open";
            return (
              <article key={capture.id} className="py-4 first:pt-0">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <Status>{capture.processingState}</Status>
                  <span className="text-xs text-muted-foreground">{capture.kind}</span>
                  <time className="readout text-xs text-muted-foreground" dateTime={capture.createdAt.toISOString()}>
                    {when(capture.createdAt)}
                  </time>
                </div>
                <p className="whitespace-pre-wrap break-words text-[13px]">{capture.text ?? capture.url}</p>
                <CaptureActions captureId={capture.id} version={capture.version} state={state} />
                {capture.processingState === "converted" && capture.convertedType === "task" && capture.convertedId ? (
                  <Button asChild className="mt-3" size="sm" variant="outline">
                    <Link href={`/neuralflow/work?task=${encodeURIComponent(capture.convertedId)}`}>Open task in NeuralFlow</Link>
                  </Button>
                ) : null}
              </article>
            );
          })}
        </div>
        {!rows.length ? (
          <NoResults
            filtered={filtered}
            clearHref={listHref("/command-center/inbox", query, { q: undefined, kind: undefined, page: 1 })}
            emptyTitle="Nothing in this view"
            emptyDescription="Capture material above or choose another filter."
          />
        ) : null}
        <Pagination basePath="/command-center/inbox" raw={query} page={page} pageSize={pageSize} total={found.total} />
      </Panel>
    </Screen>
  );
}

export default function InboxPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  return (
    <Suspense fallback={<p role="status" className="p-6 text-[13px] text-muted-foreground">Opening the inbox…</p>}>
      <Inbox searchParams={searchParams} />
    </Suspense>
  );
}
