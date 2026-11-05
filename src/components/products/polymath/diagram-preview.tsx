"use client";

import { useEffect, useState } from "react";
import { useTheme } from "next-themes";
import { renderDiagram } from "@/domains/diagrams/render";
import type { DiagramRenderResult, DiagramType } from "@/domains/diagrams/types";

/*
 * The heavy half of the DiagramView: it actually loads mermaid (and, for
 * editable types, the Excalidraw converter) and renders the stored Mermaid
 * source. Mounted behind next/dynamic with ssr: false from diagram-view.tsx —
 * the house heavy-island pattern (canvas.tsx, note-editor.tsx) — so the
 * artifact route's initial bundle carries none of it (locked decision 7).
 *
 * The failure ladder is renderDiagram's (spec §5); this island only renders
 * its outcomes: an SVG (with the fallback reason when the scene is not
 * editable), or the parser's message for a version whose source cannot
 * parse. A failed version is shown as failed — never as a blank or a guess.
 */

/** What the island reports to its parent when a render settles — the version
 * rides the outcome so the parent can version-gate the "Open in canvas"
 * affordance without re-creating the handler per version. */
export type DiagramPreviewOutcome =
  | { state: "rendered"; renderMode: "excalidraw" | "image-fallback"; fallbackReason?: string; versionNumber: number }
  | { state: "failed"; parserMessage: string; versionNumber: number };

/** Internal display state: no version echo — the island is keyed per version,
 * so what it renders is always the version it was mounted for. */
type PreviewDisplay =
  | { state: "rendering" }
  | { state: "rendered"; svg: string; renderMode: "excalidraw" | "image-fallback"; fallbackReason?: string }
  | { state: "failed"; parserMessage: string };

function DiagramPreview({
  mermaid,
  diagramType,
  versionNumber,
  onOutcome,
}: {
  mermaid: string;
  diagramType: DiagramType;
  /** Echoed in every outcome so the parent can version-gate the "Open in
   * canvas" affordance without re-creating the handler per version. */
  versionNumber: number;
  /** Reported when a render settles, so the parent can show the "Open in
   * canvas" affordance only for a version that truly converted. */
  onOutcome?: (outcome: DiagramPreviewOutcome) => void;
}) {
  const { resolvedTheme } = useTheme();
  const [display, setDisplay] = useState<PreviewDisplay>({ state: "rendering" });

  useEffect(() => {
    // A stale render (a fast version switch or theme flip) must not
    // overwrite the newer one; the live flag drops out-of-order resolutions.
    // Version switches remount this island (the parent keys it), so the
    // effect never needs a synchronous state reset — the initial "rendering"
    // state is the reset.
    let live = true;

    const theme = resolvedTheme === "dark" ? ("dark" as const) : ("default" as const);
    renderDiagram(mermaid, diagramType, { theme })
      .then((result: DiagramRenderResult) => {
        if (!live) return;
        setDisplay(
          result.renderMode === "excalidraw"
            ? { state: "rendered", svg: result.svg, renderMode: "excalidraw" }
            : {
                state: "rendered",
                svg: result.svg,
                renderMode: "image-fallback",
                fallbackReason: result.fallbackReason,
              },
        );
        onOutcome?.(
          result.renderMode === "excalidraw"
            ? { state: "rendered", renderMode: "excalidraw", versionNumber }
            : {
                state: "rendered",
                renderMode: "image-fallback",
                fallbackReason: result.fallbackReason,
                versionNumber,
              },
        );
      })
      .catch((error: unknown) => {
        if (!live) return;
        const parserMessage =
          error instanceof Error && error.name === "DiagramParseError"
            ? // The parser's own text (spec §5 rung 1) — shown verbatim.
              ((error as { parserMessage?: string }).parserMessage ?? error.message)
            : error instanceof Error
              ? error.message
              : String(error);
        setDisplay({ state: "failed", parserMessage });
        onOutcome?.({ state: "failed", parserMessage, versionNumber });
      });

    return () => {
      live = false;
    };
  }, [mermaid, diagramType, resolvedTheme, onOutcome, versionNumber]);

  if (display.state === "rendering") {
    return (
      <div role="status" className="panel flex min-h-64 items-center justify-center rounded-xl p-6">
        <p className="text-body-dense text-muted-foreground">Rendering diagram…</p>
      </div>
    );
  }

  if (display.state === "failed") {
    return (
      <div role="alert" className="panel space-y-2 rounded-xl p-6">
        <p className="text-body-dense font-medium">This version did not render.</p>
        <p className="wrap-anywhere text-xs leading-relaxed text-muted-foreground">{display.parserMessage}</p>
        <p className="text-xs text-muted-foreground">
          The Mermaid source is still in the Mermaid tab. Fix it by refining the diagram in chat.
        </p>
      </div>
    );
  }

  // The SVG is mermaid's own output under its strict security level — stored
  // LLM-authored source is never inserted as markup, only mermaid's rendering
  // of it is.
  return (
    <div className="panel flex min-h-64 items-center justify-center overflow-auto rounded-xl p-6">
      <div className="max-w-full [&>svg]:max-w-full" dangerouslySetInnerHTML={{ __html: display.svg }} />
    </div>
  );
}

export default DiagramPreview;
