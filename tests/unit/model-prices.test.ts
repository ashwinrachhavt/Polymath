import { describe, expect, it } from "vitest";
import { DEFAULT_MODEL_ID, MODEL_CATALOG, cheapestModelOf, keyProviders, priceCall } from "@/domains/agents/models";

/*
 * Value: protects=Spending never again saying "unpriced" for a model we ship;
 * fails_when=a catalog entry lands without a usable price, the default model is
 * priced at zero, or an unknown model is priced as free instead of unpriced;
 * seam=the real catalog; no_claim=that the figures match a provider's current
 * invoice (they are estimates, corrected in the catalog).
 */

describe("model prices", () => {
  it("prices every catalog model with finite, non-negative rates", () => {
    const unpriced = MODEL_CATALOG.filter(
      (m) =>
        !Number.isFinite(m.price?.inputPerMillion) ||
        !Number.isFinite(m.price?.outputPerMillion) ||
        m.price.inputPerMillion < 0 ||
        m.price.outputPerMillion < 0,
    ).map((m) => m.id);
    expect(unpriced).toEqual([]);
  });

  it("charges the default model, so its runs stop showing as unpriced", () => {
    expect(DEFAULT_MODEL_ID).toBe("zai-org/glm-5.3-flash");
    const cost = priceCall(DEFAULT_MODEL_ID, 1_000_000, 1_000_000);
    expect(cost).not.toBeNull();
    expect(cost!).toBeGreaterThan(0);
  });

  it("computes cost from per-million rates", () => {
    expect(priceCall("claude-sonnet-5-5", 2_000_000, 1_000_000)).toBeCloseTo(2 * 3 + 15, 6);
    expect(priceCall("claude-sonnet-5-5", 0, 0)).toBe(0);
  });

  it("returns null, not zero, for a model the catalog does not know", () => {
    expect(priceCall("no-such-model", 1000, 1000)).toBeNull();
  });

  it("derives key providers from the catalog and picks each one's cheapest model", () => {
    const ids = keyProviders().map((p) => p.id);
    for (const wanted of ["openai", "anthropic", "openrouter", "thehive", "groq", "gemini"])
      expect(ids).toContain(wanted);
    expect(cheapestModelOf("openai")?.id).toBe("gpt-5.4-mini");
    expect(cheapestModelOf("anthropic")?.id).toBe("claude-haiku-5-5");
    expect(cheapestModelOf("nope")).toBeNull();
  });
});
