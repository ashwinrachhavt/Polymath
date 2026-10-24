import { createElement as h, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * The results surface passes the page-parsed scope to BOTH search calls and
 * renders the coverage note from countMeaningUncoveredByState. Written when
 * the wiring landed: an earlier revision had the count with no consumer while
 * the checklist described its note as rendered UI. The split states are
 * named separately: pending is "not indexed yet" (no live job signal), failed
 * names the recorded failure without promising a retry across kinds.
 */

const auth = { userId: "u1", workspaceId: "w1", role: "owner" as const };
vi.mock("next/link", () => ({ default: (props: { href: string; children: ReactNode }) => h("a", { href: props.href }, props.children) }));
const { searchKnowledge, countMeaningUncoveredByState } = vi.hoisted(() => ({
  searchKnowledge: vi.fn(async (): Promise<{ hits: never[]; meaning: "ok" | "off" | "unconfigured" | "failed"; ms: number }> => ({ hits: [], meaning: "ok", ms: 1 })),
  countMeaningUncoveredByState: vi.fn(async () => ({ pending: 0, failed: 0 })),
}));
vi.mock("@/domains/knowledge/retrieval", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/domains/knowledge/retrieval")>();
  return { ...actual, searchKnowledge, countMeaningUncoveredByState };
});

import { Ranked, SearchResults } from "@/app/(workspace)/alfred/notes/search-results";

beforeEach(() => {
  searchKnowledge.mockClear();
  countMeaningUncoveredByState.mockClear();
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

    countMeaningUncoveredByState.mockResolvedValue({ pending: 3, failed: 0 });
    const ranked = await Ranked({
      auth,
      q: "quarterly",
      scope: { kinds: ["zettel"], filters: { provenance: "agent" } },
      hrefFor: (id: string) => `/x/${id}`,
    });
    const html = renderToStaticMarkup(ranked);
    expect(countMeaningUncoveredByState).toHaveBeenCalledWith(auth, { kinds: ["zettel"], filters: { provenance: "agent" } });
    expect(html).toContain("3 items in the selected filters are not meaning-searchable (3 not indexed yet)");
    countMeaningUncoveredByState.mockResolvedValue({ pending: 0, failed: 0 });
  });

  it("names the two uncovered states separately and never claims indexing is in progress", async () => {
    countMeaningUncoveredByState.mockResolvedValue({ pending: 0, failed: 2 });
    const failedOnly = renderToStaticMarkup(await Ranked({ auth, q: "x", hrefFor: (id: string) => id }));
    expect(failedOnly).toContain("(2 with a failed indexing pass)");
    expect(failedOnly).not.toContain("being indexed");

    countMeaningUncoveredByState.mockResolvedValue({ pending: 1, failed: 2 });
    const both = renderToStaticMarkup(await Ranked({ auth, q: "x", hrefFor: (id: string) => id }));
    expect(both).toContain("(1 not indexed yet, 2 with a failed indexing pass)");
    countMeaningUncoveredByState.mockResolvedValue({ pending: 0, failed: 0 });
  });

  it("renders no coverage note when the meaning leg is degraded or the count is zero", async () => {
    searchKnowledge.mockResolvedValueOnce({ hits: [], meaning: "failed" as const, ms: 1 });
    const degraded = renderToStaticMarkup(await Ranked({ auth, q: "x", hrefFor: (id: string) => id }));
    expect(degraded).toContain("Showing keyword matches only");
    expect(countMeaningUncoveredByState).not.toHaveBeenCalled();

    countMeaningUncoveredByState.mockResolvedValue({ pending: 0, failed: 0 });
    const covered = renderToStaticMarkup(await Ranked({ auth, q: "x", hrefFor: (id: string) => id }));
    expect(covered).not.toContain("not meaning-searchable");
  });
});
