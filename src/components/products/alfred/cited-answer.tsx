"use client";

import { useMemo } from "react";
import type { DocumentCitation } from "@/domains/knowledge/agent-search";
import { splitCitations } from "@/domains/knowledge/inline-citations";

/*
 * Renders an answer with its inline numbered citations. The markers and the
 * list are the same numbering, which is the whole point: a reader can go from
 * the sentence to the passage.
 *
 * A citation opens the document at its span. The span is a character offset
 * into the extraction, so the reader link carries it and the library reader is
 * responsible for scrolling to it.
 */

export function CitedAnswer({ answer, citations }: { answer: string; citations: DocumentCitation[] }) {
  const segments = useMemo(() => splitCitations(answer, citations), [answer, citations]);

  return (
    <div className="text-[13px] leading-relaxed">
      <p className="whitespace-pre-wrap">
        {segments.map((segment, i) =>
          segment.type === "text" ? (
            <span key={i}>{segment.text}</span>
          ) : (
            <a
              key={i}
              href={`/alfred/library/${segment.citation.documentId}`}
              title={`${segment.citation.title}: ${segment.citation.text.slice(0, 160)}`}
              className="readout mx-0.5 rounded-sm bg-muted px-1 text-[10px] text-foreground no-underline hover:bg-accent"
            >
              {segment.index + 1}
            </a>
          ),
        )}
      </p>

      {citations.length > 0 && (
        <ol className="mt-3 space-y-1 border-t border-border pt-2">
          {citations.map((citation, index) => (
            <li key={`${citation.documentId}:${citation.span.start}`} className="text-xs text-muted-foreground">
              <a
                href={`/alfred/library/${citation.documentId}`}
                className="underline-offset-2 hover:underline"
              >
                <span className="readout mr-1">{index + 1}.</span>
                {citation.title}
              </a>
              {citation.span.page !== null && <span className="ml-1">p. {citation.span.page}</span>}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
