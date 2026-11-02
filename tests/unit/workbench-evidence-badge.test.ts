// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { EvidenceBadge, type EvidenceTier } from "@/components/polymath/workbench/evidence-badge";

/*
 * The spec's component test: inferred and verified badges must produce
 * DIFFERENT accessible text — a red test here is the failure mode where a
 * reader trusts an unverified claim as if a test had confirmed it.
 *
 * value: protects=the tier trust contract (grounded reads grounded, ungrounded
 * reads ungrounded); fails_when=a tier loses its text label, its paired icon,
 * or its border-style distinction, or when inferred/verified render alike;
 * seam=the badge component in isolation, all six tiers; no_claim=which tier a
 * section deserves (pinned where the section is built, in the panel tests).
 */

const ALL_TIERS: EvidenceTier[] = ["observed", "source-backed", "verified", "recorded", "inferred", "hypothesis"];
const GROUNDED_TIERS: EvidenceTier[] = ["observed", "source-backed", "verified", "recorded"];
const UNGROUNDED_TIERS: EvidenceTier[] = ["inferred", "hypothesis"];

afterEach(cleanup);

function badge(tier: EvidenceTier) {
  return render(createElement(EvidenceBadge, { tier }));
}

describe("evidence badge", () => {
  it("gives inferred and verified different accessible text", () => {
    const verified = badge("verified").container.textContent ?? "";
    const inferred = badge("inferred").container.textContent ?? "";

    // Each states its own tier and spells out what backs it, so the
    // distinction survives color blindness, grayscale, and screen readers.
    expect(verified).toContain("verified");
    expect(verified).toContain("test run");
    expect(verified.toLowerCase()).not.toContain("inferred");
    expect(inferred).toContain("inferred");
    expect(inferred).toContain("no test or human record confirms it");
    expect(inferred.toLowerCase()).not.toContain("verified");
    expect(verified).not.toBe(inferred);
  });

  it("keeps every tier's accessible text unique", () => {
    const texts = ALL_TIERS.map((tier) => badge(tier).container.textContent ?? "");
    expect(new Set(texts).size).toBe(ALL_TIERS.length);
  });

  it("pairs a text label with the icon on every tier", () => {
    for (const tier of ALL_TIERS) {
      const { container } = badge(tier);
      expect(container.querySelector("svg"), `${tier} is missing its icon`).not.toBeNull();
      expect(container.textContent ?? "", `${tier} is missing its text label`).toContain(tier);
    }
  });

  it("draws ungrounded tiers with dashed or dotted borders, never solid", () => {
    for (const tier of GROUNDED_TIERS) {
      const el = badge(tier).container.firstElementChild as HTMLElement;
      expect(el.className, `${tier} should be solid-bordered`).toContain("border-solid");
      expect(el.className).not.toContain("border-dashed");
      expect(el.className).not.toContain("border-dotted");
    }
    for (const tier of UNGROUNDED_TIERS) {
      const el = badge(tier).container.firstElementChild as HTMLElement;
      // Exactly one border style, and never the grounded one.
      const styles = ["border-solid", "border-dashed", "border-dotted"].filter((s) => el.className.includes(s));
      expect(styles, `${tier} border style`).toEqual([tier === "hypothesis" ? "border-dotted" : "border-dashed"]);
      // The ungrounded tiers must not inherit a grounded tier's fill either.
      expect(el.className, `${tier} must not carry a grounded fill`).not.toContain("bg-muted");
    }
  });
});
