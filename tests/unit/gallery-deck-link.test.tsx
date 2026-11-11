import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

/*
 * A flashcard deck in the gallery links to where it is reviewed: inside its
 * Notebook, or on Learn for a deck made from picked sources with no Notebook.
 *
 * Value: protects=the gallery link to a Learn deck; fails_when=a deck with no
 * Notebook links to /projects/null/...; seam=the card's server render;
 * no_claim=the review pages themselves.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

const { ArtifactCard } = await import("@/app/(workspace)/artifacts/gallery-client");

const DECK = "11111111-1111-4111-8111-111111111111";

function deck(notebookId: string | null) {
  return renderToStaticMarkup(
    createElement(ArtifactCard, {
      artifact: {
        recordType: "flashcard_deck",
        id: DECK,
        title: "Spacing",
        kind: "flashcards",
        status: "generated",
        preview: "What does spacing do?",
        notebookId,
      },
      view: "grid",
    }),
  );
}

describe("ArtifactCard deck link", () => {
  it("opens a deck made without a Notebook on Learn", () => {
    expect(deck(null)).toContain(`href="/learn/decks/${DECK}"`);
  });

  it("opens a Notebook's deck inside that Notebook", () => {
    const notebook = "22222222-2222-4222-8222-222222222222";
    expect(deck(notebook)).toContain(`href="/projects/${notebook}/notebook/flashcards?deck=${DECK}"`);
  });
});
