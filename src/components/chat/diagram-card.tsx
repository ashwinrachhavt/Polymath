"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowUpRight, Check, Copy, TriangleAlert, Wand2 } from "lucide-react";
import { FactPoll } from "@/components/fact-poll";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { DiagramCardState } from "@/domains/diagrams/card-state";
import type { DiagramRenderResult } from "@/domains/diagrams/types";

/*
 * The diagram card (spec art_Yi8Fwsqn §4): one card per `diagram` tool call,
 * rendered in ChatTranscript's transcript column in place of the bare
 * ChainOfThought pill. This component mounts behind next/dynamic ssr:false —
 * imported by chat-transcript.tsx — and the render pipeline itself is a lazy
 * `await import` below, so no mermaid or mermaid-to-excalidraw byte reaches
 * any route bundle until a card actually renders a preview (locked decision 7).
 *
 * Editability honesty (locked decision 5): the pipeline decides the render
 * mode, and the copy says exactly what the person got — an editable scene or
 * an image fallback — never silently one or the other. The Excalidraw editor
 * itself is not embedded here; "Open in canvas" routes to the artifact surface,
 * whose DiagramView owns the canvas-editor handoff (spec §6).
 */

type RenderOutcome =
  | { kind: "idle" }
  | { kind: "svg"; svg: string; editable: boolean; note: string | null }
  | { kind: "parse-error"; parserMessage: string };

/* Loading is derived, not stored: idle outcome + visible Preview tab + a
 * source to render IS the loading state. Storing it would need a synchronous
 * setState inside the render effect — the cascading-render anti-pattern. */
function isRendering(outcome: RenderOutcome, tab: string, hasSource: boolean): boolean {
  return tab === "preview" && hasSource && outcome.kind === "idle";
}

function outcomeOf(result: DiagramRenderResult): RenderOutcome {
  if (result.renderMode === "excalidraw") {
    return { kind: "svg", svg: result.svg, editable: true, note: null };
  }
  return { kind: "svg", svg: result.svg, editable: false, note: result.fallbackReason };
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  function copy() {
    navigator.clipboard
      .writeText(text)
      .then(() => setCopied(true))
      .then(() => setTimeout(() => setCopied(false), 1_500));
  }
  return (
    <Button type="button" size="sm" variant="outline" onClick={copy} aria-label={label}>
      {copied ? <Check aria-hidden className="size-3.5" /> : <Copy aria-hidden className="size-3.5" />}
      {copied ? "Copied" : "Copy"}
    </Button>
  );
}

function MermaidSource({ mermaid }: { mermaid: string }) {
  return (
    <pre className="readout panel overflow-x-auto rounded-md p-3 text-data leading-5">
      <code>{mermaid}</code>
    </pre>
  );
}

