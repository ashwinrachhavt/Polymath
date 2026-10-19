import Link from "next/link";
import { Suspense } from "react";
import { connection } from "next/server";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/empty-state";
import { PageHeader, Section } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { getWikiOverview, getWikiPageText, listIngestableDocuments } from "@/domains/knowledge/wiki";
import { getAuthContext } from "@/lib/auth";
import { IngestForm } from "./ingest-form";
import { LintButton } from "./lint-button";

export const metadata = { title: "Wiki · Axiom" };

/*
 * The second brain: documents are the raw sources, this is the maintained
 * layer above them. The master index, one hub per topic, one article per
 * ingested document, and the log of how it got there. Every refresh is a new
 * version, so the page always shows the current one.
 */

// Per-request data; streams inside the Suspense boundary in the default export.
export async function WikiSurface({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  await connection();
  const auth = await getAuthContext();
  const params = await searchParams;
  const [overview, ingestable] = await Promise.all([getWikiOverview(auth), listIngestableDocuments(auth)]);
  const selected = params.page ? await getWikiPageText(auth, params.page) : null;

  return (
    <div className="flex flex-col">
      <PageHeader
        title="Wiki"
        purpose="The maintained layer over your documents: index, topics, articles, log."
        actions={<LintButton />}
      />
      <div className="flex flex-col gap-8 px-4 py-6 md:px-6">
        {!overview ? (
          <EmptyState
            title="No wiki yet"
            description="Ingest a read document and Alfred starts the wiki: an article per document, a hub per topic, a master index, and a log of every ingest. Documents stay the immutable sources; the wiki is what's maintained."
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
            <Section title={`Articles (${overview.articles.length})`}>
              <ul className="flex flex-col gap-2">
                {overview.articles.map((a) => (
                  <li key={a.artifactId} className="flex flex-col gap-0.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link href={`/alfred/wiki?page=${a.artifactId}`} className="text-[13px] font-medium underline-offset-4 hover:underline">
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

export default function WikiPage(props: { searchParams: Promise<Record<string, string | undefined>> }) {
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
