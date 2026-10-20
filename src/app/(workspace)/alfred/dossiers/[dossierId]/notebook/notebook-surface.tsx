"use client";

import Link from "next/link";
import { useState } from "react";
import { FileText, Image, Layers, NotebookPen, Presentation } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Status, Unavailable } from "@/components/workspace/ui";
import { DeckView, InfographicView, type CitationSource } from "@/components/products/alfred/artifact-views";
import type { DeckContent, InfographicContent } from "@/domains/knowledge/artifact-content";
import type { SourceRow } from "@/domains/knowledge/source-readiness";

/*
 * The notebook surface, laid out the way NotebookLM reads: sources on the left,
 * the grounded conversation in the middle, generated outputs on the right.
 *
 * The four output types are Report, Slide deck, Quiz and Infographic, plus
 * Flashcards, which is the same learning item under a different review gesture.
 * `connected_read` is deliberately absent: it is a provider read, not a studio
 * artifact, and putting it here would add a fifth kind to a four-kind contract.
 *
 * The Chat pane renders `Unavailable` until the shared chat surface is on the
 * branch. The contract it will take is fixed: runId from POST /api/v1/runs,
 * subject { type: "dossier", id }, and onCitation receiving DocumentCitation[].
 */

export type StudioOutput = "report" | "deck" | "infographic" | "quiz" | "flashcards";

const OUTPUTS: Array<{ kind: StudioOutput; label: string; icon: typeof FileText; blurb: string }> = [
  { kind: "report", label: "Report", icon: FileText, blurb: "A written brief that cites its sources." },
  { kind: "deck", label: "Slide deck", icon: Presentation, blurb: "One idea per slide, each with its source." },
  { kind: "quiz", label: "Quiz", icon: Layers, blurb: "Questions the sources can answer, quote-checked." },
  { kind: "flashcards", label: "Flashcards", icon: NotebookPen, blurb: "Review cards on a spaced schedule." },
  { kind: "infographic", label: "Infographic", icon: Image, blurb: "One page, numbers attributed to documents." },
];

export type GeneratedArtifact = {
  artifactId: string;
  title: string;
  kind: string;
  status: string;
  /** Parsed structure when the artifact is a deck or infographic. */
  structured?: DeckContent | InfographicContent | null;
};

export default function NotebookSurface({
  notebook,
  sources,
  artifacts,
  chatAvailable,
}: {
  notebook: { dossierId: string; title: string };
  sources: SourceRow[];
  artifacts: GeneratedArtifact[];
  chatAvailable: boolean;
}) {
  const [selected, setSelected] = useState<StudioOutput>("report");
  const [brief, setBrief] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const citationSources: CitationSource[] = sources.map((s) => ({ documentId: s.documentId, title: s.title }));

  return (
    <div className="grid gap-4 xl:grid-cols-[280px_minmax(0,1fr)_300px]">
      {/* Sources */}
      <aside aria-label="Sources" className="panel rounded-xl p-3">
        <div className="flex items-baseline justify-between gap-2 px-1">
          <h2 className="text-[13px] font-medium">Sources</h2>
          <Link href="/alfred/sources" className="text-xs text-muted-foreground underline-offset-2 hover:underline">
            Add
          </Link>
        </div>
        {sources.length === 0 ? (
          <p className="mt-3 px-1 text-xs leading-relaxed text-muted-foreground">
            No sources yet. Add one and it will appear here once it is ready.
          </p>
        ) : (
          <ul className="mt-2 flex flex-col">
            {sources.map((source) => (
              <li key={source.documentId} className="px-1 py-1.5">
                <p className="truncate text-[13px]">{source.title}</p>
                <p className="text-xs text-muted-foreground">
                  {source.kind === "video" ? "Video" : "Document"}
                  {source.readiness !== "ready" ? ` · ${source.readiness}` : ""}
                </p>
              </li>
            ))}
          </ul>
        )}
      </aside>

      {/* Chat */}
      <section aria-label="Chat" className="panel flex min-h-[60vh] flex-col rounded-xl p-4">
        <h2 className="text-[13px] font-medium">{notebook.title}</h2>
        <div className="mt-3 flex-1">
          {chatAvailable ? (
            // The shared surface takes over here once it is on the branch.
            <Unavailable feature="Chat surface">
              The shared chat surface is on its way. Until it lands, this pane stays closed rather than shipping a
              second conversation implementation.
            </Unavailable>
          ) : (
            <Unavailable feature="Grounded chat">
              Ask questions across these sources with citations. The surface arrives with the streaming chat branch; this
              notebook already has everything it needs to answer.
            </Unavailable>
          )}
        </div>
      </section>

      {/* Studio */}
      <aside aria-label="Studio" className="flex flex-col gap-3">
        <div className="panel rounded-xl p-3">
          <h2 className="text-[13px] font-medium">Studio</h2>
          <ul className="mt-2 flex flex-col gap-1">
            {OUTPUTS.map((output) => {
              const Icon = output.icon;
              const active = selected === output.kind;
              return (
                <li key={output.kind}>
                  <button
                    type="button"
                    onClick={() => setSelected(output.kind)}
                    className={`flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-muted ${
                      active ? "bg-muted font-medium" : ""
                    }`}
                  >
                    <Icon aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0">
                      {output.label}
                      <span className="block text-xs font-normal text-muted-foreground">{output.blurb}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          <form
            className="mt-3 flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              setMessage(
                selected === "quiz" || selected === "flashcards"
                  ? "Quizzes and flashcards are generated in Learning, so the review schedule owns them."
                  : "Studio generation is wired to the dossier run. Use Generate on the Dossiers page for now.",
              );
            }}
          >
            <Input
              aria-label="What should this output cover?"
              className="h-8 text-[13px]"
              placeholder="What should it cover?"
              value={brief}
              onChange={(e) => setBrief(e.target.value)}
            />
            <Button type="submit" size="sm" variant="outline" disabled={!brief.trim()}>
              Generate {OUTPUTS.find((o) => o.kind === selected)?.label}
            </Button>
          </form>
          {message && <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{message}</p>}
        </div>

        <div className="panel rounded-xl p-3">
          <h2 className="text-[13px] font-medium">In this notebook</h2>
          {artifacts.length === 0 ? (
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">Nothing generated yet.</p>
          ) : (
            <ul className="mt-2 flex flex-col gap-2">
              {artifacts.map((artifact) => (
                <li key={artifact.artifactId} className="border-b border-border pb-2 last:border-0 last:pb-0">
                  <div className="flex items-baseline justify-between gap-2">
                    <p className="truncate text-[13px]">{artifact.title}</p>
                    <Status>{artifact.kind}</Status>
                  </div>
                  {artifact.structured?.kind === "deck" && (
                    <div className="mt-2">
                      <DeckView content={artifact.structured} sources={citationSources} />
                    </div>
                  )}
                  {artifact.structured?.kind === "infographic" && (
                    <div className="mt-2">
                      <InfographicView content={artifact.structured} sources={citationSources} />
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </aside>
    </div>
  );
}
