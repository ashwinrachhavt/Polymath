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

describe("providerRegistry", () => {
  it("never enables a provider whose entitlement is unverified", () => {
    for (const entry of providerRegistry()) {
      if (entry.freeClass === "unverified") expect(entry.enabled, entry.id).toBe(false);
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

  it("keeps Jev registered but disabled: a real product with no free allowance", () => {
    const jev = providerEntry("jev");
    expect(jev?.enabled).toBe(false);
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
