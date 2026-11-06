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

/* ------------------------------------------------------------------ */
/* Canvas scene envelopes — what canvas_versions.scene can hold.       */
/* ------------------------------------------------------------------ */

/*
 * The scene column is append-only and holds one of two envelopes:
 *
 *  - "mermaid": written by the eve diagram tool at generation/refinement
 *    time (persistDiagram). The browser converts to Excalidraw lazily
 *    (locked decision 4), so the stored payload is the source, not a scene.
 *  - "excalidraw": written by a save from the canvas editor — the serialized
 *    drawing (elements + appState + files) from that checkpoint on.
 *
 * Pure parse/validation only: this module stays free of runtime imports so
 * both the server read model and the client editor can share it.
 */

/** Largest serialized scene a save accepts — the same 2 MB honesty limit the
 * canvas preview editor already applies to its local checkpoints. */
export const MAX_CANVAS_SCENE_CHARS = 2_000_000;

/** The generation-time envelope: Mermaid source awaiting client conversion. */
export type MermaidSceneEnvelope = { format: "mermaid"; mermaid: string; diagramType: DiagramType };

/** The serialized Excalidraw drawing a save from the canvas editor stores. */
export type ExcalidrawScenePayload = {
  elements: unknown[];
  appState?: Record<string, unknown>;
  files?: Record<string, unknown>;
};

export type ExcalidrawSceneEnvelope = { format: "excalidraw"; scene: ExcalidrawScenePayload };

export type CanvasSceneEnvelope = MermaidSceneEnvelope | ExcalidrawSceneEnvelope;

/**
 * Parse one stored canvas_versions.scene. Null for anything else — the
 * canvas surface renders an honest "unreadable version" state, never a
 * guess (the same contract as parseDiagramVersionContent for the artifact
 * chain).
 */
export function parseCanvasScene(content: unknown): CanvasSceneEnvelope | null {
  if (typeof content !== "object" || content === null) return null;
  const candidate = content as { format?: unknown };
  if (candidate.format === "mermaid") {
    const m = content as { mermaid?: unknown; diagramType?: unknown };
    if (typeof m.mermaid !== "string" || m.mermaid.length === 0) return null;
    if (typeof m.diagramType !== "string" || !(DIAGRAM_TYPES as readonly string[]).includes(m.diagramType)) {
      return null;
    }
    return { format: "mermaid", mermaid: m.mermaid, diagramType: m.diagramType as DiagramType };
  }
  if (candidate.format === "excalidraw") {
    const sc = (content as { scene?: unknown }).scene;
    if (typeof sc !== "object" || sc === null) return null;
    const elements = (sc as { elements?: unknown }).elements;
    if (!Array.isArray(elements)) return null;
    const payload: ExcalidrawScenePayload = { elements };
    const appState = (sc as { appState?: unknown }).appState;
    if (typeof appState === "object" && appState !== null) {
      payload.appState = appState as Record<string, unknown>;
    }
    const files = (sc as { files?: unknown }).files;
    if (typeof files === "object" && files !== null) {
      payload.files = files as Record<string, unknown>;
    }
    return { format: "excalidraw", scene: payload };
  }
  return null;
}

/**
 * The save-side size guard, run before the row is written: a scene that
 * would cross the cap is refused with its real size, so the person exports
 * instead of silently losing the checkpoint.
 */
export function canvasSceneSizeError(scene: ExcalidrawScenePayload): string | null {
  const size = JSON.stringify(scene).length;
  return size > MAX_CANVAS_SCENE_CHARS
    ? `the scene is ${size} characters; the cap is ${MAX_CANVAS_SCENE_CHARS}. Export the drawing instead of saving a checkpoint.`
    : null;
}
