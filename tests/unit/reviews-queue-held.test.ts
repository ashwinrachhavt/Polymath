import { describe, expect, it } from "vitest";
import { holdDecidedCard, mergeHeldDecidedCards, type HeldCards } from "@/app/(workspace)/reviews/held-cards";
import type { QueueCardData } from "@/app/(workspace)/reviews/reviews-queue";

/*
 * The merge behind the queue's retained decided cards: a decided card whose
 * proposal left the filtered server list keeps rendering (its refusal or
 * import outcome must not unmount as it arrives), while anything the server
 * list contains - at ANY version - is the current truth and never masked.
 */
const card = (id: string, version: number, status = "pending"): QueueCardData => ({
  id,
  version,
  title: `Proposal ${id}`,
  capability: "canva.design.import",
  riskClass: "external_write",
  status,
  expectedEffect: "Creates one new Canva design.",
  accountAlias: `alias-${id}`,
  dedupeKey: null,
  createdAt: "2026-10-26T00:00:00.000Z",
  expiresAt: null,
  decidedAt: null,
  // The merge never reads the remaining fields; the card type wants them.
  latestRevision: null,
  reviews: [],
  outcome: null,
  designUrl: null,
  flags: null,
} as unknown as QueueCardData);

describe("mergeHeldDecidedCards", () => {
  it("passes the listed cards through when nothing is held", () => {
    const listed = [card("a", 1)];
    expect(mergeHeldDecidedCards(listed, {})).toBe(listed);
  });

  it("renders a held decided card whose proposal left the server list", () => {
    const held: HeldCards = {};
    holdDecidedCard(held, card("a", 1), "approved");
    const merged = mergeHeldDecidedCards([], held);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ id: "a", version: 1, status: "approved" });
    expect(merged[0]!.decidedAt).toBeTruthy();
  });

  it("never duplicates a card the server list still contains", () => {
    const held: HeldCards = {};
    holdDecidedCard(held, card("a", 1), "approved");
    const merged = mergeHeldDecidedCards([card("a", 1, "approved")], held);
    expect(merged).toHaveLength(1);
  });

  it("a fresh version in the server list is the current truth: the old snapshot never masks it", () => {
    const held: HeldCards = {};
    holdDecidedCard(held, card("a", 1), "approved");
    // The same proposal id back in the list at version 2 (a re-proposed
    // revision): only the fresh card renders.
    const merged = mergeHeldDecidedCards([card("a", 2)], held);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ id: "a", version: 2, status: "pending" });
  });

  it("holds approved and rejected decisions alike, appended after the listed cards", () => {
    const held: HeldCards = {};
    holdDecidedCard(held, card("a", 1), "approved");
    holdDecidedCard(held, card("b", 3), "rejected");
    const merged = mergeHeldDecidedCards([card("c", 1)], held);
    expect(merged.map((item) => item.id)).toEqual(["c", "a", "b"]);
    expect(merged[2]).toMatchObject({ status: "rejected" });
  });
});
