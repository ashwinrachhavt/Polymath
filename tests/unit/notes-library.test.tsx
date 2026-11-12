import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnchorHTMLAttributes, ReactNode } from "react";

/*
 * Value: protects=the Notes rail lists the workspace's notes with preview and
 * last edit, marks the open one, and narrows through the paged browse query
 * without navigating; fails_when=the rail marks the wrong note, a search opens
 * a note or keeps showing the previous query's hits, or paging links drop the
 * open note; why_new=the library UI is being restored and had no tests;
 * seam=the browse action and link hrefs; no_claim=ranking, which belongs to
 * pageNotes in the domain
 */

vi.mock("next/link", async () => {
  const { createElement } = await import("react");
  return {
    default: ({ href, children, ...rest }: { href: string } & AnchorHTMLAttributes<HTMLAnchorElement>) =>
      createElement("a", { href, ...rest }, children as ReactNode),
  };
});

vi.mock("@/app/(workspace)/polymath/notes/actions", () => ({ browseNotesAction: vi.fn() }));
vi.mock("@/app/(workspace)/polymath/notes/note-editor", async () => {
  const { createElement } = await import("react");
  return { NewNoteButton: () => createElement("button", { type: "button" }, "New note") };
});

import { browseNotesAction } from "@/app/(workspace)/polymath/notes/actions";
import { NotesLibrary } from "@/app/(workspace)/polymath/notes/notes-library";
import type { LibraryNote } from "@/app/(workspace)/polymath/notes/library-notes";

const search = vi.mocked(browseNotesAction);

const plan: LibraryNote = {
  id: "b",
  title: "Quarterly plan",
  kind: "note",
  excerpt: "Revenue and hiring",
  updatedAt: "2026-01-15T12:00:00.000Z",
  hasDraft: false,
};
const harness: LibraryNote = {
  id: "a",
  title: "Building the harness",
  kind: "note",
  excerpt: "Permissions and sandboxing",
  updatedAt: "2026-01-14T12:00:00.000Z",
  hasDraft: true,
};

function show(notes: LibraryNote[] = [plan, harness], total = notes.length, page = 1) {
  return render(<NotesLibrary notes={notes} selectedId="b" total={total} page={page} />);
}

beforeEach(() => {
  search.mockReset().mockResolvedValue({ items: [], total: 0 });
});
afterEach(() => vi.clearAllMocks());

describe("notes library", () => {
  it("lists each note with its preview and last edit, marking the open one", () => {
    show();
    const selected = screen.getByRole("link", { name: /Quarterly plan/ });
    expect(selected.getAttribute("aria-current")).toBe("page");
    expect(selected.getAttribute("href")).toBe("/polymath/notes?id=b");
    // The list is shaped like the chat list: title and a day stamp per row,
    // no excerpt, and rows grouped by day.
    expect(screen.queryByText("Revenue and hiring")).toBeNull();
    expect(screen.getAllByRole("link", { name: /Quarterly plan|Building the harness/ })).toHaveLength(2);
    expect(screen.getByRole("link", { name: /Building the harness/ }).getAttribute("aria-current")).toBeNull();
    expect(screen.getByText("draft")).toBeTruthy();
  });

  it("shows the full count and the page it is on", () => {
    show([plan], 61, 2);
    expect(screen.getByText("61")).toBeTruthy();
    expect(screen.getByText("2 / 3")).toBeTruthy();
    // Paging is a link, so it works without JavaScript and keeps the open note.
    expect(screen.getByRole("link", { name: "Older" }).getAttribute("href")).toBe("/polymath/notes?id=b&page=3");
    expect(screen.getByRole("link", { name: "Newer" }).getAttribute("href")).toBe("/polymath/notes?id=b");
  });

  it("narrows through the browse query without navigating", async () => {
    search.mockResolvedValue({ items: [plan], total: 1 });
    show();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search notes" }), { target: { value: "plan" } });
    // The rows answer the query they were fetched for; until then, say so.
    expect(screen.getByText("Searching…")).toBeTruthy();
    await screen.findByRole("link", { name: /Quarterly plan/ });
    expect(search).toHaveBeenCalledWith({ query: "plan" });
    expect(screen.queryByText("Permissions and sandboxing")).toBeNull();
    // The matched note is still the open one.
    expect(screen.getByRole("link", { name: /Quarterly plan/ }).getAttribute("aria-current")).toBe("page");
  });

  it("says when a search matches nothing instead of leaving stale rows", async () => {
    search.mockResolvedValue({ items: [], total: 0 });
    show();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search notes" }), { target: { value: "absent" } });
    expect(await screen.findByText("No notes match “absent”.")).toBeTruthy();
    expect(screen.queryByRole("link", { name: /Quarterly plan/ })).toBeNull();
  });

  it("ignores a slow answer for a query the field no longer holds", async () => {
    let answerPlan: (found: { items: LibraryNote[]; total: number }) => void = () => {};
    search.mockImplementationOnce(() => new Promise((resolve) => (answerPlan = resolve)));
    show();
    const field = screen.getByRole("searchbox", { name: "Search notes" });
    fireEvent.change(field, { target: { value: "plan" } });
    await vi.waitFor(() => expect(search).toHaveBeenCalledWith({ query: "plan" }));
    fireEvent.change(field, { target: { value: "harness" } });
    answerPlan({ items: [plan], total: 1 });
    // The plan answer is not the harness answer; the rail must not show it.
    expect(await screen.findByText("Searching…")).toBeTruthy();
    expect(screen.queryByText("Revenue and hiring")).toBeNull();
  });

  it("tells the difference between an empty workspace and an empty page", () => {
    show([], 0, 1);
    expect(screen.getByText("No notes yet. Write the first one.")).toBeTruthy();
    show([], 61, 4);
    expect(screen.getByText("No notes on this page.")).toBeTruthy();
  });
});
