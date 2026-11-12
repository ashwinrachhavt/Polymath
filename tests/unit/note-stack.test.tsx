import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AnchorHTMLAttributes, ReactNode } from "react";

/*
 * Value: protects=a [[link]] or backlink opens the linked note as a pane
 * beside the note being written, in the same page, with the trail in the URL;
 * fails_when=following a link navigates away from the written note, a link in
 * a pane drops or duplicates the trail, or Close keeps the closed pane;
 * why_new=the stacked reader became the writing surface's link behaviour;
 * seam=the router push and the hrefs; no_claim=pane layout in pixels, which
 * the browser check covers
 */

vi.mock("next/link", async () => {
  const { createElement } = await import("react");
  return {
    default: ({
      href,
      children,
      scroll: _scroll,
      ...rest
    }: { href: string; scroll?: boolean } & AnchorHTMLAttributes<HTMLAnchorElement>) =>
      createElement("a", { href, ...rest }, children as ReactNode),
  };
});
const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

import { NoteStack, useNoteStack, type StackNote } from "@/app/(workspace)/polymath/notes/note-stack";

const W = "11111111-1111-4111-8111-111111111111";
const A = "22222222-2222-4222-8222-222222222222";
const B = "33333333-3333-4333-8333-333333333333";

const pane = (id: string, title: string, markdown: string): StackNote => ({
  id,
  title,
  kind: "note",
  tags: [],
  updatedAt: "2026-11-12T10:00:00.000Z",
  markdown,
  backlinks: [],
});

/** Stands in for the editor: opens a note the way a clicked [[link]] does. */
function Writer() {
  const stack = useNoteStack();
  return (
    <button type="button" onClick={() => stack?.follow(null, 0, A)}>
      open linked
    </button>
  );
}

beforeEach(() => {
  push.mockReset();
  Element.prototype.scrollTo = vi.fn();
});

describe("linked notes open beside the note being written", () => {
  it("a link in the written note opens its note as the first pane", () => {
    render(<NoteStack noteId={W} noteTitle="Draft" editor={<Writer />} notes={[]} />);
    fireEvent.click(screen.getByRole("button", { name: "open linked" }));
    expect(push).toHaveBeenCalledWith(`/polymath/notes?id=${W}&stack=${A}`, { scroll: false });
  });

  it("a link inside a pane opens the next pane, keeping the trail before it", () => {
    render(
      <NoteStack
        noteId={W}
        noteTitle="Draft"
        editor={<Writer />}
        notes={[pane(A, "Alpha", "See [[Beta]] next.")]}
        linked={[{ id: B, title: "Beta", excerpt: "second" }]}
      />,
    );
    const link = screen.getByRole("link", { name: "Beta" });
    expect(link.getAttribute("href")).toBe(`/polymath/notes?id=${W}&stack=${A},${B}`);
    fireEvent.click(link, { button: 0 });
    expect(push).toHaveBeenCalledWith(`/polymath/notes?id=${W}&stack=${A},${B}`, { scroll: false });
  });

  it("a link back to the written note brings it into view instead of opening it twice", () => {
    render(
      <NoteStack
        noteId={W}
        noteTitle="Draft"
        editor={<Writer />}
        notes={[pane(A, "Alpha", "Back to [[Draft]].")]}
        linked={[{ id: W, title: "Draft", excerpt: null }]}
      />,
    );
    // The phone's back link is named for the written note too; this is the [[link]] in the text.
    const wiki = screen.getAllByRole("link", { name: "Draft" }).find((a) => a.classList.contains("wiki-link"));
    fireEvent.click(wiki!, { button: 0 });
    expect(push).not.toHaveBeenCalled();
  });

  it("a modified click is left to the browser, so a new tab still works", () => {
    render(
      <NoteStack
        noteId={W}
        noteTitle="Draft"
        editor={<Writer />}
        notes={[pane(A, "Alpha", "See [[Beta]].")]}
        linked={[{ id: B, title: "Beta", excerpt: null }]}
      />,
    );
    fireEvent.click(screen.getByRole("link", { name: "Beta" }), { button: 0, metaKey: true });
    expect(push).not.toHaveBeenCalled();
  });

  it("closing a pane drops it and every pane after it; writing in one makes it the written note", () => {
    render(
      <NoteStack
        noteId={W}
        noteTitle="Draft"
        editor={<Writer />}
        notes={[pane(A, "Alpha", ""), pane(B, "Beta", "")]}
      />,
    );
    expect(screen.getByRole("link", { name: "Close Alpha" }).getAttribute("href")).toBe(`/polymath/notes?id=${W}`);
    expect(screen.getByRole("link", { name: "Close Beta" }).getAttribute("href")).toBe(
      `/polymath/notes?id=${W}&stack=${A}`,
    );
    expect(screen.getByRole("link", { name: "Write in Beta" }).getAttribute("href")).toBe(`/polymath/notes?id=${B}`);
  });

  it("a title no note carries reads as text, not a link", () => {
    render(
      <NoteStack noteId={W} noteTitle="Draft" editor={<Writer />} notes={[pane(A, "Alpha", "See [[Nowhere]].")]} />,
    );
    expect(screen.queryByRole("link", { name: "Nowhere" })).toBeNull();
    expect(screen.getByText("Nowhere")).toBeTruthy();
  });
});
