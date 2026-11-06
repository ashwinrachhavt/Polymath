"use client";

/*
 * Diagram render pipeline — spec art_Yi8Fwsqn §5, locked decisions 4/5/7.
 *
 * Turns Mermaid source into (a) an SVG preview and (b), for flowcharts and
 * sequences, an editable Excalidraw scene. Runs client-side only: mermaid and
 * the converter are browser-oriented, and no server-side mermaid parse is
 * attempted (locked decision 4). Robustness comes from this module's parse
 * guard plus the eve tool's structural guard and the agent's one-shot
 * self-correction pass.
 *
 * Bundle discipline (locked decision 7): both heavy libraries load through
 * `await import()` inside the functions below — nothing here static-imports
 * them, so evaluating this module (from any route or server component) adds
 * zero mermaid/excalidraw bytes. The diagram card that calls renderDiagram
 * must itself mount behind next/dynamic with ssr: false, per the
 * canvas.tsx/note-editor.tsx house pattern.
 *
 * The installed @excalidraw/mermaid-to-excalidraw 2.2.2 exposes the
 * two-step API — parseMermaid(definition) → graph, graphToExcalidraw(graph)
 * → { elements } — via subpath modules rather than a single
 * convertMermaidToExcalidraw call (the spec §5 pseudocode's name; behavior
 * is the same contract).
 */

import { DIAGRAM_TYPE_LABELS, supportsElementEdit, type DiagramRenderResult, type DiagramType } from "./types";

/** Rung 1 of the failure ladder: the source never parsed. The `message`
 * carries the parser's own text — the card shows it verbatim and the agent
 * self-corrects against it. Never swallowed into a fallback: a failed parse
 * has no SVG to fall back to. */
export class DiagramParseError extends Error {
  constructor(
    message: string,
    readonly parserMessage: string,
  ) {
    super(message);
    this.name = "DiagramParseError";
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function loadMermaid(theme?: "default" | "dark") {
  const mermaid = (await import("mermaid")).default;
  // startOnLoad: false — the pipeline drives parse/render explicitly; the
  // converter's own defaults (linear flowchart curves, 20px labels) match
  // what it renders inside Excalidraw. Theme follows the surface when the
  // caller supplies one (DiagramView dark mode), and securityLevel stays at
  // its strict default — stored LLM-authored source is never trusted markup.
  mermaid.initialize(theme ? { startOnLoad: false, theme } : { startOnLoad: false });
  return mermaid;
}

/**
 * Render one diagram. Throws only DiagramParseError (rung 1); every other
 * problem degrades to the image-fallback result with the SVG intact, so a
 * person always sees a rendered preview when mermaid could draw one.
 */
export async function renderDiagram(
  mermaidSrc: string,
  diagramType: DiagramType,
  options?: { theme?: "default" | "dark" },
): Promise<DiagramRenderResult> {
  const mermaid = await loadMermaid(options?.theme);

  // Rung 1 — parse guard. mermaid.parse throws with the parser's message on
  // invalid source; surface it as DiagramParseError for the one-shot
  // self-correction pass. Conversion is never attempted on unparsed source.
  try {
    await mermaid.parse(mermaidSrc);
  } catch (error) {
    const parserMessage = errorText(error);
    throw new DiagramParseError(`Mermaid source failed to parse: ${parserMessage}`, parserMessage);
  }

  // SVG preview — the payload of both render modes. mermaid.render needs a
  // DOM (it builds an offscreen element); this module is client-side only.
  const renderId = `diagram-${crypto.randomUUID()}`;
  const { svg } = await mermaid.render(renderId, mermaidSrc);

  // Rung 2 — editability honesty. Only flowcharts and sequences convert to
  // editable scenes (locked decision 5); everything else is a declared image
  // fallback, and the SVG still renders in the Preview tab.
  if (!supportsElementEdit(diagramType)) {
    return {
      renderMode: "image-fallback",
      svg,
      fallbackReason: `${DIAGRAM_TYPE_LABELS[diagramType]} diagrams open as an image, not an editable scene.`,
    };
  }

  // Rung 3 — conversion runtime error on a supported type degrades to the
  // same fallback (spec §5): the SVG preview survives, the error is logged,
  // and the UI never claims an editable scene that does not exist.
  try {
    // The 2.2.2 index exports only the combined parseMermaidToExcalidraw;
    // the two-step surface lives in subpath modules and is what lets the
    // pipeline intercept a GraphImage (raster) result before conversion.
    const [{ parseMermaid }, { graphToExcalidraw }] = await Promise.all([
      import("@excalidraw/mermaid-to-excalidraw/dist/parseMermaid.js"),
      import("@excalidraw/mermaid-to-excalidraw/dist/graphToExcalidraw.js"),
    ]);
    const graph = await parseMermaid(mermaidSrc, { startOnLoad: false });
    // Mermaid types the converter cannot element-edit come back as a
    // GraphImage (a raster of the diagram). If the declared type said
    // flowchart/sequence but the graph degraded to an image, be honest about
    // it instead of converting a bitmap into a picture-in-a-canvas.
    if ("type" in graph && graph.type === "graphImage") {
      return {
        renderMode: "image-fallback",
        svg,
        fallbackReason: "This diagram converted as an image, not an editable scene.",
      };
    }
    const { elements, files } = await graphToExcalidraw(graph);
    return { renderMode: "excalidraw", svg, elements, files };
  } catch (error) {
    console.error("[diagrams] mermaid-to-excalidraw conversion failed; falling back to image", error);
    return {
      renderMode: "image-fallback",
      svg,
      fallbackReason: "This diagram could not be converted to an editable scene; it opens as an image.",
    };
  }
}
