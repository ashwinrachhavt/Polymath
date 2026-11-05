import type { MermaidToExcalidrawResult } from "@excalidraw/mermaid-to-excalidraw/dist/interfaces.js";

/*
 * Diagram Agent shared types — spec art_Yi8Fwsqn (§3, §5, locked decisions 1/4/5).
 *
 * Pure type + constant module: no runtime imports, so any surface can import
 * these without pulling mermaid or @excalidraw/mermaid-to-excalidraw into a
 * bundle. The heavy render pipeline lives in ./render.ts behind dynamic imports.
 */

/**
 * The diagram types the eve `diagram` tool accepts (spec §1). Mermaid is the
 * generation format — the LLM authors this list, never raw Excalidraw JSON
 * (locked decision 1).
 */
export const DIAGRAM_TYPES = ["flowchart", "sequence", "class", "state", "er", "journey", "gantt", "mindmap"] as const;

export type DiagramType = (typeof DIAGRAM_TYPES)[number];

/**
 * Editability honesty (locked decision 5): the mermaid-to-excalidraw
 * converter element-edits only flowcharts and sequences. Every other type
 * renders as an image fallback and the UI must say so — never silently claim
 * editability.
 *
 * Implementation note: the installed @excalidraw/mermaid-to-excalidraw 2.2.2
 * also parses class/state/er graphs, but the spec pins the editable set to
 * flowchart + sequence; widening it is a deliberate spec change, not a
 * drive-by.
 */
export const EDITABLE_DIAGRAM_TYPES = ["flowchart", "sequence"] as const satisfies readonly DiagramType[];

export function supportsElementEdit(diagramType: DiagramType): boolean {
  return (EDITABLE_DIAGRAM_TYPES as readonly DiagramType[]).includes(diagramType);
}

/** Set client-side after the conversion attempt (spec §3). */
export type DiagramRenderMode = "excalidraw" | "image-fallback";

/**
 * One render attempt's outcome. Parse failure never reaches this union — it
 * throws DiagramParseError so the card can surface the parser's message and
 * the agent's one-shot self-correction can react to it (spec §5 failure
 * ladder rung 1). Conversion-time problems degrade to `image-fallback` with
 * the SVG intact (rungs 2–3); `fallbackReason` is human-readable UI copy.
 */
export type DiagramRenderResult =
  | {
      renderMode: "excalidraw";
      /** Mermaid SVG for the Preview tab (also the image-fallback payload). */
      svg: string;
      /** Editable Excalidraw scene skeletons for the canvas editor. */
      elements: MermaidToExcalidrawResult["elements"];
      files?: MermaidToExcalidrawResult["files"];
    }
  | {
      renderMode: "image-fallback";
      svg: string;
      /** Why the scene is not element-editable — shown to the person, plainly. */
      fallbackReason: string;
    };

/**
 * The `diagram` tool's stream frame payload (spec §3). Ids and source only —
 * never the converted scene, so the MAX_TOOL_PAYLOAD cap is never at risk.
 */
export type DiagramToolOutput = {
  canvasId: string;
  artifactId: string;
  version: number;
  mermaid: string;
  diagramType: DiagramType;
  /** Set client-side after the conversion attempt. */
  renderMode: DiagramRenderMode;
};
