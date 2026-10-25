import Link from "next/link";
import { Suspense, type ReactNode } from "react";
import { Status } from "@/components/workspace/ui";
import { timeAgo } from "@/lib/time";
import { countMeaningUncoveredByState, listHitConnections, searchKnowledge, type SearchFilters, type SearchHit, type SearchResult } from "@/domains/knowledge/retrieval";
import type { AuthContext } from "@/lib/auth";

/*
 * Ranked results for the notebook search. The keyword leg answers in a few
 * milliseconds, so it renders first; the fused keyword + meaning ranking
 * streams in behind it once the query has been embedded. Each hit says why it
 * ranked, so the order is never a mystery.
 */

const KIND_LABEL: Record<string, string> = { zettel: "zettel", transcript: "conversation", document: "document", memo: "memo", report: "report" };

function marked(snippet: string): ReactNode[] {
  return snippet.split(/(\[\[.*?\]\])/g).map((part, i) =>
    part.startsWith("[[") && part.endsWith("]]")
      ? <mark key={i} className="rounded-sm bg-muted px-0.5 text-foreground">{part.slice(2, -2)}</mark>
      : part,
  );
}

function Why({ hit }: { hit: SearchHit }) {
  const chips: string[] = [];
  if (hit.why.titleMatch) chips.push("title");
  if (hit.why.keywordRank !== null) chips.push(`keyword #${hit.why.keywordRank}`);
  if (hit.why.meaningRank !== null && hit.why.similarity !== null) chips.push(`meaning ${Math.round(hit.why.similarity * 100)}%`);
  return (
    <span className="mt-1 flex flex-wrap gap-1" aria-label="Why this ranked">
      {chips.map((c) => <span key={c} className="rounded-sm border border-border px-1.5 text-[11px] text-muted-foreground">{c}</span>)}
    </span>
  );
}

/*
 * The link-graph neighborhood of a hit, in plain words: where it came from
 * (with the supporting passage when one is recorded), what it points at, and
 * what points back. Rendered as text inside the hit link - the destination's
 * own outlink/backlink panels carry the navigation.
 */
function Connections({ hit }: { hit: SearchHit }) {
  const c = hit.connections;
  if (!c || (c.out.length === 0 && c.in.length === 0)) return null;
  // Explicit reference edges read as bare titles; a typed edge names its type.
  const named = (e: { title: string; linkType: string }) => (e.linkType === "reference" ? e.title : `${e.linkType} ${e.title}`);
  const parts: string[] = [];
  // A projection artifact's own source edge names the record it mirrors (a
  // document, a thread) with the same title - that is noise, not a connection.
  const source = c.out.find((e) => e.linkType === "source" && e.title !== hit.title);
  if (source) {
    const quote = source.context?.replace(/\s+/g, " ").trim();
    parts.push(`From ${source.title}${quote ? ` - \u201c${quote.length > 100 ? `${quote.slice(0, 100).trimEnd()}\u2026` : quote}\u201d` : ""}`);
  }
  const outRefs = c.out.filter((e) => e.linkType !== "source");
  if (outRefs.length) parts.push(`Links to ${outRefs.map(named).join(", ")}`);
  const derived = c.in.filter((e) => e.linkType === "source");
  if (derived.length) parts.push(`Zettels from this: ${derived.map((e) => e.title).join(", ")}`);
  const citedBy = c.in.filter((e) => e.linkType !== "source");
  if (citedBy.length) parts.push(`Cited by ${citedBy.map(named).join(", ")}`);
  const hidden = c.outTotal - c.out.length + (c.inTotal - c.in.length);
  if (hidden > 0) parts.push(`+${hidden} more`);
  return (
    <span className="mt-0.5 block text-[11px] text-muted-foreground/80" aria-label="Connections">
      {parts.join(" \u00b7 ")}
    </span>
  );
}

