import { describe, expect, it } from "vitest";
import { artifactNextStep } from "@/domains/knowledge/continuation";

describe("artifactNextStep", () => {
  it("derives a suggestion for open states and nothing for terminal ones", () => {
    expect(artifactNextStep("draft")).toContain("Review it");
    expect(artifactNextStep("reviewed")).toContain("Decide what this output becomes next");
    expect(artifactNextStep("published")).toBeNull();
    expect(artifactNextStep("archived")).toBeNull();
    expect(artifactNextStep("generated")).toBeNull();
  });
});
