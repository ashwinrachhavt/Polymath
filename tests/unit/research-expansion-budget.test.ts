import { describe, expect, it } from "vitest";
import {
  DEEP_DIVE_MAX_HOPS,
  budgetOf,
} from "@/domains/knowledge/research-expansion";

/*
 * The deep-dive budget (ASH-293) is the part that must survive refactors: a hop
 * counter that can go negative, or a cap a caller can raise, turns "bounded
 * research" into an unbounded crawl that only looks bounded.
 */

describe("research budget", () => {
  it("reports remaining hops as a floor at zero, never negative", () => {
    expect(budgetOf({ hopsUsed: 3, callsUsed: 0 }).hopsRemaining).toBe(DEEP_DIVE_MAX_HOPS - 3);
    expect(budgetOf({ hopsUsed: 99, callsUsed: 0 }).hopsRemaining).toBe(0);
  });

  it("cannot raise the hop cap above the product's own limit", () => {
    expect(budgetOf({ hopsUsed: 0, callsUsed: 0, hopsMax: 99 }).hopsMax).toBe(DEEP_DIVE_MAX_HOPS);
  });

  it("lets a run narrow the cap", () => {
    expect(budgetOf({ hopsUsed: 0, callsUsed: 0, hopsMax: 2 }).hopsMax).toBe(2);
    expect(budgetOf({ hopsUsed: 0, callsUsed: 0, hopsMax: 2 }).hopsRemaining).toBe(2);
  });

  it("distinguishes an unset call cap from a zero one", () => {
    // Null means "no cap set"; zero is a real cap that stops before any search.
    expect(budgetOf({ hopsUsed: 0, callsUsed: 0 }).callsMax).toBeNull();
    expect(budgetOf({ hopsUsed: 0, callsUsed: 0, callsMax: 0 }).callsMax).toBe(0);
  });

  it("carries the calls already spent into the report", () => {
    expect(budgetOf({ hopsUsed: 1, callsUsed: 2, callsMax: 5 }).callsUsed).toBe(2);
  });
});
