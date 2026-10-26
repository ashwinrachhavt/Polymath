"use client";

import type { DocumentCitation } from "@/domains/knowledge/agent-search";
import { splitCitations } from "@/domains/knowledge/inline-citations";
import { inline } from "@/components/markdown-inline";

/*
 * An answer with its `[[n]]` markers rendered as numbered citations that jump
 * to the matching entry in the source list below it. The marker is a real
 * anchor (not a click handler) so it works on first paint and can be opened in
 * a new tab; the list entries carry the matching ids.
 *
 * A marker naming no citation never reaches here — splitCitations drops it —
 * because a number that goes nowhere is worse than no number.
 */
export function CitedText({ text, citations }: { text: string; citations: DocumentCitation[] }) {
  if (citations.length === 0) return <>{inline(text)}</>;
  return (
    <>
      {splitCitations(text, citations).map((segment, i) =>
        segment.type === "citation" ? (
          <a
            key={i}
            href={`#citation-${segment.index}`}
            aria-label={`Go to source ${segment.index + 1}`}
            className="bg-muted text-muted-foreground hover:text-foreground mx-0.5 inline-flex h-[15px] min-w-[15px] items-center justify-center rounded-full px-1 align-super text-[10px] leading-none font-medium no-underline"
          >
            {segment.index + 1}
          </a>
        ) : (
          <span key={i}>{inline(segment.text)}</span>
        ),
      )}
    </>
  );
}
