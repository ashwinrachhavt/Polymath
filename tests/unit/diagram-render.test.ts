import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Diagram render pipeline — spec art_Yi8Fwsqn §5, the three-rung failure
 * ladder:
 *   1. parse failure  → DiagramParseError carrying the parser's message
 *                       (the agent's one-shot self-correction reads it).
 *   2. unsupported or non-editable type → image-fallback, SVG intact, the
 *                       converter is never even asked.
 *   3. conversion runtime error on a supported type → the same fallback,
 *                       SVG intact, error logged — never a fake editable scene.
 *
 * Both heavy libraries are mocked: the unit project runs deny-all fetch with
 * no DOM, and the pipeline's bundle contract is that its behavior, not
 * mermaid's internals, is what this test pins.
 */

const mocks = vi.hoisted(() => ({
  initialize: vi.fn(),
  parse: vi.fn(),
  render: vi.fn(),
  parseMermaid: vi.fn(),
  graphToExcalidraw: vi.fn(),
}));

vi.mock("mermaid", () => ({
  default: { initialize: mocks.initialize, parse: mocks.parse, render: mocks.render },
}));
// The pipeline imports the 2.2.2 subpath modules (the index only exports the
// combined parseMermaidToExcalidraw), so the mocks target those specifiers.
vi.mock("@excalidraw/mermaid-to-excalidraw/dist/parseMermaid.js", () => ({
  parseMermaid: mocks.parseMermaid,
}));
vi.mock("@excalidraw/mermaid-to-excalidraw/dist/graphToExcalidraw.js", () => ({
  graphToExcalidraw: mocks.graphToExcalidraw,
}));

import { DiagramParseError, renderDiagram } from "@/domains/diagrams/render";
import {
  DIAGRAM_TYPES,
  EDITABLE_DIAGRAM_TYPES,
  supportsElementEdit,
  type DiagramRenderResult,
  type DiagramToolOutput,
  type DiagramType,
} from "@/domains/diagrams/types";

const FLOWCHART = "flowchart TD\n  A[User] --> B[API]";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.parse.mockResolvedValue(undefined);
  mocks.render.mockResolvedValue({ svg: '<svg id="preview"></svg>' });
  // Silence the rung-3 log; the fallback path must log, but tests assert the
  // result, and raw error output pollutes the runner.
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("rung 1 — parse failure", () => {
  it("throws DiagramParseError carrying the parser's message", async () => {
    mocks.parse.mockRejectedValue(new Error("Expected NODE, got LOADTEST at line 2"));
    const error = await renderDiagram("nonsense", "flowchart").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DiagramParseError);
    expect((error as DiagramParseError).parserMessage).toContain("Expected NODE");
  });

  it("never renders an SVG or reaches the converter after a parse failure", async () => {
    mocks.parse.mockRejectedValue(new Error("bad source"));
    await expect(renderDiagram(FLOWCHART, "flowchart")).rejects.toBeInstanceOf(DiagramParseError);
    expect(mocks.render).not.toHaveBeenCalled();
    expect(mocks.parseMermaid).not.toHaveBeenCalled();
  });

  it("includes the parser message in the outer error text", async () => {
    mocks.parse.mockRejectedValue(new Error("unclosed bracket"));
    await expect(renderDiagram(FLOWCHART, "flowchart")).rejects.toThrow(/unclosed bracket/);
  });
});

describe("rung 2 — non-editable diagram types", () => {
  it.each(["gantt", "journey", "mindmap", "class", "state", "er"] as DiagramType[])(
    "renders SVG and declares image-fallback for %s without touching the converter",
    async (diagramType) => {
      const result = await renderDiagram(FLOWCHART, diagramType);
      expect(result.renderMode).toBe("image-fallback");
      if (result.renderMode === "image-fallback") {
        expect(result.svg).toContain("<svg");
        expect(result.fallbackReason).toContain("image");
        expect(result.fallbackReason).toContain(diagramType);
      }
      expect(mocks.parseMermaid).not.toHaveBeenCalled();
      expect(mocks.graphToExcalidraw).not.toHaveBeenCalled();
    },
  );
});

describe("rung 3 — conversion runtime error on a supported type", () => {
  it("falls back to the SVG with a logged error when conversion throws", async () => {
    mocks.parseMermaid.mockRejectedValue(new Error("layout engine exploded"));
    const result = await renderDiagram(FLOWCHART, "flowchart");
    expect(result.renderMode).toBe("image-fallback");
    if (result.renderMode === "image-fallback") {
      expect(result.svg).toContain("<svg");
      expect(result.fallbackReason).not.toBe("");
    }
    expect(console.error).toHaveBeenCalled();
  });

  it("falls back when the parsed graph degrades to a GraphImage", async () => {
    // The converter signals "this is not element-editable" by returning a
    // raster; the pipeline must believe the graph over the declared type.
    mocks.parseMermaid.mockResolvedValue({ type: "graphImage", dataURL: "data:image/png;base64,x" });
    const result = await renderDiagram(FLOWCHART, "sequence");
    expect(result.renderMode).toBe("image-fallback");
    expect(mocks.graphToExcalidraw).not.toHaveBeenCalled();
  });

  it("does not fake editable elements on the fallback path", async () => {
    mocks.graphToExcalidraw.mockRejectedValue(new Error("boom"));
    const result: DiagramRenderResult = await renderDiagram(FLOWCHART, "flowchart");
    expect(result).not.toHaveProperty("elements");
  });
});

