import { describe, expect, it } from "vitest";
import { ruleKind } from "@/domains/capture/kind-label";

/*
 * The free rules tier of the capture kind label. Each rule settles a capture
 * whose shape is unambiguous, so Jev is asked only about the rest; anything
 * the rules cannot name confidently comes back null.
 */

describe("ruleKind", () => {
  it("a URL with no other text is an article", () => {
    expect(ruleKind({ text: "", url: "https://example.com/post", structure: "url" })?.kind).toBe("article");
    expect(ruleKind({ text: "https://example.com/post", url: null, structure: "url" })?.kind).toBe("article");
  });

  it("a URL with the person's own words is not settled by the URL rule", () => {
    expect(
      ruleKind({ text: "This changed how I think about caching", url: "https://example.com/post", structure: "prose" }),
    ).toBeNull();
  });

  it("text starting with a verb and a due phrase is a task", () => {
    const label = ruleKind({ text: "Email Dana the budget by Friday", url: null, structure: "prose" });
    expect(label?.kind).toBe("task");
    expect(label?.reason).toBeTruthy();
  });

  it("a markdown checkbox is a task", () => {
    expect(ruleKind({ text: "- [ ] renew the passport", url: null, structure: "list" })?.kind).toBe("task");
  });

  it("text in quotation marks with an attribution is a quote", () => {
    expect(
      ruleKind({
        text: "“Simplicity is prerequisite for reliability.” — Edsger Dijkstra",
        url: null,
        structure: "prose",
      })?.kind,
    ).toBe("quote");
    expect(ruleKind({ text: '"Less, but better." - Dieter Rams', url: null, structure: "prose" })?.kind).toBe("quote");
  });

  it("a contact structure is a person", () => {
    expect(ruleKind({ text: "Dana Lee\ndana@example.com\n+1 555 0100", url: null, structure: "contact" })?.kind).toBe(
      "person",
    );
  });

  it("ambiguous prose returns null", () => {
    expect(
      ruleKind({
        text: "Maybe the onboarding flow should start from the person's first capture instead of a tour.",
        url: null,
        structure: "prose",
      }),
    ).toBeNull();
    // A verb with no due phrase is not enough to call it a task.
    expect(ruleKind({ text: "Read more about stoicism", url: null, structure: "prose" })).toBeNull();
    // Quotation marks with no attribution are not enough to call it a quote.
    expect(ruleKind({ text: '"interesting"', url: null, structure: "prose" })).toBeNull();
  });
});
