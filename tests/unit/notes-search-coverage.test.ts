import { createElement as h, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * The results surface passes the page-parsed scope to BOTH search calls and
 * renders the coverage note from countMeaningUncovered. Written when the
 * wiring landed: an earlier revision had countMeaningUncovered with no
 * consumer while the checklist described its note as rendered UI.
 */

const auth = { userId: "u1", workspaceId: "w1", role: "owner" as const };
vi.mock("next/link", () => ({ default: (props: { href: string; children: ReactNode }) => h("a", { href: props.href }, props.children) }));
const { searchKnowledge, countMeaningUncovered } = vi.hoisted(() => ({
  searchKnowledge: vi.fn(async (): Promise<{ hits: never[]; meaning: "ok" | "off" | "unconfigured" | "failed"; ms: number }> => ({ hits: [], meaning: "ok", ms: 1 })),
  countMeaningUncovered: vi.fn(async () => 0),
}));
vi.mock("@/domains/knowledge/retrieval", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/domains/knowledge/retrieval")>();
  return { ...actual, searchKnowledge, countMeaningUncovered };
});

import { Ranked, SearchResults } from "@/app/(workspace)/alfred/notes/search-results";

beforeEach(() => {
  searchKnowledge.mockClear();
  countMeaningUncovered.mockClear();
});

describe("notes search results coverage wiring", () => {
  it("passes the scope to both search calls and the coverage count, and renders the note", async () => {
    const element = await SearchResults({
      auth,
      q: "quarterly",
      scope: { kinds: ["zettel"], filters: { from: new Date("2026-10-22T00:00:00Z"), provenance: "agent" } },
      hrefFor: (id: string) => `/x/${id}`,
    });
    renderToStaticMarkup(element);
    expect(searchKnowledge).toHaveBeenCalledWith(auth, expect.objectContaining({ kinds: ["zettel"], filters: expect.objectContaining({ provenance: "agent" }) }));

    countMeaningUncovered.mockResolvedValue(3);
    const ranked = await Ranked({
      auth,
      q: "quarterly",
      scope: { kinds: ["zettel"], filters: { provenance: "agent" } },
      hrefFor: (id: string) => `/x/${id}`,
    });
    const html = renderToStaticMarkup(ranked);
    expect(countMeaningUncovered).toHaveBeenCalledWith(auth, { kinds: ["zettel"], filters: { provenance: "agent" } });
    expect(html).toContain("3 items in the selected filters are not meaning-searchable");
    countMeaningUncovered.mockResolvedValue(0);
  });

  it("renders no coverage note when the meaning leg is degraded or the count is zero", async () => {
    searchKnowledge.mockResolvedValueOnce({ hits: [], meaning: "failed" as const, ms: 1 });
    const degraded = renderToStaticMarkup(await Ranked({ auth, q: "x", hrefFor: (id: string) => id }));
    expect(degraded).toContain("Showing keyword matches only");
    expect(countMeaningUncovered).not.toHaveBeenCalled();

    countMeaningUncovered.mockResolvedValue(0);
    const covered = renderToStaticMarkup(await Ranked({ auth, q: "x", hrefFor: (id: string) => id }));
    expect(covered).not.toContain("not meaning-searchable");
  });
});
