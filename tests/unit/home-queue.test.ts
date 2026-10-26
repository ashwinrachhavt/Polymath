import { describe, expect, it } from "vitest";
import { rankHomeQueue, type HomeQueueCard } from "@/domains/home/queue";

/*
 * ASH-309: the homepage's opinion about what deserves the owner's judgment
 * first. The order is the product thesis, so it is pinned here exactly.
 */

function card(partial: Partial<HomeQueueCard>): HomeQueueCard {
  return {
    origin: "agent",
    id: partial.id ?? Math.random().toString(36).slice(2),
    title: "t",
    effect: "e",
    reason: null,
    riskClass: "read",
    expiresAt: null,
    createdAt: new Date("2026-10-25T12:00:00Z"),
    href: "#",
    decision: { kind: "capture" },
    ...partial,
  };
}

const NOW = new Date("2026-10-25T18:00:00Z");

describe("rankHomeQueue", () => {
  it("decisions with a live deadline come first, soonest expiry first", () => {
    const soon = card({ id: "soon", expiresAt: new Date("2026-10-25T19:00:00Z") });
    const later = card({ id: "later", expiresAt: new Date("2026-10-26T19:00:00Z") });
    const timeless = card({ id: "timeless", riskClass: "prohibited" });
    expect(rankHomeQueue([timeless, later, soon], NOW).map((c) => c.id)).toEqual(["soon", "later", "timeless"]);
  });

  it("an expired deadline stops outranking - it is already decided by default", () => {
    const expired = card({ id: "expired", expiresAt: new Date("2026-10-25T17:00:00Z") });
    const risky = card({ id: "risky", riskClass: "sensitive_write" });
    expect(rankHomeQueue([expired, risky], NOW).map((c) => c.id)).toEqual(["risky", "expired"]);
  });

  it("then risk: more judgment at stake ranks ahead", () => {
    const read = card({ id: "read", riskClass: "read" });
    const sensitive = card({ id: "sensitive", riskClass: "sensitive_write" });
    const write = card({ id: "write", riskClass: "external_write" });
    expect(rankHomeQueue([read, sensitive, write], NOW).map((c) => c.id)).toEqual(["sensitive", "write", "read"]);
  });

  it("then newest first, and every tie resolves deterministically", () => {
    const older = card({ id: "b", createdAt: new Date("2026-10-25T10:00:00Z") });
    const newer = card({ id: "a", createdAt: new Date("2026-10-25T11:00:00Z") });
    const twin = card({ id: "c", createdAt: new Date("2026-10-25T11:00:00Z") });
    expect(rankHomeQueue([older, twin, newer], NOW).map((c) => c.id)).toEqual(["a", "c", "b"]);
    // stable across input order: the homepage never reshuffles between renders
    expect(rankHomeQueue([twin, older, newer], NOW).map((c) => c.id)).toEqual(["a", "c", "b"]);
  });
});
