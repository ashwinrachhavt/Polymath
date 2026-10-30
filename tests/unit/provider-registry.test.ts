import { describe, expect, it } from "vitest";
import {
  assertProviderUsable,
  providerEntry,
  providerRegistry,
  ProviderDisabledError,
  quotaAllowance,
} from "@/integrations/providers/registry";

/*
 * The registry is the free-first guardrail: which providers exist, what
 * their verified entitlement is, and which ones fail closed. These tests pin
 * the decisions, not the marketing numbers — an allowance figure can change
 * with the next verification pass, the rules cannot.
 */

/**
 * Providers enabled on a deliberate owner decision even though no recurring
 * free allowance was verified. The rule below still holds for everything else;
 * naming an exception here is the review step that a silent `enabled: true`
 * would skip, and the quota gate — not this flag — is what bounds spend.
 */
const OWNER_APPROVED_PAID = new Set(["jev"]);

/**
 * Search routes the owner enabled on 2026-10-27 with live keys, though their
 * recurring free entitlement is still unverified. They stay opt-in: each is
 * bounded by the quota ledger, and none is reached without a key.
 */
const OWNER_APPROVED_SEARCH = new Set(["tavily", "exa"]);

describe("providerRegistry", () => {
  it("never enables a provider whose entitlement is unverified", () => {
    for (const entry of providerRegistry()) {
      if (entry.freeClass === "unverified") {
        if (OWNER_APPROVED_PAID.has(entry.id)) {
          // An approved paid provider must still be explicit about it.
          expect(entry.allowPaidUsage, entry.id).toBe(true);
          continue;
        }
        if (OWNER_APPROVED_SEARCH.has(entry.id)) {
          // Search routes the owner enabled on 2026-10-27 while their renewal
          // terms stay unverified. Explicit, not silent: the ledger caps spend.
          expect(entry.allowPaidUsage, entry.id).toBe(false);
          continue;
        }
        expect(entry.enabled, entry.id).toBe(false);
      }
    }
  });

  it("never allows paid fallback on any entry", () => {
    for (const entry of providerRegistry()) {
      expect(entry.allowPaidFallback, entry.id).toBe(false);
    }
  });

  it("records verification provenance on every enabled metered provider", () => {
    for (const entry of providerRegistry()) {
      if (entry.enabled && entry.quota) {
        expect(entry.verifiedAt, entry.id).toBeTruthy();
        expect(entry.verificationSource, entry.id).toMatch(/^https:\/\//);
      }
    }
  });

  it("marks the Gemini free route as not for sensitive data (free tier may train)", () => {
    const gemini = providerEntry("gemini");
    expect(gemini?.enabled).toBe(true);
    expect(gemini?.sensitiveDataAllowed).toBe(false);
    expect(gemini?.quota?.renewal).toBe("daily");
  });

  it("keeps Jev's paid usage explicit and its spend bounded by the ledger", () => {
    const jev = providerEntry("jev");
    // Enabled 2026-10-25 on the owner's decision; that decision is recorded as
    // paid usage rather than hidden behind a verified free tier that does not
    // exist. JEV_MONTHLY_INPUT_TOKENS is the real cap, and an unset allowance
    // is a zero cap in the quota gate.
    expect(jev?.enabled).toBe(true);
    expect(jev?.allowPaidUsage).toBe(true);
    expect(jev?.allowPaidFallback).toBe(false);
    expect(jev?.sensitiveDataAllowed).toBe(false);
    expect(jev?.verificationSource).toBe("https://docs.typesafe.ai/models");
  });
});

describe("ai-gateway-search entry", () => {
  it("stays disabled and paid-only until the spend is opted into", () => {
    const entry = providerEntry("ai-gateway-search")!;
    expect(entry.enabled).toBe(false);
    expect(entry.freeClass).toBe("paid");
    expect(entry.allowPaidUsage).toBe(false);
    expect(entry.allowPaidFallback).toBe(false);
    expect(entry.verificationSource).toContain("vercel.com");
  });
});

describe("composio entry", () => {
  it("carries a verified spend gate: quota, recent verification, composio.dev source", () => {
    // Spec #316: the spend guard refuses Composio Instant calls while these
    // are missing — a regression here silently reopens unbounded spend.
    const entry = providerEntry("composio")!;
    expect(entry.enabled).toBe(true);
    expect(entry.allowPaidUsage).toBe(false);
    expect(entry.allowPaidFallback).toBe(false);
    expect(entry.quota).not.toBeNull();
    expect(entry.quota!.allowance).toBeGreaterThan(0);
    expect(entry.quota!.renewal).toBe("monthly");
    expect(entry.verifiedAt).not.toBeNull();
    expect(entry.verifiedAt! >= "2026-10-25").toBe(true);
    expect(entry.verificationSource).toContain("composio.dev");
  });
});

describe("mercury entry", () => {
  it("carries the one-time trial grant with a verified spend gate", () => {
    // Owner decision 2026-10-29: first in the free-first chain while the
    // 100M-token grant lasts. A trial, not a recurring tier — and the ledger,
    // not this entry, is what stops spend when the grant drains.
    const entry = providerEntry("mercury")!;
    expect(entry.enabled).toBe(true);
    expect(entry.freeClass).toBe("trial");
    expect(entry.allowPaidUsage).toBe(false);
    expect(entry.allowPaidFallback).toBe(false);
    expect(entry.sensitiveDataAllowed).toBe(false);
    expect(entry.quota).not.toBeNull();
    expect(entry.quota!.unit).toBe("tokens");
    expect(entry.quota!.allowance).toBe(100_000_000);
    expect(entry.quota!.allowanceEnv).toBe("MERCURY_TOTAL_TOKENS");
    expect(entry.verifiedAt).toBe("2026-10-29");
    expect(entry.verificationSource).toContain("inceptionlabs.ai");
  });
});

describe("assertProviderUsable", () => {
  it("fails closed on unknown, disabled and unverified providers", () => {
    expect(() => assertProviderUsable(null, "made-up")).toThrow(ProviderDisabledError);
    expect(() => assertProviderUsable(providerEntry("jev"), "jev")).toThrow(ProviderDisabledError);
    expect(() => assertProviderUsable(providerEntry("tavily"), "tavily")).toThrow(ProviderDisabledError);
    expect(assertProviderUsable(providerEntry("firecrawl"), "firecrawl").id).toBe("firecrawl");
  });
});

describe("quotaAllowance", () => {
  it("lets the account's real entitlement override the public default", () => {
    const entry = providerEntry("firecrawl")!;
    expect(quotaAllowance(entry, {})).toBe(1000);
    expect(quotaAllowance(entry, { FIRECRAWL_MONTHLY_CREDITS: "2500" })).toBe(2500);
    expect(quotaAllowance(entry, { FIRECRAWL_MONTHLY_CREDITS: "junk" })).toBe(1000);
  });
});
