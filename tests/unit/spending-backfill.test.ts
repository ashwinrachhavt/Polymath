import { describe, expect, it, vi } from "vitest";
import type { RateCardRates } from "@/domains/spending/pricing";
import { planUsagePricingStamps, sumUsd, type BackfillCandidate } from "@/domains/spending/backfill";

/*
 * The backfill's planner is the only decision-maker in the script, so it is
 * pure and tested without a database: every pricing state the resolver can
 * answer with, the no-provider shortcut that must not query a card, and the
 * report's decimal-string money arithmetic. The SQL side (candidate
 * selection, guarded writes, the ledger-identical summary) is proven in the
 * integration suite against real Postgres.
 */

vi.mock("@/lib/db", () => ({ db: {} }));

const card = (overrides: Partial<RateCardRates> = {}): RateCardRates => ({
  id: "card-1",
  inputPerMillion: "1.000000",
  outputPerMillion: "5.000000",
  cacheReadPerMillion: "0.050000",
  cacheWritePerMillion: null,
  ...overrides,
});

const candidate = (overrides: Partial<BackfillCandidate> = {}): BackfillCandidate => ({
  id: "event-1",
  workspaceId: "ws-1",
  data: { inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 500_000 },
  createdAt: new Date("2026-10-01T12:00:00Z"),
  model: "gpt-5.4-mini",
  ...overrides,
});

describe("planUsagePricingStamps", () => {
  it("prices from the card effective at the event's own timestamp", async () => {
    const ats: Date[] = [];
    const decisions = await planUsagePricingStamps([candidate()], async (_ws, provider, model, at) => {
      ats.push(at);
      expect(provider).toBe("openai");
      expect(model).toBe("gpt-5.4-mini");
      return card();
    });
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toEqual({
      id: "event-1",
      workspaceId: "ws-1",
      pricing: { usd: "1.525000", state: "estimated", rateCardId: "card-1" },
    });
    expect(ats).toEqual([new Date("2026-10-01T12:00:00Z")]);
  });

  it("never queries a card for a model outside the catalog", async () => {
    const decisions = await planUsagePricingStamps([candidate({ model: "claude-hive-x" })], async () => {
      throw new Error("card lookup must not run for an unknown model");
    });
    expect(decisions[0]?.pricing).toEqual({ usd: null, state: "unpriced" });
  });

  it("never queries a card when the run has no frozen model", async () => {
    const decisions = await planUsagePricingStamps([candidate({ model: null })], async () => {
      throw new Error("card lookup must not run for a missing model");
    });
    expect(decisions[0]?.pricing).toEqual({ usd: null, state: "unpriced" });
  });

  it("reads a tokenless event as a known zero, with or without a card", async () => {
    const withoutCard = await planUsagePricingStamps([candidate({ data: {} })], async () => null);
    const withCard = await planUsagePricingStamps([candidate({ data: {} })], async () => card());
    expect(withoutCard[0]?.pricing).toEqual({ usd: "0.000000", state: "confirmed-zero" });
    expect(withCard[0]?.pricing).toEqual({ usd: "0.000000", state: "confirmed-zero" });
  });

  it("reads a null payload as zero tokens — the extraction contract prices absent fields at zero", async () => {
    const decisions = await planUsagePricingStamps([candidate({ data: null })], async () => null);
    expect(decisions[0]?.pricing).toEqual({ usd: "0.000000", state: "confirmed-zero" });
  });

  it("keeps a provider-reported cost ahead of any estimate", async () => {
    const decisions = await planUsagePricingStamps([candidate({ data: { costUsd: "0.10" } })], async () => card());
    expect(decisions[0]?.pricing).toEqual({ usd: "0.10", state: "provider-reported" });
  });

  it("treats an unparseable card as unusable, pricing the event unpriced", async () => {
    const corrupt = card({ inputPerMillion: "abc" });
    const decisions = await planUsagePricingStamps([candidate()], async () => corrupt);
    expect(decisions[0]?.pricing).toEqual({ usd: null, state: "unpriced" });
  });

  it("plans every candidate in order", async () => {
    const decisions = await planUsagePricingStamps(
      [candidate({ id: "a", data: {} }), candidate({ id: "b", data: {} })],
      async () => null,
    );
    expect(decisions.map((d) => d.id)).toEqual(["a", "b"]);
  });
});

describe("sumUsd", () => {
  it("adds six-decimal figures exactly, never through a float", () => {
    expect(sumUsd(["1.525000", "0.10", "12"])).toBe("13.625000");
    expect(sumUsd(["0.0011", "1.237500"])).toBe("1.238600");
  });

  it("sums an empty list to zero and skips garbage", () => {
    expect(sumUsd([])).toBe("0.000000");
    expect(sumUsd(["not-a-number", "1.000000"])).toBe("1.000000");
  });

  it("rounds half-up past the sixth decimal", () => {
    expect(sumUsd(["0.0000005"])).toBe("0.000001");
    expect(sumUsd(["0.0000004"])).toBe("0.000000");
  });
});
