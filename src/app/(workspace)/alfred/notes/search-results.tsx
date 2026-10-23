import Link from "next/link";
import { Suspense, type ReactNode } from "react";
import { Status } from "@/components/workspace/ui";
import { timeAgo } from "@/lib/time";
import { searchKnowledge, type SearchHit, type SearchResult } from "@/domains/knowledge/retrieval";
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
                <Why hit={hit} />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

async function Ranked(props: { auth: AuthContext; q: string; hrefFor: (id: string) => string; selectedId?: string }) {
  const result = await searchKnowledge(props.auth, { query: props.q, limit: 20 });
  const note = result.meaning === "ok" ? undefined : "Showing keyword matches only. Meaning search is not available right now.";
  return <HitList result={result} hrefFor={props.hrefFor} selectedId={props.selectedId} note={note} />;
}

export async function SearchResults(props: { auth: AuthContext; q: string; hrefFor: (id: string) => string; selectedId?: string }) {
  const quick = await searchKnowledge(props.auth, { query: props.q, limit: 20, mode: "keyword" });
  return (
    <Suspense fallback={<HitList result={quick} hrefFor={props.hrefFor} selectedId={props.selectedId} note="Refining by meaning…" />}>
      <Ranked {...props} />
    </Suspense>
  );
}
