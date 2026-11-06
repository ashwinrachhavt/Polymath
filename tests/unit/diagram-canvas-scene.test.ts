import { describe, expect, it } from "vitest";
import { MAX_CANVAS_SCENE_CHARS, canvasSceneSizeError, parseCanvasScene } from "@/domains/diagrams/types";

/*
 * The canvas scene envelope contracts: generation writes a mermaid envelope,
 * an editor save writes a serialized Excalidraw envelope, and anything else
 * parses to null so the canvas surface renders its honest unreadable state
 * instead of a guess.
 */

describe("parseCanvasScene — the scene-envelope dispatch", () => {
  it("parses the generation-time mermaid envelope", () => {
    const parsed = parseCanvasScene({ format: "mermaid", mermaid: "graph LR\na-->b", diagramType: "flowchart" });
    expect(parsed).toEqual({ format: "mermaid", mermaid: "graph LR\na-->b", diagramType: "flowchart" });
  });

  it("parses a saved Excalidraw envelope, keeping elements/appState/files", () => {
    const scene = { elements: [{ id: "e1", type: "rectangle" }], appState: { viewBackgroundEnabled: true }, files: {} };
    expect(parseCanvasScene({ format: "excalidraw", scene })).toEqual({ format: "excalidraw", scene });
  });

  it("accepts an Excalidraw envelope with elements only", () => {
    expect(parseCanvasScene({ format: "excalidraw", scene: { elements: [] } })).toEqual({
      format: "excalidraw",
      scene: { elements: [] },
    });
  });

  it("rejects a mermaid envelope with an unknown diagramType instead of defaulting it", () => {
    expect(parseCanvasScene({ format: "mermaid", mermaid: "graph LR\na-->b", diagramType: "pie" })).toBeNull();
  });

  it("rejects an Excalidraw envelope whose elements are not an array", () => {
    expect(parseCanvasScene({ format: "excalidraw", scene: { elements: "not-an-array" } })).toBeNull();
    expect(parseCanvasScene({ format: "excalidraw", scene: null })).toBeNull();
  });

  it("rejects other formats and non-objects", () => {
    expect(parseCanvasScene({ format: "svg", scene: {} })).toBeNull();
    expect(parseCanvasScene("graph LR")).toBeNull();
    expect(parseCanvasScene(null)).toBeNull();
  });
});

describe("canvasSceneSizeError — the save-side cap", () => {
  it("passes a small scene", () => {
    expect(canvasSceneSizeError({ elements: [{ id: "e1" }] })).toBeNull();
  });

  it("refuses an oversized scene with its real size", () => {
    const error = canvasSceneSizeError({ elements: [{ id: "x".repeat(MAX_CANVAS_SCENE_CHARS) }] });
    expect(error).toContain("the cap is");
  });
});