function HitList({ result, hrefFor, selectedId, note }: { result: SearchResult; hrefFor: (id: string) => string; selectedId?: string; note?: string }) {
  return (
    <div>
      {note && <p className="mb-2 text-xs text-muted-foreground" role="status">{note}</p>}
      {result.hits.length === 0 ? (
        <p className="px-1 py-3 text-[13px] text-muted-foreground">Nothing matches that yet. Try fewer words, or describe the idea the way you would say it.</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {result.hits.map((hit) => (
            <li key={hit.id}>
              <Link
                href={hrefFor(hit.id)}
                className={`block rounded-md border px-3 py-2 text-[13px] ${selectedId === hit.id ? "border-foreground/30 bg-muted/60" : "border-transparent hover:bg-muted/40"}`}
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="truncate font-medium">{hit.title}</span>
                  <span className="flex shrink-0 items-center gap-2">
                    <span className="text-[11px] text-muted-foreground">edited {timeAgo(hit.updatedAt)}</span>
                    {KIND_LABEL[hit.kind] && <Status>{KIND_LABEL[hit.kind]}</Status>}
                  </span>
                </span>
                {hit.snippet && <span className="mt-0.5 line-clamp-2 block text-xs text-muted-foreground">{marked(hit.snippet)}</span>}
                <Connections hit={hit} />
                <Why hit={hit} />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The scope every search leg and the coverage count share, parsed from the URL by the page. */
export type SearchScope = { kinds?: readonly string[]; filters?: SearchFilters };

export async function Ranked(props: { auth: AuthContext; q: string; scope?: SearchScope; hrefFor: (id: string) => string; selectedId?: string }) {
  const result = await searchKnowledge(props.auth, { query: props.q, limit: 20, kinds: props.scope?.kinds, filters: props.scope?.filters });
  let note: string | undefined;
  if (result.meaning === "ok") {
    // Partial indexing is named, never presented as a complete search: same
    // kinds/filters/tenant as the search itself, with current text, without a
    // current-version embedding row. The count never sees the query text.
    const { pending, failed } = await countMeaningUncoveredByState(props.auth, { kinds: props.scope?.kinds, filters: props.scope?.filters });
    const uncovered = pending + failed;
    if (uncovered > 0) {
      // Name each state for what it actually is: pending means no pass has
      // completed for the current version (never "being indexed" - there is
      // no live job signal), failed means the last pass recorded an error.
      // Retry lives on the surfaces that own it (the note's own status chip),
      // not promised here across kinds that have no retry route.
      const states = [
        pending > 0 ? `${pending} not indexed yet` : null,
        failed > 0 ? `${failed} with a failed indexing pass` : null,
      ].filter(Boolean).join(", ");
      note = `${uncovered} ${uncovered === 1 ? "item" : "items"} in the selected filters ${uncovered === 1 ? "is" : "are"} not meaning-searchable (${states}) and may be missing from these results.`;
    }
  } else {
    note = "Showing keyword matches only. Meaning search is not available right now.";
  }
  // Reveal each hit's connections (spec): one batched read for the page.
  if (result.hits.length) {
    const connections = await listHitConnections(props.auth, result.hits.map((h) => h.id));
    for (const hit of result.hits) {
      const c = connections.get(hit.id);
      if (c && (c.out.length > 0 || c.in.length > 0)) hit.connections = c;
    }
  }
  return <HitList result={result} hrefFor={props.hrefFor} selectedId={props.selectedId} note={note} />;
}

export async function SearchResults(props: { auth: AuthContext; q: string; scope?: SearchScope; hrefFor: (id: string) => string; selectedId?: string }) {
  const quick = await searchKnowledge(props.auth, { query: props.q, limit: 20, mode: "keyword", kinds: props.scope?.kinds, filters: props.scope?.filters });
  return (
    <Suspense fallback={<HitList result={quick} hrefFor={props.hrefFor} selectedId={props.selectedId} note="Refining by meaning…" />}>
      <Ranked {...props} />
    </Suspense>
  );
}
