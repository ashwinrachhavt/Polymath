import type { DeckContent, InfographicContent } from "@/domains/knowledge/artifact-content";

/*
 * Read-only renderers for generated structure. They take the parsed content,
 * never raw JSON, so a malformed row cannot crash a page.
 *
 * A citation renders as a numbered reference into the source list the caller
 * passes. That is the NotebookLM gesture: the marker in the text and the entry
 * in the list are the same number.
 *
 * Every generated-text element carries wrap-anywhere: content is model output
 * inside schema length caps, not guaranteed breakable, and one unbroken string
 * must not size the layout (a 500-char bullet otherwise blows a mobile page
 * past the viewport through min-content sizing).
 */

export type CitationSource = { documentId: string; title: string };

function CitationMarker({ index }: { index: number }) {
  return (
    <sup className="readout ml-0.5 text-[10px] text-muted-foreground" aria-label={`Source ${index + 1}`}>
      {index + 1}
    </sup>
  );
}

function markers(citations: string[], sources: CitationSource[]): number[] {
  return citations
    .map((id) => sources.findIndex((s) => s.documentId === id))
    .filter((i) => i >= 0);
}

export function DeckView({ content, sources }: { content: DeckContent; sources: CitationSource[] }) {
  return (
    <ol className="space-y-4">
      {content.slides.map((slide, i) => {
        const cites = markers(slide.citations, sources);
        return (
          <li key={`${i}-${slide.title}`} className="panel rounded-xl p-5">
            <div className="flex items-baseline justify-between gap-3">
              <h3 className="wrap-anywhere text-[15px] font-medium">
                {slide.title}
                {cites.map((index) => (
                  <CitationMarker key={index} index={index} />
                ))}
              </h3>
              <span className="readout text-xs text-muted-foreground">
                {i + 1} / {content.slides.length}
              </span>
            </div>
            {slide.bullets.length > 0 && (
              <ul className="mt-3 space-y-1.5">
                {slide.bullets.map((bullet, b) => (
                  <li key={b} className="flex gap-2 text-[13px] leading-relaxed">
                    <span aria-hidden className="mt-1.5 size-1 shrink-0 rounded-full bg-muted-foreground" />
                    <span className="wrap-anywhere">{bullet}</span>
                  </li>
                ))}
              </ul>
            )}
            {slide.note && <p className="mt-3 wrap-anywhere border-t border-border pt-3 text-xs leading-relaxed text-muted-foreground">{slide.note}</p>}
            {cites.length === 0 && (
              <p className="mt-3 text-xs text-muted-foreground">Unsourced slide. Edit it to cite a document.</p>
            )}
          </li>
        );
      })}
    </ol>
  );
}

export function InfographicView({ content, sources }: { content: InfographicContent; sources: CitationSource[] }) {
  return (
    <article className="panel rounded-xl p-6">
      <h2 className="wrap-anywhere text-lg font-medium">{content.headline}</h2>

      {content.stats.length > 0 && (
        <dl className={content.layout === "stats" ? "mt-5 grid grid-cols-2 gap-4 sm:grid-cols-3" : "mt-4 flex flex-wrap gap-6"}>
          {content.stats.map((stat, i) => {
            const index = stat.citation ? sources.findIndex((s) => s.documentId === stat.citation) : -1;
            return (
              <div key={`${i}-${stat.label}`} className="min-w-0">
                <dt className="wrap-anywhere text-xs text-muted-foreground">{stat.label}</dt>
                <dd className="readout mt-1 wrap-anywhere text-2xl">
                  {stat.value}
                  {index >= 0 && <CitationMarker index={index} />}
                </dd>
              </div>
            );
          })}
        </dl>
      )}

      {content.sections.length > 0 && (
        <div className="mt-6 space-y-4">
          {content.sections.map((section, i) => (
            <section key={`${i}-${section.heading}`}>
              <h3 className="wrap-anywhere text-[13px] font-medium">{section.heading}</h3>
              <p className="mt-1 wrap-anywhere text-[13px] leading-relaxed text-muted-foreground">{section.body}</p>
            </section>
          ))}
        </div>
      )}

      {content.citations.length > 0 && (
        <footer className="mt-6 border-t border-border pt-3">
          <ol className="space-y-1">
            {markers(content.citations, sources).map((index) => (
              <li key={index} className="text-xs text-muted-foreground">
                <span className="readout mr-1">{index + 1}.</span>
                <span className="wrap-anywhere">{sources[index].title}</span>
              </li>
            ))}
          </ol>
        </footer>
      )}
    </article>
  );
}
