import { describe, expect, it } from "vitest";
import {
  rateToMicroPerMillion,
  reportedCostFromUsage,
  resolvePricing,
  tokensFromUsage,
  type PricingState,
  type RateCardRates,
} from "@/domains/spending/pricing";

/*
 * The pricing resolver's whole contract, no database: precedence across the
 * five states, exact decimal arithmetic, cache-rate fallback, and hostile
 * usage payloads from the eve bridge.
 */

const card = (over: Partial<RateCardRates> = {}): RateCardRates => ({
  id: "card_1",
  inputPerMillion: "1.500000",
  outputPerMillion: "6.000000",
  cacheReadPerMillion: null,
  cacheWritePerMillion: null,
  ...over,
});

const tokens = { input: 1_000_000, output: 500_000, cacheRead: 0, cacheWrite: 0 };

describe("resolvePricing precedence", () => {
  it("prices provider-reported above everything, without a card", () => {
    const priced = resolvePricing({
      provider: "openai",
      model: "m",
      tokens,
      reportedCostUsd: "0.42",
      rateCard: card(),
    });
    expect(priced).toEqual({ usd: "0.42", state: "provider-reported" });
  });

  it("prices estimated from the rate card when nothing is reported", () => {
    const priced = resolvePricing({ provider: "openai", model: "m", tokens, rateCard: card() });
    expect(priced).toEqual({ usd: "4.500000", state: "estimated", rateCardId: "card_1" });
  });

  it("prices confirmed-zero when no tokens were consumed, card or not", () => {
    const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    expect(resolvePricing({ provider: "openai", model: "m", tokens: zero })).toEqual({
      usd: "0.000000",
      state: "confirmed-zero",
    });
    expect(resolvePricing({ provider: "openai", model: "m", tokens: zero, rateCard: card() }).state).toBe(
      "confirmed-zero",
    );
  });

  it("prices unpriced when tokens exist but no card does", () => {
    const priced = resolvePricing({ provider: "openai", model: "m", tokens });
    expect(priced).toEqual({ usd: null, state: "unpriced" });
  });

  it("prices unpriced rather than guessing from a corrupt card", () => {
    const corrupt = card({ inputPerMillion: "not-a-number" });
    expect(resolvePricing({ provider: "openai", model: "m", tokens, rateCard: corrupt }).state).toBe("unpriced");
  });

  it("treats an empty reported cost as absent and falls through", () => {
    const priced = resolvePricing({ provider: "openai", model: "m", tokens, reportedCostUsd: "  ", rateCard: card() });
    expect(priced.state).toBe("estimated");
  });

  it("never returns reconciled: that state is reserved for manual writes", () => {
    // Pins the union: adding a state here is a contract change the resolver
    // must answer for, not one that compiles silently.
    const allStates: PricingState[] = ["provider-reported", "estimated", "confirmed-zero", "unpriced", "reconciled"];
    const resolved = [
      resolvePricing({ provider: "p", model: "m", tokens, reportedCostUsd: "1" }),
      resolvePricing({ provider: "p", model: "m", tokens, rateCard: card() }),
      resolvePricing({ provider: "p", model: "m", tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }),
      resolvePricing({ provider: "p", model: "m", tokens }),
      resolvePricing({ provider: "p", model: "m", tokens, rateCard: card({ inputPerMillion: "x" }) }),
    ];
    for (const priced of resolved) {
      expect(allStates).toContain(priced.state);
      expect(priced.state).not.toBe("reconciled");
    }
  });
});

describe("resolvePricing arithmetic", () => {
  it("sums all four token classes at their rates", () => {
    const priced = resolvePricing({
      provider: "openai",
      model: "m",
      tokens: { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000 },
      rateCard: card({
        inputPerMillion: "1.000000",
        outputPerMillion: "2.000000",
        cacheReadPerMillion: "0.100000",
        cacheWritePerMillion: "0.200000",
      }),
    });
    expect(priced.usd).toBe("3.300000");
  });

  it("prices cache tokens at the input rate when the card has no cache rate", () => {
    const priced = resolvePricing({
      provider: "openai",
      model: "m",
      tokens: { input: 0, output: 0, cacheRead: 2_000_000, cacheWrite: 1_000_000 },
      rateCard: card({ inputPerMillion: "1.000000" }),
    });
    expect(priced.usd).toBe("3.000000");
  });

  it("rounds half-up to micro-dollars at the boundary", () => {
    // 1.5 micro-USD exactly: half-up goes to 2.
    const halfUp = resolvePricing({
      provider: "openai",
      model: "m",
      tokens: { input: 1_500_000, output: 0, cacheRead: 0, cacheWrite: 0 },
      rateCard: card({ inputPerMillion: "0.000001" }),
    });
    expect(halfUp.usd).toBe("0.000002");
    // 0.999999 micro-USD rounds down to zero — and stays a ledger string.
    const down = resolvePricing({
      provider: "openai",
      model: "m",
      tokens: { input: 499_999, output: 0, cacheRead: 0, cacheWrite: 0 },
      rateCard: card({ inputPerMillion: "0.000001" }),
    });
    expect(down.usd).toBe("0.000000");
  });

  it("stays exact where a float would drift", () => {
    // 3 × 0.1 with BigInt is 0.3 exactly, where Number math gives
    // 0.30000000000000004.
    const priced = resolvePricing({
      provider: "openai",
      model: "m",
      tokens: { input: 3_000_000, output: 0, cacheRead: 0, cacheWrite: 0 },
      rateCard: card({ inputPerMillion: "0.100000" }),
    });
    expect(priced.usd).toBe("0.300000");
  });
});

describe("rateToMicroPerMillion", () => {
  it.each([
    ["1.5", BigInt(1_500_000)],
    ["12", BigInt(12_000_000)],
    ["0.000001", BigInt(1)],
    ["0.257400", BigInt(257_400)],
  ])("parses %s to micro-units", (rate, micros) => {
    expect(rateToMicroPerMillion(rate)).toBe(micros);
  });

  it.each(["1.0000005", "-1", "abc", "", "1e3", ".5"])("rejects %s", (rate) => {
    expect(rateToMicroPerMillion(rate)).toBeNull();
  });
});

describe("tokensFromUsage", () => {
  it("reads the four token classes and floors partial counts", () => {
    expect(tokensFromUsage({ inputTokens: 10.9, outputTokens: "42", cacheReadTokens: 0, cacheWriteTokens: 7 })).toEqual(
      { input: 10, output: 42, cacheRead: 0, cacheWrite: 7 },
    );
  });

  it("prices hostile fields as zero, never NaN", () => {
    expect(
      tokensFromUsage({ inputTokens: -5, outputTokens: { a: 1 }, cacheReadTokens: Number.NaN, cacheWriteTokens: null }),
    ).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });
});

describe("reportedCostFromUsage", () => {
  it("accepts a finite number or a decimal string", () => {
    expect(reportedCostFromUsage({ costUsd: 0.42 })).toBe("0.42");
    expect(reportedCostFromUsage({ costUsd: "0.42" })).toBe("0.42");
    expect(reportedCostFromUsage({ costUsd: 0 })).toBe("0");
  });

  it("treats negative, malformed, and missing costs as absent", () => {
    expect(reportedCostFromUsage({ costUsd: -1 })).toBeNull();
    expect(reportedCostFromUsage({ costUsd: "abc" })).toBeNull();
    expect(reportedCostFromUsage({})).toBeNull();
  });
});
