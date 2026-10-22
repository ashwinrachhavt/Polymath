import { describe, expect, it } from "vitest";
import { artifactNextStep, deriveContinuationFromArtifacts } from "@/domains/knowledge/continuation";

/*
 * Continue is derived from saved state (design rule 4): only draft/reviewed
 * outputs appear, newest change first, the next step is a suggestion derived
 * from the status, and discarded work never resurfaces (archived rows are
 * excluded in the query; terminal statuses derive no next step).
 */
describe("artifactNextStep", () => {
  it("derives a suggestion for open states and nothing for terminal ones", () => {
    expect(artifactNextStep("draft")).toContain("Review it");
    expect(artifactNextStep("reviewed")).toContain("Decide what this output becomes next");
    expect(artifactNextStep("published")).toBeNull();
    expect(artifactNextStep("archived")).toBeNull();
    expect(artifactNextStep("generated")).toBeNull();
  });
});

describe("deriveContinuationFromArtifacts", () => {
  const older = new Date("2026-10-01T10:00:00Z");
  const newer = new Date("2026-10-20T10:00:00Z");

  it("keeps only drafts and reviewed outputs, newest change first", () => {
    const items = deriveContinuationFromArtifacts([
      { id: "a1", title: "Old draft", kind: "report", status: "draft", updatedAt: older },
      { id: "a2", title: "Kept output", kind: "report", status: "reviewed", updatedAt: newer },
      { id: "a3", title: "Published", kind: "note", status: "published", updatedAt: newer },
      { id: "a4", title: "Discarded", kind: "note", status: "archived", updatedAt: newer },
    ]);
    expect(items.map((i) => i.artifactId)).toEqual(["a2", "a1"]);
  });

  it("marks each next step as derived, linking to the draft workbench", () => {
    const items = deriveContinuationFromArtifacts([
      { id: "a9", title: "Case study", kind: "report", status: "draft", updatedAt: older },
    ]);
    expect(items[0]).toMatchObject({
      artifactId: "a9",
      status: "draft",
      href: "/alfred/dossiers?draft=a9",
      suggestedNextStep: "Review it: keep the draft or discard it.",
    });
  });

  it("honours the limit", () => {
    const rows = Array.from({ length: 8 }, (_, i) => ({
      id: `a${i}`,
      title: `Draft ${i}`,
      kind: "note",
      status: "draft",
      updatedAt: new Date(older.getTime() + i * 1000),
    }));
    const items = deriveContinuationFromArtifacts(rows, 3);
    expect(items).toHaveLength(3);
    expect(items[0].artifactId).toBe("a7");
  });
});
