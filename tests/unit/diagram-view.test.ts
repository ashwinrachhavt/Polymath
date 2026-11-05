import { describe, expect, it, vi } from "vitest";

/*
 * DiagramView read model (spec art_Yi8Fwsqn §6):
 *  - dispatch: a `diagram` artifact's stored version envelope parses only
 *    when it really is a diagram envelope — deck/infographic payloads and
 *    malformed shapes render as failed versions, never as guesses.
 *  - version switcher: pickDiagramVersion walks the artifact_versions chain —
 *    newest by default, stale requests fall forward to the newest.
 *
 * The db module is mocked: these are pure-logic tests; the query path's
 * workspace scoping is asserted at the SQL level in the domain, and the
 * unit project runs with no database.
 */

vi.mock("@/lib/db", () => ({ db: {} }));

import {
  parseDiagramVersionContent,
  pickDiagramVersion,
  type DiagramVersionContent,
} from "@/domains/diagrams/view";

const FLOWCHART: DiagramVersionContent = {
  type: "diagram",
  mermaid: "flowchart TD\n  a[User] --> b[API]",
  diagramType: "flowchart",
};

describe("parseDiagramVersionContent — the diagram-kind dispatch", () => {
  it("parses a well-formed diagram envelope", () => {
    expect(parseDiagramVersionContent(FLOWCHART)).toEqual(FLOWCHART);
  });

  it("parses every non-editable diagram type too — fallback types are still diagrams", () => {
    const gantt: DiagramVersionContent = { type: "diagram", mermaid: "gantt\n  title Plan", diagramType: "gantt" };
    expect(parseDiagramVersionContent(gantt)?.diagramType).toBe("gantt");
  });

  it("rejects other structured kinds — deck content never dispatches to the diagram view", () => {
    const deck = { kind: "deck", slides: [{ title: "One" }] };
    expect(parseDiagramVersionContent(deck)).toBeNull();
  });

  it("rejects a missing or non-diagram type marker", () => {
    expect(parseDiagramVersionContent({ mermaid: "flowchart TD", diagramType: "flowchart" })).toBeNull();
    expect(
      parseDiagramVersionContent({ type: "markdown", mermaid: "flowchart TD", diagramType: "flowchart" }),
    ).toBeNull();
  });

  it("rejects an unknown diagramType instead of defaulting it", () => {
    expect(parseDiagramVersionContent({ type: "diagram", mermaid: "flowchart TD", diagramType: "gitgraph" })).toBeNull();
  });

  it("rejects empty or non-string mermaid", () => {
    expect(parseDiagramVersionContent({ type: "diagram", mermaid: "", diagramType: "flowchart" })).toBeNull();
    expect(parseDiagramVersionContent({ type: "diagram", mermaid: 42, diagramType: "flowchart" })).toBeNull();
  });

  it("rejects non-object payloads", () => {
    expect(parseDiagramVersionContent(null)).toBeNull();
    expect(parseDiagramVersionContent("flowchart TD")).toBeNull();
    expect(parseDiagramVersionContent(undefined)).toBeNull();
  });
});

describe("pickDiagramVersion — the version switcher", () => {
  const chain = [
    { versionNumber: 1, label: "v1" },
    { versionNumber: 2, label: "v2" },
    { versionNumber: 3, label: "v3" },
  ];

  it("defaults to the newest version", () => {
    expect(pickDiagramVersion(chain)?.versionNumber).toBe(3);
  });

  it("selects the requested version", () => {
    expect(pickDiagramVersion(chain, 1)?.versionNumber).toBe(1);
    expect(pickDiagramVersion(chain, 2)?.versionNumber).toBe(2);
  });

  it("falls forward to the newest on a stale request — never blank", () => {
    expect(pickDiagramVersion(chain, 99)?.versionNumber).toBe(3);
  });

  it("finds the newest regardless of input order", () => {
    expect(pickDiagramVersion([chain[2], chain[0], chain[1]] as typeof chain)?.versionNumber).toBe(3);
  });

  it("returns undefined for an empty chain", () => {
    expect(pickDiagramVersion([])).toBeUndefined();
  });

  it("returns the single version for a one-version chain", () => {
    expect(pickDiagramVersion([chain[0]])?.versionNumber).toBe(1);
  });
});
