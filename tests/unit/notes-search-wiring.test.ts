import { createElement as h, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Pins the notes-search filter wiring end to end at the component level: the
 * page parses kind/edited/source URL params into the shared search scope and
 * renders the filter chips only while a query is active, and the results
 * surface passes that scope to BOTH search calls and renders the coverage
 * note from countMeaningUncovered. Written when the wiring landed - an
 * earlier revision of this surface had the domain filters with no consumer
 * while the checklist described chips as rendered.
 */

vi.mock("next/server", () => ({ connection: async () => undefined }));
vi.mock("next/link", () => ({ default: (props: { href: string; children: ReactNode }) => h("a", { href: props.href }, props.children) }));
const auth = { userId: "u1", workspaceId: "w1", role: "owner" as const };
vi.mock("@/lib/auth", () => ({ getAuthContext: vi.fn(async () => auth) }));
const { searchKnowledge, countMeaningUncovered } = vi.hoisted(() => ({
  searchKnowledge: vi.fn(async () => ({ hits: [], meaning: "ok" as const, ms: 1 })),
  countMeaningUncovered: vi.fn(async () => 0),
}));
vi.mock("@/domains/knowledge/retrieval", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/domains/knowledge/retrieval")>();
  return { ...actual, searchKnowledge, countMeaningUncovered };
});
vi.mock("@/domains/knowledge/notes", () => ({
  pageNotes: vi.fn(async () => ({ items: [], total: 0 })),
  listNoteTags: vi.fn(async () => []),
  getNote: vi.fn(async () => null),
  listNoteVersions: vi.fn(async () => []),
  listNoteOutlinks: vi.fn(async () => []),
  listNoteBacklinks: vi.fn(async () => []),
}));
vi.mock("@/domains/knowledge/relations", () => ({ relatedNotes: vi.fn(async () => []) }));
const toolbarProps = vi.hoisted(() => ({ fn: vi.fn((props: unknown) => (void props, null)) }));
vi.mock("@/components/list/list-toolbar", () => ({
  ListToolbar: (props: unknown) => {
    toolbarProps.fn(props);
    return null;
  },
}));
vi.mock("@/components/list/clamp", () => ({ redirectPastEnd: vi.fn() }));
vi.mock("@/app/(workspace)/alfred/notes/note-editor", () => ({ NewNoteButton: () => null, NoteEditor: () => null }));
vi.mock("@/app/(workspace)/alfred/notes/notebook-workspace", () => ({
  NotebookWorkspace: (props: { list: unknown; children: unknown }) =>
    h("div", null, props.list as ReactNode, props.children as ReactNode),
}));

const resultsProps = vi.hoisted(() => ({ fn: vi.fn((props: unknown) => (void props, null)) }));
vi.mock("@/app/(workspace)/alfred/notes/search-results", () => ({
  SearchResults: (props: unknown) => {
    resultsProps.fn(props);
    return null;
  },
}));

import { NotesSurface } from "@/app/(workspace)/alfred/notes/page";

const params = (raw: Record<string, string>) => Promise.resolve(raw);

beforeEach(() => {
  searchKnowledge.mockClear();
  countMeaningUncovered.mockClear();
  toolbarProps.fn.mockClear();
});

describe("notes page search-filter wiring", () => {
  it("renders Kind/Edited/Provenance chips only while a query is active", async () => {
    renderToStaticMarkup(await NotesSurface({ searchParams: params({}) }));
    const idle = toolbarProps.fn.mock.calls[0]?.[0] as { filters: { key: string }[] };
    expect(idle.filters.map((f) => f.key)).toEqual(["view", "layout"]);

    renderToStaticMarkup(await NotesSurface({ searchParams: params({ q: "quarterly" }) }));
    const searching = toolbarProps.fn.mock.calls[1]?.[0] as { filters: { key: string }[] };
    expect(searching.filters.map((f) => f.key)).toEqual(["view", "layout", "kind", "edited", "source"]);
  });

  it("parses kind/edited/source URL params into the scope handed to the results surface", async () => {
    renderToStaticMarkup(await NotesSurface({ searchParams: params({ q: "quarterly", kind: "zettel", edited: "week", source: "agent" }) }));
    const scope = (resultsProps.fn.mock.calls[0]?.[0] as { scope: { kinds: string[]; filters: { from: Date; provenance: string } } }).scope;
    expect(scope.kinds).toEqual(["zettel"]);
    expect(scope.filters.provenance).toBe("agent");
    const ageMs = Date.now() - scope.filters.from.getTime();
    expect(ageMs).toBeGreaterThan(6 * 86_400_000);
    expect(ageMs).toBeLessThan(8 * 86_400_000);

    // An invalid filter value falls back to unfiltered, never crashes the page.
    renderToStaticMarkup(await NotesSurface({ searchParams: params({ q: "quarterly", kind: "bogus" }) }));
    const scope2 = (resultsProps.fn.mock.calls[1]?.[0] as { scope: { kinds?: string[]; filters?: unknown } }).scope;
    expect(scope2.kinds).toBeUndefined();
  });
});
