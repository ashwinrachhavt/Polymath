import { createElement as h, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * The notes page is one always-editable note. Bare /polymath/notes renders the
 * most recent note with content in place (no redirect, so no second render)
 * and asks the client to put its id in the URL. A retired ?stack= opens its
 * last note; the other retired view params (board, mode, layout, q) are ignored.
 */

vi.mock("next/server", () => ({ connection: async () => undefined }));
const auth = { userId: "u1", workspaceId: "w1", role: "owner" as const };
vi.mock("@/lib/auth", () => ({ getAuthContext: vi.fn(async () => auth) }));
const now = new Date();
const noteRow = {
  id: "b",
  title: "Quarterly plan",
  kind: "note",
  tags: [],
  version: 1,
  content: null,
  draft: null,
  createdAt: now,
  updatedAt: now,
};
vi.mock("@/domains/knowledge/notes", () => ({
  listNotes: vi.fn(async () => [] as { id: string; excerpt: string | null }[]),
  getNote: vi.fn(async () => null as unknown),
  listNoteVersions: vi.fn(async () => []),
  listNoteOutlinks: vi.fn(async () => []),
  listNoteBacklinks: vi.fn(async () => []),
  extractWikiLinkTitles: vi.fn(() => [] as string[]),
  getLinkPreviews: vi.fn(async () => []),
}));
vi.mock("@/domains/knowledge/note-comments", () => ({ listNoteComments: vi.fn(async () => []) }));
vi.mock("@/domains/knowledge/relations", () => ({ relatedNotes: vi.fn(async () => []) }));
vi.mock("@/app/(workspace)/polymath/notes/note-editor", () => ({
  NewNoteButton: () => h("button", null, "New note"),
  NoteEditor: (props: { noteId: string; missingLinkTitles: string[] }) =>
    h("div", { "data-testid": "editor", "data-note": props.noteId, "data-missing": props.missingLinkTitles.join(";") }),
}));
vi.mock("@/app/(workspace)/polymath/notes/notebook-workspace", () => ({
  NotebookWorkspace: (props: { children: ReactNode; replaceUrl?: string }) =>
    h("div", { "data-replace-url": props.replaceUrl }, props.children),
  FindNoteButton: () => h("button", null, "Find a note"),
}));

import { NotesSurface } from "@/app/(workspace)/polymath/notes/page";
import { extractWikiLinkTitles, getLinkPreviews, getNote, listNotes } from "@/domains/knowledge/notes";

const params = (raw: Record<string, string>) => Promise.resolve(raw);

beforeEach(() => {
  vi.mocked(listNotes).mockReset().mockResolvedValue([]);
  vi.mocked(getNote).mockReset().mockResolvedValue(null);
});

describe("notes page", () => {
  it("bare /polymath/notes renders the latest note with content in place", async () => {
    vi.mocked(listNotes).mockResolvedValue([
      { id: "a", excerpt: "" },
      { id: "b", excerpt: "text" },
    ] as never);
    vi.mocked(getNote).mockResolvedValue(noteRow as never);
    const html = renderToStaticMarkup(await NotesSurface({ searchParams: params({}) }));
    expect(html).toContain('data-note="b"');
    expect(html).toContain('data-replace-url="/polymath/notes?id=b"');
    expect(getNote).toHaveBeenCalledWith(auth, "b");
    // Only plain notes: a bare visit never opens a zettel.
    expect(listNotes).toHaveBeenCalledWith(auth, 25, ["note"]);
  });

  it("a note opened by id keeps its URL", async () => {
    vi.mocked(getNote).mockResolvedValue(noteRow as never);
    const html = renderToStaticMarkup(await NotesSurface({ searchParams: params({ id: "b" }) }));
    expect(html).not.toContain("data-replace-url");
    expect(listNotes).not.toHaveBeenCalled();
  });

  it("a retired ?stack= opens its last note", async () => {
    vi.mocked(getNote).mockResolvedValue(noteRow as never);
    const html = renderToStaticMarkup(await NotesSurface({ searchParams: params({ stack: "a,b" }) }));
    expect(getNote).toHaveBeenCalledWith(auth, "b");
    expect(html).toContain('data-replace-url="/polymath/notes?id=b"');
  });

  it("a missing note offers the finder and a new note, in words that fit any device", async () => {
    const html = renderToStaticMarkup(await NotesSurface({ searchParams: params({ id: "gone" }) }));
    expect(html).toContain("That note is not here");
    expect(html).toContain("Find a note");
    expect(html).not.toMatch(/Cmd|Ctrl/);
  });

  it("retired view params are ignored", async () => {
    vi.mocked(getNote).mockResolvedValue(noteRow as never);
    const retiredParams: Record<string, string>[] = [{ board: "1", mode: "list" }, { layout: "kanban" }, { q: "plan" }];
    for (const retired of retiredParams) {
      const html = renderToStaticMarkup(await NotesSurface({ searchParams: params({ id: "b", ...retired }) }));
      expect(html).toContain('data-note="b"');
    }
  });

  it("names as missing only linked titles with no note at this render, never the note itself", async () => {
    vi.mocked(getNote).mockResolvedValue(noteRow as never);
    vi.mocked(extractWikiLinkTitles).mockReturnValueOnce(["Alpha", "Nowhere|Shown", "quarterly plan"]);
    vi.mocked(getLinkPreviews).mockResolvedValueOnce([{ id: "a1", title: "alpha", firstParagraph: "" }]);
    const html = renderToStaticMarkup(await NotesSurface({ searchParams: params({ id: "b" }) }));
    expect(html).toContain('data-missing="nowhere"');
  });

  it("never names a title past the preview lookup's cap as missing", async () => {
    vi.mocked(getNote).mockResolvedValue(noteRow as never);
    const titles = Array.from({ length: 55 }, (_, i) => `Link ${i + 1}`);
    vi.mocked(extractWikiLinkTitles).mockReturnValueOnce(titles);
    // Link 52 is a real note, but the capped lookup never asked for it.
    vi.mocked(getLinkPreviews).mockResolvedValueOnce(
      titles
        .slice(0, 50)
        .filter((t) => t !== "Link 2")
        .map((title, i) => ({ id: `n${i}`, title, firstParagraph: "" })),
    );
    const html = renderToStaticMarkup(await NotesSurface({ searchParams: params({ id: "b" }) }));
    expect(html).toContain('data-missing="link 2"');
    expect(html).not.toContain("link 52");
  });

  it("with no notes at all, offers a new note instead of redirecting", async () => {
    const html = renderToStaticMarkup(await NotesSurface({ searchParams: params({ board: "1" }) }));
    expect(html).toContain("New note");
    expect(html).not.toContain('data-testid="editor"');
  });
});
