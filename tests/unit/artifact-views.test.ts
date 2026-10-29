import { createElement as h } from "react";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DeckView, InfographicView } from "@/components/products/polymath/artifact-views";
import type { DeckContent, InfographicContent } from "@/domains/knowledge/artifact-content";

/*
 * Generated deck/infographic text is model output: schema-capped in length but
 * not guaranteed to contain break opportunities. One unbroken string used to
 * size the whole mobile layout through min-content (a 500-char bullet measured
 * ~3500px wide), blowing the notebook page past the viewport. Every generated
 * text element must carry wrap-anywhere so its min-content is one character.
 */

const UNBROKEN = "a1b2c3d4e5f6".repeat(30); // 360 chars, zero break opportunities

const deck: DeckContent = {
  kind: "deck",
  slides: [
    { title: UNBROKEN, bullets: [UNBROKEN], note: UNBROKEN, citations: [] },
    { title: "Normal slide", bullets: ["A readable bullet."], citations: [] },
  ],
};

const infographic: InfographicContent = {
  kind: "infographic",
  headline: UNBROKEN,
  layout: "stats",
  stats: [{ label: UNBROKEN, value: UNBROKEN.slice(0, 40) }],
  sections: [{ heading: UNBROKEN, body: UNBROKEN }],
  citations: [],
};

describe("DeckView generated-text wrapping", () => {
  const html = renderToStaticMarkup(h(DeckView, { content: deck, sources: [] }));

  it("wraps slide titles, bullets and notes with wrap-anywhere", () => {
    const occurrences = html.split("wrap-anywhere").length - 1;
    // Two slides: 2 titles + 2 bullets + 1 note.
    expect(occurrences).toBe(5);
  });

  it("renders the hostile unbroken string inside a wrapping element", () => {
    expect(html).toContain(`<span class="wrap-anywhere">${UNBROKEN}</span>`);
    expect(html).toContain(`<h3 class="wrap-anywhere text-[15px] font-medium">${UNBROKEN}`);
  });
});

describe("InfographicView generated-text wrapping", () => {
  const html = renderToStaticMarkup(h(InfographicView, { content: infographic, sources: [] }));

  it("wraps headline, stat label/value and section heading/body with wrap-anywhere", () => {
    const occurrences = html.split("wrap-anywhere").length - 1;
    // headline + dt + dd + section h3 + section p.
    expect(occurrences).toBe(5);
  });

  it("keeps citation source titles inside a wrapping element", () => {
    const withCite = renderToStaticMarkup(
      h(InfographicView, {
        content: { ...infographic, citations: ["00000000-0000-4000-8000-000000000000"] },
        sources: [{ documentId: "00000000-0000-4000-8000-000000000000", title: UNBROKEN }],
      }),
    );
    expect(withCite).toContain(`<span class="wrap-anywhere">${UNBROKEN}</span>`);
  });
});
