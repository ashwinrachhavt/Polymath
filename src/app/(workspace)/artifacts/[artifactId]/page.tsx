import { Suspense } from "react";
import { connection } from "next/server";
import Link from "next/link";
import { ArrowLeft, Copy, Download, MoreHorizontal, Sparkles } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { getAuthContext } from "@/lib/auth";
import { getArtifactDetail } from "@/domains/knowledge/artifact-gallery";
import { extractToc, type TocEntry } from "@/domains/knowledge/artifact-toc";
import { ArtifactMarkdown } from "@/components/artifact-markdown";
import { DebriefButton } from "../debrief-button";
import { DeckView, InfographicView } from "@/components/products/alfred/artifact-views";
import type { DeckContent, InfographicContent } from "@/domains/knowledge/artifact-content";

export const metadata = { title: "Artifact · Polymath" };

/*
 * One artifact, rendered like a document: back link, title, and the body with
 * a table-of-contents sidebar built from the markdown's headings. A deck or
 * infographic renders its structured views instead, with the TOC derived from
 * that structure.
 */

export async function ArtifactSurface({ artifactId }: { artifactId: string }) {
  await connection();
  const auth = await getAuthContext();
  const artifact = await getArtifactDetail(auth, artifactId);
  if (!artifact) {
    return <div className="page-content text-[13px] text-muted-foreground">This artifact does not exist.</div>;
  }

  const structured =
    (artifact.structured as { kind?: string } | null)?.kind === "deck"
      ? (artifact.structured as DeckContent)
      : (artifact.structured as { kind?: string } | null)?.kind === "infographic"
        ? (artifact.structured as InfographicContent)
        : null;

  // A deck's TOC is its slides; an infographic's is its sections. Markdown
  // artifacts get theirs from the headings.
  const toc: TocEntry[] = structured?.kind === "deck"
    ? structured.slides.map((slide, i) => ({ id: `slide-${i + 1}`, text: slide.title, level: 2 }))
    : structured?.kind === "infographic"
      ? [
          { id: "headline", text: structured.headline, level: 1 },
          ...structured.sections.map((section, i) => ({ id: `section-${i + 1}`, text: section.heading, level: 2 })),
        ]
      : extractToc(artifact.markdown ?? "");

  return (
    <>
      <div className="flex items-center justify-between gap-4 border-b border-border px-6 py-3">
        <p className="flex items-center gap-3 text-[13px]">
          <Link href="/artifacts" className="flex items-center gap-1 text-muted-foreground hover:text-foreground">
            <ArrowLeft aria-hidden className="size-3.5" /> Back to artifacts
          </Link>
          <span className="flex items-center gap-1.5 text-muted-foreground">
            <Sparkles aria-hidden className="size-3.5" /> Generated in Polymath
          </span>
        </p>
        <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
          {artifact.kind === "transcript" ? <DebriefButton artifactId={artifactId} /> : null}
          <MoreHorizontal aria-hidden className="size-4" />
          <Copy aria-hidden className="size-4" />
          <Download aria-hidden className="size-4" />
          <Link
            href={`/projects`}
            className="rounded-md border border-border px-3 py-1.5 hover:bg-muted"
          >
            Share
          </Link>
        </div>
      </div>
      <div className="mx-auto flex w-full max-w-6xl gap-10 px-6 py-10">
        {toc.length > 0 ? (
          <nav aria-label="Table of contents" className="sticky top-8 hidden w-56 shrink-0 self-start border-l border-border pl-4 lg:block">
            <ul className="flex flex-col gap-2.5">
              {toc.map((entry, index) => (
                <li key={`${entry.id}-${index}`}>
                  <a
                    href={`#${entry.id}`}
                    className={`block text-[13px] leading-snug hover:underline ${index === 0 ? "border-l-2 border-primary -ml-[17px] pl-[15px] text-foreground" : "text-muted-foreground"}`}
                  >
                    {entry.text}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        ) : null}
        <article className="min-w-0 flex-1">
          {structured?.kind === "deck" ? (
            <DeckView content={structured} sources={artifact.sources.map((s) => ({ documentId: s.documentId, title: s.title }))} />
          ) : structured?.kind === "infographic" ? (
            <InfographicView content={structured} sources={artifact.sources.map((s) => ({ documentId: s.documentId, title: s.title }))} />
          ) : (
            <>
              <h1 className="mb-6 text-3xl font-medium">{artifact.title}</h1>
              <ArtifactMarkdown text={artifact.markdown ?? artifact.plainText ?? ""} />
            </>
          )}
          {artifact.sources.length > 0 ? (
            <section aria-label="Sources" className="mt-12 border-t border-border pt-6">
              <h2 className="text-[13px] font-medium uppercase tracking-wide text-muted-foreground">Sources</h2>
              <ul className="mt-3 flex flex-col gap-2">
                {artifact.sources.map((source) => (
                  <li key={source.documentId} className="text-[13px]">
                    <Link href={`/alfred/knowledge?doc=${source.documentId}`} className="underline underline-offset-2 hover:text-foreground">
                      {source.title}
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </article>
      </div>
    </>
  );
}

/* Params are read inside the boundary: awaiting them in the page body put URL
   data outside Suspense, which cost the route its instant navigation. */
export default function ArtifactDetailPage({ params }: { params: Promise<{ artifactId: string }> }) {
  return (
    <Suspense fallback={<Skeleton className="m-6 h-64 w-full" />}>
      <ArtifactRoute params={params} />
    </Suspense>
  );
}

async function ArtifactRoute({ params }: { params: Promise<{ artifactId: string }> }) {
  const { artifactId } = await params;
  return <ArtifactSurface artifactId={artifactId} />;
}
