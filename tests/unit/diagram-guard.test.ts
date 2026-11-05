import { describe, expect, it } from "vitest";
import { DEFAULT_ALLOWED_TOOLS } from "@/domains/agents/commands";
import { MAX_TOOL_PAYLOAD } from "@/domains/agents/stream-contract";
import { TOOL_OPERATION_REGISTRY } from "@/domains/agents/authorization";
import {
  DIAGRAM_CREATE_CAPABILITY,
  DIAGRAM_TYPES,
  countMermaidNodes,
  diagramToolPayload,
  guardMermaidSource,
} from "@/domains/diagrams/diagrams";

/*
 * The diagram tool's structural guard (spec art_Yi8Fwsqn §1): malformed or
 * oversized Mermaid never reaches the UI or the database — it comes back as
 * an agent-readable error that feeds the one-shot self-correction pass. The
 * tool-result payload budget is pinned here too: an over-cap result replaced
 * wholesale by capPayload would take the ids down with it.
 */

const VALID_FLOWCHART = "flowchart TD\n  a[User] --> b[API]\n  b --> c{DB}";

function guardError(source: string): string {
  const guarded = guardMermaidSource(source);
  expect(guarded.ok).toBe(false);
  return guarded.ok === false ? guarded.error : "";
}

describe("guardMermaidSource — fences and hallucination artifacts", () => {
  it("passes bare source through unchanged", () => {
    const guarded = guardMermaidSource(VALID_FLOWCHART);
    expect(guarded).toEqual({ ok: true, mermaid: VALID_FLOWCHART });
  });

  it("strips a ```mermaid fence around otherwise-valid source", () => {
    const guarded = guardMermaidSource("```mermaid\n" + VALID_FLOWCHART + "\n```");
    expect(guarded).toEqual({ ok: true, mermaid: VALID_FLOWCHART });
  });

  it("rejects an unclosed fence", () => {
    const error = guardError("```mermaid\n" + VALID_FLOWCHART);
    expect(error).toMatch(/unclosed code fence/);
  });

  it("rejects source with text before or after a fence", () => {
    expect(guardError("Here is the diagram:\n```mermaid\n" + VALID_FLOWCHART + "\n```")).toMatch(
      /before the opening code fence/,
    );
    expect(guardError("```mermaid\n" + VALID_FLOWCHART + "\n```\nHope this helps!")).toMatch(
      /after the closing code fence/,
    );
  });

  it("rejects a stray five-backtick artifact mid-source", () => {
    expect(guardError(VALID_FLOWCHART + "\n`````")).toMatch(/before the opening code fence/);
  });

  it("rejects leading YAML front-matter but not an inline --- link", () => {
    expect(guardError("---\ntitle: auth\n---\n" + VALID_FLOWCHART)).toMatch(/front-matter/);
    const guarded = guardMermaidSource("flowchart TD\n  a --- b");
    expect(guarded.ok).toBe(true);
  });

  it("rejects an empty payload", () => {
    expect(guardError("```mermaid\n```\n")).toMatch(/empty after fence stripping/);
  });
});

describe("guardMermaidSource — budget caps", () => {
  it("rejects sources over the 20k character cap", () => {
    const filler = "  a --> b\n".repeat(2200);
    expect(guardError("flowchart TD\n" + filler)).toMatch(/cap is 20000/);
  });

  it("rejects a label over 200 characters", () => {
    const longLabel = "x".repeat(201);
    expect(guardError(`flowchart TD\n  a[${longLabel}] --> b`)).toMatch(/label is 201 characters; the cap is 200/);
  });

  it("rejects diagrams over the 60-node sanity cap", () => {
    const lines = Array.from({ length: 61 }, (_, i) => `  n${i}${i < 60 ? ` --> n${i + 1}` : ""}`);
    const error = guardError("flowchart TD\n" + lines.join("\n"));
    expect(error).toMatch(/about 61 nodes; the cap is 60/);
  });

  it("accepts a diagram at the 60-node cap", () => {
    const lines = Array.from({ length: 59 }, (_, i) => `  n${i} --> n${i + 1}`);
    const guarded = guardMermaidSource("flowchart TD\n" + lines.join("\n"));
    expect(guarded.ok).toBe(true);
  });

  it("counts unique nodes, not labels or keywords", () => {
    expect(countMermaidNodes(VALID_FLOWCHART)).toBe(3);
    // Comments, style lines, and participant aliases are not nodes.
    const noisy = [
      "sequenceDiagram",
      "  %% a comment about n0",
      "  participant U as User",
      "  U->>api: request",
      "  api-->>U: response",
    ].join("\n");
    expect(countMermaidNodes(noisy)).toBe(2);
    // Edge labels do not become nodes.
    expect(countMermaidNodes("flowchart TD\n  a -->|yes| b\n  a -- no --> c")).toBe(3);
    // Operator dashes glue to tokens they touch ("U->>api" -> "U-") — without
    // trimming, a 30-message exchange between two participants counts as ~60
    // phantom nodes and falsely trips the sanity cap.
    expect(countMermaidNodes("U->>api: a\napi-->>U: b\nU->>api: c")).toBe(2);
    // Dashes inside a legitimate id survive the trim.
    expect(countMermaidNodes("flowchart TD\n  my-node[User] --> your_node[API]")).toBe(2);
  });
});

describe("diagramToolPayload — the MAX_TOOL_PAYLOAD budget", () => {
  const ids = { canvasId: "c", artifactId: "a", version: 1, diagramType: "flowchart" as const };

  it("echoes the mermaid source when the result fits the frame cap", () => {
    const payload = diagramToolPayload({ ...ids, mermaid: VALID_FLOWCHART });
    expect(payload).toEqual({ ok: true, ...ids, mermaid: VALID_FLOWCHART });
    expect(JSON.stringify(payload).length).toBeLessThanOrEqual(MAX_TOOL_PAYLOAD);
  });

  it("drops the source (never the ids) when it would blow the frame cap", () => {
    const bigSource = "x".repeat(MAX_TOOL_PAYLOAD);
    const payload = diagramToolPayload({ ...ids, mermaid: bigSource });
    expect(payload.mermaid).toBeUndefined();
    expect(payload.mermaidOmitted).toBe(true);
    expect(payload.canvasId).toBe("c");
    expect(payload.artifactId).toBe("a");
    // The lean result always survives capPayload unreplaced.
    expect(JSON.stringify(payload).length).toBeLessThanOrEqual(MAX_TOOL_PAYLOAD);
  });
});

describe("diagram tool registration — deny-by-default wiring", () => {
  it("the capability constant matches the registry and the default allowlist", () => {
    expect(DIAGRAM_CREATE_CAPABILITY).toBe("diagram.create");
    // The GA03 registry knows the operation at document.create authority —
    // an internal write, no approval (local-only persistence).
    expect(TOOL_OPERATION_REGISTRY["diagram.create"]).toMatchObject({
      capability: "document.create",
      effectClass: "internal_write",
    });
    expect(TOOL_OPERATION_REGISTRY["diagram.create"]?.requiresApproval).toBeUndefined();
    // The run policy snapshot copies DEFAULT_ALLOWED_TOOLS verbatim, so the
    // tool is dead-403 without this row.
    expect(DEFAULT_ALLOWED_TOOLS).toContain("diagram.create");
  });

  it("the tool's diagramType enum is the spec's eight types", () => {
    expect([...DIAGRAM_TYPES]).toEqual([
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
});
