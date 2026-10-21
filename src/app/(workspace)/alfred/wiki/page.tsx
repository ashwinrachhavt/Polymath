import Link from "next/link";
import { Suspense } from "react";
import { connection } from "next/server";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/empty-state";
import { PageHeader, Section } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { getWikiOverview, getWikiPageText, listIngestableDocuments } from "@/domains/knowledge/wiki";
import { getAuthContext } from "@/lib/auth";
import { redirectPastEnd } from "@/components/list/clamp";
import { ListToolbar } from "@/components/list/list-toolbar";
import { NoResults } from "@/components/list/no-results";
import { Pagination } from "@/components/list/pagination";
import { listHref, matchesQuery, paginate, parseListParams, type RawSearchParams } from "@/lib/list-params";
import { IngestForm } from "./ingest-form";
import { LintButton } from "./lint-button";

export const metadata = { title: "Wiki · Polymath" };

/*
 * The second brain: documents are the raw sources, this is the maintained
 * layer above them. The master index, one hub per topic, one article per
 * ingested document, and the log of how it got there. Every refresh is a new
 * version, so the page always shows the current one.
 */

const BASE = "/alfred/wiki";

// Per-request data; streams inside the Suspense boundary in the default export.
export async function WikiSurface({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  await connection();
  const auth = await getAuthContext();
  const raw = await searchParams;
  // `page` already names the selected wiki page on this screen, so the article
  // pager uses `apage`; the list helpers read their page number from there.
  const selectedId = typeof raw.page === "string" ? raw.page : undefined;
  const [overview, ingestable] = await Promise.all([getWikiOverview(auth), listIngestableDocuments(auth)]);
  const selected = selectedId ? await getWikiPageText(auth, selectedId) : null;
  const topicSlugs = overview ? overview.topics.map((t) => t.slug) : [];
  const list = parseListParams({ ...raw, page: raw.apage }, { filters: { topic: topicSlugs } });
  const matching = overview
    ? overview.articles.filter(
        (a) =>
          (!list.filters.topic || a.topics.includes(list.filters.topic)) &&
          matchesQuery(list.q, a.title, a.summary, a.topics.join(" ")),
      )
    : [];
  const articlePage = paginate(matching, list.page, list.pageSize);
  redirectPastEnd(BASE, raw, list.page, list.pageSize, matching.length, "apage");

  return (
    <div className="flex flex-col">
      <PageHeader
        title="Wiki"
        actions={<LintButton />}
      />
      <div className="flex flex-col gap-8 page-content">
        {!overview ? (
          <EmptyState
            title="No wiki yet"
          />
        ) : (
          <>
            <Section title="Index">
              <pre className="max-w-prose text-[13px] leading-relaxed whitespace-pre-wrap">{overview.indexText}</pre>
            </Section>
            <Section title={`Topics (${overview.topics.length})`}>
              <ul className="flex flex-col gap-1.5">
                {overview.topics.map((t) => (
                  <li key={t.slug} className="flex items-center gap-2 text-[13px]">
                    <Link href={`/alfred/wiki?page=${t.artifactId}`} className="font-medium underline-offset-4 hover:underline">
                      {t.slug}
                    </Link>
                    <span className="text-muted-foreground">{t.summary}</span>
                  </li>
                ))}
              </ul>
            </Section>
            <Section title={`Articles (${matching.length}${matching.length === overview.articles.length ? "" : ` of ${overview.articles.length}`})`}>
              {overview.articles.length > 0 ? (
                <ListToolbar
                  pageKeys={["apage"]}
                  searchPlaceholder="Search articles"
                  filters={[{ key: "topic", label: "Topic", allLabel: "All topics", options: topicSlugs.map((t) => ({ value: t, label: t })) }]}
                />
              ) : null}
              <ul className="flex flex-col gap-2">
                {articlePage.items.map((a) => (
                  <li key={a.artifactId} className="flex flex-col gap-0.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link href={listHref(BASE, raw, { page: a.artifactId })} className="text-[13px] font-medium underline-offset-4 hover:underline">
                        {a.title}
                      </Link>
                      {a.topics.map((t) => (
                        <Badge key={t} variant="secondary" className="text-[11px]">
                          {t}
                        </Badge>
                      ))}
                    </div>
                    {a.summary ? <p className="text-muted-foreground max-w-prose text-xs">{a.summary}</p> : null}
                  </li>
                ))}
              </ul>
              {matching.length === 0 ? (
                <NoResults
                  filtered={Boolean(list.q || list.filters.topic)}
                  clearHref={listHref(BASE, raw, { q: undefined, topic: undefined, apage: undefined })}
                  emptyTitle="No articles yet"
                  emptyDescription="Ingest a document below and its article appears here."
                />
              ) : null}
              <Pagination basePath={BASE} raw={raw} page={articlePage.page} pageSize={list.pageSize} total={matching.length} pageParam="apage" />
            </Section>
            {overview.logTail.length ? (
              <Section title="Recent log">
                <ul className="flex flex-col gap-1">
                  {overview.logTail.map((line, i) => (
                    <li key={i} className="text-muted-foreground font-mono text-xs">
                      {line}
                    </li>
                  ))}
                </ul>
              </Section>
            ) : null}
          </>
        )}
        {selected ? (
          <Section title={selected.title}>
            <p className="text-muted-foreground mb-2 text-xs">Version {selected.versionNumber}</p>
            <pre className="max-w-prose text-[13px] leading-relaxed whitespace-pre-wrap">{selected.plainText}</pre>
          </Section>
        ) : null}
        <Section title="Ingest a document">
          <IngestForm documents={ingestable} />
        </Section>
      </div>
    </div>
  );
}

export default function WikiPage(props: { searchParams: Promise<RawSearchParams> }) {
  return (
    <Suspense fallback={<WikiSkeleton />}>
      <WikiSurface {...props} />
    </Suspense>
  );
}

function WikiSkeleton() {
  return (
    <div role="status" aria-label="Loading Wiki" className="flex flex-1 flex-col gap-4 p-6">
      <Skeleton className="h-6 w-40" />
      <Skeleton className="h-4 w-full max-w-xl" />
      <Skeleton className="h-40" />
    </div>
  );
}