export default function DiagramCard({
  card,
  onRefine,
}: {
  card: DiagramCardState;
  onRefine?: (prefill: string) => void;
}) {
  const [tab, setTab] = useState("preview");
  const [outcome, setOutcome] = useState<RenderOutcome>({ kind: "idle" });

  const rendered = card.state === "rendered" ? card.output : null;
  const mermaid = rendered?.mermaid ?? null;
  const diagramType = rendered?.diagramType ?? null;

  // The pipeline hydrates only when the Preview tab is visible — the heavy
  // libraries never load for a card the person reads as source or scrolls past.
  // setOutcome fires only in promise callbacks, never synchronously in here.
  useEffect(() => {
    if (tab !== "preview" || !mermaid || !diagramType) return;
    if (outcome.kind !== "idle") return;
    let cancelled = false;
    (async () => {
      try {
        const { renderDiagram } = await import("@/domains/diagrams/render");
        const result = await renderDiagram(mermaid, diagramType);
        if (!cancelled) setOutcome(outcomeOf(result));
      } catch (error) {
        // Rung 1 of the failure ladder: the parser's message, verbatim — the
        // tool's structural guard is a heuristic, so the parser is the truth.
        if (cancelled) return;
        const parserMessage =
          error instanceof Error && error.name === "DiagramParseError"
            ? ((error as { parserMessage?: string }).parserMessage ?? error.message)
            : error instanceof Error
              ? error.message
              : String(error);
        setOutcome({ kind: "parse-error", parserMessage });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tab, mermaid, diagramType, outcome.kind]);

  if (card.state === "rendering") {
    return (
      <div className="panel rounded-xl p-4" data-diagram-card="rendering">
        <FactPoll
          label={`Rendering diagram${card.title ? `: ${card.title}` : "…"}`}
          compact
          topics={["diagram", "rendering", "motion", "light"]}
        />
        <Skeleton className="mt-3 h-40 w-full rounded-md" />
      </div>
    );
  }

  if (card.state === "correcting") {
    return (
      <div className="panel rounded-xl p-4" data-diagram-card="correcting" role="status">
        <div className="flex items-center gap-2">
          <TriangleAlert aria-hidden className="text-muted-foreground size-3.5" />
          <p className="text-body-dense text-muted-foreground">
            The first attempt didn{`'`}t parse{card.title ? ` — ${card.title}` : ""}. The agent gets one automatic
            retry; the retry renders below.
          </p>
        </div>
        <pre className="readout bg-muted/60 mt-2 overflow-x-auto rounded-md p-2 text-data leading-5">
          <code>{card.parserError}</code>
        </pre>
      </div>
    );
  }

  if (card.state === "failed") {
    return (
      <div className="panel rounded-xl p-4" data-diagram-card="failed">
        <div className="flex items-center gap-2">
          <TriangleAlert aria-hidden className="text-destructive size-3.5" />
          <p className="text-body-dense text-destructive">
            {card.title ? `${card.title}: ` : ""}The diagram failed to generate.
          </p>
        </div>
        <p className="text-muted-foreground mt-2 text-body-dense leading-5">{card.error}</p>
        {card.superseded ? (
          <p className="text-muted-foreground mt-1 text-body-dense leading-5">
            A later attempt regenerated this diagram. The card below is current.
          </p>
        ) : null}
        {card.mermaid ? (
          <div className="mt-3 space-y-2">
            <p className="text-muted-foreground text-body-dense">
              The attempted source, if you want to fix it by hand:
            </p>
            <MermaidSource mermaid={card.mermaid} />
            <CopyButton text={card.mermaid} label="Copy Mermaid source" />
          </div>
        ) : null}
      </div>
    );
  }

  // RENDERED — past the early returns, the card is in the rendered state.
  if (card.state !== "rendered") return null;
  const output = card.output;
  const preview =
    outcome.kind === "svg" ? (
      <div className="flex flex-col gap-2">
        {/* Mermaid's own SVG, produced client-side with the parser as the
          guard; mermaid's default securityLevel sanitizes label content. */}
        <div
          className="flex justify-center overflow-x-auto rounded-md p-3 [&_svg]:h-auto [&_svg]:max-w-full"
          data-diagram-svg
          role="img"
          aria-label={card.title ?? "Generated diagram"}
          dangerouslySetInnerHTML={{ __html: outcome.svg }}
        />
        <p
          className="text-muted-foreground text-body-dense leading-5"
          data-diagram-editability={outcome.editable ? "excalidraw" : "image-fallback"}
        >
          {outcome.editable
            ? "This diagram converted to an editable Excalidraw scene."
            : (outcome.note ?? "This diagram opens as an image, not an editable scene.")}
        </p>
      </div>
    ) : outcome.kind === "parse-error" ? (
      <div className="space-y-2" data-diagram-card="parse-error">
        <p className="text-body-dense text-destructive leading-5">
          The stored Mermaid source failed to parse in the browser:
        </p>
        <pre className="readout bg-muted/60 overflow-x-auto rounded-md p-2 text-data leading-5">
          <code>{outcome.parserMessage}</code>
        </pre>
        <p className="text-muted-foreground text-body-dense leading-5">
          The source is on the Mermaid tab. Fix it by hand or ask for a corrected version.
        </p>
      </div>
    ) : (
      <div className="space-y-2" data-diagram-card="preview-loading">
        <Skeleton className="h-40 w-full rounded-md" />
        {isRendering(outcome, tab, Boolean(mermaid)) ? (
          <FactPoll label="Rendering the diagram…" compact topics={["diagram", "rendering", "motion", "light"]} />
        ) : null}
      </div>
    );

  return (
    <div className="panel rounded-xl p-4" data-diagram-card="rendered" data-diagram-type={output.diagramType}>
      {card.superseded ? (
        <p className="text-muted-foreground mb-2 text-body-dense leading-5" data-diagram-superseded>
          This version was superseded by a later attempt. The newest card below is current.
        </p>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <h3 className="truncate text-body font-medium">{card.title ?? "Diagram"}</h3>
          <span
            className="readout bg-muted text-muted-foreground shrink-0 rounded px-1.5 py-0.5 text-data"
            data-diagram-version
          >
            v{output.version}
          </span>
        </div>
        <Link
          href={`/artifacts/${output.artifactId}`}
          className="text-muted-foreground hover:text-foreground inline-flex shrink-0 items-center gap-1 text-label"
        >
          Artifact <ArrowUpRight aria-hidden className="size-3.5" />
        </Link>
      </div>

      <Tabs value={tab} onValueChange={setTab} className="mt-3">
        <TabsList>
          <TabsTrigger value="preview">Preview</TabsTrigger>
          <TabsTrigger value="mermaid">Mermaid</TabsTrigger>
        </TabsList>
        <TabsContent value="preview" className="pt-3">
          {preview}
        </TabsContent>
        <TabsContent value="mermaid" className="pt-3">
          {mermaid ? (
            <div className="space-y-2">
              <MermaidSource mermaid={mermaid} />
              <CopyButton text={mermaid} label="Copy Mermaid source" />
            </div>
          ) : (
            <p className="text-muted-foreground text-body-dense leading-5">
              The source is too large for the transcript frame, so it is not shown here. It is stored in full on version
              v{output.version} of the artifact.
            </p>
          )}
        </TabsContent>
      </Tabs>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" asChild>
          {/* The canvas-editor handoff for diagram artifacts is the artifact
            surface's DiagramView (spec §6); until that lands, this routes to
            the artifact page rather than dead-ending on the bare canvas
            screen, which cannot load a diagram record yet. */}
          <Link href={`/artifacts/${output.artifactId}`}>Open in canvas</Link>
        </Button>
        {onRefine ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => onRefine(`Refine this diagram (${card.title ?? "diagram"}): `)}
          >
            <Wand2 aria-hidden className="size-3.5" /> Refine
          </Button>
        ) : null}
      </div>
    </div>
  );
}
