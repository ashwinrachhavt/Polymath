import { createElement as h, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { SearchHit, SearchResult } from "@/domains/knowledge/retrieval";

/*
 * Pins the search-connections wiring at the component level: the ranked
 * results surface attaches each hit's link-graph neighborhood (one batched
 * read) and the hit row renders it in plain words - source with its
 * supporting passage, out references, backlinks, "+N more" for the rest.
 */

vi.mock("next/link", () => ({ default: (props: { href: string; children: ReactNode }) => h("a", { href: props.href }, props.children) }));

// Fresh per test: Ranked attaches connections onto the hit objects in place.
const makeHit = (): SearchHit => ({
  id: "h1",
  title: "Claim card",
  kind: "zettel",
  updatedAt: new Date("2026-10-20T00:00:00Z"),
  score: 1,
  why: { keywordRank: 1, meaningRank: null, similarity: null, titleMatch: false },
  snippet: null,
});

const mocks = vi.hoisted(() => ({
  searchKnowledge: vi.fn(),
  countMeaningUncoveredByState: vi.fn(async () => ({ pending: 0, failed: 0 })),
  listHitConnections: vi.fn(async () => new Map()),
}));
vi.mock("@/domains/knowledge/retrieval", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/domains/knowledge/retrieval")>();
  return { ...actual, ...mocks };
});

import { Ranked } from "@/app/(workspace)/alfred/notes/search-results";

const auth = { userId: "u1", workspaceId: "w1", role: "owner" as const };
const hrefFor = (id: string) => `/alfred/notes?id=${id}`;

describe("Ranked connections wiring", () => {
  it("attaches the batched neighborhood and renders source, links, and citations", async () => {
    mocks.searchKnowledge.mockResolvedValueOnce({ hits: [makeHit()], meaning: "off" as const, ms: 1 } satisfies SearchResult);
    mocks.listHitConnections.mockResolvedValueOnce(new Map([["h1", {
      out: [
        { id: "d1", title: "Reference doc", kind: "document", linkType: "source", context: "The exact supporting passage." },
        { id: "n1", title: "Note A", kind: "note", linkType: "reference", context: null },
      ],
      in: [{ id: "n2", title: "Big essay", kind: "note", linkType: "reference", context: null }],
      outTotal: 3,
      inTotal: 1,
    }]]));
    const html = renderToStaticMarkup(await Ranked({ auth, q: "claim", hrefFor }));
    expect(mocks.listHitConnections).toHaveBeenCalledWith(auth, ["h1"]);
    expect(html).toContain('aria-label="Connections"');
    expect(html).toContain("From Reference doc");
    expect(html).toContain("The exact supporting passage.");
    expect(html).toContain("Links to Note A");
    expect(html).toContain("Cited by Big essay");
    expect(html).toContain("+1 more");
  });

  it("renders no connections line for an unconnected hit", async () => {
    mocks.searchKnowledge.mockResolvedValueOnce({ hits: [makeHit()], meaning: "off" as const, ms: 1 } satisfies SearchResult);
    mocks.listHitConnections.mockResolvedValueOnce(new Map([["h1", { out: [], in: [], outTotal: 0, inTotal: 0 }]]));
    const html = renderToStaticMarkup(await Ranked({ auth, q: "claim", hrefFor }));
    expect(html).toContain("Claim card");
    expect(html).not.toContain('aria-label="Connections"');
  });

  it("skips the read entirely when there are no hits", async () => {
    mocks.searchKnowledge.mockResolvedValueOnce({ hits: [], meaning: "off", ms: 1 } satisfies SearchResult);
    mocks.listHitConnections.mockClear();
    renderToStaticMarkup(await Ranked({ auth, q: "nothing", hrefFor }));
    expect(mocks.listHitConnections).not.toHaveBeenCalled();
  });
});
