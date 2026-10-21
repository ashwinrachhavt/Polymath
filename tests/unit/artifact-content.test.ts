import { describe, expect, it } from "vitest";
import {
  deckContent,
  filterCitations,
  infographicContent,
  parseGeneratedContent,
  parseStructuredContent,
  structuredPlainText,
} from "@/domains/knowledge/artifact-content";

const DOC_A = "11111111-1111-4111-8111-111111111111";
const DOC_B = "22222222-2222-4222-8222-222222222222";
const DOC_FOREIGN = "33333333-3333-4333-8333-333333333333";

const deck = {
  kind: "deck" as const,
  slides: [
    { title: "One", bullets: ["a", "b"], citations: [DOC_A] },
    { title: "Two", bullets: ["c"], citations: [DOC_A, DOC_FOREIGN] },
  ],
};

describe("parseGeneratedContent", () => {
  it("parses a bare deck object and adds kind when missing", () => {
    const out = parseGeneratedContent("deck", JSON.stringify({ slides: deck.slides }));
    expect(out?.kind).toBe("deck");
  });

  it("tolerates a fenced code block", () => {
    const out = parseGeneratedContent("deck", "```json\n" + JSON.stringify(deck) + "\n```");
    expect(out?.kind).toBe("deck");
  });

  it("returns null for prose", () => {
    expect(parseGeneratedContent("deck", "Here is a deck: it has slides.")).toBeNull();
  });

  it("returns null when the shape is wrong", () => {
    expect(parseGeneratedContent("deck", JSON.stringify({ kind: "deck", slides: [] }))).toBeNull();
    expect(parseGeneratedContent("infographic", JSON.stringify({ kind: "infographic", headline: "x" }))).toBeNull();
  });
});

describe("parseStructuredContent", () => {
  it("does not parse a report as structured", () => {
    expect(parseStructuredContent("report", { text: "hello" })).toBeNull();
  });

  it("rejects an unknown layout", () => {
    const bad = { kind: "infographic", headline: "h", layout: "poster", stats: [], sections: [], citations: [] };
    expect(parseStructuredContent("infographic", bad)).toBeNull();
  });
});

describe("filterCitations", () => {
  it("drops a citation outside the pinned set and counts it", () => {
    const allowed = new Set([DOC_A, DOC_B]);
    const out = filterCitations(deck, allowed);
    expect(out.droppedCitations).toBe(1);
    if (out.content.kind !== "deck") throw new Error("shape");
    expect(out.content.slides[1].citations).toEqual([DOC_A]);
  });

  it("keeps every valid citation and reports none dropped", () => {
    const out = filterCitations(deck, new Set([DOC_A, DOC_FOREIGN]));
    expect(out.droppedCitations).toBe(0);
  });

  it("strips a stat whose document is not pinned", () => {
    const info = {
      kind: "infographic" as const,
      headline: "h",
      layout: "stats" as const,
      stats: [{ label: "Count", value: "42", citation: DOC_FOREIGN }, { label: "Rate", value: "7%", citation: DOC_A }],
      sections: [],
      citations: [DOC_A, DOC_FOREIGN],
    };
    const out = filterCitations(info, new Set([DOC_A]));
    if (out.content.kind !== "infographic") throw new Error("shape");
    expect(out.droppedCitations).toBe(2);
    expect(out.content.stats[0].citation).toBeUndefined();
    expect(out.content.stats[1].citation).toBe(DOC_A);
    expect(out.content.citations).toEqual([DOC_A]);
  });
});

describe("structuredPlainText", () => {
  it("projects a deck into headed bullets", () => {
    const text = structuredPlainText(deck);
    expect(text).toContain("# 1. One");
    expect(text).toContain("- a");
    expect(text).toContain("# 2. Two");
  });

  it("projects an infographic into headline and sections", () => {
    const text = structuredPlainText({
      kind: "infographic",
      headline: "Numbers",
      layout: "sections",
      stats: [],
      sections: [{ heading: "Why", body: "Because." }],
      citations: [],
    });
    expect(text).toContain("Numbers");
    expect(text).toContain("## Why");
  });
});

describe("round trip", () => {
  it("a stored deck parses back to the same shape", () => {
    const parsed = parseStructuredContent("deck", JSON.parse(JSON.stringify(deck)));
    expect(parsed).toEqual(deck);
  });

  it("deckContent rejects a slide with no title", () => {
    const bad = deckContent.safeParse({ kind: "deck", slides: [{ title: "  ", bullets: [] }] });
    expect(bad.success).toBe(false);
  });

  it("infographicContent accepts an empty stats list", () => {
    expect(infographicContent.safeParse({ kind: "infographic", headline: "h", layout: "lede" }).success).toBe(true);
  });
});
