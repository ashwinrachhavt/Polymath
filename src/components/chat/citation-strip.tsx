"use client";

import Link from "next/link";
import { BookOpen, ChevronDown } from "lucide-react";
import type { ChatCitation } from "@/domains/agents/stream-contract";

/*
 * The Sources strip under the answer: the passages the answer actually cites,
 * collapsed into one <details>. Extracted from chat-surface.tsx so that file
 * stays under its line budget; pure presentation, citations in.
 */

export function CitationStrip({ citations }: { citations: ChatCitation[] }) {
  if (citations.length === 0) return null;
  return (
    <details className="group mt-3 rounded-xl border border-border text-[12px]">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
        <BookOpen aria-hidden className="size-3.5 shrink-0" />
        {/* Citations are passages, so one document can back several. The
          chip names the documents; the count would read as "5 sources"
          for one document. */}
        <span className="shrink-0 font-medium text-foreground/80">
          Sources · {new Set(citations.map((citation) => citation.documentId)).size}
        </span>
        <span className="min-w-0 flex-1 truncate group-open:hidden">
          {[...new Set(citations.map((citation) => citation.title))].join(", ")}
        </span>
        <ChevronDown aria-hidden className="size-3.5 shrink-0 transition-transform group-open:rotate-180" />
      </summary>
      <ul className="space-y-2 border-t border-border px-3 py-2" aria-label="Citations">
        {citations.map((citation, index) => (
          <li key={`${citation.documentId}:${citation.span.start}`} id={`citation-${index}`} className="scroll-mt-4">
            {/* The title opens the document at its library route, so a
              citation is a way into the source rather than a label. */}
            <Link
              href={`/polymath/library/${citation.documentId}`}
              className="font-medium underline decoration-transparent underline-offset-2 transition-colors hover:decoration-current"
            >
              {citation.title}
            </Link>
            {/* The passage is evidence for the answer. Chunks arrive
              mid-sentence, so the line is trimmed to a readable start
              before clamping. */}
            <p className="line-clamp-2 text-muted-foreground">{trimPassage(citation.text)}</p>
          </li>
        ))}
      </ul>
    </details>
  );
}

/**
 * A search chunk starts wherever the span started, often mid-word. Trim to the
 * first full word so a citation opens with prose instead of a fragment like
 * "ion patterns of SMBs".
 */
function trimPassage(text: string): string {
  const trimmed = text.trimStart();
  // A fragment begins lowercase or mid-token; drop the partial first word.
  const firstBreak = trimmed.search(/[\s,.;:]/);
  const firstWord = firstBreak === -1 ? trimmed : trimmed.slice(0, firstBreak);
  const startsClean = /^[A-Z"'“('[]/.test(firstWord) && firstWord.length > 2;
  return startsClean ? trimmed : firstBreak === -1 ? trimmed : trimmed.slice(firstBreak + 1).trimStart();
}
