import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { MARGIN_MODE_PROPERTY, MarginNotes } from "@/components/products/polymath/margin-notes";
import type { LinkPreview } from "@/domains/knowledge/notes";

/*
 * Value: protects=the margin column shows a card per cited, previewed note, folds the rest behind
 * "+N more" which opens them in place, and draws nothing when no previewed note is cited;
 * fails_when="+N more" leaves the column, an empty column renders, or a card appears for a link with
 * no preview; why_new=the overflow and empty cases had no tests; seam=the --margin-notes property the
 * container query sets (jsdom cannot evaluate the query, so the test sets it); no_claim=card positions
 */

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});
afterEach(() => document.body.replaceChildren());

const preview = (n: number): LinkPreview => ({ id: `n${n}`, title: `Note ${n}`, firstParagraph: `About ${n}.` });

/** A note column in margin mode whose text cites `cited` by title. */
function page(cited: string[]) {
  const column = document.body.appendChild(document.createElement("div"));
  column.setAttribute("data-note-container", "");
  const inner = column.appendChild(document.createElement("div"));
  inner.className = "note-column";
  inner.style.setProperty(MARGIN_MODE_PROPERTY, "on");
  const editorRoot = inner.appendChild(document.createElement("div"));
  for (const title of cited) {
    const link = editorRoot.appendChild(document.createElement("span"));
    link.dataset.wikiTitle = title;
  }
  return editorRoot;
}

async function mount(previews: LinkPreview[], cited: string[]) {
  const editorRoot = page(cited);
  render(<MarginNotes previews={previews} editorRoot={editorRoot} />);
  // Anchors are measured on the next animation frame.
  await act(() => new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))));
}

describe("margin notes", () => {
  it("shows twelve cards and opens the rest in place", async () => {
    const previews = Array.from({ length: 14 }, (_, i) => preview(i + 1));
    await mount(
      previews,
      previews.map((p) => p.title),
    );
    expect(screen.getAllByRole("article")).toHaveLength(12);
    fireEvent.click(screen.getByRole("button", { name: "+2 more linked notes" }));
    expect(screen.getAllByRole("article")).toHaveLength(14);
    expect(screen.queryByRole("button", { name: /more linked notes/ })).toBeNull();
  });

  it("draws nothing for a note with no links", async () => {
    await mount([], []);
    expect(screen.queryByRole("complementary", { name: "Linked notes" })).toBeNull();
  });

  it("draws nothing when every link points at a missing note", async () => {
    await mount([], ["Nowhere", "Nobody"]);
    expect(screen.queryByRole("complementary", { name: "Linked notes" })).toBeNull();
  });

  it("draws a card only for a cited note", async () => {
    await mount([preview(1), preview(2)], ["Note 2", "Nowhere"]);
    expect(screen.getByRole("complementary", { name: "Linked notes" })).toBeTruthy();
    expect(screen.getAllByRole("article").map((card) => card.textContent)).toEqual(["Note 2About 2."]);
  });
});
