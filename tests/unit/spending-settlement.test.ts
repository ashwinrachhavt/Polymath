import { describe, expect, it } from "vitest";
import { decideSettlement } from "@/domains/spending/settlement";

/*
 * Pure unit scope for the close rule (PR-5). The SQL aggregation that feeds
 * these facts is proven in tests/integration/spending-settlement.test.ts; what
 * this proves is the branch table itself:
 *
 *   usage events | priced events | settles
 *   -------------+---------------+--------------------------
 *   0            | 0             | 0, confirmed-zero
 *   n            | n             | priced sum, priced
 *   n            | < n           | reservation estimate, estimated
 *
 * The subtlety the table hides: a `confirmed-zero` event is PRICED — it
 * carries a resolved figure (zero), so it must not trip the estimate branch.
 * Only unknown cost (unpriced) does.
 */

const facts = (over: Partial<Parameters<typeof decideSettlement>[0]> = {}) => ({
  usageEvents: 2,
  pricedEvents: 2,
  pricedUsd: "0.300000",
  reservedUsd: "0.500000",
  ...over,
});

describe("decideSettlement", () => {
  it("settles a run with no usage events at a confirmed zero", () => {
    expect(decideSettlement(facts({ usageEvents: 0, pricedEvents: 0 }))).toEqual({
      actualUsd: "0.000000",
      state: "confirmed-zero",
    });
  });

  it("settles fully priced usage at the priced sum", () => {
    expect(decideSettlement(facts())).toEqual({ actualUsd: "0.300000", state: "priced" });
  });

  it("settles any unpriced usage at the reservation estimate, not the priced part", () => {
    // One priced event ($0.30) plus one unpriced: the estimate covers the
    // whole run, so $0.30 would understate and $0.30+$? is unknowable.
    expect(decideSettlement(facts({ pricedEvents: 1 }))).toEqual({
      actualUsd: "0.500000",
      state: "estimated",
    });
  });

  it("settles an entirely unpriced run at the reservation estimate", () => {
    expect(decideSettlement(facts({ pricedEvents: 0 }))).toEqual({
      actualUsd: "0.500000",
      state: "estimated",
    });
  });

  it("treats a confirmed-zero event as priced, not as unknown cost", () => {
    // The event's figure is known and zero — the priced branch wins even
    // though the sum is zero. Only unpriced rows mean "unknown".
    expect(decideSettlement(facts({ pricedUsd: "0.000000" }))).toEqual({
      actualUsd: "0.000000",
      state: "priced",
    });
  });

  it("keeps the priced branch at the exact boundary pricedEvents === usageEvents", () => {
    // The estimate must never fire when every event carries a figure, even
    // when the actuals came in above the estimate.
    expect(decideSettlement(facts({ pricedUsd: "9.999999" }))).toEqual({
      actualUsd: "9.999999",
      state: "priced",
    });
  });
});
