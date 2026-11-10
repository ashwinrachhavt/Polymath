import { describe, expect, it, vi } from "vitest";

/*
 * Value: protects=the "Notes matching X" card's header opens the best match; fails_when=the header goes
 * back to bare /polymath/notes, which opens the latest note instead of a match; why_new=no card test
 * covered the header link; seam=pageNotes; no_claim=search ranking
 */

vi.mock("@/domains/knowledge/notes", () => ({ pageNotes: vi.fn() }));
vi.mock("@/domains/actions/queries", () => ({}));
vi.mock("@/domains/agents/queries", () => ({}));
vi.mock("@/domains/calendar/queries", () => ({}));
vi.mock("@/domains/knowledge/library", () => ({}));
vi.mock("@/domains/work/queries", () => ({}));

import { buildSurfaceCard } from "@/domains/supervisor/cards";
import { pageNotes } from "@/domains/knowledge/notes";

const auth = { userId: "u1", workspaceId: "w1", role: "owner" } as never;
const note = { id: "n1", title: "Plan", version: 2, updatedAt: new Date("2026-01-10T12:00:00Z") };

describe("note search card", () => {
  it("links its header to the first match", async () => {
    vi.mocked(pageNotes).mockResolvedValue({ items: [note], total: 1 } as never);
    const card = await buildSurfaceCard(auth, { kind: "open_note", query: "plan" } as never);
    expect(card.href).toBe("/polymath/notes?id=n1");
    expect(card.items[0].href).toBe("/polymath/notes?id=n1");
  });

  it("falls back to the notes page when nothing matches", async () => {
    vi.mocked(pageNotes).mockResolvedValue({ items: [], total: 0 } as never);
    const card = await buildSurfaceCard(auth, { kind: "open_note", query: "zzz" } as never);
    expect(card.href).toBe("/polymath/notes");
  });
});
