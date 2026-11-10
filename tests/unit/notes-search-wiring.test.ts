import { createElement as h, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * The notes page is one always-editable note. Bare /polymath/notes opens the
 * most recent note with content, and the retired view params (board, mode,
 * stack, layout, q) are accepted and ignored.
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
  NoteEditor: (props: { noteId: string }) => h("div", { "data-testid": "editor", "data-note": props.noteId }),
}));
vi.mock("@/app/(workspace)/polymath/notes/notebook-workspace", () => ({
  NotebookWorkspace: (props: { children: ReactNode }) => h("div", null, props.children),
}));

import { NotesSurface } from "@/app/(workspace)/polymath/notes/page";
import { getNote, listNotes } from "@/domains/knowledge/notes";

const params = (raw: Record<string, string>) => Promise.resolve(raw);

beforeEach(() => {
  vi.mocked(listNotes).mockReset().mockResolvedValue([]);
  vi.mocked(getNote).mockReset().mockResolvedValue(null);
});

describe("notes page", () => {
  it("bare /polymath/notes redirects to the latest note with content", async () => {
    vi.mocked(listNotes).mockResolvedValue([
      { id: "a", excerpt: "" },
      { id: "b", excerpt: "text" },
    ] as never);
    await expect(NotesSurface({ searchParams: params({}) })).rejects.toMatchObject({
      digest: expect.stringContaining("/polymath/notes?id=b"),
    });
    expect(listNotes).toHaveBeenCalledWith(auth, 25);
  });

  it("retired view params are ignored", async () => {
    vi.mocked(getNote).mockResolvedValue(noteRow as never);
    const retiredParams: Record<string, string>[] = [
      { board: "1", mode: "list" },
      { stack: "x" },
      { layout: "kanban" },
      { q: "plan" },
    ];
    for (const retired of retiredParams) {
      const html = renderToStaticMarkup(await NotesSurface({ searchParams: params({ id: "b", ...retired }) }));
      expect(html).toContain('data-note="b"');
    }
  });

  it("with no notes at all, offers a new note instead of redirecting", async () => {
    const html = renderToStaticMarkup(await NotesSurface({ searchParams: params({ board: "1" }) }));
    expect(html).toContain("New note");
    expect(html).not.toContain('data-testid="editor"');
  });
});
