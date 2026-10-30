import { describe, expect, it } from "vitest";
import { destinations, destinationForPath } from "@/lib/navigation";

describe("Ideas destination", () => {
  it("is a top-level rail destination between Notes and Document Vault", () => {
    const labels = destinations.map((d) => d.label);
    const ideas = labels.indexOf("Ideas");
    expect(ideas).toBeGreaterThan(-1);
    expect(labels.indexOf("Notes")).toBeLessThan(ideas);
    expect(labels.indexOf("Document Vault")).toBeGreaterThan(ideas);
  });

  it("resolves its own path and every retired path to Ideas", () => {
    expect(destinationForPath("/polymath/ideas")?.label).toBe("Ideas");
    for (const retired of [
      "/polymath/knowledge/zettels",
      "/polymath/knowledge/zettels/session",
      "/polymath/knowledge/ideas",
      "/polymath/knowledge/cards",
      "/polymath/knowledge/areas",
    ]) {
      expect(destinationForPath(retired)?.label, retired).toBe("Ideas");
    }
  });
});