describe("success path", () => {
  it("returns an editable scene for a flowchart", async () => {
    mocks.parseMermaid.mockResolvedValue({ type: "flowchart" });
    mocks.graphToExcalidraw.mockResolvedValue({ elements: [{ type: "rectangle", id: "a" }] });
    const result = await renderDiagram(FLOWCHART, "flowchart");
    expect(result).toStrictEqual({
      renderMode: "excalidraw",
      svg: '<svg id="preview"></svg>',
      elements: [{ type: "rectangle", id: "a" }],
      files: undefined,
    });
  });

  it("returns an editable scene for a sequence diagram", async () => {
    mocks.parseMermaid.mockResolvedValue({ type: "sequence" });
    mocks.graphToExcalidraw.mockResolvedValue({ elements: [{ type: "arrow", id: "b" }], files: {} });
    const result = await renderDiagram("sequenceDiagram\n  A->>B: hi", "sequence");
    expect(result.renderMode).toBe("excalidraw");
    if (result.renderMode === "excalidraw") expect(result.files).toStrictEqual({});
    expect(mocks.parseMermaid).toHaveBeenCalledWith("sequenceDiagram\n  A->>B: hi", { startOnLoad: false });
  });

  it("initializes mermaid with startOnLoad disabled", async () => {
    await renderDiagram(FLOWCHART, "flowchart");
    expect(mocks.initialize).toHaveBeenCalledWith({ startOnLoad: false });
  });
});

describe("editability map (locked decision 5)", () => {
  it("covers exactly the spec's eight diagram types", () => {
    expect(DIAGRAM_TYPES).toStrictEqual([
      "flowchart",
      "sequence",
      "class",
      "state",
      "er",
      "journey",
      "gantt",
      "mindmap",
    ]);
  });

  it("element-edits flowchart and sequence only", () => {
    expect(EDITABLE_DIAGRAM_TYPES).toStrictEqual(["flowchart", "sequence"]);
    expect(DIAGRAM_TYPES.map((type) => [type, supportsElementEdit(type)] as const)).toStrictEqual([
      ["flowchart", true],
      ["sequence", true],
      ["class", false],
      ["state", false],
      ["er", false],
      ["journey", false],
      ["gantt", false],
      ["mindmap", false],
    ]);
  });
});

describe("DiagramToolOutput shape (spec §3)", () => {
  it("carries ids, source, type, and a client-set renderMode — never the converted scene", () => {
    const output: DiagramToolOutput = {
      canvasId: "cv_00000000-0000-4000-8000-000000000000",
      artifactId: "art_00000000-0000-4000-8000-000000000000",
      version: 2,
      mermaid: FLOWCHART,
      diagramType: "flowchart",
      renderMode: "excalidraw",
    };
    expect(Object.keys(output)).toStrictEqual([
      "canvasId",
      "artifactId",
      "version",
      "mermaid",
      "diagramType",
      "renderMode",
    ]);
  });
});

/*
 * Bundle contract (locked decision 7): no file under src/ or eve/ may
 * statically import mermaid or @excalidraw/mermaid-to-excalidraw. The only
 * legal reference is a dynamic `await import(...)` — an async chunk, not
 * initial bytes. `import type` statements are erased at runtime and allowed.
 */
describe("bundle hygiene — heavy libs are dynamically imported only", () => {
  const ROOTS = ["src", "eve"];
  const STATIC_IMPORT_PATTERNS = [
    (pkg: string) => new RegExp(`\\bfrom\\s*["']${pkg}(?:/[\\w./-]+)?["']`),
    (pkg: string) => new RegExp(`(^|\\n)\\s*import\\s*["']${pkg}(?:/[\\w./-]+)?["']`),
    (pkg: string) => new RegExp(`\\brequire\\(\\s*["']${pkg}(?:/[\\w./-]+)?["']\\s*\\)`),
  ];
  const TYPE_ONLY_IMPORT = /\bimport\s+type\s+[^;]*?from\s*["'][^"']+["'];?/g;

  function* walk(dir: string): Generator<string> {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      const stat = statSync(path);
      if (stat.isDirectory()) {
        if (entry === "node_modules") continue;
        yield* walk(path);
      } else if (/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(entry)) {
        yield path;
      }
    }
  }

  it("no source file statically imports mermaid or mermaid-to-excalidraw", () => {
    const offenders: string[] = [];
    for (const root of ROOTS) {
      for (const path of walk(root)) {
        const source = readFileSync(path, "utf8").replace(TYPE_ONLY_IMPORT, "");
        for (const pkg of ["mermaid", "@excalidraw/mermaid-to-excalidraw"]) {
          if (STATIC_IMPORT_PATTERNS.some((pattern) => pattern(pkg).test(source))) offenders.push(path);
        }
      }
    }
    expect(offenders).toStrictEqual([]);
  });

  it("the render module keeps both heavy loads behind dynamic import()", () => {
    const source = readFileSync("src/domains/diagrams/render.ts", "utf8");
    expect(source).toContain('import("mermaid")');
    // The 2.2.2 two-step surface lives in subpath modules (see render.ts).
    expect(source).toContain('import("@excalidraw/mermaid-to-excalidraw/dist/');
  });
});
